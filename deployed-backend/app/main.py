from __future__ import annotations

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .config import Settings
from .database import JobConflictError, JobDatabase
from .listenbrainz import ListenBrainzClient
from .models import (
    ClaimJobRequest,
    CompleteJobRequest,
    EnqueueJobRequest,
    FailJobRequest,
    HeartbeatRequest,
    RecommendationRequest,
)
from .vector_store import VectorStore

logger = logging.getLogger(__name__)

settings = Settings.from_environment()
jobs = JobDatabase(settings.state_db_path)
vectors = VectorStore(
    url=settings.qdrant_url,
    api_key=settings.qdrant_api_key,
    scalar_quantization=settings.qdrant_scalar_quantization,
)
listenbrainz = ListenBrainzClient(settings.listenbrainz_algorithm)


@asynccontextmanager
async def lifespan(_: FastAPI):
    jobs.initialize()
    yield


app = FastAPI(
    title="DemocraTune Recommendation Backend",
    version="0.1.0",
    lifespan=lifespan,
)


def _bearer_token(authorization: str | None) -> str:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return authorization.removeprefix("Bearer ").strip()


def require_app_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if not secrets.compare_digest(_bearer_token(authorization), settings.app_api_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)


def require_worker_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if not secrets.compare_digest(
        _bearer_token(authorization), settings.worker_api_token
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)


def require_any_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    token = _bearer_token(authorization)
    if not (
        secrets.compare_digest(token, settings.app_api_token)
        or secrets.compare_digest(token, settings.worker_api_token)
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)


@app.get("/health")
async def health() -> dict[str, Any]:
    try:
        qdrant_ready = await asyncio.to_thread(vectors.ready)
    except Exception:  # noqa: BLE001 - health must cover all Qdrant client failures
        qdrant_ready = False
    return {"ok": qdrant_ready, "qdrant": qdrant_ready}


@app.post("/v1/jobs", dependencies=[Depends(require_app_token)])
async def enqueue_job(request: EnqueueJobRequest) -> dict[str, Any]:
    pipeline = request.pipeline_version or settings.default_pipeline_version
    mbid = str(request.mbid)
    try:
        exists = await asyncio.to_thread(
            vectors.has_point, mbid=mbid, pipeline_version=pipeline
        )
    except Exception:  # noqa: BLE001 - queueing must survive a Qdrant outage
        logger.exception(
            "Could not check whether %s already exists in pipeline %s; queueing it",
            mbid,
            pipeline,
        )
        exists = False
    if exists:
        return {
            "created": False,
            "already_available": True,
            "mbid": mbid,
            "pipeline_version": pipeline,
        }

    job, created = jobs.enqueue(
        mbid=mbid,
        pipeline_version=pipeline,
        youtube_url=request.youtube_url,
        title=request.title,
        artist=request.artist,
        duration=request.duration,
        priority=request.priority,
    )
    return {"created": created, "already_available": False, "job": job}


@app.post("/v1/jobs/claim", dependencies=[Depends(require_worker_token)])
async def claim_job(request: ClaimJobRequest) -> dict[str, Any]:
    job = jobs.claim(
        worker_id=request.worker_id,
        pipeline_version=request.pipeline_version,
        lease_seconds=request.lease_seconds,
    )
    return {"job": job}


@app.post("/v1/jobs/{job_id}/heartbeat", dependencies=[Depends(require_worker_token)])
async def heartbeat_job(job_id: str, request: HeartbeatRequest) -> dict[str, Any]:
    try:
        job = jobs.heartbeat(
            job_id=job_id,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
            lease_seconds=request.lease_seconds,
        )
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": job}


@app.get("/v1/features/{mbid}", dependencies=[Depends(require_any_token)])
async def feature_status(mbid: UUID, pipeline_version: str) -> dict[str, Any]:
    canonical_mbid = str(mbid)
    exists = await asyncio.to_thread(
        vectors.has_point, mbid=canonical_mbid, pipeline_version=pipeline_version
    )
    return {
        "mbid": canonical_mbid,
        "pipeline_version": pipeline_version,
        "available": exists,
    }


