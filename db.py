"""
DB 관리 - Supabase (운영) / SQLite (로컬 폴백)
배치 쿼리로 API 호출 최소화 (127경기 → ~5회 호출)
"""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta

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
        return
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


# ════════════════════════════════════════════════════════
#  배치 조회 (API 호출 최소화)
# ════════════════════════════════════════════════════════

def get_all_openings_batch(matchup_ids: list) -> dict:
    """matchup_id 리스트 → {matchup_id: opening_row} 딕셔너리 (1회 쿼리)"""
    if not matchup_ids:
        return {}
    if USE_SUPABASE:
        res = _sb().table("opening_lines").select("*").in_("matchup_id", matchup_ids).execute()
        return {r["matchup_id"]: r for r in (res.data or [])}
    else:
        with _sqlite() as conn:
            ph = ",".join("?" * len(matchup_ids))
            rows = conn.execute(
                f"SELECT * FROM opening_lines WHERE matchup_id IN ({ph})", matchup_ids
            ).fetchall()
            return {r["matchup_id"]: dict(r) for r in rows}


def get_recent_snapshots_batch(matchup_ids: list, limit_per_game: int = 10) -> dict:
    """matchup_id 리스트 → {matchup_id: [snapshot, ...]} (최근 N개, 1회 쿼리)"""
    if not matchup_ids:
        return {}
    # 최근 limit_per_game*6분 창 (5분 간격 × limit × 여유)
    from_ts = (datetime.now(timezone.utc) - timedelta(minutes=limit_per_game * 6)).isoformat()
    if USE_SUPABASE:
        res = (_sb().table("snapshots")
               .select("*")
               .in_("matchup_id", matchup_ids)
               .gte("ts", from_ts)
               .order("id", desc=True)
               .limit(len(matchup_ids) * limit_per_game + 100)
               .execute())
        result: dict[int, list] = {}
        for r in (res.data or []):
            mid = r["matchup_id"]
            lst = result.setdefault(mid, [])
            if len(lst) < limit_per_game:
                lst.append(r)
        return result
    else:
        with _sqlite() as conn:
            ph = ",".join("?" * len(matchup_ids))
            rows = conn.execute(
                f"SELECT * FROM snapshots WHERE matchup_id IN ({ph})"
                f" AND ts >= ? ORDER BY id DESC LIMIT ?",
                matchup_ids + [from_ts[:19], len(matchup_ids) * limit_per_game + 100]
            ).fetchall()
            result: dict[int, list] = {}
            for row in rows:
                d = dict(row)
                mid = d["matchup_id"]
                lst = result.setdefault(mid, [])
                if len(lst) < limit_per_game:
                    lst.append(d)
            return result


def save_snapshots_batch(games: list):
    """스냅샷 전체 배치 INSERT (1회 쿼리)"""
    if not games:
        return
    rows = [_game_row(g) for g in games]
    if USE_SUPABASE:
        _sb().table("snapshots").insert(rows).execute()
    else:
        with _sqlite() as conn:
            for row in rows:
                cols = ", ".join(row.keys())
                vals = ", ".join(f":{k}" for k in row.keys())
                conn.execute(f"INSERT INTO snapshots ({cols}) VALUES ({vals})", row)


def save_openings_batch(games: list):
    """신규 오프닝 배치 UPSERT (1회 쿼리)"""
    if not games:
        return
    rows = [_game_row(g) for g in games]
    if USE_SUPABASE:
        _sb().table("opening_lines").upsert(
            rows, on_conflict="matchup_id", ignore_duplicates=True
        ).execute()
    else:
        with _sqlite() as conn:
            for row in rows:
                cols = ", ".join(row.keys())
                vals = ", ".join(f":{k}" for k in row.keys())
                conn.execute(f"INSERT OR IGNORE INTO opening_lines ({cols}) VALUES ({vals})", row)


