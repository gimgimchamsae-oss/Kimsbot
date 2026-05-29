#!/usr/bin/env python3
"""
GitHub Actions에서 실행되는 베트맨 API 수집기.

1) inqCacheBuyAbleGameInfoList.do  → 현재 G101 회차 gmTs 조회
2) gameInfoInq.do                  → 경기/배당/구매율/배당변동 raw JSON
3) inqWinrstDetlBody.do            → 최근 마감 경기 결과 raw JSON (현재 + 과거 5회차)
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
        print(f"[warn] result fetch failed for gmTs={gm_ts}: {e}", file=sys.stderr)
        return "{}"


def upload_files(files):
    """files = [(remote_path, content_str), ...]"""
    transport = paramiko.Transport((SSH_HOST, 22))
    import io as _io
    _pk = paramiko.Ed25519Key.from_private_key(_io.StringIO(SSH_KEY))
    transport.connect(username=SSH_USER, pkey=_pk)
    sftp = paramiko.SFTPClient.from_transport(transport)
    for path, content in files:
        with sftp.open(path, "w") as f:
            f.write(content)
    sftp.close()
    transport.close()


def ssh_exec(cmd, timeout=120):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    import io as _io
    _pk = paramiko.Ed25519Key.from_private_key(_io.StringIO(SSH_KEY))
    client.connect(SSH_HOST, username=SSH_USER, pkey=_pk, timeout=20)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    client.close()
    return out, err


def main():
    t0 = time.time()
    gm_ts = current_gm_ts()
    if not gm_ts:
        print("[info] no active G101 round; exit")
        return
    print(f"[info] gmTs={gm_ts}")

    game_json = fetch_game(gm_ts)
    print(f"[info] gameInfoInq size={len(game_json)}")
    result_json = fetch_result(gm_ts)
    print(f"[info] winrst size={len(result_json)}")

    game_path = f"{REMOTE_DIR}/betman_game_{gm_ts}.json"
    result_path = f"{REMOTE_DIR}/betman_result_{gm_ts}.json"

    # 과거 5회차 결과 fetch (외국축구 등 회차 넘긴 후 결과 나오는 경기 대응)
    past_results = []
    for offset in range(1, 6):
        past_ts = gm_ts - offset
        r_json = fetch_result(past_ts)
        if len(r_json) > 100:  # 빈 결과 ({}) 스킵
            past_results.append((past_ts, f"{REMOTE_DIR}/betman_result_{past_ts}.json", r_json))
            print(f"[info] past gmTs={past_ts} winrst size={len(r_json)}")

    # 모든 파일 한 번에 SFTP 업로드
    files = [(game_path, game_json), (result_path, result_json)]
    files.extend([(p, c) for _, p, c in past_results])
    upload_files(files)
    print(f"[info] uploaded {len(files)} files")

    # 현재 회차: 게임 + 결과 처리
    cmd = (
        f"cd /app/kimkimbot && "
        f"./venv/bin/python3 betman_cache.py --from-file {game_path} --gm-ts {gm_ts} && "
        f"./venv/bin/python3 betman_results.py --from-file {result_path} --gm-ts {gm_ts} || true"
    )
    out, err = ssh_exec(cmd)
    print(f"[current] {out}")
    if err.strip():
        print(f"[current stderr] {err}", file=sys.stderr)

    # 과거 회차: 결과만 처리
    for past_ts, r_path, _ in past_results:
        cmd2 = f"cd /app/kimkimbot && ./venv/bin/python3 betman_results.py --from-file {r_path} --gm-ts {past_ts} || true"
        out2, err2 = ssh_exec(cmd2)
        print(f"[past {past_ts}] {out2}")
        if err2.strip():
            print(f"[past {past_ts} stderr] {err2}", file=sys.stderr)

    print(f"[done] total {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
