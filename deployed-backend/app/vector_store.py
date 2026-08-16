from __future__ import annotations

import hashlib
import math
import re
from typing import Any

from qdrant_client import QdrantClient, models


def collection_name(pipeline_version: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", pipeline_version).strip("-")[:40]
    digest = hashlib.sha256(pipeline_version.encode()).hexdigest()[:8]
    return f"democratune-{slug or 'pipeline'}-{digest}"


class VectorStore:
    def __init__(self, *, url: str, api_key: str, scalar_quantization: bool) -> None:
        self.client = QdrantClient(url=url, api_key=api_key, timeout=30)
        self.scalar_quantization = scalar_quantization

    def ready(self) -> bool:
        self.client.get_collections()
        return True

    def _exists(self, pipeline_version: str) -> bool:
        return self.client.collection_exists(collection_name(pipeline_version))

    def ensure_collection(self, pipeline_version: str, dimensions: int) -> str:
        name = collection_name(pipeline_version)
        if self.client.collection_exists(name):
            existing = self.client.get_collection(name)
            vectors = existing.config.params.vectors
            existing_size = getattr(vectors, "size", None)
            if existing_size is not None and existing_size != dimensions:
                raise ValueError(
                    f"pipeline {pipeline_version!r} already has dimension "
                    f"{existing_size}, not {dimensions}"
                )
            return name

        quantization = None
        if self.scalar_quantization:
            quantization = models.ScalarQuantization(
                scalar=models.ScalarQuantizationConfig(
                    type=models.ScalarType.INT8,
                    quantile=0.99,
                    always_ram=False,
                )
            )
        self.client.create_collection(
            collection_name=name,
            vectors_config=models.VectorParams(
                size=dimensions,
                distance=models.Distance.COSINE,
                on_disk=True,
            ),
            hnsw_config=models.HnswConfigDiff(on_disk=True),
            quantization_config=quantization,
        )
        return name

    def upsert(
        self,
        *,
        mbid: str,
        pipeline_version: str,
        vector: list[float],
        payload: dict[str, Any],
    ) -> None:
        name = self.ensure_collection(pipeline_version, len(vector))
        self.client.upsert(
            collection_name=name,
            wait=True,
            points=[
                models.PointStruct(
                    id=mbid,
                    vector=vector,
                    payload={
                        **payload,
                        "mbid": mbid,
                        "pipeline_version": pipeline_version,
                    },
                )
            ],
        )

    def has_point(self, *, mbid: str, pipeline_version: str) -> bool:
        if not self._exists(pipeline_version):
            return False
        points = self.client.retrieve(
            collection_name=collection_name(pipeline_version),
            ids=[mbid],
            with_payload=False,
            with_vectors=False,
        )
        return bool(points)

    def recommend(
        self,
        *,
        seed_mbids: list[str],
        excluded_mbids: set[str],
        pipeline_version: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not self._exists(pipeline_version):
            return []

        name = collection_name(pipeline_version)
        points = self.client.retrieve(
            collection_name=name,
            ids=seed_mbids,
            with_payload=False,
            with_vectors=True,
        )
        vectors = [point.vector for point in points if isinstance(point.vector, list)]
        if not vectors:
            return []

        dimensions = len(vectors[0])
        if any(len(vector) != dimensions for vector in vectors):
            raise ValueError("seed vectors have inconsistent dimensions")

        # Newer seeds appear later in the request and receive more weight.
        weights = list(range(1, len(vectors) + 1))
        total_weight = sum(weights)
        centroid = [
            sum(weight * vector[index] for weight, vector in zip(weights, vectors))
            / total_weight
            for index in range(dimensions)
        ]
        norm = math.sqrt(sum(value * value for value in centroid))
        if norm == 0:
            return []
        centroid = [value / norm for value in centroid]

        excluded = set(seed_mbids) | excluded_mbids
        response = self.client.query_points(
            collection_name=name,
            query=centroid,
            limit=min(256, max(limit * 5, 25)),
            with_payload=True,
            with_vectors=False,
        )
        results: list[dict[str, Any]] = []
        for point in response.points:
            payload = point.payload or {}
            mbid = str(payload.get("mbid") or point.id)
            if mbid in excluded:
                continue
            results.append(
                {
                    "recording_mbid": mbid,
                    "score": float(point.score),
                    "title": payload.get("title"),
                    "artist": payload.get("artist"),
                    "source": "engine",
                }
            )
            if len(results) >= limit:
                break
        return results