def fill_opening_nulls_batch(games: list, existing_openings: dict):
    """
    기존 오프닝에 null 필드가 있을 때만 업데이트.
    already-fetched existing_openings 딕셔너리 활용 → 개별 SELECT 불필요.
    """
    FIELDS = ["ml_home","ml_away","ml_draw","sp_pts","sp_home","sp_away",
              "ou_pts","ou_over","ou_under"]
    if USE_SUPABASE:
        sb = _sb()
        for game in games:
            mid = game["matchup_id"]
            cur = existing_openings.get(mid)
            if not cur:
                continue
            # null 필드가 하나도 없으면 스킵
            if all(cur.get(k) is not None for k in FIELDS):
                continue
            row = _game_row(game)
            updates = {k: row[k] for k in FIELDS
                       if row.get(k) is not None and cur.get(k) is None}
            if updates:
                sb.table("opening_lines").update(updates).eq("matchup_id", mid).execute()
    else:
        with _sqlite() as conn:
            FIELDS_SQL = ["ml_home","ml_away","ml_draw","sp_pts","sp_home","sp_away",
                          "ou_pts","ou_over","ou_under"]
            for game in games:
                mid = game["matchup_id"]
                cur = existing_openings.get(mid)
                if not cur:
                    continue
                row = _game_row(game)
                updates = {k: row[k] for k in FIELDS_SQL
                           if row.get(k) is not None and cur.get(k) is None}
                if updates:
                    set_clause = ", ".join(f"{k}=:{k}" for k in updates)
                    updates["matchup_id"] = mid
                    conn.execute(
                        f"UPDATE opening_lines SET {set_clause} WHERE matchup_id=:matchup_id",
                        updates
                    )


# ════════════════════════════════════════════════════════
#  단건 조회 (하위 호환 유지 — 로컬 디버그용)
# ════════════════════════════════════════════════════════

def save_opening(game: dict):
    row = _game_row(game)
    if USE_SUPABASE:
        _sb().table("opening_lines").upsert(row, on_conflict="matchup_id", ignore_duplicates=True).execute()
    else:
        with _sqlite() as conn:
            cols = ", ".join(row.keys())
            vals = ", ".join(f":{k}" for k in row.keys())
            conn.execute(f"INSERT OR IGNORE INTO opening_lines ({cols}) VALUES ({vals})", row)


def fill_opening_nulls(game: dict):
    row = _game_row(game)
    mid = row["matchup_id"]
    fields = ["ml_home","ml_away","ml_draw","sp_pts","sp_home","sp_away","ou_pts","ou_over","ou_under"]
    if USE_SUPABASE:
        existing = _sb().table("opening_lines").select(",".join(fields)).eq("matchup_id", mid).execute()
        if not existing.data:
            return
        cur = existing.data[0]
        updates = {k: row[k] for k in fields if row.get(k) is not None and cur.get(k) is None}
        if updates:
            _sb().table("opening_lines").update(updates).eq("matchup_id", mid).execute()
    else:
        with _sqlite() as conn:
            cur = conn.execute("SELECT * FROM opening_lines WHERE matchup_id=?", (mid,)).fetchone()
            if not cur:
                return
            cur = dict(cur)
            updates = {k: row[k] for k in fields if row.get(k) is not None and cur.get(k) is None}
            if updates:
                set_clause = ", ".join(f"{k}=:{k}" for k in updates)
                updates["matchup_id"] = mid
                conn.execute(f"UPDATE opening_lines SET {set_clause} WHERE matchup_id=:matchup_id", updates)


def get_opening(matchup_id: int):
    if USE_SUPABASE:
        res = _sb().table("opening_lines").select("*").eq("matchup_id", matchup_id).execute()
        return res.data[0] if res.data else None
    else:
        with _sqlite() as conn:
            row = conn.execute("SELECT * FROM opening_lines WHERE matchup_id=?", (matchup_id,)).fetchone()
            return dict(row) if row else None


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
    rows = get_recent_snapshots(matchup_id, limit=1)
    return rows[0] if rows else None


def get_recent_snapshots(matchup_id: int, limit: int = 10) -> list:
    if USE_SUPABASE:
        res = _sb().table("snapshots").select("*").eq("matchup_id", matchup_id).order("id", desc=True).limit(limit).execute()
        return res.data or []
    else:
        with _sqlite() as conn:
            rows = conn.execute(
                "SELECT * FROM snapshots WHERE matchup_id=? ORDER BY id DESC LIMIT ?",
                (matchup_id, limit)
            ).fetchall()
            return [dict(r) for r in rows]


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
