from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from typing import Any

os.environ["APP_API_TOKEN"] = "test-app-token"
os.environ["WORKER_API_TOKEN"] = "test-worker-token"
os.environ["QDRANT_API_KEY"] = "test-qdrant-key"
os.environ["STATE_DB_PATH"] = "/tmp/democratune-import-only.sqlite3"

from fastapi.testclient import TestClient

from app import main
from app.database import JobDatabase

MBID = "8a49dba0-253a-4535-b87f-78bb035336ce"
OTHER_MBID = "45aeb154-20f8-4c2a-9ea4-b2a7fcfb719c"


class FakeVectorStore:
    def __init__(self) -> None:
        self.has_point_result = False
        self.has_point_error: Exception | None = None
        self.recommend_result: list[dict[str, Any]] = []
        self.recommend_error: Exception | None = None
        self.upsert_error: Exception | None = None
        self.upserts: list[dict[str, Any]] = []

    def has_point(self, **_: Any) -> bool:
        if self.has_point_error:
            raise self.has_point_error
        return self.has_point_result

    def recommend(self, **_: Any) -> list[dict[str, Any]]:
        if self.recommend_error:
            raise self.recommend_error
        return self.recommend_result

    def upsert(self, **kwargs: Any) -> None:
        if self.upsert_error:
            raise self.upsert_error
        self.upserts.append(kwargs)

    def ready(self) -> bool:
        return True


class FakeListenBrainz:
    def __init__(self) -> None:
        self.result: list[dict[str, Any]] = []
        self.error: Exception | None = None

    async def similar_recordings(self, **_: Any) -> list[dict[str, Any]]:
        if self.error:
            raise self.error
        return self.result


class RecommendationApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = JobDatabase(
            str(Path(self.temporary_directory.name) / "state.sqlite3")
        )
        self.vectors = FakeVectorStore()
        self.listenbrainz = FakeListenBrainz()
        self.original_jobs = main.jobs
        self.original_vectors = main.vectors
        self.original_listenbrainz = main.listenbrainz
        main.jobs = self.database
        main.vectors = self.vectors
        main.listenbrainz = self.listenbrainz
        self.client_context = TestClient(main.app, raise_server_exceptions=False)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        self.client_context.__exit__(None, None, None)
        main.jobs = self.original_jobs
        main.vectors = self.original_vectors
        main.listenbrainz = self.original_listenbrainz
        self.temporary_directory.cleanup()

    @staticmethod
    def app_headers() -> dict[str, str]:
        return {"Authorization": "Bearer test-app-token"}

    @staticmethod
    def worker_headers() -> dict[str, str]:
        return {"Authorization": "Bearer test-worker-token"}

    @staticmethod
    def enqueue_payload() -> dict[str, Any]:
        return {
            "mbid": MBID,
            "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "title": "Test",
            "artist": "Artist",
            "duration": 180,
            "pipeline_version": "test-v1",
        }

    def claim(self) -> dict[str, Any]:
        response = self.client.post(
            "/v1/jobs/claim",
            headers=self.worker_headers(),
            json={
                "worker_id": "worker-a",
                "pipeline_version": "test-v1",
                "lease_seconds": 60,
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["job"]

    def test_app_routes_require_the_app_token(self) -> None:
        missing = self.client.post("/v1/jobs", json=self.enqueue_payload())
        wrong_role = self.client.post(
            "/v1/jobs", headers=self.worker_headers(), json=self.enqueue_payload()
        )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong_role.status_code, 403)

    def test_enqueue_survives_qdrant_availability_failure(self) -> None:
        self.vectors.has_point_error = RuntimeError("qdrant offline")

        response = self.client.post(
            "/v1/jobs", headers=self.app_headers(), json=self.enqueue_payload()
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["created"])
        self.assertEqual(response.json()["job"]["status"], "pending")

    def test_qdrant_error_falls_through_to_listenbrainz(self) -> None:
        self.vectors.recommend_error = RuntimeError("qdrant offline")
        self.listenbrainz.result = [
            {
                "recording_mbid": OTHER_MBID,
                "score": 0.8,
                "title": "Recommended",
                "artist": "Someone",
                "source": "listenbrainz",
            }
        ]

        response = self.client.post(
            "/v1/recommendations",
            headers=self.app_headers(),
            json={"seed_mbids": [MBID]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["selected_source"], "listenbrainz")
        self.assertEqual(
            response.json()["attempted_sources"], ["engine", "listenbrainz"]
        )

    def test_all_external_errors_reach_playlist_fallback(self) -> None:
        self.vectors.recommend_error = RuntimeError("qdrant offline")
        self.listenbrainz.error = RuntimeError("listenbrainz offline")

        response = self.client.post(
            "/v1/recommendations",
            headers=self.app_headers(),
            json={"seed_mbids": [MBID]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["selected_source"], "fallback_playlist")
        self.assertEqual(response.json()["candidates"], [])

    def test_failed_vector_write_releases_completion_fence(self) -> None:
        enqueue = self.client.post(
            "/v1/jobs", headers=self.app_headers(), json=self.enqueue_payload()
        )
        self.assertEqual(enqueue.status_code, 200)
        claimed = self.claim()
        self.vectors.upsert_error = RuntimeError("write failed")

        response = self.client.post(
            f"/v1/jobs/{claimed['id']}/complete",
            headers=self.worker_headers(),
            json={
                "worker_id": "worker-a",
                "lease_token": claimed["lease_token"],
                "vector": [1.0, 0.0],
            },
        )

        self.assertEqual(response.status_code, 500)
        job = self.database.get(claimed["id"])
        assert job is not None
        self.assertEqual(job["status"], "leased")

    def test_successful_completion_writes_vector_and_finishes_job(self) -> None:
        enqueue = self.client.post(
            "/v1/jobs", headers=self.app_headers(), json=self.enqueue_payload()
        )
        self.assertEqual(enqueue.status_code, 200)
        claimed = self.claim()

        response = self.client.post(
            f"/v1/jobs/{claimed['id']}/complete",
            headers=self.worker_headers(),
            json={
                "worker_id": "worker-a",
                "lease_token": claimed["lease_token"],
                "vector": [3.0, 4.0],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["job"]["status"], "completed")
        self.assertEqual(self.vectors.upserts[0]["vector"], [0.6, 0.8])


if __name__ == "__main__":
    unittest.main()
