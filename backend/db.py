"""SQLite: biblioteka obrazów, presety, ustawienia UI (kv). Jedno połączenie na wątek."""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from .config import DATA

DB_FILE = DATA / "library.db"
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS images(
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  rel_path TEXT NOT NULL,           -- względem library_dir
  prompt TEXT DEFAULT '', negative_prompt TEXT DEFAULT '',
  model_id TEXT, model_name TEXT, mode TEXT,
  seed INTEGER, steps INTEGER, cfg REAL, sampler TEXT, scheduler TEXT, denoise REAL,
  gen_seconds REAL,
  favorite INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, imported INTEGER DEFAULT 0,
  loras_json TEXT DEFAULT '[]', sources_json TEXT DEFAULT '[]',
  timings_json TEXT, request_json TEXT,
  search_text TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_flags ON images(hidden, favorite);
CREATE TABLE IF NOT EXISTS presets(id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, rel_path TEXT NOT NULL, name TEXT, width INTEGER, height INTEGER, created_at INTEGER);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        DATA.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_FILE, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.executescript(SCHEMA)
        _local.c = c
    return c


def kv_get(key: str, default: Any = None) -> Any:
    r = conn().execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(r["value"]) if r else default


def kv_set(key: str, value: Any) -> None:
    c = conn()
    c.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              (key, json.dumps(value, ensure_ascii=False)))
    c.commit()
