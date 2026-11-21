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

    def test_recommend_weights_later_seeds_more_in_any_retrieve_order(self) -> None:
        older = "11111111-1111-4111-8111-111111111111"
        newer = "22222222-2222-4222-8222-222222222222"
        # Qdrant hands the points back in the opposite order to the request.
        self.client.retrieve = lambda **_: [
            SimpleNamespace(id=newer, vector=[0.0, 1.0]),
            SimpleNamespace(id=older, vector=[1.0, 0.0]),
        ]
        self.store.recommend(
            seed_mbids=[older, newer],
            excluded_mbids=set(),
            pipeline_version="test-v1",
            limit=5,
        )
        assert self.client.query is not None
        x, y = self.client.query
        # Weights 1 (older) and 2 (newer): the newer seed dominates.
        self.assertAlmostEqual(y / x, 2.0)

    def test_recommend_asks_qdrant_to_skip_exclusions(self) -> None:
        captured: dict[str, Any] = {}
        original = self.client.query_points

        def query_points(**kwargs: Any) -> Any:
            captured.update(kwargs)
            return original(**kwargs)

        self.client.query_points = query_points
        self.store.recommend(
            seed_mbids=[SEED],
            excluded_mbids={EXCLUDED},
            pipeline_version="test-v1",
            limit=5,
        )
        condition = captured["query_filter"].must_not[0]
        self.assertEqual(set(condition.has_id), {SEED, EXCLUDED})

    def test_losing_the_race_to_create_a_collection_is_fine(self) -> None:
        created = {"exists": False}

        def collection_exists(_: str) -> bool:
            return created["exists"]

        def create_collection(**_: Any) -> None:
            # Another completion created it a moment earlier.
            created["exists"] = True
            raise RuntimeError("collection already exists")

        self.client.collection_exists = collection_exists
        self.client.create_collection = create_collection
        self.store.ensure_collection("test-v1", 2)

        created["exists"] = False
        self.client.create_collection = lambda **_: (_ for _ in ()).throw(
            RuntimeError("qdrant down")
        )
        with self.assertRaises(RuntimeError):
            self.store.ensure_collection("test-v2", 2)


if __name__ == "__main__":
    unittest.main()
