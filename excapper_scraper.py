"""
Excapper 축구 머니 데이터 → Supabase 푸시
- excapper_latest_matchodds_btts.csv 읽어서 리그/팀 매핑
- 지원 리그만 필터링 (EPL/EFL Championship/La Liga/Serie A/Bundesliga/Ligue 1/MLS/K리그1·2/J리그/A리그/UCL/Europa/Conference)
- € → ₩ 환산 (EUR_TO_KRW 환경변수, 기본 1500)
- Supabase excapper_betting 테이블에 sport='soccer' 행 갱신
"""

from __future__ import annotations

import csv
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

KST = timezone(timedelta(hours=9))
EUR_TO_KRW = float(os.environ.get("EUR_TO_KRW", "1500"))

# Excapper 리그명 → 앱 정규 리그명
LEAGUE_MAP = {
    "English Premier League": "EPL",
    "English Championship": "EFL Championship",
    "English EFL Championship": "EFL Championship",
    "English Sky Bet Championship": "EFL Championship",
    "Sky Bet Championship": "EFL Championship",
    "Italian Serie A": "Serie A",
    "Spanish La Liga": "La Liga",
    "Spanish Primera Division": "La Liga",
    "German Bundesliga": "Bundesliga",
    "French Ligue 1": "Ligue 1",
    "American Major League Soccer": "MLS",
    "Major League Soccer": "MLS",
    "MLS": "MLS",
    "US MLS": "MLS",
    "Korean K League 1": "K리그1",
    "Korean K League": "K리그1",
    "K League 1": "K리그1",
    "South Korean K1 League": "K리그1",
    "South Korean K League 1": "K리그1",
    "South Korean K1": "K리그1",
    "K1 League": "K리그1",
    "Korean K League 2": "K리그2",
    "K League 2": "K리그2",
    "South Korean K2 League": "K리그2",
    "South Korean K League 2": "K리그2",
    "K2 League": "K리그2",
    "Japanese J League": "J리그",
    "Japanese J1 League": "J리그",
    "J1 League": "J리그",
    "Japanese J. League": "J리그",
    "Japanese J. League 100 Year Vision": "J리그",
    "J. League": "J리그",
    "Japanese J2 League": "J리그2",
    "J2 League": "J리그2",
    "Japanese J. League 2": "J리그2",
    "Japanese J. League 2/3 100 Year Vision": "J리그2",
    "Japanese J3 League": "J리그3",
    "J3 League": "J리그3",
    "Australian A-League": "A리그",
    "A-League": "A리그",
    "Australian A-League Men": "A리그",
    "A-League Men": "A리그",
    "Dutch Eredivisie": "Eredivisie",
    "Netherlands Eredivisie": "Eredivisie",
    "Dutch Premier League": "Eredivisie",
    "Eredivisie": "Eredivisie",
    "Holland Eredivisie": "Eredivisie",
    "Netherlands - Eredivisie": "Eredivisie",
    "UEFA Champions League": "UCL",
    "UEFA Europa League": "Europa",
    "UEFA Conference League": "Conference",
    "UEFA Europa Conference League": "Conference",
}


def map_league(name: str) -> str | None:
    return LEAGUE_MAP.get((name or "").strip())


def _money_to_int(s: str) -> int:
    """'4231€' / '398431 €' / '1,234€' → 4231"""
    if not s:
        return 0
    s = s.replace(",", "").replace(" ", "")
    m = re.search(r"-?\d+", s)
    return int(m.group()) if m else 0


def _pct(s: str) -> int | None:
    """'74%' → 74, '-' → None"""
    if not s or s == "-":
        return None
    m = re.search(r"\d+", s)
    return int(m.group()) if m else None


def _odds(s: str) -> float | None:
    """'1.79' → 1.79, '' → None"""
    if not s or s.strip() in ("", "-"):
        return None
    try:
        return float(s.strip())
    except ValueError:
        return None


