"""HTML 구조 파악용 디버그 스크래퍼"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        # 봇 감지 우회
        await page.set_extra_http_headers({
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        await page.goto("https://www.sportsbettingdime.com/mlb/public-betting-trends/",
                        wait_until="domcontentloaded", timeout=45000)
        # 테이블 또는 5초 대기
        try:
            await page.wait_for_selector("table", timeout=15000)
        except Exception:
            pass
        await page.wait_for_timeout(3000)

        tables = await page.query_selector_all("table")
        print(f"테이블 수: {len(tables)}")

        # 두 번째 테이블 구조 확인
        if len(tables) >= 2:
            html = await tables[1].inner_html()
            print("=== 두 번째 테이블 HTML (처음 4000자) ===")
            print(html[:4000])

        # bg-base-100 행 상세 확인
        rows = await page.query_selector_all("tr.bg-base-100")
        print(f"\n=== bg-base-100 행 수: {len(rows)} ===")
        for i, row in enumerate(rows[:6]):
            hidden = await row.get_attribute("class") or ""
            text = (await row.inner_text()).strip()
            print(f"row[{i}] class='{hidden}'")
            print(f"  text: {text[:200]}")
            print()

        await browser.close()

asyncio.run(main())
