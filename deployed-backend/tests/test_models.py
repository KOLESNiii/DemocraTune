from __future__ import annotations

import unittest

from pydantic import ValidationError

from app.models import CompleteJobRequest, EnqueueJobRequest, RecommendationRequest

MBID = "8a49dba0-253a-4535-b87f-78bb035336ce"


class RequestModelTests(unittest.TestCase):
    def test_vector_is_normalized(self) -> None:
        request = CompleteJobRequest(
            worker_id="worker",
            lease_token="lease",
            vector=[3.0, 4.0],
        )
        self.assertEqual(request.vector, [0.6, 0.8])

    def test_non_youtube_enqueue_url_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            EnqueueJobRequest(
                mbid=MBID,
                youtube_url="https://example.com/audio.mp3",
                title="Title",
                artist="Artist",
                duration=180,
            )

    def test_duplicate_recommendation_sources_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            RecommendationRequest(
                seed_mbids=[MBID],
                source_order=["engine", "engine"],
            )


if __name__ == "__main__":
    unittest.main()
