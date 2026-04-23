"""
Pinnacle 역행봇 메인 모니터
GitHub Actions에서 5분마다 실행 (또는 로컬에서 루프 실행)
"""

import sys
import os
from datetime import datetime, timezone, timedelta

from pinnacle_scraper import fetch_games
from db import init_db, save_snapshot, save_opening, get_opening, get_prev_snapshot
from alert import check_alerts

KST = timezone(timedelta(hours=9))

LEAGUE_FLAG = {
    "MLB": "🇺🇸", "KBO": "🇰🇷", "NPB": "🇯🇵",
    "EPL": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Bundesliga": "🇩🇪", "Serie A": "🇮🇹",
    "Ligue 1": "🇫🇷", "La Liga": "🇪🇸",
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


def notify(alert: dict):
    tag = {"누적": "📈", "즉시": "⚡️", "라인변경": "🔄"}.get(alert["type"], "🔔")
    print(f"\n{'='*55}\n{alert['msg']}\n{'='*55}")
    _send_telegram(alert["msg"])


def notify_opening(game: dict):
    flag  = LEAGUE_FLAG.get(game["league"], "⚾️")
    starts = game["starts_at"].replace(" KST", "")

    ml_away = f"{game['ml_away']:.2f}" if game.get("ml_away") else "?"
    ml_home = f"{game['ml_home']:.2f}" if game.get("ml_home") else "?"
    ml_draw = f" / 무 {game['ml_draw']:.2f}" if game.get("ml_draw") else ""

    if game.get("sp_pts") is not None:
        home_pts = game["sp_pts"]
        away_pts = -home_pts
        sp = f"핸디  원정 {away_pts:+.1f} ({game['sp_away']:.2f}) / 홈 {home_pts:+.1f} ({game['sp_home']:.2f})"
    else:
        sp = "핸디 ?"

    ou = f"U/O {game['ou_pts']} 오버 {game['ou_over']:.2f} / 언더 {game['ou_under']:.2f}" \
        if game.get("ou_pts") is not None else "U/O ?"

    msg = (
        f"📌 [오프닝 라인 등록]\n\n"
        f"{flag} {game['league']}: {game['away']} vs {game['home']}\n"
        f"⏰ 경기: {starts} KST\n\n"
        f"승패  원정 {ml_away} / 홈 {ml_home}{ml_draw}\n"
        f"{sp}\n"
        f"{ou}"
    )
    print(msg)
    _send_telegram(msg)


def run():
    init_db()
    now = datetime.now(KST).strftime("%H:%M:%S KST")
    print(f"[{now}] 배당 수집 시작...")

    games = fetch_games()
    print(f"경기 {len(games)}개 처리 중...")

    total_alerts = 0
    for game in games:
        mid     = game["matchup_id"]
        opening = get_opening(mid)
        prev    = get_prev_snapshot(mid)

        # 신규 경기 → 오프닝 저장 + 알림
        if opening is None:
            save_opening(game)
            notify_opening(game)
            opening = game

        # 알림 체크
        alerts = check_alerts(game, opening, prev)
        for a in alerts:
            notify(a)
        total_alerts += len(alerts)

        # 스냅샷 저장
        save_snapshot(game)

    print(f"완료 — 알림 {total_alerts}건\n")


if __name__ == "__main__":
    run()