@app.post("/v1/jobs/{job_id}/complete", dependencies=[Depends(require_worker_token)])
async def complete_job(job_id: str, request: CompleteJobRequest) -> dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] == "completed":
        return {"job": job}
    if (
        job["lease_owner"] != request.worker_id
        or job["lease_token"] != request.lease_token
    ):
        raise HTTPException(status_code=409, detail="job lease is no longer owned")

    await asyncio.to_thread(
        vectors.upsert,
        mbid=job["mbid"],
        pipeline_version=job["pipeline_version"],
        vector=request.vector,
        payload={
            "title": job["title"],
            "artist": job["artist"],
            "duration": job["duration"],
            "attributes": request.attributes,
        },
    )
    try:
        completed = jobs.complete(
            job_id=job_id,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
        )
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": completed}


@app.post(
    "/v1/jobs/{job_id}/complete-existing",
    dependencies=[Depends(require_worker_token)],
)
async def complete_existing_job(
    job_id: str, request: HeartbeatRequest
) -> dict[str, Any]:
    """Finish a retry when an earlier attempt inserted the vector then crashed."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    exists = await asyncio.to_thread(
        vectors.has_point,
        mbid=job["mbid"],
        pipeline_version=job["pipeline_version"],
    )
    if not exists:
        raise HTTPException(status_code=409, detail="feature does not exist")
    try:
        completed = jobs.complete(
            job_id=job_id,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
        )
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": completed}


@app.post("/v1/jobs/{job_id}/fail", dependencies=[Depends(require_worker_token)])
async def fail_job(job_id: str, request: FailJobRequest) -> dict[str, Any]:
    try:
        job = jobs.fail(
            job_id=job_id,
            worker_id=request.worker_id,
            lease_token=request.lease_token,
            error=request.error,
            retryable=request.retryable,
        )
    except JobConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job": job}


@app.post("/v1/recommendations", dependencies=[Depends(require_app_token)])
async def recommendations(request: RecommendationRequest) -> dict[str, Any]:
    seed_mbids = [str(mbid) for mbid in request.seed_mbids]
    excluded = {str(mbid) for mbid in request.excluded_mbids}
    pipeline = request.pipeline_version or settings.default_pipeline_version
    source_order = request.source_order or list(settings.default_source_order)
    attempted: list[str] = []

    for source in source_order:
        attempted.append(source)
        if source == "engine":
            try:
                candidates = await asyncio.to_thread(
                    vectors.recommend,
                    seed_mbids=seed_mbids,
                    excluded_mbids=excluded,
                    pipeline_version=pipeline,
                    limit=request.limit,
                )
            except Exception:  # noqa: BLE001 - fallback sources are the recovery path
                logger.exception(
                    "Recommendation engine failed for pipeline %s; trying fallback",
                    pipeline,
                )
                candidates = []
            if candidates:
                return {
                    "selected_source": "engine",
                    "attempted_sources": attempted,
                    "pipeline_version": pipeline,
                    "candidates": candidates,
                }
        elif source == "listenbrainz":
            try:
                candidates = await listenbrainz.similar_recordings(
                    seed_mbids=seed_mbids,
                    excluded_mbids=excluded,
                    limit=request.limit,
                )
            except Exception:  # noqa: BLE001 - the playlist fallback must still run
                logger.exception("ListenBrainz recommendation fallback failed")
                candidates = []
            if candidates:
                return {
                    "selected_source": "listenbrainz",
                    "attempted_sources": attempted,
                    "pipeline_version": pipeline,
                    "candidates": candidates,
                }
        elif source == "fallback_playlist":
            return {
                "selected_source": "fallback_playlist",
                "attempted_sources": attempted,
                "pipeline_version": pipeline,
                "candidates": [],
            }

    return {
        "selected_source": None,
        "attempted_sources": attempted,
        "pipeline_version": pipeline,
        "candidates": [],
    }
