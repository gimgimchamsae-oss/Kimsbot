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


def notify(alert: dict):
    """알림 출력 (텔레그램 연동 시 여기서 발송)"""
    now = datetime.now(KST).strftime("%H:%M:%S")
    tag = {"누적": "📈", "즉시": "⚡", "라인변경": "🔄"}.get(alert["type"], "🔔")
    print(f"\n{'='*55}")
    print(f"{tag} [{alert['type']}] {now}")
    print(alert["msg"])
    print(f"{'='*55}")

    # 텔레그램 연동 (TELEGRAM_TOKEN, TELEGRAM_CHAT_ID 환경변수 설정 시 활성화)
    token   = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat_id:
        try:
            import requests
            text = f"{tag} [{alert['type']}]\n{alert['msg']}"
            requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text},
                timeout=5,
            )
        except Exception as e:
            print(f"[텔레그램 오류] {e}")


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

        # 신규 경기 → 오프닝 저장
        if opening is None:
            save_opening(game)
            print(f"  [신규] {game['league']} {game['away']} @ {game['home']} ({game['starts_at']})")
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
