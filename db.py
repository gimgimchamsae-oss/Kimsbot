"""
DB 관리 - Supabase (운영) / SQLite (로컬 폴백)
"""

import os
import sqlite3
from contextlib import contextmanager

# Supabase 환경변수 있으면 Supabase 사용
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)

DB_PATH = "pinnacle_odds.db"


# ── Supabase 클라이언트 ───────────────────────────────────
def _sb():
    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── SQLite 폴백 ──────────────────────────────────────────
@contextmanager
def _sqlite():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    if USE_SUPABASE:
        return  # Supabase는 테이블 이미 생성됨
    with _sqlite() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            matchup_id INTEGER, league TEXT, sport TEXT DEFAULT 'baseball',
            home TEXT, away TEXT, starts_at TEXT,
            ts TEXT DEFAULT (datetime('now')),
            ml_home REAL, ml_away REAL, ml_draw REAL,
            sp_pts REAL, sp_home REAL, sp_away REAL,
            ou_pts REAL, ou_over REAL, ou_under REAL
        );
        CREATE TABLE IF NOT EXISTS opening_lines (
            matchup_id INTEGER PRIMARY KEY, league TEXT, sport TEXT DEFAULT 'baseball',
            home TEXT, away TEXT, starts_at TEXT, ts TEXT,
            ml_home REAL, ml_away REAL, ml_draw REAL,
            sp_pts REAL, sp_home REAL, sp_away REAL,
            ou_pts REAL, ou_over REAL, ou_under REAL
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            matchup_id INTEGER, alert_type TEXT, threshold TEXT,
            ts TEXT DEFAULT (datetime('now'))
        );
        """)
        for col, defn in [("ml_draw","REAL"), ("sport","TEXT NOT NULL DEFAULT 'baseball'")]:
            for tbl in ["snapshots", "opening_lines"]:
                try:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col} {defn}")
                except Exception:
                    pass


def _game_row(game: dict) -> dict:
    keys = ["matchup_id","league","sport","home","away","starts_at",
            "ml_home","ml_away","ml_draw",
            "sp_pts","sp_home","sp_away",
            "ou_pts","ou_over","ou_under"]
    return {k: game.get(k) for k in keys}


# ── 오프닝 저장 ──────────────────────────────────────────
def save_opening(game: dict):
    row = _game_row(game)
    if USE_SUPABASE:
        _sb().table("opening_lines").upsert(row, on_conflict="matchup_id", ignore_duplicates=True).execute()
    else:
        with _sqlite() as conn:
            cols = ", ".join(row.keys())
            vals = ", ".join(f":{k}" for k in row.keys())
            conn.execute(f"INSERT OR IGNORE INTO opening_lines ({cols}) VALUES ({vals})", row)


def get_opening(matchup_id: int):
    if USE_SUPABASE:
        res = _sb().table("opening_lines").select("*").eq("matchup_id", matchup_id).execute()
        return res.data[0] if res.data else None
    else:
        with _sqlite() as conn:
            row = conn.execute("SELECT * FROM opening_lines WHERE matchup_id=?", (matchup_id,)).fetchone()
            return dict(row) if row else None


# ── 스냅샷 저장 ──────────────────────────────────────────
def save_snapshot(game: dict):
    row = _game_row(game)
    if USE_SUPABASE:
        _sb().table("snapshots").insert(row).execute()
    else:
        with _sqlite() as conn:
            cols = ", ".join(row.keys())
            vals = ", ".join(f":{k}" for k in row.keys())
            conn.execute(f"INSERT INTO snapshots ({cols}) VALUES ({vals})", row)


def get_prev_snapshot(matchup_id: int):
    if USE_SUPABASE:
        res = _sb().table("snapshots").select("*").eq("matchup_id", matchup_id).order("id", desc=True).limit(1).execute()
        return res.data[0] if res.data else None
    else:
        with _sqlite() as conn:
            row = conn.execute(
                "SELECT * FROM snapshots WHERE matchup_id=? ORDER BY id DESC LIMIT 1", (matchup_id,)
            ).fetchone()
            return dict(row) if row else None


# ── 알림 이력 ────────────────────────────────────────────
def alert_sent(matchup_id: int, alert_type: str, threshold: str = None) -> bool:
    if USE_SUPABASE:
        q = _sb().table("alerts").select("id").eq("matchup_id", matchup_id).eq("alert_type", alert_type)
        if threshold is not None:
            q = q.eq("threshold", threshold)
        else:
            q = q.is_("threshold", "null")
        return len(q.execute().data) > 0
    else:
        with _sqlite() as conn:
            row = conn.execute(
                "SELECT 1 FROM alerts WHERE matchup_id=? AND alert_type=? AND (threshold=? OR (threshold IS NULL AND ? IS NULL))",
                (matchup_id, alert_type, threshold, threshold)
            ).fetchone()
            return row is not None


def save_alert(matchup_id: int, alert_type: str, threshold: str = None):
    row = {"matchup_id": matchup_id, "alert_type": alert_type, "threshold": threshold}
    if USE_SUPABASE:
        _sb().table("alerts").insert(row).execute()
    else:
        with _sqlite() as conn:
            conn.execute("INSERT INTO alerts (matchup_id, alert_type, threshold) VALUES (?,?,?)",
                         (matchup_id, alert_type, threshold))
