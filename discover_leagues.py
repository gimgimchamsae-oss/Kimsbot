"""
Pinnacle 축구 리그 ID 탐색기
python discover_leagues.py 로 실행
"""
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.pinnacle.com",
    "Referer": "https://www.pinnacle.com/",
    "X-API-Key": "CmX2KcMrXuFmNg6YFbmTxE0y9CfIa4uXrRnhpJJOdMQualIjHNMFTBLKiGLZgBYSdflCqxFMfHeM0bBlSqoHaQXW5eTUq0I0",
}

r = requests.get("https://guest.api.arcadia.pinnacle.com/0.1/sports/29/leagues?all=false", headers=HEADERS, timeout=15)
leagues = r.json()

keywords = ["korea", "k league", "australia", "a-league", "a league"]
print("=== 검색 결과 ===")
for lg in leagues:
    name = lg.get("name", "").lower()
    if any(k in name for k in keywords):
        print(f"ID: {lg['id']:>8}  |  {lg['name']}")

print("\n=== 전체 리그 (참고용) ===")
for lg in sorted(leagues, key=lambda x: x.get("name", "")):
    print(f"ID: {lg['id']:>8}  |  {lg['name']}")
