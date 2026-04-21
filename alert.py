"""
배당 변동 알림 로직
- 누적 0.05 구간마다 알림 (0.10, 0.15, 0.20...)
- 즉시 0.10+ 단발 변동 알림
- 핸디캡 / 오버언더 라인 자체 변경 알림
"""

from datetime import datetime, timezone, timedelta
from db import alert_sent, save_alert

CUMUL_START    = 0.10
CUMUL_STEP     = 0.05
INSTANT_THRESH = 0.10
KST = timezone(timedelta(hours=9))

FIELD_KO = {
    "ml_home":  ("ML", "홈"),
    "ml_away":  ("ML", "원정"),
    "sp_home":  ("핸디캡", "홈"),
    "sp_away":  ("핸디캡", "원정"),
    "ou_over":  ("오버언더", "오버"),
    "ou_under": ("오버언더", "언더"),
}

LEAGUE_EMOJI = {"MLB": "⚾️", "KBO": "⚾️", "NPB": "⚾️"}


def _diff(a, b):
    if a is None or b is None:
        return None
    return abs(float(a) - float(b))


def _signed_diff(new, old):
    return float(new) - float(old)


def _cumul_thresholds_hit(diff: float) -> list[str]:
    hits = []
    level = CUMUL_START
    while level <= diff + 1e-9:
        hits.append(f"{level:.2f}")
        level = round(level + CUMUL_STEP, 2)
    return hits


def _hours_until(starts_at: str) -> str:
    """starts_at 'MM/DD HH:MM KST' → '약 Xh 후' 문자열"""
    try:
        now = datetime.now(KST)
        year = now.year
        dt = datetime.strptime(f"{year}/{starts_at}", "%Y/%m/%d %H:%M KST")
        dt = dt.replace(tzinfo=KST)
        diff_h = (dt - now).total_seconds() / 3600
        if diff_h < 0:
            return "진행 중"
        elif diff_h < 1:
            return f"약 {int(diff_h*60)}분 후"
        else:
            return f"약 {diff_h:.1f}h 후"
    except Exception:
        return ""


def _header(game: dict) -> str:
    emoji  = LEAGUE_EMOJI.get(game["league"], "⚾️")
    until  = _hours_until(game["starts_at"])
    starts = game["starts_at"].replace(" KST", "")
    return (
        f"{emoji} {game['league']}: {game['away']} vs {game['home']}\n"
        f"⏰ 경기: {starts} KST  ({until})"
    )


def check_alerts(game: dict, opening: dict, prev: dict) -> list[dict]:
    mid    = game["matchup_id"]
    header = _header(game)
    alerts = []

    cumul_fields = ["ml_home", "ml_away", "sp_home", "sp_away", "ou_over", "ou_under"]

    # ── 누적 알림 ────────────────────────────────────────────
    for field in cumul_fields:
        diff = _diff(game.get(field), opening.get(field))
        if diff is None:
            continue
        signed = _signed_diff(game[field], opening[field])
        arrow  = "📉" if signed < 0 else "📈"
        cat, side = FIELD_KO[field]

        for thresh in _cumul_thresholds_hit(diff):
            atype = f"cumul_{field}"
            if not alert_sent(mid, atype, thresh):
                save_alert(mid, atype, thresh)
                alerts.append({"type": "누적", "msg": (
                    f"📈 [누적 이동 감지]\n\n"
                    f"{header}\n\n"
                    f"📊 항목: {cat} {side} 누적 이동\n"
                    f"{arrow} 오프닝 대비 {signed:+.2f} 변동\n"
                    f"  오프닝: {opening[field]:.2f}  →  현재: {game[field]:.2f}"
                )})

    # ── 즉시 변동 알림 ───────────────────────────────────────
    if prev:
        for field in cumul_fields:
            diff = _diff(game.get(field), prev.get(field))
            if diff is None or diff < INSTANT_THRESH:
                continue
            signed = _signed_diff(game[field], prev[field])
            arrow  = "🔻" if signed < 0 else "🔺"
            cat, side = FIELD_KO[field]
            desc   = "급하락 ❄️" if signed < 0 else "급상승 🔥"

            save_alert(mid, f"instant_{field}", f"{diff:.2f}")
            alerts.append({"type": "즉시", "msg": (
                f"⚡️ [스팀무브 감지 — 즉시 알림]\n\n"
                f"{header}\n\n"
                f"📊 항목: {cat} {side} 스팀\n"
                f"💥 {cat} {side} 5분 내 {desc}\n"
                f"  직전: {prev[field]:.2f}  →  현재: {game[field]:.2f}  ({signed:+.2f})"
            )})

    # ── 핸디캡 라인 변경 ─────────────────────────────────────
    if (game.get("sp_pts") is not None and opening.get("sp_pts") is not None
            and game["sp_pts"] != opening["sp_pts"]):
        atype = "line_sp"
        if not alert_sent(mid, atype, str(game["sp_pts"])):
            save_alert(mid, atype, str(game["sp_pts"]))
            delta = game["sp_pts"] - opening["sp_pts"]
            alerts.append({"type": "라인변경", "msg": (
                f"🔄 [핸디캡 기준선 변경]\n\n"
                f"{header}\n\n"
                f"📊 항목: 핸디캡 기준점 변경\n"
                f"💥 기준선 {delta:+.1f} 이동\n"
                f"  오프닝: {opening['sp_pts']:+.1f}  →  현재: {game['sp_pts']:+.1f}"
            )})

    # ── 오버언더 라인 변경 ───────────────────────────────────
    if (game.get("ou_pts") is not None and opening.get("ou_pts") is not None
            and game["ou_pts"] != opening["ou_pts"]):
        atype = "line_ou"
        if not alert_sent(mid, atype, str(game["ou_pts"])):
            save_alert(mid, atype, str(game["ou_pts"]))
            delta = game["ou_pts"] - opening["ou_pts"]
            arrow = "❄️" if delta < 0 else "🔥"
            alerts.append({"type": "라인변경", "msg": (
                f"⚡️ [스팀무브 감지 — 즉시 알림]\n\n"
                f"{header}\n\n"
                f"📊 항목: 언오버 기준점 스팀\n"
                f"💥 U/O 기준점 5분 내 급{'하락' if delta < 0 else '상승'} {arrow}\n"
                f"  직전: {opening['ou_pts']:.1f}  →  현재: {game['ou_pts']:.1f}  ({delta:+.1f})"
            )})

    return alerts
