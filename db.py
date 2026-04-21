"""
SQLite DB 관리 - 배당 스냅샷 및 알림 이력
"""

import sqlite3
from contextlib import contextmanager

DB_PATH = "pinnacle_odds.db"


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            matchup_id  INTEGER NOT NULL,
            league      TEXT NOT NULL,
            home        TEXT NOT NULL,
            away        TEXT NOT NULL,
            starts_at   TEXT NOT NULL,
            ts          TEXT NOT NULL DEFAULT (datetime('now')),
            ml_home     REAL,
            ml_away     REAL,
            sp_pts      REAL,
            sp_home     REAL,
            sp_away     REAL,
            ou_pts      REAL,
            ou_over     REAL,
            ou_under    REAL
        );

        CREATE TABLE IF NOT EXISTS opening_lines (
            matchup_id  INTEGER PRIMARY KEY,
            league      TEXT NOT NULL,
            home        TEXT NOT NULL,
            away        TEXT NOT NULL,
            starts_at   TEXT NOT NULL,
            ts          TEXT NOT NULL,
            ml_home     REAL,
            ml_away     REAL,
            sp_pts      REAL,
            sp_home     REAL,
            sp_away     REAL,
            ou_pts      REAL,
            ou_over     REAL,
            ou_under    REAL
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            matchup_id  INTEGER NOT NULL,
            alert_type  TEXT NOT NULL,
            threshold   TEXT,
            ts          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """)


def save_snapshot(game: dict):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO snapshots
                (matchup_id, league, home, away, starts_at,
                 ml_home, ml_away,
                 sp_pts, sp_home, sp_away,
                 ou_pts, ou_over, ou_under)
            VALUES
                (:matchup_id, :league, :home, :away, :starts_at,
                 :ml_home, :ml_away,
                 :sp_pts, :sp_home, :sp_away,
                 :ou_pts, :ou_over, :ou_under)
        """, game)


def get_opening(matchup_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM opening_lines WHERE matchup_id = ?", (matchup_id,)
        ).fetchone()
        return dict(row) if row else None


def save_opening(game: dict):
    with get_conn() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO opening_lines
                (matchup_id, league, home, away, starts_at, ts,
                 ml_home, ml_away,
                 sp_pts, sp_home, sp_away,
                 ou_pts, ou_over, ou_under)
            VALUES
                (:matchup_id, :league, :home, :away, :starts_at, datetime('now'),
                 :ml_home, :ml_away,
                 :sp_pts, :sp_home, :sp_away,
                 :ou_pts, :ou_over, :ou_under)
        """, game)


def get_prev_snapshot(matchup_id: int):
    with get_conn() as conn:
        row = conn.execute("""
            SELECT * FROM snapshots
            WHERE matchup_id = ?
            ORDER BY id DESC LIMIT 1
        """, (matchup_id,)).fetchone()
        return dict(row) if row else None


def alert_sent(matchup_id: int, alert_type: str, threshold: str = None) -> bool:
    with get_conn() as conn:
        row = conn.execute("""
            SELECT 1 FROM alerts
            WHERE matchup_id = ? AND alert_type = ? AND (threshold = ? OR (threshold IS NULL AND ? IS NULL))
        """, (matchup_id, alert_type, threshold, threshold)).fetchone()
        return row is not None


def save_alert(matchup_id: int, alert_type: str, threshold: str = None):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO alerts (matchup_id, alert_type, threshold)
            VALUES (?, ?, ?)
        """, (matchup_id, alert_type, threshold))
