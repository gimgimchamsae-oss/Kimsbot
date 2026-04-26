"""
sportsbettingdime.com 공개 구매율 스크래퍼 (Playwright)
MLB / NBA / NHL 지원
"""

import asyncio
import os
import re
from datetime import datetime, timezone, timedelta
from playwright.async_api import async_playwright

KST = timezone(timedelta(hours=9))

SPORT_URLS = {
    "mlb": "https://www.sportsbettingdime.com/mlb/public-betting-trends/",
    "nba": "https://www.sportsbettingdime.com/nba/public-betting-trends/",
    "nhl": "https://www.sportsbettingdime.com/nhl/public-betting-trends/",
}

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")


def _sb():
    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def _pct(text: str):
    """'16%' → 16"""
    try:
        m = re.search(r'\d+', text)
        return int(m.group()) if m else None
    except Exception:
        return None


async def get_cells(row) -> list[str]:
    cells = await row.query_selector_all("td")
    texts = []
    for c in cells:
        texts.append((await c.inner_text()).strip())
    return texts


async def scrape_sport(page, sport: str, url: str) -> list[dict]:
    print(f"[{sport.upper()}] 스크래핑 중...")
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(8000)
    except Exception as e:
        print(f"[{sport.upper()}] 페이지 로드 실패: {e}")
        return []

    tables = await page.query_selector_all("table")
    if len(tables) < 2:
        print(f"[{sport.upper()}] 테이블 없음")
        return []

    # 두 번째 테이블에서 (no class) 행만 추출
    all_rows = await tables[1].query_selector_all("tr")
    data_rows = []
    for row in all_rows:
        cls = await row.get_attribute("class") or ""
        if cls.strip() == "":  # (no class) 행만
            data_rows.append(row)

    games = []
    i = 0
    while i < len(data_rows):
        row = data_rows[i]
        text = (await row.inner_text()).strip()

        # 날짜 행 (UTC 포함)
        if "UTC" in text or "pm UTC" in text or "am UTC" in text:
            # 다음 두 행이 원정/홈 팀
            if i + 2 < len(data_rows):
                away_cells = await get_cells(data_rows[i + 1])
                home_cells = await get_cells(data_rows[i + 2])

                # 유효한 팀 데이터 확인 (셀 수 충분한지)
                if len(away_cells) >= 3 and len(home_cells) >= 3:
                    away = away_cells[0] if away_cells else ""
                    home = home_cells[0] if home_cells else ""

                    # "Matchup Report" 같은 비팀 행 제외
                    if away and home and "Report" not in away and "Report" not in home:
                        game = {
                            "sport":           sport,
                            "away":            away,
                            "home":            home,
                            "game_time":       text,
                            # ML
                            "ml_bets_away":    _pct(away_cells[2]) if len(away_cells) > 2 else None,
                            "ml_handle_away":  _pct(away_cells[3]) if len(away_cells) > 3 else None,
                            "ml_bets_home":    _pct(home_cells[2]) if len(home_cells) > 2 else None,
                            "ml_handle_home":  _pct(home_cells[3]) if len(home_cells) > 3 else None,
                            # Spread
                            "sp_bets_away":    _pct(away_cells[5]) if len(away_cells) > 5 else None,
                            "sp_handle_away":  _pct(away_cells[6]) if len(away_cells) > 6 else None,
                            "sp_bets_home":    _pct(home_cells[5]) if len(home_cells) > 5 else None,
                            "sp_handle_home":  _pct(home_cells[6]) if len(home_cells) > 6 else None,
                            # Total
                            "ou_bets_over":    _pct(away_cells[8]) if len(away_cells) > 8 else None,
                            "ou_handle_over":  _pct(away_cells[9]) if len(away_cells) > 9 else None,
                            "ou_bets_under":   _pct(home_cells[8]) if len(home_cells) > 8 else None,
                            "ou_handle_under": _pct(home_cells[9]) if len(home_cells) > 9 else None,
                            "updated_at":      datetime.now(KST).isoformat(),
                        }
                        games.append(game)
                        print(f"  {away} vs {home} | ML베팅 원정{game['ml_bets_away']}% 홈{game['ml_bets_home']}%")
                        i += 3  # 날짜 + 원정 + 홈
                        continue
            i += 1
        else:
            i += 1

    print(f"[{sport.upper()}] {len(games)}경기 수집")
    return games


async def main():
    all_games = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )

        for sport, url in SPORT_URLS.items():
            games = await scrape_sport(page, sport, url)
            all_games.extend(games)

        await browser.close()

    print(f"\n총 {len(all_games)}경기 구매율 수집 완료")

    if not all_games:
        print("데이터 없음")
        return

    if SUPABASE_URL and SUPABASE_KEY:
        try:
            sb = _sb()
            for sport in SPORT_URLS:
                sb.table("public_betting").delete().eq("sport", sport).execute()
            sb.table("public_betting").insert(all_games).execute()
            print("Supabase 저장 완료!")
        except Exception as e:
            print(f"Supabase 저장 실패: {e}")
    else:
        print("[로컬] Supabase 미설정")


if __name__ == "__main__":
    asyncio.run(main())
