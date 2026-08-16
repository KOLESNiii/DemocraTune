# DemocraTune recommendation backend

This directory contains independently deployable pieces:

- an always-on FastAPI + Qdrant service for an Oracle Cloud Always Free VM;
- an ARM64, CPU-only Essentia worker that can run continuously on the Oracle
  Ampere VM;
- an intermittent, outbound-only home worker that uses `yt-dlp` and modern
  Essentia CPU inference as optional burst capacity.

The Oracle service remains available while the home PC is off. Missing-song
jobs wait in a leased SQLite queue. Either worker can claim a job, download one
temporary audio file, extract a normalized Discogs-EffNet embedding plus
conventional signal descriptors, upload the result, and delete the temporary
directory.

## Runtime flow

```text
DemocraTune/Convex
       |
       +-- resolve catalogue misses through a globally rate-limited queue
       |
       +-- enqueue one job per MBID + pipeline version
       |
       +-- request recommendations with a room-defined source order
                         |
                         +-- Qdrant engine
                         +-- ListenBrainz similar recordings
                         +-- fallback_playlist sentinel

Oracle Ampere A1 VM                   Home Ubuntu PC (optional/intermittent)
FastAPI + SQLite queue <------+       polls the same lease queue
Qdrant (private)               |       yt-dlp -> Essentia CPU
Caddy (public TLS)             |       uploads vectors -> deletes temp audio
ARM64 Essentia CPU worker <----+
```

The default recommendation order is:

```text
engine -> listenbrainz -> fallback_playlist
```

`POST /v1/recommendations` accepts a different `source_order`, so a later room
setting can choose, for example, `engine -> fallback_playlist` or
`listenbrainz -> engine -> fallback_playlist`. The backend returns
`selected_source: "fallback_playlist"` as a signal; the existing Convex
playback mutation remains responsible for selecting the actual host playlist
song.

## Why there can be several vector collections

The service creates one Qdrant collection per `pipeline_version`. Never mix:

- historical/derived AcousticBrainz descriptors;
- modern Discogs-EffNet embeddings;
- embeddings from a future model revision.

They have different dimensions and meanings. The included worker supports
`essentia-discogs-effnet-1280-v1`. A future AcousticBrainz importer can publish
its compact vectors under a separate name such as
`acousticbrainz-derived-128-v1` without changing the API.

## Deployment

Oracle provisioning, Compose configuration, ARM64 and home-worker deployment,
verification, upgrades, backups, and rollback are documented in
[`DEPLOY.MD`](DEPLOY.MD).

## API examples

Queue a track after it has been accepted into a room (never for search-result
keystrokes):

```bash
curl -X POST https://your-domain.example/v1/jobs \
  -H "Authorization: Bearer $APP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mbid": "8a49dba0-253a-4535-b87f-78bb035336ce",
    "youtube_url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "title": "Protection",
    "artist": "Massive Attack",
    "duration": 289
  }'
```

Request candidates:

```bash
curl -X POST https://your-domain.example/v1/recommendations \
  -H "Authorization: Bearer $APP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "seed_mbids": ["8a49dba0-253a-4535-b87f-78bb035336ce"],
    "source_order": ["engine", "listenbrainz", "fallback_playlist"],
    "limit": 10
  }'
```

The app token belongs in Convex as `RECOMMENDATION_API_TOKEN`, alongside the
backend origin in `RECOMMENDATION_API_URL`. It must never enter a browser
bundle. Convex also needs `FASTAPI_BASE_URL` pointing at the main Vercel origin
so returned recording candidates can pass through the existing verified
`/api/search` adapter before entering a room queue.

## Storage model

Use the home PC for the immutable ~626 GB compressed AcousticBrainz archive.
Do not place that archive on Oracle. Stream it into a compact derived Qdrant
collection instead.

Qdrant is configured for on-disk vectors, an on-disk HNSW index, and scalar
quantization. Approximate raw vector sizes for 7.56 million recordings are:

| Vector                                    | Raw float32 values | Practical collection budget |
| ----------------------------------------- | -----------------: | --------------------------: |
| 128-dimensional AcousticBrainz derivative |             3.9 GB |            roughly 10-30 GB |
| 256-dimensional derivative                |             7.7 GB |            roughly 20-50 GB |
| 1280-dimensional modern embedding         |            38.7 GB |          roughly 60-150+ GB |

The full modern collection is therefore not the first import target. Keep the
complete compact AcousticBrainz-derived collection online and grow modern
embeddings demand-first for songs actually used by DemocraTune.

## Operational and licensing notes

- ListenBrainz Labs similar-recording data is experimental and best-effort;
  results are cached in memory for one day.
- Essentia and this worker's integration need to be reviewed under Essentia's
  AGPL/commercial licensing terms for the intended deployment.
- The supplied media-source adapter uses `yt-dlp` as requested. Its use remains
  subject to the applicable platform terms and content rights.
- Enqueue only tracks accepted into rooms, enforce room-level limits in
  Convex, and never let anonymous search traffic create extraction work.
