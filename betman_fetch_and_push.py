#!/usr/bin/env python3
"""
GitHub Actions에서 실행되는 베트맨 API 수집기.

1) inqCacheBuyAbleGameInfoList.do  → 현재 G101 회차 gmTs 조회
2) gameInfoInq.do                  → 경기/배당/구매율/배당변동 raw JSON
3) inqWinrstDetlBody.do            → 최근 마감 경기 결과 raw JSON
4) SFTP로 sharpsignal.cloud:/tmp/  업로드
5) ssh exec: betman_cache.py --from-file ... 트리거 (DB 적재 + 픽 채점)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import paramiko

BUYABLE_API = "https://www.betman.co.kr/buyPsblGame/inqCacheBuyAbleGameInfoList.do"
BUYABLE_URL = "https://www.betman.co.kr/main/mainPage/gamebuy/buyableGameList.do"
GAME_API    = "https://www.betman.co.kr/buyPsblGame/gameInfoInq.do"
GAMESLIP    = "https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do"
RESULT_API  = "https://www.betman.co.kr/gamebuy/winrst/inqWinrstDetlBody.do"
RESULT_URL  = "https://www.betman.co.kr/main/mainPage/gamebuy/winrstDetl.do"

HEADERS = {
    "Content-Type": "application/json; charset=UTF-8",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
}

SSH_HOST = os.environ["SSH_HOST"]
SSH_USER = os.environ["SSH_USER"]
SSH_KEY = os.environ["SSH_KEY"]
REMOTE_DIR = "/tmp"


def fetch_json(url, payload, referer, attempts=4):
    body = json.dumps(payload).encode("utf-8")
    hdr = dict(HEADERS)
    hdr["Referer"] = referer
    last_err = None
    for i in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=hdr, method="POST")
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            last_err = e
            time.sleep(1.5 * i)
    raise RuntimeError(f"fetch failed: {url} :: {last_err}")


def current_gm_ts():
    raw = fetch_json(BUYABLE_API, {"_sbmInfo": {"debugMode": "false"}}, referer=BUYABLE_URL)
    obj = json.loads(raw)
    for g in obj.get("protoGames", []) or []:
        if g.get("gmId") == "G101" and g.get("gmTs"):
            return int(g["gmTs"])
    return None


def fetch_game(gm_ts):
    referer = f"{GAMESLIP}?gmId=G101&gmTs={gm_ts}"
    return fetch_json(
        GAME_API,
        {"gmId": "G101", "gmTs": str(gm_ts), "gameYear": "", "_sbmInfo": {"debugMode": "false"}},
        referer=referer,
    )


def fetch_result(gm_ts):
    """마감 결과 (최근 회차 — 동일 gmTs로 시도하되 비면 빈 dict 반환)"""
    referer = f"{RESULT_URL}?gmId=G101&gmTs={gm_ts}"
    try:
        return fetch_json(
            RESULT_API,
            {"gmId": "G101", "gmTs": str(gm_ts), "_sbmInfo": {"debugMode": "false"}},
            referer=referer,
        )
    except Exception as e:
        print(f"[warn] result fetch failed: {e}", file=sys.stderr)
        return "{}"


def main():
    t0 = time.time()
    gm_ts = current_gm_ts()
    if not gm_ts:
        # 회차 없음 (회차 사이 공백기) — 종료
        print("[info] no active G101 round; exit")
        return
    print(f"[info] gmTs={gm_ts}")

    game_json = fetch_game(gm_ts)
    print(f"[info] gameInfoInq size={len(game_json)}")

    # 결과는 진행 중 회차에서도 일부 마감된 경기 있을 수 있음
    result_json = fetch_result(gm_ts)
    print(f"[info] winrst size={len(result_json)}")

    # SFTP 업로드
    transport = paramiko.Transport((SSH_HOST, 22))
    import io as _io; _pk = paramiko.Ed25519Key.from_private_key(_io.StringIO(SSH_KEY))
    transport.connect(username=SSH_USER, pkey=_pk)
    sftp = paramiko.SFTPClient.from_transport(transport)

    game_path = f"{REMOTE_DIR}/betman_game_{gm_ts}.json"
    result_path = f"{REMOTE_DIR}/betman_result_{gm_ts}.json"

    with sftp.open(game_path, "w") as f:
        f.write(game_json)
    with sftp.open(result_path, "w") as f:
        f.write(result_json)
    sftp.close()
    print(f"[info] uploaded {game_path}, {result_path}")

    # ssh exec — betman_cache.py 실행 + betman_results.py 실행
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    import io as _io2; _pk2 = paramiko.Ed25519Key.from_private_key(_io2.StringIO(SSH_KEY))
    client.connect(SSH_HOST, username=SSH_USER, pkey=_pk2, timeout=20)
    cmd = (
        f"cd /app/kimkimbot && "
        f"./venv/bin/python3 betman_cache.py --from-file {game_path} --gm-ts {gm_ts} && "
        f"./venv/bin/python3 betman_results.py --from-file {result_path} --gm-ts {gm_ts} || true"
    )
    stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(f"[remote stdout]\n{out}")
    if err.strip():
        print(f"[remote stderr]\n{err}", file=sys.stderr)
    client.close()
    transport.close()
    # ── 추가: 과거 5회차 결과도 fetch + 정산 ──
    # 외국축구 등 회차 넘긴 후 결과 나오는 경기 대응
    past_results = []
    for offset in range(1, 6):
        past_ts = gm_ts - offset
        try:
            r_json = fetch_result(past_ts)
            if len(r_json) > 100:  # 빈 결과 ({}) 스킵
                r_path = f"{REMOTE_DIR}/betman_result_{past_ts}.json"
                past_results.append((past_ts, r_path, r_json))
                print(f"[info] past gmTs={past_ts} winrst size={len(r_json)}")
        except Exception as e:
            print(f"[warn] past gmTs={past_ts} skip: {e}", file=sys.stderr)

    if past_results:
        # SFTP 재업로드 (transport 재사용)
        transport2 = paramiko.Transport((SSH_HOST, 22))
        import io as _io3; _pk3 = paramiko.Ed25519Key.from_private_key(_io3.StringIO(SSH_KEY))
        transport2.connect(username=SSH_USER, pkey=_pk3)
        sftp2 = paramiko.SFTPClient.from_transport(transport2)
        for past_ts, r_path, r_json in past_results:
            with sftp2.open(r_path, "w") as f:
                f.write(r_json)
        sftp2.close(); transport2.close()

        # SSH로 각 회차 betman_results.py 실행
        client2 = paramiko.SSHClient()
        client2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        import io as _io4; _pk4 = paramiko.Ed25519Key.from_private_key(_io4.StringIO(SSH_KEY))
        client2.connect(SSH_HOST, username=SSH_USER, pkey=_pk4, timeout=20)
        for past_ts, r_path, _ in past_results:
            cmd2 = f"cd /app/kimkimbot && ./venv/bin/python3 betman_results.py --from-file {r_path} --gm-ts {past_ts} || true"
            _, out2, err2 = client2.exec_command(cmd2, timeout=60)
            print(f"[past {past_ts}]
{out2.read().decode('utf-8','replace')}")
            e2 = err2.read().decode('utf-8','replace')
            if e2.strip():
                print(f"[past {past_ts} stderr]
{e2}", file=sys.stderr)
        client2.close()

    print(f"[done] total {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
