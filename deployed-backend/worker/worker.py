from __future__ import annotations

import math
import os
import socket
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Self

import httpx
import numpy as np
import yt_dlp

# Source-built Essentia on ARM and the TensorFlow wheel share libtensorflow_cc.
# Initializing TensorFlow first avoids loading a second, uninitialized copy of
# its C++ runtime. The prebuilt x86 essentia-tensorflow wheel does not expose a
# standalone tensorflow package, so it intentionally takes the fallback path.
try:
    import tensorflow as _tensorflow  # type: ignore[import-not-found]  # noqa: F401
except ModuleNotFoundError:
    pass

from essentia.standard import (
    DynamicComplexity,
    KeyExtractor,
    MonoLoader,
    RhythmExtractor2013,
    TensorflowPredictEffnetDiscogs,
)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} must be configured")
    return value


API_URL = required("BACKEND_API_URL").rstrip("/")
TOKEN = required("WORKER_API_TOKEN")
WORKER_ID = os.environ.get("WORKER_ID", socket.gethostname())
PIPELINE_VERSION = os.environ.get("PIPELINE_VERSION", "essentia-discogs-effnet-1280-v1")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
LEASE_SECONDS = int(os.environ.get("LEASE_SECONDS", "1800"))
MAX_AUDIO_SECONDS = int(os.environ.get("MAX_AUDIO_SECONDS", "1200"))
MODEL_PATH = os.environ.get("MODEL_PATH", "/opt/models/discogs-effnet-bs1-1.pb")
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

_embedding_model: TensorflowPredictEffnetDiscogs | None = None


def model() -> TensorflowPredictEffnetDiscogs:
    global _embedding_model
    if _embedding_model is None:
        _embedding_model = TensorflowPredictEffnetDiscogs(
            graphFilename=MODEL_PATH,
            output="PartitionedCall:1",
            batchSize=1,
        )
    return _embedding_model


