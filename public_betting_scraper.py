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


def _pct(text: str) -> int | None:
    """'65%' → 65"""
    try:
        return int(re.sub(r"[^\d]", "", text))
    except Exception:
        return None


async def scrape_sport(page, sport: str, url: str) -> list[dict]:
    print(f"[{sport.upper()}] 스크래핑 중... {url}")
    try:
        await page.goto(url, wait_until="networkidle", timeout=45000)
        # 테이블 로딩 대기
        await page.wait_for_selector("table", timeout=20000)
        await page.wait_for_timeout(2000)
    except Exception as e:
        print(f"[{sport.upper()}] 페이지 로드 실패: {e}")
        return []

    games = []
    try:
        rows = await page.query_selector_all("table tbody tr")
        print(f"[{sport.upper()}] 행 {len(rows)}개 발견")

        i = 0
        while i < len(rows) - 1:
            row_away = rows[i]
            row_home = rows[i + 1]

            # 팀명 추출
            away_el = await row_away.query_selector("td:first-child")
            home_el = await row_home.query_selector("td:first-child")
            if not away_el or not home_el:
                i += 1
                continue

            away = (await away_el.inner_text()).strip()
            home = (await home_el.inner_text()).strip()

            # 팀명 없으면 스킵
            if not away or not home or len(away) < 2 or len(home) < 2:
                i += 1
                continue

            # 셀 추출 (away row)
            away_cells = await row_away.query_selector_all("td")
            home_cells = await row_home.query_selector_all("td")

            async def cell_text(cells, idx):
                try:
                    return (await cells[idx].inner_text()).strip()
                except Exception:
                    return ""

            # 컬럼 순서: 팀명 | ML베팅% | ML핸들% | 스프레드베팅% | 스프레드핸들% | 토탈베팅% | 토탈핸들%
            game = {
                "sport":           sport,
                "away":            away,
                "home":            home,
                "ml_bets_away":    _pct(await cell_text(away_cells, 1)),
                "ml_handle_away":  _pct(await cell_text(away_cells, 2)),
                "sp_bets_away":    _pct(await cell_text(away_cells, 3)),
                "sp_handle_away":  _pct(await cell_text(away_cells, 4)),
                "ou_bets_over":    _pct(await cell_text(away_cells, 5)),
                "ou_handle_over":  _pct(await cell_text(away_cells, 6)),
                "ml_bets_home":    _pct(await cell_text(home_cells, 1)),
                "ml_handle_home":  _pct(await cell_text(home_cells, 2)),
                "sp_bets_home":    _pct(await cell_text(home_cells, 3)),
                "sp_handle_home":  _pct(await cell_text(home_cells, 4)),
                "ou_bets_under":   _pct(await cell_text(home_cells, 5)),
                "ou_handle_under": _pct(await cell_text(home_cells, 6)),
                "updated_at":      datetime.now(KST).isoformat(),
            }

            # 유효한 데이터인지 확인
            if game["ml_bets_away"] is not None or game["ml_bets_home"] is not None:
                games.append(game)
                print(f"  {away} vs {home}  ML베팅: 원정{game['ml_bets_away']}% / 홈{game['ml_bets_home']}%")

            i += 2  # 2줄씩 처리

    except Exception as e:
        print(f"[{sport.upper()}] 파싱 오류: {e}")

    return games


async def main():
    all_games = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )

        for sport, url in SPORT_URLS.items():
            games = await scrape_sport(page, sport, url)
            all_games.extend(games)

        await browser.close()

    print(f"\n총 {len(all_games)}경기 구매율 수집 완료")

    if not all_games:
        print("데이터 없음 — 종료")
        return

    if SUPABASE_URL and SUPABASE_KEY:
        try:
            sb = _sb()
            # 전체 교체 (upsert 대신 delete → insert)
            for sport in SPORT_URLS:
                sb.table("public_betting").delete().eq("sport", sport).execute()
            sb.table("public_betting").insert(all_games).execute()
            print("Supabase 저장 완료!")
        except Exception as e:
            print(f"Supabase 저장 실패: {e}")
    else:
        print("[로컬] Supabase 미설정 — 결과만 출력")
        for g in all_games:
            print(g)


if __name__ == "__main__":
    asyncio.run(main())
