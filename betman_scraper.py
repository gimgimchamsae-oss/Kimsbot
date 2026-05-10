#!/usr/bin/env python3
"""
betman.co.kr API → Supabase proto_betting 저장
cron 30분마다 실행: */30 * * * * cd /app/kimkimbot && ./venv/bin/python3 betman_scraper.py
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

API_URL      = "https://www.betman.co.kr/buyPsblGame/gameInfoInq.do"
BUYABLE_API  = "https://www.betman.co.kr/buyPsblGame/inqCacheBuyAbleGameInfoList.do"
BUYABLE_URL  = "https://www.betman.co.kr/main/mainPage/gamebuy/buyableGameList.do"
GAMESLIP_URL = "https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do"
HIDDEN_KEYWORDS = ("SUM", "전반", "승1패")

KST = timezone(timedelta(hours=9))


# ── betman API 호출 ──────────────────────────────────────────

def fetch_json(req, attempts=4):
    last_err = None
    for i in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            last_err = e
            if i < attempts:
                time.sleep(0.8 * i)
    raise last_err


def fetch_current_round():
    payload = json.dumps({"_sbmInfo": {"debugMode": "false"}}, ensure_ascii=False).encode()
    req = urllib.request.Request(
        BUYABLE_API, data=payload,
        headers={
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": BUYABLE_URL,
            "User-Agent": "Mozilla/5.0",
        }, method="POST",
    )
    data = fetch_json(req)
    for g in data.get("protoGames", []):
        if g.get("gmId") == "G101":
            return g["gmId"], g["gmTs"]
    # G101 없으면 None 반환 (판매 중인 회차 없음)
    return None, None


def fetch_game_info(gm_id, gm_ts):
    referer = f"{GAMESLIP_URL}?{urllib.parse.urlencode({'gmId': gm_id, 'gmTs': gm_ts})}"
    payload = json.dumps(
        {"gmId": gm_id, "gmTs": str(gm_ts), "gameYear": "", "_sbmInfo": {"debugMode": "false"}},
        ensure_ascii=False,
    ).encode()
    req = urllib.request.Request(
        API_URL, data=payload,
        headers={
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": referer,
            "User-Agent": "Mozilla/5.0",
        }, method="POST",
    )
    return fetch_json(req)


# ── 데이터 파싱 ──────────────────────────────────────────────

def pct(count, total):
    return round(count * 100 / total, 1) if total else 0.0


def format_date(ms):
    if not ms:
        return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(KST).strftime("%Y-%m-%d %H:%M")


def is_hidden(market):
    return any(k in market for k in HIDDEN_KEYWORDS)


def comp_rows(comp_schedules):
    keys = comp_schedules.get("keys", [])
    for row in comp_schedules.get("datas", []):
        yield dict(zip(keys, row))


def build_rows(data):
    votes = {int(v["GM_SEQ"]): v for v in data.get("voteStatus", [])}
    total_sell = int(data.get("currentLottery", {}).get("totalSellAmount", 0) or 0)
    raw_rows = []
    for sched in comp_rows(data.get("compSchedules", {})):
        market = sched.get("betNm") or sched.get("betTypNm") or ""
        if is_hidden(market):
            continue
        seq   = int(sched["matchSeq"])
        vote  = votes.get(seq, {})
        wc    = int(vote.get("W_BET_CNT", 0))
        dc    = int(vote.get("D_BET_CNT", 0))
        lc    = int(vote.get("L_BET_CNT", 0))
        total = wc + dc + lc
        raw_rows.append({
            "matchSeq": seq,
            "date":     format_date(sched.get("gameDate")),
            "itemCode": sched.get("itemCode") or "",
            "league":   sched.get("leagueShortName") or sched.get("leagueName") or "",
            "home":     sched.get("homeName") or "",
            "away":     sched.get("awayName") or "",
            "market":   market,
            "base":     sched.get("winHandi") or sched.get("loseHandi") or "",
            "winTxt":   sched.get("winTxt") or "",
            "winCount": wc,   "winPct": pct(wc, total),
            "drawTxt":  sched.get("drawTxt") or "",
            "drawCount": dc,  "drawPct": pct(dc, total),
            "loseTxt":  sched.get("loseTxt") or "",
            "loseCount": lc,  "losePct": pct(lc, total),
            "totalCount": total,
            "totalSell": total_sell,
        })
    return raw_rows


# ── proto_betting 포맷으로 변환 ──────────────────────────────

ITEM_TO_SPORT = {"BS": "baseball", "BK": "basketball", "SC": "soccer"}


def sport_from(row):
    return ITEM_TO_SPORT.get(row.get("itemCode", ""))


def assign(target, field, val, count=None):
    if val is None:
        return
    target[field] = val
    if count is not None:
        target[f"{field}_count"] = count


def apply_market(target, row):
    market   = row.get("market", "")
    win_pct  = row["winPct"]
    draw_pct = row["drawPct"]
    lose_pct = row["losePct"]
    win_txt  = row.get("winTxt", "")
    lose_txt = row.get("loseTxt", "")

    if "언더오버" in market or "언더/오버" in market:
        if "언더" in win_txt:
            assign(target, "ou_bets_under", win_pct,  row["winCount"])
        if "오버" in win_txt:
            assign(target, "ou_bets_over",  win_pct,  row["winCount"])
        if "언더" in lose_txt:
            assign(target, "ou_bets_under", lose_pct, row["loseCount"])
        if "오버" in lose_txt:
            assign(target, "ou_bets_over",  lose_pct, row["loseCount"])
        target["ou_base"] = row.get("base", "")
        return

    if "핸디" in market:
        assign(target, "sp_bets_home", win_pct,  row["winCount"])
        assign(target, "sp_bets_draw", draw_pct, row["drawCount"])
        assign(target, "sp_bets_away", lose_pct, row["loseCount"])
        target["sp_base"] = row.get("base", "")
        return

    if "승무패" in market or "승패" in market:
        assign(target, "ml_bets_home", win_pct,  row["winCount"])
        if row.get("drawTxt") and row["drawTxt"] != "-":
            assign(target, "ml_bets_draw", draw_pct, row["drawCount"])
        assign(target, "ml_bets_away", lose_pct, row["loseCount"])


def rows_to_proto(raw_rows):
    grouped = {}
    for row in raw_rows:
        sport     = sport_from(row)
        game_date = (row.get("date") or "")[:10]
        if not sport or not game_date:
            continue
        key = f"{sport}|{row['league']}|{row['home']}|{row['away']}|{game_date}"
        if key not in grouped:
            grouped[key] = {
                "sport":      sport,
                "league":     row["league"],
                "home":       row["home"],
                "away":       row["away"],
                "home_abbr":  row["home"],
                "away_abbr":  row["away"],
                "game_date":  game_date,
                "source":     "betman",
                "updated_at": datetime.now(tz=KST).isoformat(),
            }
        apply_market(grouped[key], row)
    return list(grouped.values())


# ── Supabase 저장 ────────────────────────────────────────────

def supabase_request(method, path, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body, ensure_ascii=False).encode() if body else None
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"Supabase {method} {path}: {e.code} {body_text}")


def save_to_supabase(proto_rows):
    if not proto_rows:
        print("[betman] 저장할 데이터 없음")
        return

    # 기존 데이터 전체 삭제 후 새로 삽입 (betman이 유일한 소스)
    supabase_request(
        "DELETE",
        'proto_betting?game_date=gte.2000-01-01',
    )

    # source 필드 제거 (테이블에 컬럼 없음)
    clean_rows = [{k: v for k, v in row.items() if k != 'source'} for row in proto_rows]

    # 배치 삽입 (100개씩)
    batch_size = 100
    total = 0
    for i in range(0, len(clean_rows), batch_size):
        batch = clean_rows[i:i + batch_size]
        supabase_request("POST", "proto_betting", batch)
        total += len(batch)

    print(f"[betman] Supabase proto_betting 저장 완료: {total}건")


# ── 메인 ─────────────────────────────────────────────────────

def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY 환경변수가 없습니다.")

    print(f"[betman] 시작: {datetime.now(tz=KST).strftime('%Y-%m-%d %H:%M:%S')}")

    gm_id, gm_ts = fetch_current_round()
    if gm_id is None:
        print("[betman] G101 no active round - exit")
        return
    print(f"[betman] 회차: {gm_id} / {gm_ts}")

    data     = fetch_game_info(gm_id, gm_ts)
    raw_rows = build_rows(data)
    print(f"[betman] 원본 행: {len(raw_rows)}개")

    proto_rows = rows_to_proto(raw_rows)
    print(f"[betman] 변환 후: {len(proto_rows)}개 경기")

    save_to_supabase(proto_rows)
    print("[betman] 완료")


if __name__ == "__main__":
    main()
