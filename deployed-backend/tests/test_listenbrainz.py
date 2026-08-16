from __future__ import annotations

import unittest
from unittest.mock import AsyncMock

from app.listenbrainz import ListenBrainzClient

SEED_OLD = "8a49dba0-253a-4535-b87f-78bb035336ce"
SEED_NEW = "45aeb154-20f8-4c2a-9ea4-b2a7fcfb719c"
CANDIDATE = "84760d82-7b99-4fa1-aeb7-88c5e9f9247b"


class ListenBrainzTests(unittest.IsolatedAsyncioTestCase):
    async def test_merges_seed_scores_and_ignores_failed_seed(self) -> None:
        client = ListenBrainzClient("test-algorithm")
        client._for_seed = AsyncMock(
            side_effect=[
                [
                    {
                        "recording_mbid": CANDIDATE,
                        "score": 50,
                        "recording_name": "Candidate",
                        "artist_credit_name": "Artist",
                    }
                ],
                RuntimeError("temporary failure"),
            ]
        )

        results = await client.similar_recordings(
            seed_mbids=[SEED_OLD, SEED_NEW],
            excluded_mbids=set(),
            limit=5,
        )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["recording_mbid"], CANDIDATE)
        self.assertEqual(results[0]["source"], "listenbrainz")

    async def test_excludes_seed_recordings(self) -> None:
        client = ListenBrainzClient("test-algorithm")
        client._for_seed = AsyncMock(
            return_value=[{"recording_mbid": SEED_OLD, "score": 1.0}]
        )

        results = await client.similar_recordings(
            seed_mbids=[SEED_OLD],
            excluded_mbids=set(),
            limit=5,
        )

        self.assertEqual(results, [])


if __name__ == "__main__":
    unittest.main()
