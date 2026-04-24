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

LEAGUE_FLAG = {
    "MLB": "🇺🇸", "KBO": "🇰🇷", "NPB": "🇯🇵",
    "EPL": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Bundesliga": "🇩🇪", "Serie A": "🇮🇹",
    "Ligue 1": "🇫🇷", "La Liga": "🇪🇸",
    "K리그1": "🇰🇷", "MLS": "🇺🇸",
    "UCL": "🏆", "Europa": "🟠", "Conference": "🟢",
    "NBA": "🇺🇸", "KBL": "🇰🇷",
    "NHL": "🇺🇸",
}


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
        f"{flag} {game['league']}: {game['home']} vs {game['away']}\n"
        f"⏰ 경기: {starts} KST  ({until})"
    )


def _pts_changed(a, b) -> bool:
    """부동소수점 오차 방지: 소수점 2자리 반올림 후 비교"""
    if a is None or b is None:
        return False
    return round(float(a), 2) != round(float(b), 2)


def _pts_str(v) -> str:
    """threshold 저장 시 정규화된 문자열 사용"""
    return f"{round(float(v), 2):.2f}" if v is not None else ""


def check_alerts(game: dict, opening: dict, prev: dict) -> list[dict]:
    mid    = game["matchup_id"]
    header = _header(game)
    alerts = []

    # 라인 변경 여부 미리 확인 (스팀무브 억제용)
    sp_line_changed = _pts_changed(game.get("sp_pts"), opening.get("sp_pts"))
    ou_line_changed = _pts_changed(game.get("ou_pts"), opening.get("ou_pts"))

    # 라인 변경 시 해당 마켓 스팀무브 억제 (라인변경 알림에 배당 포함되어 있으므로)
    suppressed = set()
    if sp_line_changed:
        suppressed.update(["sp_home", "sp_away"])
    if ou_line_changed:
        suppressed.update(["ou_over", "ou_under"])

    # ── 스팀무브 (즉시 0.10+ 변동, 마켓별 1개로 묶음) ──────
    if prev:
        # 마켓 그룹 정의: (그룹명, 알림타입키, [필드목록])
        steam_groups = [
            ("ML",    "instant_ml", ["ml_home", "ml_away", "ml_draw"]),
            ("핸디캡", "instant_sp", ["sp_home", "sp_away"]),
            ("오버언더","instant_ou", ["ou_over", "ou_under"]),
        ]
        for group_name, atype, fields in steam_groups:
            # 억제된 필드 그룹이면 스킵
            if all(f in suppressed for f in fields if game.get(f) is not None):
                continue

            # 그룹 내 0.10+ 변동 필드 수집
            moved = []
            for field in fields:
                if field in suppressed:
                    continue
                diff = _diff(game.get(field), prev.get(field))
                if diff is None or diff < INSTANT_THRESH:
                    continue
                moved.append((field, diff))

            if not moved:
                continue

            # 대표 변동폭으로 중복 억제
            max_diff = max(d for _, d in moved)
            if alert_sent(mid, atype, f"{max_diff:.2f}"):
                continue
            save_alert(mid, atype, f"{max_diff:.2f}")

            # 변동 내용 라인 생성
            lines = []
            for field, diff in moved:
                signed = _signed(game[field], prev[field])
                _, side = FIELD_KO[field]
                arrow = "📉" if signed < 0 else "📈"
                lines.append(f"  {arrow} {side}: {prev[field]:.2f} → {game[field]:.2f}  ({signed:+.2f})")

            desc = "급하락 ❄️" if _signed(game[moved[0][0]], prev[moved[0][0]]) < 0 else "급상승 🔥"
            alerts.append({"type": "즉시", "msg": (
                f"⚡️ [스팀무브 감지]\n\n"
                f"{header}\n\n"
                f"📊 {group_name} {desc}\n"
                + "\n".join(lines)
            )})

    # ── 핸디캡 기준선 변경 (배당 포함) ──────────────────────
    if sp_line_changed:
        atype = "line_sp"
        if not alert_sent(mid, atype, _pts_str(game["sp_pts"])):
            save_alert(mid, atype, _pts_str(game["sp_pts"]))
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
    if ou_line_changed:
        atype = "line_ou"
        if not alert_sent(mid, atype, _pts_str(game["ou_pts"])):
            save_alert(mid, atype, _pts_str(game["ou_pts"]))
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
