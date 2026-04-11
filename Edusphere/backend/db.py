from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

try:
    import psycopg
    from psycopg.rows import dict_row
except ModuleNotFoundError:  # pragma: no cover - allows SQLite mode before pg deps are installed
    psycopg = None
    dict_row = None


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_DIR = BASE_DIR / "database"
DEFAULT_DB_PATH = DEFAULT_DB_DIR / "edusphere.db"
DB_PATH = Path(os.environ.get("DATABASE_PATH", DEFAULT_DB_PATH))
DB_DIR = DB_PATH.parent
SCHEMA_SQLITE_PATH = Path(__file__).resolve().parent / "schema.sql"
SCHEMA_POSTGRES_PATH = Path(__file__).resolve().parent / "schema_postgres.sql"
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")
IntegrityError = psycopg.IntegrityError if IS_POSTGRES and psycopg else sqlite3.IntegrityError

_INSERT_RE = re.compile(
    r"INSERT OR (REPLACE|IGNORE) INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\)\s*VALUES",
    re.IGNORECASE | re.DOTALL,
)

_CONFLICT_COLUMNS = {
    "users": ["id"],
    "faculty_profiles": ["user_id"],
    "student_profiles": ["user_id"],
    "courses": ["id"],
    "course_lectures": ["id"],
    "course_enrollments": ["course_id", "student_id"],
    "subjects": ["name"],
    "marks": ["student_id", "course_id"],
    "attendance_summary": ["student_id", "course_id"],
    "attendance_sessions": ["course_id", "session_date", "student_id"],
    "announcements": ["id"],
    "notifications": ["id"],
    "notification_reads": ["notification_id", "student_id"],
    "assignments": ["id"],
    "lecture_status": ["student_id", "course_id", "lecture_id"],
    "report_cards": ["id"],
    "report_card_entries": ["id"],
    "support_thread_reads": ["user_id", "student_id", "faculty_id"],
    "admin_faculty_thread_reads": ["user_id", "faculty_id"],
}


def _postgresify_query(query: str) -> str:
    sql = query.replace("?", "%s")
    match = _INSERT_RE.search(sql)
    if not match:
        return sql

    mode = match.group(1).upper()
    table = match.group(2)
    columns = [col.strip() for col in match.group(3).split(",") if col.strip()]
    conflict_cols = _CONFLICT_COLUMNS.get(table)
    if not conflict_cols:
        return sql.replace("INSERT OR IGNORE INTO", "INSERT INTO").replace("INSERT OR REPLACE INTO", "INSERT INTO")

    base_sql = sql.replace("INSERT OR IGNORE INTO", "INSERT INTO").replace("INSERT OR REPLACE INTO", "INSERT INTO")
    if mode == "IGNORE":
        return f"{base_sql} ON CONFLICT ({', '.join(conflict_cols)}) DO NOTHING"

    update_cols = [col for col in columns if col not in conflict_cols]
    if not update_cols:
        return f"{base_sql} ON CONFLICT ({', '.join(conflict_cols)}) DO NOTHING"

    assignments = ", ".join(f"{col} = EXCLUDED.{col}" for col in update_cols)
    return f"{base_sql} ON CONFLICT ({', '.join(conflict_cols)}) DO UPDATE SET {assignments}"


class CursorWrapper:
    def __init__(self, cursor):
        self._cursor = cursor

    @staticmethod
    def _wrap_row(row):
        if row is None:
            return None
        if isinstance(row, AppRow):
            return row
        return AppRow(dict(row))

    def fetchone(self):
        return self._wrap_row(self._cursor.fetchone())

    def fetchall(self):
        return [self._wrap_row(row) for row in self._cursor.fetchall()]

    @property
    def rowcount(self):
        return getattr(self._cursor, "rowcount", -1)


class ConnectionWrapper:
    def __init__(self, conn, *, is_postgres: bool):
        self._conn = conn
        self._is_postgres = is_postgres

    def execute(self, query: str, params=None):
        params = () if params is None else params
        sql = _postgresify_query(query) if self._is_postgres else query
        return CursorWrapper(self._conn.execute(sql, params))

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type:
                self._conn.rollback()
            else:
                self._conn.commit()
        finally:
            self._conn.close()
        return False


class AppRow(dict):
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def get_connection() -> ConnectionWrapper:
    if IS_POSTGRES:
        if psycopg is None:
            raise RuntimeError("psycopg is required when DATABASE_URL points to Postgres")
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        return ConnectionWrapper(conn, is_postgres=True)

    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return ConnectionWrapper(conn, is_postgres=False)


def init_db() -> None:
    schema_path = SCHEMA_POSTGRES_PATH if IS_POSTGRES else SCHEMA_SQLITE_PATH
    schema = schema_path.read_text(encoding="utf-8")
    with get_connection() as conn:
        if IS_POSTGRES:
            statements = [stmt.strip() for stmt in schema.split(";") if stmt.strip()]
            for statement in statements:
                conn.execute(statement)
        else:
            raw_conn = conn._conn
            raw_conn.executescript(schema)
