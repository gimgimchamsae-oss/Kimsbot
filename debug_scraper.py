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

        # 테이블 HTML 출력
        tables = await page.query_selector_all("table")
        print(f"테이블 수: {len(tables)}")

        if tables:
            html = await tables[0].inner_html()
            print("=== 첫 번째 테이블 (처음 3000자) ===")
            print(html[:3000])

        # tr 클래스 확인
        rows = await page.query_selector_all("table tr")
        print(f"\n=== TR 행 수: {len(rows)} ===")
        for i, row in enumerate(rows[:10]):
            cls = await row.get_attribute("class") or ""
            cells = await row.query_selector_all("td")
            texts = []
            for c in cells[:3]:
                texts.append((await c.inner_text()).strip()[:30])
            print(f"row[{i}] class='{cls}' | {texts}")

        await browser.close()

asyncio.run(main())
