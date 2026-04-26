"""
sportsbettingdime.com 공개 구매율 스크래퍼 (Playwright)
MLB / NBA / NHL 지원
구조: th=팀명, td[0]=odds, td[1]=BET%, td[2]=Handle%, td[3]=spread, td[4]=BET%, td[5]=Handle%, td[6]=total, td[7]=BET%, td[8]=Handle%
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


async def get_team_and_cells(row):
    """팀명(th) + 데이터셀(td) 반환"""
    th = await row.query_selector("th")
    team = (await th.inner_text()).strip() if th else ""
    cells = await row.query_selector_all("td")
    texts = [(await c.inner_text()).strip() for c in cells]
    return team, texts


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

    # 두 번째 테이블에서 class 없는 행만 추출
    all_rows = await tables[1].query_selector_all("tr")
    data_rows = []
    for row in all_rows:
        cls = (await row.get_attribute("class") or "").strip()
        if cls == "":
            data_rows.append(row)

    games = []
    i = 0
    while i < len(data_rows):
        text = (await data_rows[i].inner_text()).strip()

        # 날짜 행 (UTC / GMT 포함)
        if "UTC" in text or "GMT" in text:
            if i + 2 < len(data_rows):
                away, away_cells = await get_team_and_cells(data_rows[i + 1])
                home, home_cells = await get_team_and_cells(data_rows[i + 2])

                if (len(away_cells) >= 3 and len(home_cells) >= 3
                        and away and home
                        and "Report" not in away and "Report" not in home
                        and "UTC" not in away and "UTC" not in home):

                    # td[0]=odds, td[1]=BET%, td[2]=Handle%
                    # td[3]=spread, td[4]=BET%, td[5]=Handle%
                    # td[6]=total, td[7]=BET%, td[8]=Handle%
                    game = {
                        "sport":           sport,
                        "away":            away,
                        "home":            home,
                        # td[1]=mobile ML BET%, td[2]=mobile ML Handle% (same values as desktop)
                        "ml_bets_away":    _pct(away_cells[1]) if len(away_cells) > 1 else None,
                        "ml_handle_away":  _pct(away_cells[2]) if len(away_cells) > 2 else None,
                        "ml_bets_home":    _pct(home_cells[1]) if len(home_cells) > 1 else None,
                        "ml_handle_home":  _pct(home_cells[2]) if len(home_cells) > 2 else None,
                        # td[7]=SP BET%, td[8]=SP Handle% (desktop: 0-2 mobile, 3-5 desktop ML, 6-8 spread)
                        "sp_bets_away":    _pct(away_cells[7]) if len(away_cells) > 7 else None,
                        "sp_handle_away":  _pct(away_cells[8]) if len(away_cells) > 8 else None,
                        "sp_bets_home":    _pct(home_cells[7]) if len(home_cells) > 7 else None,
                        "sp_handle_home":  _pct(home_cells[8]) if len(home_cells) > 8 else None,
                        # td[10]=OU BET%, td[11]=OU Handle% (9-11 total)
                        "ou_bets_over":    _pct(away_cells[10]) if len(away_cells) > 10 else None,
                        "ou_handle_over":  _pct(away_cells[11]) if len(away_cells) > 11 else None,
                        "ou_bets_under":   _pct(home_cells[10]) if len(home_cells) > 10 else None,
                        "ou_handle_under": _pct(home_cells[11]) if len(home_cells) > 11 else None,
                        "updated_at":      datetime.now(KST).isoformat(),
                    }
                    games.append(game)
                    print(f"  {away} vs {home} | ML베팅 원정{game['ml_bets_away']}% 홈{game['ml_bets_home']}%")
                    i += 3
                    continue
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
