from __future__ import annotations

import os
from dataclasses import dataclass


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} must be configured")
    return value


def _boolean(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_api_token: str
    worker_api_token: str
    qdrant_url: str
    qdrant_api_key: str
    state_db_path: str
    default_pipeline_version: str
    default_source_order: tuple[str, ...]
    listenbrainz_algorithm: str
    qdrant_scalar_quantization: bool

    @classmethod
    def from_environment(cls) -> Settings:
        source_order = tuple(
            item.strip()
            for item in os.environ.get(
                "DEFAULT_SOURCE_ORDER",
                "engine,listenbrainz,fallback_playlist",
            ).split(",")
            if item.strip()
        )
        allowed = {"engine", "listenbrainz", "fallback_playlist"}
        if not source_order or any(item not in allowed for item in source_order):
            raise RuntimeError(
                "DEFAULT_SOURCE_ORDER must contain only engine, listenbrainz, "
                "and fallback_playlist"
            )

        return cls(
            app_api_token=_required("APP_API_TOKEN"),
            worker_api_token=_required("WORKER_API_TOKEN"),
            qdrant_url=os.environ.get("QDRANT_URL", "http://qdrant:6333"),
            qdrant_api_key=_required("QDRANT_API_KEY"),
            state_db_path=os.environ.get(
                "STATE_DB_PATH", "/var/lib/democratune/state.sqlite3"
            ),
            default_pipeline_version=os.environ.get(
                "DEFAULT_PIPELINE_VERSION",
                "essentia-discogs-effnet-1280-v1",
            ),
            default_source_order=source_order,
            listenbrainz_algorithm=os.environ.get(
                "LISTENBRAINZ_SIMILAR_ALGORITHM",
                "session_based_days_7500_session_300_contribution_5_"
                "threshold_15_limit_50_skip_30_top_n_listeners_1000",
            ),
            qdrant_scalar_quantization=_boolean("QDRANT_SCALAR_QUANTIZATION", True),
        )
