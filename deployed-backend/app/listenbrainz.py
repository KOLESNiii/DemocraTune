from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

SIMILAR_URL = "https://labs.api.listenbrainz.org/similar-recordings/json"


class ListenBrainzClient:
    def __init__(self, algorithm: str) -> None:
        self.algorithm = algorithm
        self._cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    async def _for_seed(self, mbid: str) -> list[dict[str, Any]]:
        cached = self._cache.get(mbid)
        now = time.time()
        if cached is not None and cached[0] > now:
            return cached[1]

        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                SIMILAR_URL,
                params={
                    "recording_mbids": mbid,
                    "algorithm": self.algorithm,
                },
                headers={"User-Agent": "DemocraTune/0.1 (recommendation fallback)"},
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, list):
                return []
            rows = [item for item in data if isinstance(item, dict)]
            self._cache[mbid] = (now + 86400, rows)
            return rows

    async def similar_recordings(
        self,
        *,
        seed_mbids: list[str],
        excluded_mbids: set[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        # A few recent seeds are enough and keep this experimental service cheap.
        seeds = seed_mbids[-3:]
        responses = await asyncio.gather(
            *(self._for_seed(mbid) for mbid in seeds), return_exceptions=True
        )
        scores: dict[str, float] = {}
        metadata: dict[str, dict[str, Any]] = {}
        excluded = set(seed_mbids) | excluded_mbids

        for seed_index, response in enumerate(responses, start=1):
            if isinstance(response, BaseException) or not response:
                continue
            maximum = max(float(item.get("score") or 0) for item in response) or 1.0
            seed_weight = seed_index / len(seeds)
            for item in response:
                mbid = str(item.get("recording_mbid") or "")
                if not mbid or mbid in excluded:
                    continue
                scores[mbid] = (
                    scores.get(mbid, 0.0)
                    + (float(item.get("score") or 0) / maximum) * seed_weight
                )
                metadata[mbid] = item

        ranked = sorted(scores, key=scores.get, reverse=True)[:limit]
        return [
            {
                "recording_mbid": mbid,
                "score": scores[mbid],
                "title": metadata[mbid].get("recording_name"),
                "artist": metadata[mbid].get("artist_credit_name"),
                "source": "listenbrainz",
            }
            for mbid in ranked
        ]
