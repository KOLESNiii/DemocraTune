from __future__ import annotations

import unittest
from types import SimpleNamespace
from typing import Any

from app.vector_store import VectorStore, collection_name

SEED = "8a49dba0-253a-4535-b87f-78bb035336ce"
EXCLUDED = "45aeb154-20f8-4c2a-9ea4-b2a7fcfb719c"
CANDIDATE = "84760d82-7b99-4fa1-aeb7-88c5e9f9247b"


class FakeQdrantClient:
    def __init__(self) -> None:
        self.query: list[float] | None = None

    def collection_exists(self, _: str) -> bool:
        return True

    def retrieve(self, **_: Any) -> list[Any]:
        return [SimpleNamespace(vector=[1.0, 0.0])]

    def query_points(self, **kwargs: Any) -> Any:
        self.query = kwargs["query"]
        return SimpleNamespace(
            points=[
                SimpleNamespace(
                    id=SEED, score=1.0, payload={"mbid": SEED}
                ),
                SimpleNamespace(
                    id=EXCLUDED, score=0.9, payload={"mbid": EXCLUDED}
                ),
                SimpleNamespace(
                    id=CANDIDATE,
                    score=0.8,
                    payload={
                        "mbid": CANDIDATE,
                        "title": "Candidate",
                        "artist": "Artist",
                    },
                ),
            ]
        )


class VectorStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = VectorStore.__new__(VectorStore)
        self.client = FakeQdrantClient()
        self.store.client = self.client
        self.store.scalar_quantization = False

    def test_collection_name_is_stable_and_sanitized(self) -> None:
        first = collection_name("model/version 1")
        second = collection_name("model/version 1")
        self.assertEqual(first, second)
        self.assertRegex(first, r"^democratune-model-version-1-[0-9a-f]{8}$")

    def test_recommend_excludes_seeds_and_explicit_exclusions(self) -> None:
        results = self.store.recommend(
            seed_mbids=[SEED],
            excluded_mbids={EXCLUDED},
            pipeline_version="test-v1",
            limit=5,
        )

        self.assertEqual([result["recording_mbid"] for result in results], [CANDIDATE])
        self.assertEqual(results[0]["source"], "engine")
        self.assertEqual(self.client.query, [1.0, 0.0])


if __name__ == "__main__":
    unittest.main()
