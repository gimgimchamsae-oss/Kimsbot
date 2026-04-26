"""HTML 구조 파악용 디버그 스크래퍼 v3"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        await page.set_extra_http_headers({
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })

        print("페이지 로드 중...")
        await page.goto(
            "https://www.sportsbettingdime.com/mlb/public-betting-trends/",
            wait_until="domcontentloaded",
            timeout=60000
        )
        print("domcontentloaded 완료, 테이블 대기...")
        try:
            await page.wait_for_selector("table", timeout=20000)
        except Exception:
            print("테이블 타임아웃 — 계속 진행")
        await page.wait_for_timeout(2000)

        tables = await page.query_selector_all("table")
        print(f"테이블 수: {len(tables)}")

        # 두 번째 테이블 구조 확인
        if len(tables) >= 2:
            html = await tables[1].inner_html()
            print("=== 두 번째 테이블 (처음 4000자) ===")
            print(html[:4000])

        # bg-base-100 행 상세 확인
        rows = await page.query_selector_all("tr.bg-base-100")
        print(f"\n=== bg-base-100 행 수: {len(rows)} ===")
        for i, row in enumerate(rows[:4]):
            cls = await row.get_attribute("class") or ""
            text = (await row.inner_text()).strip()
            print(f"row[{i}] class='{cls}'")
            print(f"  text: {text[:300]}")
            print()

        await browser.close()

asyncio.run(main())