def parse_csv(csv_path: str | Path) -> list[dict]:
    """Excapper CSV → Supabase upsert용 dict 리스트."""
    games: dict[str, dict] = {}
    csv_path = Path(csv_path)
    if not csv_path.exists():
        print(f"[Excapper] CSV 파일 없음: {csv_path}")
        return []

    with csv_path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            game_id = (r.get("game_id") or "").strip()
            league = map_league(r.get("league") or "")
            if not league:
                continue
            teams = (r.get("game") or "").strip()
            if " - " not in teams:
                continue
            home, away = (t.strip() for t in teams.split(" - ", 1))

            if game_id not in games:
                total_money_eur = _money_to_int(r.get("all_money") or "")
                games[game_id] = {
                    "excapper_id": game_id,
                    "sport": "soccer",
                    "league": league,
                    "home": home,
                    "away": away,
                    "kickoff": (r.get("kickoff") or "").strip(),
                    "total_money": int(total_money_eur * EUR_TO_KRW),
                    "updated_at": datetime.now(KST).isoformat(),
                }

            mg = (r.get("market_group") or "").strip()

            if mg == "Match Odds":
                # market1=home, market2=DRAW, market3=away
                g = games[game_id]
                g["ml_bets_home"]   = _pct(r.get("market1_percent") or "")
                g["ml_bets_draw"]   = _pct(r.get("market2_percent") or "")
                g["ml_bets_away"]   = _pct(r.get("market3_percent") or "")
                g["ml_amount_home"] = int(_money_to_int(r.get("market1_summ") or "") * EUR_TO_KRW)
                g["ml_amount_draw"] = int(_money_to_int(r.get("market2_summ") or "") * EUR_TO_KRW)
                g["ml_amount_away"] = int(_money_to_int(r.get("market3_summ") or "") * EUR_TO_KRW)
                # PAYOUT 계산용 배당
                g["ml_odds_home"]   = _odds(r.get("market1_odds") or "")
                g["ml_odds_draw"]   = _odds(r.get("market2_odds") or "")
                g["ml_odds_away"]   = _odds(r.get("market3_odds") or "")
            elif mg in ("Both teams to Score?", "Both Teams to Score?"):
                # market1=No, market2=Yes
                g = games[game_id]
                g["btts_no_pct"]     = _pct(r.get("market1_percent") or "")
                g["btts_yes_pct"]    = _pct(r.get("market2_percent") or "")
                g["btts_no_amount"]  = int(_money_to_int(r.get("market1_summ") or "") * EUR_TO_KRW)
                g["btts_yes_amount"] = int(_money_to_int(r.get("market2_summ") or "") * EUR_TO_KRW)
                # PAYOUT 계산용 배당
                g["btts_no_odds"]    = _odds(r.get("market1_odds") or "")
                g["btts_yes_odds"]   = _odds(r.get("market2_odds") or "")

    return list(games.values())


def push_to_server(games: list[dict]) -> bool:
    """sharpsignal.cloud 서버의 /app/kimkimbot/excapper.json 으로 SFTP 업로드."""
    import json
    import tempfile
    host = os.environ.get("EXCAPPER_SSH_HOST", "sharpsignal.cloud")
    user = os.environ.get("EXCAPPER_SSH_USER", "root")
    pw   = os.environ.get("EXCAPPER_SSH_PASS")
    remote = os.environ.get("EXCAPPER_REMOTE_PATH", "/app/kimkimbot/excapper.json")
    if not pw:
        print("[Excapper] EXCAPPER_SSH_PASS 환경변수 없음 - SFTP 푸시 건너뜀")
        return False
    try:
        import paramiko  # type: ignore
    except ImportError:
        print("[Excapper] paramiko 미설치: pip install paramiko")
        return False
    try:
        # 임시 JSON 파일 작성
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tf:
            json.dump(games, tf, ensure_ascii=False)
            tmp_path = tf.name
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        __import__(io); import io as _io3
        if key_str:
            _pk = __import__(paramiko).Ed25519Key.from_private_key(_io3.StringIO(key_str))
            ssh.connect(hostname=host, port=22, username=user, pkey=_pk, timeout=20)
        else:
            ssh.connect(hostname=host, port=22, username=user, password=pw, timeout=20)
        sftp = ssh.open_sftp()
        sftp.put(tmp_path, remote)
        sftp.close()
        ssh.close()
        os.unlink(tmp_path)
        print(f"[Excapper] 서버 업로드 완료: {len(games)}건 → {host}:{remote}")
        return True
    except Exception as e:
        print(f"[Excapper] SFTP 푸시 실패: {e}")
        return False


def write_local_json(games: list[dict], out_path: str | Path = "/app/kimkimbot/excapper.json") -> bool:
    """서버 로컬 JSON 파일로 직접 쓰기 (서버에서 직접 실행될 때)."""
    import json
    out_path = Path(out_path)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # 원자적 교체: 임시 파일에 쓰고 rename
        tmp = out_path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(games, f, ensure_ascii=False)
        tmp.replace(out_path)
        print(f"[Excapper] 로컬 JSON 작성 완료: {len(games)}건 → {out_path}")
        return True
    except Exception as e:
        print(f"[Excapper] 로컬 JSON 작성 실패: {e}")
        return False


def fetch_and_push(csv_path: str | Path = "excapper_latest_matchodds_btts.csv") -> int:
    """CSV 파싱 + JSON 출력 (로컬 또는 SFTP)."""
    games = parse_csv(csv_path)
    print(f"[Excapper] 파싱: {len(games)}경기 (지원 리그만)")
    if not games:
        return 0
    # EXCAPPER_LOCAL_JSON 환경변수가 있으면 로컬 직접 쓰기 (서버에서 실행시)
    local_out = os.environ.get("EXCAPPER_LOCAL_JSON")
    if local_out:
        write_local_json(games, local_out)
    else:
        push_to_server(games)
    return len(games)


if __name__ == "__main__":
    csv_default = Path(__file__).resolve().parent / "excapper_latest_matchodds_btts.csv"
    csv_path = os.environ.get("EXCAPPER_CSV", str(csv_default))
    fetch_and_push(csv_path)
