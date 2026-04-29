"""
Pinnacle 역행봇 메인 모니터
GitHub Actions에서 5분마다 실행 (또는 로컬에서 루프 실행)
배치 쿼리로 Supabase API 호출 최소화 (~5회/실행)
"""

import os
from datetime import datetime, timezone, timedelta

from pinnacle_scraper import fetch_games
from db import (init_db,
                get_all_openings_batch, get_recent_snapshots_batch,
                save_openings_batch, save_snapshots_batch, fill_opening_nulls_batch,
                refresh_stale_soccer_openings)
from alert import check_alerts

KST = timezone(timedelta(hours=9))

LEAGUE_FLAG = {
    # 야구
    "MLB": "🇺🇸", "KBO": "🇰🇷", "NPB": "🇯🇵",
    # 축구 리그
    "EPL": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Bundesliga": "🇩🇪", "Serie A": "🇮🇹",
    "Ligue 1": "🇫🇷", "La Liga": "🇪🇸",
    "K리그1": "🇰🇷", "K리그2": "🇰🇷", "MLS": "🇺🇸", "A리그": "🇦🇺", "J리그": "🇯🇵",
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


def notify(alert: dict):
    print(f"\n{'='*55}\n{alert['msg']}\n{'='*55}")
    _send_telegram(alert["msg"])


def notify_opening(game: dict):
    flag   = LEAGUE_FLAG.get(game["league"], "⚾️")
    starts = game["starts_at"].replace(" KST", "")
    is_soccer = game.get("sport") == "soccer"

    ml_home = f"{game['ml_home']:.2f}" if game.get("ml_home") else "?"
    ml_away = f"{game['ml_away']:.2f}" if game.get("ml_away") else "?"
    if is_soccer and game.get("ml_draw"):
        ml_line = f"승무패  홈 {ml_home} / 무 {game['ml_draw']:.2f} / 원정 {ml_away}"
    else:
        ml_line = f"승패  홈 {ml_home} / 원정 {ml_away}"

    if game.get("sp_pts") is not None:
        home_pts = game["sp_pts"]
        away_pts = -home_pts
        sp = f"핸디  홈 {home_pts:+.1f} ({game['sp_home']:.2f}) / 원정 {away_pts:+.1f} ({game['sp_away']:.2f})"
    else:
        sp = "핸디 ?"

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

    sb_url = os.environ.get("SUPABASE_URL", "")
    sb_key = os.environ.get("SUPABASE_KEY", "")
    print(f"SUPABASE_URL set: {bool(sb_url)}")
    print(f"SUPABASE_KEY set: {bool(sb_key)}")

    games = fetch_games()
    print(f"경기 {len(games)}개 처리 중...")

    matchup_ids = [g["matchup_id"] for g in games]

    # ── 배치 조회 (Supabase 2회) ──────────────────────────
    print("배치 조회 중...")
    all_openings  = get_all_openings_batch(matchup_ids)
    all_recents   = get_recent_snapshots_batch(matchup_ids, limit_per_game=10)
    print(f"오프닝 {len(all_openings)}건 / 스냅샷 {sum(len(v) for v in all_recents.values())}건 로드")

    # ── 게임별 처리 (DB 쿼리 없음) ───────────────────────
    new_openings  = []
    total_alerts  = 0

    for game in games:
        mid     = game["matchup_id"]
        opening = all_openings.get(mid)
        recents = all_recents.get(mid, [])
        prev    = recents[0] if recents else None

        if opening is None:
            new_openings.append(game)
            opening = game   # 알림 체크에 현재값 사용

        alerts = check_alerts(game, opening, prev, recents)
        for a in alerts:
            notify(a)
        total_alerts += len(alerts)

    # ── 배치 저장 (Supabase 2~3회) ───────────────────────
    print(f"저장 중... (신규오프닝 {len(new_openings)}건)")
    save_openings_batch(new_openings)
    fill_opening_nulls_batch(games, all_openings)
    refresh_stale_soccer_openings(games, all_openings)   # 축구 오프닝 리셋 (72h 이내 + 7일 이상)
    save_snapshots_batch(games)

    # ── 오프닝 알림 ──────────────────────────────────────
    new_openings.sort(key=lambda g: g["starts_at"])
    for game in new_openings:
        notify_opening(game)

    print(f"완료 — 신규오프닝 {len(new_openings)}건 / 알림 {total_alerts}건\n")


if __name__ == "__main__":
    run()
