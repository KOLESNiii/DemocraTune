from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any
from uuid import uuid4


class JobConflictError(RuntimeError):
    pass


class JobDatabase:
    def __init__(self, path: str) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def initialize(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS extraction_jobs (
                    id TEXT PRIMARY KEY,
                    mbid TEXT NOT NULL,
                    pipeline_version TEXT NOT NULL,
                    youtube_url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    duration INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 5,
                    available_at REAL NOT NULL,
                    lease_owner TEXT,
                    lease_token TEXT,
                    lease_expires_at REAL,
                    last_error TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE (mbid, pipeline_version)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS jobs_claimable
                ON extraction_jobs (
                    pipeline_version,
                    status,
                    available_at,
                    priority DESC,
                    created_at
                )
                """
            )
            # A committing job is exclusively owned by the API process while it
            # writes to Qdrant. If that process restarts, no old writer can still
            # be running, so the job is safe to retry. The worker will detect an
            # already-written point and use complete-existing when appropriate.
            connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'pending', available_at = ?, lease_owner = NULL,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error = 'coordinator restarted during completion',
                    updated_at = ?
                WHERE status = 'committing'
                """,
                (now, now),
            )

    @staticmethod
    def _as_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def enqueue(
        self,
        *,
        mbid: str,
        pipeline_version: str,
        youtube_url: str,
        title: str,
        artist: str,
        duration: int,
        priority: int,
    ) -> tuple[dict[str, Any], bool]:
        now = time.time()
        job_id = str(uuid4())
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO extraction_jobs (
                    id, mbid, pipeline_version, youtube_url, title, artist,
                    duration, status, priority, available_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                """,
                (
                    job_id,
                    mbid,
                    pipeline_version,
                    youtube_url,
                    title,
                    artist,
                    duration,
                    priority,
                    now,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                """
                SELECT * FROM extraction_jobs
                WHERE mbid = ? AND pipeline_version = ?
                """,
                (mbid, pipeline_version),
            ).fetchone()
            assert row is not None
            return dict(row), cursor.rowcount == 1

    def claim(
        self, *, worker_id: str, pipeline_version: str, lease_seconds: int
    ) -> dict[str, Any] | None:
        now = time.time()
        lease_token = str(uuid4())
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM extraction_jobs
                WHERE pipeline_version = ?
                  AND attempts < max_attempts
                  AND (
                    (status = 'pending' AND available_at <= ?)
                    OR (status = 'leased' AND lease_expires_at < ?)
                  )
                ORDER BY priority DESC, created_at ASC
                LIMIT 1
                """,
                (pipeline_version, now, now),
            ).fetchone()
            if row is None:
                connection.commit()
                return None

            connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'leased', attempts = attempts + 1,
                    lease_owner = ?, lease_token = ?, lease_expires_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (worker_id, lease_token, now + lease_seconds, now, row["id"]),
            )
            claimed = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (row["id"],)
            ).fetchone()
            connection.commit()
            return self._as_dict(claimed)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            return self._as_dict(
                connection.execute(
                    "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
                ).fetchone()
            )

    def heartbeat(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        lease_seconds: int,
    ) -> dict[str, Any]:
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE extraction_jobs
                SET lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND status = 'leased'
                  AND lease_owner = ? AND lease_token = ?
                  AND lease_expires_at >= ?
                """,
                (
                    now + lease_seconds,
                    now,
                    job_id,
                    worker_id,
                    lease_token,
                    now,
                ),
            )
            if cursor.rowcount != 1:
                raise JobConflictError("job lease is no longer owned by this worker")
            row = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            assert row is not None
            return dict(row)

    def complete(
        self, *, job_id: str, worker_id: str, lease_token: str
    ) -> dict[str, Any]:
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'completed', lease_owner = NULL,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error = NULL, updated_at = ?
                WHERE id = ? AND status = 'leased'
                  AND lease_owner = ? AND lease_token = ?
                  AND lease_expires_at >= ?
                """,
                (now, job_id, worker_id, lease_token, now),
            )
            if cursor.rowcount != 1:
                row = connection.execute(
                    "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
                ).fetchone()
                if row is not None and row["status"] == "completed":
                    return dict(row)
                raise JobConflictError("job lease is no longer owned by this worker")
            row = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            assert row is not None
            return dict(row)

    def begin_completion(
        self, *, job_id: str, worker_id: str, lease_token: str
    ) -> tuple[dict[str, Any], bool]:
        """Fence a Qdrant write so this lease cannot be reclaimed mid-upsert."""
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'committing', updated_at = ?
                WHERE id = ? AND status = 'leased'
                  AND lease_owner = ? AND lease_token = ?
                  AND lease_expires_at >= ?
                """,
                (now, job_id, worker_id, lease_token, now),
            )
            row = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if cursor.rowcount == 1:
                assert row is not None
                return dict(row), True
            if row is not None and row["status"] == "completed":
                return dict(row), False
            raise JobConflictError("job lease is expired or no longer owned")

    def finish_completion(
        self, *, job_id: str, worker_id: str, lease_token: str
    ) -> dict[str, Any]:
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'completed', lease_owner = NULL,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error = NULL, updated_at = ?
                WHERE id = ? AND status = 'committing'
                  AND lease_owner = ? AND lease_token = ?
                """,
                (now, job_id, worker_id, lease_token),
            )
            row = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if cursor.rowcount == 1:
                assert row is not None
                return dict(row)
            if row is not None and row["status"] == "completed":
                return dict(row)
            raise JobConflictError("job completion fence is no longer owned")

    def abort_completion(
        self, *, job_id: str, worker_id: str, lease_token: str
    ) -> None:
        """Return a failed external write to its lease for normal retry handling."""
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE extraction_jobs
                SET status = 'leased', updated_at = ?
                WHERE id = ? AND status = 'committing'
                  AND lease_owner = ? AND lease_token = ?
                """,
                (time.time(), job_id, worker_id, lease_token),
            )
            if cursor.rowcount != 1:
                raise JobConflictError("job completion fence is no longer owned")

    def fail(
        self,
        *,
        job_id: str,
        worker_id: str,
        lease_token: str,
        error: str,
        retryable: bool,
    ) -> dict[str, Any]:
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM extraction_jobs
                WHERE id = ? AND status = 'leased'
                  AND lease_owner = ? AND lease_token = ?
                  AND lease_expires_at >= ?
                """,
                (job_id, worker_id, lease_token, now),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise JobConflictError("job lease is no longer owned by this worker")

            should_retry = retryable and row["attempts"] < row["max_attempts"]
            status = "pending" if should_retry else "failed"
            backoff = min(3600, 30 * (2 ** max(0, row["attempts"] - 1)))
            available_at = now + backoff if should_retry else now
            connection.execute(
                """
                UPDATE extraction_jobs
                SET status = ?, available_at = ?, lease_owner = NULL,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, available_at, error, now, job_id),
            )
            updated = connection.execute(
                "SELECT * FROM extraction_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            connection.commit()
            assert updated is not None
            return dict(updated)
