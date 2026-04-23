"""
배당 변동 알림 로직
- 즉시 0.10+ 스팀무브 알림
- 핸디캡 / 오버언더 라인 자체 변경 알림 (배당 변동 포함)
"""

from datetime import datetime, timezone, timedelta
from db import alert_sent, save_alert

INSTANT_THRESH = 0.10
KST = timezone(timedelta(hours=9))

FIELD_KO = {
    "ml_home":  ("ML", "홈"),
    "ml_away":  ("ML", "원정"),
    "ml_draw":  ("ML", "무승부"),
    "sp_home":  ("핸디캡", "홈"),
    "sp_away":  ("핸디캡", "원정"),
    "ou_over":  ("오버언더", "오버"),
    "ou_under": ("오버언더", "언더"),
}

LEAGUE_FLAG = {"MLB": "🇺🇸", "KBO": "🇰🇷", "NPB": "🇯🇵"}


def _diff(a, b):
    if a is None or b is None:
        return None
    return abs(float(a) - float(b))


def _signed(new, old):
    return float(new) - float(old)


def _hours_until(starts_at: str) -> str:
    try:
        now  = datetime.now(KST)
        dt   = datetime.strptime(f"{now.year}/{starts_at}", "%Y/%m/%d %H:%M KST")
        dt   = dt.replace(tzinfo=KST)
        diff = (dt - now).total_seconds() / 3600
        if diff < 0:   return "진행 중"
        if diff < 1:   return f"약 {int(diff*60)}분 후"
        return f"약 {diff:.1f}h 후"
    except Exception:
        return ""


def _header(game: dict) -> str:
    flag   = LEAGUE_FLAG.get(game["league"], "⚾️")
    starts = game["starts_at"].replace(" KST", "")
    until  = _hours_until(game["starts_at"])
    return (
        f"{flag} {game['league']}: {game['away']} vs {game['home']}\n"
        f"⏰ 경기: {starts} KST  ({until})"
    )


def check_alerts(game: dict, opening: dict, prev: dict) -> list[dict]:
    mid    = game["matchup_id"]
    header = _header(game)
    alerts = []

    # 라인 변경 여부 미리 확인 (스팀무브 억제용)
    sp_line_changed = (game.get("sp_pts") is not None and opening.get("sp_pts") is not None
                       and game["sp_pts"] != opening["sp_pts"])
    ou_line_changed = (game.get("ou_pts") is not None and opening.get("ou_pts") is not None
                       and game["ou_pts"] != opening["ou_pts"])

    # 라인 변경 시 해당 마켓 스팀무브 억제 (라인변경 알림에 배당 포함되어 있으므로)
    suppressed = set()
    if sp_line_changed:
        suppressed.update(["sp_home", "sp_away"])
    if ou_line_changed:
        suppressed.update(["ou_over", "ou_under"])

    # ── 스팀무브 (즉시 0.10+ 변동) ──────────────────────────
    if prev:
        steam_fields = ["ml_home", "ml_away", "ml_draw", "sp_home", "sp_away", "ou_over", "ou_under"]
        for field in steam_fields:
            if field in suppressed:
                continue
            diff = _diff(game.get(field), prev.get(field))
            if diff is None or diff < INSTANT_THRESH:
                continue
            signed = _signed(game[field], prev[field])
            cat, side = FIELD_KO[field]
            desc  = f"급하락 ❄️" if signed < 0 else f"급상승 🔥"

            save_alert(mid, f"instant_{field}", f"{diff:.2f}")
            alerts.append({"type": "즉시", "msg": (
                f"⚡️ [스팀무브 감지]\n\n"
                f"{header}\n\n"
                f"📊 {cat} {side} {desc}\n"
                f"  직전: {prev[field]:.2f}  →  현재: {game[field]:.2f}  ({signed:+.2f})"
            )})

    # ── 핸디캡 기준선 변경 (배당 포함) ──────────────────────
    if (game.get("sp_pts") is not None and opening.get("sp_pts") is not None
            and game["sp_pts"] != opening["sp_pts"]):
        atype = "line_sp"
        if not alert_sent(mid, atype, str(game["sp_pts"])):
            save_alert(mid, atype, str(game["sp_pts"]))
            delta = game["sp_pts"] - opening["sp_pts"]

            # 배당 변동 포함
            sp_home_chg = f"{_signed(game['sp_home'], opening['sp_home']):+.2f}" if game.get("sp_home") and opening.get("sp_home") else ""
            sp_away_chg = f"{_signed(game['sp_away'], opening['sp_away']):+.2f}" if game.get("sp_away") and opening.get("sp_away") else ""

            alerts.append({"type": "라인변경", "msg": (
                f"🔄 [핸디캡 기준선 변경]\n\n"
                f"{header}\n\n"
                f"📐 기준선  {opening['sp_pts']:+.1f}  →  {game['sp_pts']:+.1f}  ({delta:+.1f})\n"
                f"📊 배당 변동\n"
                f"  원정: {opening['sp_away']:.2f} → {game['sp_away']:.2f}  ({sp_away_chg})\n"
                f"  홈:   {opening['sp_home']:.2f} → {game['sp_home']:.2f}  ({sp_home_chg})"
            )})

    # ── 오버언더 기준선 변경 (배당 포함) ────────────────────
    if (game.get("ou_pts") is not None and opening.get("ou_pts") is not None
            and game["ou_pts"] != opening["ou_pts"]):
        atype = "line_ou"
        if not alert_sent(mid, atype, str(game["ou_pts"])):
            save_alert(mid, atype, str(game["ou_pts"]))
            delta = game["ou_pts"] - opening["ou_pts"]
            arrow = "❄️" if delta < 0 else "🔥"

            over_chg  = f"{_signed(game['ou_over'],  opening['ou_over']):+.2f}"  if game.get("ou_over")  and opening.get("ou_over")  else ""
            under_chg = f"{_signed(game['ou_under'], opening['ou_under']):+.2f}" if game.get("ou_under") and opening.get("ou_under") else ""

            alerts.append({"type": "라인변경", "msg": (
                f"🔄 [오버언더 기준선 변경]\n\n"
                f"{header}\n\n"
                f"📐 기준선  {opening['ou_pts']:.1f}  →  {game['ou_pts']:.1f}  ({delta:+.1f}) {arrow}\n"
                f"📊 배당 변동\n"
                f"  오버: {opening['ou_over']:.2f} → {game['ou_over']:.2f}  ({over_chg})\n"
                f"  언더: {opening['ou_under']:.2f} → {game['ou_under']:.2f}  ({under_chg})"
            )})

    return alerts
