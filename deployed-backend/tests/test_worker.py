from __future__ import annotations

import contextlib
import os
import sys
import types
import typing
import unittest
from typing import Any
from unittest.mock import patch

# The production image installs these large audio dependencies. Unit tests only
# exercise orchestration and failure classification, so lightweight import
# doubles keep the coordinator test environment CPU- and model-independent.
if not hasattr(typing, "Self"):  # Python 3.10 test environment compatibility
    typing.Self = typing.Any  # type: ignore[attr-defined]


class DownloadError(Exception):
    pass


yt_dlp = types.ModuleType("yt_dlp")
yt_dlp.YoutubeDL = object  # type: ignore[attr-defined]
yt_dlp.utils = types.SimpleNamespace(DownloadError=DownloadError)  # type: ignore[attr-defined]
sys.modules.setdefault("yt_dlp", yt_dlp)

essentia = types.ModuleType("essentia")
essentia_standard = types.ModuleType("essentia.standard")
for name in (
    "DynamicComplexity",
    "KeyExtractor",
    "MonoLoader",
    "RhythmExtractor2013",
    "TensorflowPredictEffnetDiscogs",
):
    setattr(essentia_standard, name, object)
sys.modules.setdefault("essentia", essentia)
sys.modules.setdefault("essentia.standard", essentia_standard)

os.environ.setdefault("BACKEND_API_URL", "https://recommendations.example")
os.environ.setdefault("WORKER_API_TOKEN", "test-worker-token")

from worker import worker


class FakeResponse:
    def __init__(self, body: dict[str, Any] | None = None) -> None:
        self.body = body or {}

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.body


class FakeClient:
    def __init__(self, feature_available: bool = False) -> None:
        self.feature_available = feature_available
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def get(self, *_: Any, **__: Any) -> FakeResponse:
        return FakeResponse({"available": self.feature_available})

    def post(self, url: str, *, json: dict[str, Any]) -> FakeResponse:
        self.posts.append((url, json))
        return FakeResponse()


def job(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "job-1",
        "mbid": "8a49dba0-253a-4535-b87f-78bb035336ce",
        "title": "Test track",
        "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "pipeline_version": worker.PIPELINE_VERSION,
        "lease_token": "lease-token",
        **overrides,
    }


class WorkerProcessTests(unittest.TestCase):
    def test_existing_feature_completes_without_downloading(self) -> None:
        client = FakeClient(feature_available=True)

        with patch.object(worker, "download_audio") as download:
            worker.process(client, job())

        download.assert_not_called()
        self.assertTrue(client.posts[0][0].endswith("/complete-existing"))

    def test_unsupported_pipeline_is_permanently_failed(self) -> None:
        client = FakeClient()

        worker.process(client, job(pipeline_version="unknown-v2"))

        url, payload = client.posts[-1]
        self.assertTrue(url.endswith("/fail"))
        self.assertFalse(payload["retryable"])
        self.assertIn("worker supports", payload["error"])

    def test_download_error_is_retryable(self) -> None:
        client = FakeClient()

        with (
            patch.object(worker, "Heartbeat", return_value=contextlib.nullcontext()),
            patch.object(
                worker,
                "download_audio",
                side_effect=DownloadError("temporary source failure"),
            ),
        ):
            worker.process(client, job())

        _, payload = client.posts[-1]
        self.assertTrue(payload["retryable"])
        self.assertIn("DownloadError", payload["error"])

    def test_extraction_error_is_not_retried(self) -> None:
        client = FakeClient()

        with (
            patch.object(worker, "Heartbeat", return_value=contextlib.nullcontext()),
            patch.object(worker, "download_audio", return_value="audio-file"),
            patch.object(worker, "extract", side_effect=ValueError("invalid vector")),
        ):
            worker.process(client, job())

        _, payload = client.posts[-1]
        self.assertFalse(payload["retryable"])
        self.assertIn("ValueError", payload["error"])


if __name__ == "__main__":
    unittest.main()
