"""
Pinnacle 배당 수집 (requests 기반)
야구: MLB / KBO / NPB
축구: EPL / Bundesliga / Serie A / Ligue 1 / La Liga
농구: NBA / KBL
아이스하키: NHL
"""

import requests
from datetime import datetime, timezone, timedelta

BASE = "https://guest.api.arcadia.pinnacle.com/0.1"
KST  = timezone(timedelta(hours=9))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Origin": "https://www.pinnacle.com",
    "Referer": "https://www.pinnacle.com/",
    "X-API-Key": "CmX2KcMrXuFmNg6YFbmTxE0y9CfIa4uXrRnhpJJOdMQualIjHNMFTBLKiGLZgBYSdflCqxFMfHeM0bBlSqoHaQXW5eTUq0I0",
}

# sport: baseball=3, soccer=29
LEAGUES = {
    # 야구
    "246":    ("MLB",          "baseball"),
    "6227":   ("KBO",          "baseball"),
    "187703": ("NPB",          "baseball"),
    # 축구 - 국내/지역 리그
    "1980":   ("EPL",          "soccer"),
    "1842":   ("Bundesliga",   "soccer"),
    "2436":   ("Serie A",      "soccer"),
    "2036":   ("Ligue 1",      "soccer"),
    "2196":   ("La Liga",      "soccer"),
    "207551": ("K리그1",        "soccer"),
    "2663":   ("MLS",          "soccer"),
    # 축구 - UEFA 대회
    "2627":   ("UCL",          "soccer"),
    "2630":   ("Europa",       "soccer"),
    "214101": ("Conference",   "soccer"),
    # 농구
    "487":    ("NBA",          "basketball"),
    "3389":   ("KBL",          "basketball"),   # KBL ID — GitHub Actions 첫 실행 시 확인 필요
    # 아이스하키
    "1456":   ("NHL",          "hockey"),
}


def _get(path: str) -> list | dict:
    r = requests.get(f"{BASE}{path}", headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()


def to_decimal(american: int) -> float:
    if american >= 100:
        return round(american / 100 + 1, 4)
    return round(100 / abs(american) + 1, 4)


def fetch_games() -> list[dict]:
    games = []
    for lid, (lname, sport) in LEAGUES.items():
        try:
            matchups = _get(f"/leagues/{lid}/matchups")
            markets  = _get(f"/leagues/{lid}/markets/straight")
        except Exception as e:
            print(f"[{lname}] API 오류: {e}")
            continue

        mkt_idx: dict[int, dict] = {}
        for m in markets:
            if (m.get("period") == 0 and not m.get("isAlternate")
                    and m["type"] in ("moneyline", "spread", "total")):
                mkt_idx.setdefault(m["matchupId"], {})[m["type"]] = m

        for mu in matchups:
            if "participants" not in mu or mu.get("parentId"):
                continue
            home = next((p["name"] for p in mu["participants"] if p["alignment"] == "home"), "")
            away = next((p["name"] for p in mu["participants"] if p["alignment"] == "away"), "")
            if not home or not away:
                continue

            raw = mu.get("startTime") or (mu.get("periods") or [{}])[0].get("cutoffAt", "")
            try:
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(KST)
                starts_at = dt.strftime("%m/%d %H:%M KST")
            except Exception:
                starts_at = raw

            mkts = mkt_idx.get(mu["id"], {})

            def price(mkt, des):
                if not mkt:
                    return None
                p = next((x for x in mkt["prices"] if x.get("designation") == des), None)
                return to_decimal(p["price"]) if p else None

            def pts(mkt, des):
                if not mkt:
                    return None
                p = next((x for x in mkt["prices"] if x.get("designation") == des), None)
                v = p.get("points") if p else None
                return float(v) if v is not None else None

            ml  = mkts.get("moneyline")
            sp  = mkts.get("spread")
            tot = mkts.get("total")

            games.append({
                "matchup_id": mu["id"],
                "league":     lname,
                "sport":      sport,
                "home":       home,
                "away":       away,
                "starts_at":  starts_at,
                "ml_home":    price(ml,  "home"),
                "ml_away":    price(ml,  "away"),
                "ml_draw":    price(ml,  "draw"),   # 축구 무승부
                "sp_pts":     pts(sp,    "home"),
                "sp_home":    price(sp,  "home"),
                "sp_away":    price(sp,  "away"),
                "ou_pts":     pts(tot,   "over"),
                "ou_over":    price(tot, "over"),
                "ou_under":   price(tot, "under"),
            })

    return games


if __name__ == "__main__":
    games = fetch_games()
    print(f"수집 완료: {len(games)}경기 ({datetime.now(KST).strftime('%H:%M:%S KST')})\n")
    for g in sorted(games, key=lambda x: x["starts_at"]):
        draw = f" / 무 {g['ml_draw']}" if g.get("ml_draw") else ""
        print(f"[{g['league']}] {g['away']} @ {g['home']} ({g['starts_at']})")
        print(f"  ML: 원정 {g['ml_away']} / 홈 {g['ml_home']}{draw}")
        if g['sp_pts'] is not None:
            print(f"  핸디: {g['sp_pts']:+.1f}  원정 {g['sp_away']} / 홈 {g['sp_home']}")
        if g['ou_pts'] is not None:
            print(f"  O/U: {g['ou_pts']}  오버 {g['ou_over']} / 언더 {g['ou_under']}")
