from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.database import JobConflictError, JobDatabase


class JobDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = JobDatabase(
            str(Path(self.temporary_directory.name) / "state.sqlite3")
        )
        self.database.initialize()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def enqueue(self):
        return self.database.enqueue(
            mbid="8a49dba0-253a-4535-b87f-78bb035336ce",
            pipeline_version="test-v1",
            youtube_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title="Test",
            artist="Artist",
            duration=180,
            priority=0,
        )

    def test_enqueue_is_deduplicated_by_mbid_and_pipeline(self) -> None:
        first, first_created = self.enqueue()
        second, second_created = self.enqueue()

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first["id"], second["id"])

    def test_claim_and_complete_require_the_lease(self) -> None:
        self.enqueue()
        claimed = self.database.claim(
            worker_id="worker-a", pipeline_version="test-v1", lease_seconds=60
        )
        assert claimed is not None

        with self.assertRaises(JobConflictError):
            self.database.complete(
                job_id=claimed["id"],
                worker_id="worker-b",
                lease_token=claimed["lease_token"],
            )

        completed = self.database.complete(
            job_id=claimed["id"],
            worker_id="worker-a",
            lease_token=claimed["lease_token"],
        )
        self.assertEqual(completed["status"], "completed")

    def test_retryable_failure_returns_job_to_pending(self) -> None:
        self.enqueue()
        claimed = self.database.claim(
            worker_id="worker-a", pipeline_version="test-v1", lease_seconds=60
        )
        assert claimed is not None
        failed = self.database.fail(
            job_id=claimed["id"],
            worker_id="worker-a",
            lease_token=claimed["lease_token"],
            error="temporary",
            retryable=True,
        )
        self.assertEqual(failed["status"], "pending")
        self.assertIsNone(failed["lease_token"])


if __name__ == "__main__":
    unittest.main()