class Heartbeat:
    def __init__(self, job: dict[str, Any]) -> None:
        self.job = job
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)

    def _run(self) -> None:
        interval = max(30, min(300, LEASE_SECONDS // 3))
        while not self.stop_event.wait(interval):
            try:
                with httpx.Client(timeout=15, headers=HEADERS) as client:
                    response = client.post(
                        f"{API_URL}/v1/jobs/{self.job['id']}/heartbeat",
                        json={
                            "worker_id": WORKER_ID,
                            "lease_token": self.job["lease_token"],
                            "lease_seconds": LEASE_SECONDS,
                        },
                    )
                    response.raise_for_status()
            except Exception as exc:  # noqa: BLE001 - next heartbeat can recover
                print(f"Heartbeat failed for {self.job['id']}: {exc}", flush=True)


def download_audio(url: str, directory: Path) -> Path:
    def reject_unsuitable(info: dict[str, Any], *, incomplete: bool) -> str | None:
        if incomplete:
            return None
        if info.get("is_live") or info.get("live_status") in {
            "is_live",
            "is_upcoming",
        }:
            return "live streams are not accepted"
        duration = info.get("duration")
        if duration and float(duration) > MAX_AUDIO_SECONDS:
            return f"audio is longer than {MAX_AUDIO_SECONDS} seconds"
        return None

    options: dict[str, Any] = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "outtmpl": str(directory / "source.%(ext)s"),
        "match_filter": reject_unsuitable,
        "retries": 3,
        "fragment_retries": 3,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
        if info is None:
            raise RuntimeError("yt-dlp returned no media information")
        requested = info.get("requested_downloads") or []
        candidates = [
            item.get("filepath") for item in requested if isinstance(item, dict)
        ]
        candidates.append(downloader.prepare_filename(info))
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return Path(candidate)
    raise RuntimeError("yt-dlp completed without creating an audio file")


def extract(audio_path: Path) -> tuple[list[float], dict[str, Any]]:
    signal_16k = MonoLoader(
        filename=str(audio_path), sampleRate=16000, resampleQuality=4
    )()
    patch_embeddings = np.asarray(model()(signal_16k), dtype=np.float32)
    if patch_embeddings.size == 0:
        raise RuntimeError("Essentia returned no embedding patches")
    pooled = patch_embeddings.reshape(-1, patch_embeddings.shape[-1]).mean(axis=0)
    norm = float(np.linalg.norm(pooled))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError("Essentia returned an invalid embedding")
    vector = (pooled / norm).astype(np.float32).tolist()

    # These conventional descriptors are CPU signal processing. They make
    # recommendation explanations/debugging possible but are not mixed into
    # the neural embedding.
    signal_44k = MonoLoader(filename=str(audio_path), sampleRate=44100)()
    bpm, _, _, _, bpm_intervals = RhythmExtractor2013(method="multifeature")(signal_44k)
    key, scale, key_strength = KeyExtractor()(signal_44k)
    dynamic_complexity, loudness = DynamicComplexity()(signal_44k)
    attributes = {
        "bpm": float(bpm),
        "beat_interval_count": len(bpm_intervals),
        "key": str(key),
        "scale": str(scale),
        "key_strength": float(key_strength),
        "dynamic_complexity": float(dynamic_complexity),
        "loudness": float(loudness),
        "embedding_dimensions": len(vector),
        "extractor": "Essentia TensorflowPredictEffnetDiscogs bs1",
    }
    return vector, attributes


def feature_exists(client: httpx.Client, job: dict[str, Any]) -> bool:
    response = client.get(
        f"{API_URL}/v1/features/{job['mbid']}",
        params={"pipeline_version": job["pipeline_version"]},
    )
    response.raise_for_status()
    return bool(response.json()["available"])


def complete(
    client: httpx.Client,
    job: dict[str, Any],
    vector: list[float],
    attributes: dict[str, Any],
) -> None:
    response = client.post(
        f"{API_URL}/v1/jobs/{job['id']}/complete",
        json={
            "worker_id": WORKER_ID,
            "lease_token": job["lease_token"],
            "vector": vector,
            "attributes": attributes,
        },
    )
    response.raise_for_status()


def fail(
    client: httpx.Client,
    job: dict[str, Any],
    error: Exception,
    *,
    retryable: bool,
) -> None:
    response = client.post(
        f"{API_URL}/v1/jobs/{job['id']}/fail",
        json={
            "worker_id": WORKER_ID,
            "lease_token": job["lease_token"],
            "error": f"{type(error).__name__}: {error}"[:2000],
            "retryable": retryable,
        },
    )
    response.raise_for_status()


def process(client: httpx.Client, job: dict[str, Any]) -> None:
    print(f"Processing {job['mbid']} ({job['title']})", flush=True)
    if feature_exists(client, job):
        # A previous attempt may have inserted the vector before losing its
        # lease. The completion endpoint verifies the point before changing
        # queue state, so no audio is downloaded twice.
        response = client.post(
            f"{API_URL}/v1/jobs/{job['id']}/complete-existing",
            json={
                "worker_id": WORKER_ID,
                "lease_token": job["lease_token"],
                "lease_seconds": LEASE_SECONDS,
            },
        )
        response.raise_for_status()
        return

    if job["pipeline_version"] != PIPELINE_VERSION:
        unsupported = RuntimeError(
            f"worker supports {PIPELINE_VERSION}, not {job['pipeline_version']}"
        )
        fail(client, job, unsupported, retryable=False)
        return

    try:
        with Heartbeat(job), tempfile.TemporaryDirectory(prefix="democratune-") as temp:
            audio_path = download_audio(job["youtube_url"], Path(temp))
            vector, attributes = extract(audio_path)
            complete(client, job, vector, attributes)
        print(f"Completed {job['mbid']}", flush=True)
    except yt_dlp.utils.DownloadError as exc:
        fail(client, job, exc, retryable=True)
    except (httpx.HTTPError, OSError) as exc:
        fail(client, job, exc, retryable=True)
    except Exception as exc:  # noqa: BLE001 - deterministic extractor failure
        fail(client, job, exc, retryable=False)


def run() -> None:
    print(
        f"Worker {WORKER_ID} ready for pipeline {PIPELINE_VERSION}; CPU inference enabled",
        flush=True,
    )
    with httpx.Client(timeout=30, headers=HEADERS) as client:
        while True:
            try:
                response = client.post(
                    f"{API_URL}/v1/jobs/claim",
                    json={
                        "worker_id": WORKER_ID,
                        "pipeline_version": PIPELINE_VERSION,
                        "lease_seconds": LEASE_SECONDS,
                    },
                )
                response.raise_for_status()
                job = response.json().get("job")
                if job is None:
                    time.sleep(POLL_SECONDS)
                    continue
                process(client, job)
            except httpx.HTTPError as exc:
                print(f"Queue request failed: {exc}", flush=True)
                time.sleep(max(POLL_SECONDS, 30))


if __name__ == "__main__":
    run()
