from __future__ import annotations

import math
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

SourceName = Literal["engine", "listenbrainz", "fallback_playlist"]


class EnqueueJobRequest(BaseModel):
    mbid: UUID
    youtube_url: str
    title: str = Field(min_length=1, max_length=500)
    artist: str = Field(min_length=1, max_length=500)
    duration: int = Field(ge=1, le=7200)
    pipeline_version: str | None = Field(default=None, min_length=1, max_length=100)
    priority: int = Field(default=0, ge=-100, le=100)

    @field_validator("youtube_url")
    @classmethod
    def validate_youtube_url(cls, value: str) -> str:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        allowed = {
            "youtube.com",
            "www.youtube.com",
            "music.youtube.com",
            "youtu.be",
        }
        if parsed.scheme != "https" or host not in allowed:
            raise ValueError("youtube_url must be an HTTPS YouTube URL")
        return value


class ClaimJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=100)
    pipeline_version: str = Field(min_length=1, max_length=100)
    lease_seconds: int = Field(default=1800, ge=60, le=7200)


class HeartbeatRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=100)
    lease_token: str = Field(min_length=1, max_length=100)
    lease_seconds: int = Field(default=1800, ge=60, le=7200)


class CompleteJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=100)
    lease_token: str = Field(min_length=1, max_length=100)
    vector: list[float] = Field(min_length=2, max_length=4096)
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("vector")
    @classmethod
    def validate_vector(cls, value: list[float]) -> list[float]:
        if any(not math.isfinite(item) for item in value):
            raise ValueError("vector values must be finite")
        norm = math.sqrt(sum(item * item for item in value))
        if norm <= 0:
            raise ValueError("vector must have a non-zero norm")
        return [item / norm for item in value]


class FailJobRequest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=100)
    lease_token: str = Field(min_length=1, max_length=100)
    error: str = Field(min_length=1, max_length=2000)
    retryable: bool = True


class RecommendationRequest(BaseModel):
    seed_mbids: list[UUID] = Field(min_length=1, max_length=20)
    excluded_mbids: list[UUID] = Field(default_factory=list, max_length=500)
    pipeline_version: str | None = Field(default=None, min_length=1, max_length=100)
    source_order: list[SourceName] | None = Field(default=None, min_length=1)
    limit: int = Field(default=10, ge=1, le=50)

    @field_validator("source_order")
    @classmethod
    def unique_source_order(
        cls, value: list[SourceName] | None
    ) -> list[SourceName] | None:
        if value is not None and len(value) != len(set(value)):
            raise ValueError("source_order cannot contain duplicates")
        return value
