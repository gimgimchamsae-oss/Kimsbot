"""
Pinnacle 역행봇 메인 모니터
GitHub Actions에서 5분마다 실행 (또는 로컬에서 루프 실행)
"""

import os
from datetime import datetime, timezone, timedelta

from pinnacle_scraper import fetch_games
from db import init_db, save_snapshot, save_opening, get_opening, get_prev_snapshot
from alert import check_alerts

KST = timezone(timedelta(hours=9))

LEAGUE_FLAG = {
    # 야구
    "MLB": "🇺🇸", "KBO": "🇰🇷", "NPB": "🇯🇵",
    # 축구 리그
    "EPL": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Bundesliga": "🇩🇪", "Serie A": "🇮🇹",
    "Ligue 1": "🇫🇷", "La Liga": "🇪🇸",
    "K리그1": "🇰🇷", "MLS": "🇺🇸",
    # UEFA 대회
    "UCL": "🏆", "Europa": "🟠", "Conference": "🟢",
    # 농구
    "NBA": "🇺🇸", "KBL": "🇰🇷",
    # 아이스하키
    "NHL": "🇺🇸",
}


def _send_telegram(text: str):
    token   = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return
    try:
        import requests as req
        req.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text},
            timeout=5,
        )
    except Exception as e:
        print(f"[텔레그램 오류] {e}")


def _parse_kst(starts_at: str) -> datetime | None:
    """'MM/DD HH:MM KST' → datetime(KST)"""
    try:
        year = datetime.now(KST).year
        dt = datetime.strptime(f"{year}/{starts_at}", "%Y/%m/%d %H:%M KST")
        return dt.replace(tzinfo=KST)
    except Exception:
        return None



def notify(alert: dict):
    print(f"\n{'='*55}\n{alert['msg']}\n{'='*55}")
    _send_telegram(alert["msg"])


def notify_opening(game: dict):
    flag   = LEAGUE_FLAG.get(game["league"], "⚾️")
    starts = game["starts_at"].replace(" KST", "")
    is_soccer = game.get("sport") == "soccer"

    # 승패 (홈 먼저, 무승부 가운데)
    ml_home = f"{game['ml_home']:.2f}" if game.get("ml_home") else "?"
    ml_away = f"{game['ml_away']:.2f}" if game.get("ml_away") else "?"
    if is_soccer and game.get("ml_draw"):
        ml_line = f"승무패  홈 {ml_home} / 무 {game['ml_draw']:.2f} / 원정 {ml_away}"
    else:
        ml_line = f"승패  홈 {ml_home} / 원정 {ml_away}"

    # 핸디 (홈 먼저)
    if game.get("sp_pts") is not None:
        home_pts = game["sp_pts"]
        away_pts = -home_pts
        sp = f"핸디  홈 {home_pts:+.1f} ({game['sp_home']:.2f}) / 원정 {away_pts:+.1f} ({game['sp_away']:.2f})"
    else:
        sp = "핸디 ?"

    # 오버언더
    ou = f"U/O {game['ou_pts']}  오버 {game['ou_over']:.2f} / 언더 {game['ou_under']:.2f}" \
        if game.get("ou_pts") is not None else "U/O ?"

    msg = (
        f"📌 [오프닝 라인 등록]\n\n"
        f"{flag} {game['league']}: {game['home']} vs {game['away']}\n"
        f"⏰ 경기: {starts} KST\n\n"
        f"{ml_line}\n"
        f"{sp}\n"
        f"{ou}"
    )
    print(msg)
    _send_telegram(msg)


def run():
    init_db()
    now = datetime.now(KST).strftime("%H:%M:%S KST")
    print(f"[{now}] 배당 수집 시작...")

    # 디버그: Supabase 연결 확인
    import os
    sb_url = os.environ.get("SUPABASE_URL", "")
    sb_key = os.environ.get("SUPABASE_KEY", "")
    print(f"[DEBUG] USE_SUPABASE={bool(sb_url and sb_key)} / URL={sb_url[:30] if sb_url else 'None'}")

    games = fetch_games()
    print(f"경기 {len(games)}개 처리 중...")

    # 신규 오프닝 수집 (시간 제한 없이 전체 등록)
    new_openings = []
    total_alerts = 0

    for game in games:
        mid     = game["matchup_id"]
        opening = get_opening(mid)
        prev    = get_prev_snapshot(mid)

        if opening is None:
            try:
                save_opening(game)
                print(f"[오프닝] {game['home']} vs {game['away']} ({game['starts_at']})")
            except Exception as e:
                print(f"[오프닝 실패] {game['home']} vs {game['away']} → {e}")
            new_openings.append(game)
            opening = game

        # 알림 체크 (모든 경기 대상)
        alerts = check_alerts(game, opening, prev)
        for a in alerts:
            notify(a)
        total_alerts += len(alerts)

        # 스냅샷 저장
        save_snapshot(game)

    # 오프닝 알림: 시간순 정렬 후 발송
    new_openings.sort(key=lambda g: g["starts_at"])
    for game in new_openings:
        notify_opening(game)

    print(f"완료 — 신규오프닝 {len(new_openings)}건 / 알림 {total_alerts}건\n")


if __name__ == "__main__":
    run()
