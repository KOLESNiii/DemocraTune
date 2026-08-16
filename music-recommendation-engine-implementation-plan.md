# Music Recommendation Engine — Implementation and Hosting Plan

Last reviewed: 2026-08-16

## 1. Architecture decision

Use three deliberately separate runtimes:

1. **Vercel + Convex** keep the fast product path: the Next.js clients, rooms,
   queues, history, live state, and playback decisions.
2. **Oracle Cloud Always Free** runs the small, always-available recommendation
   coordinator and Qdrant. It stores a leased extraction queue, vectors, and
   serves recommendation requests.
3. **An Oracle ARM64 CPU worker** continuously consumes extraction jobs. The
   home Ubuntu PC can run the x86 worker as optional burst capacity. Both use
   `yt-dlp`, temporary audio, and modern Essentia, then delete the temporary
   directory.

There is no Modal dependency and no GPU dependency. Convex does not hold the
vector corpus. The deployable implementation is in
[`deployed-backend/`](deployed-backend/README.md), with its operational runbook
in [`deployed-backend/DEPLOY.MD`](deployed-backend/DEPLOY.MD).

```text
browser clients
      |
      +-- search through the existing cacheable Vercel adapter
      +-- queue/vote/playback through Convex
                    |
                    +-- accepted canonical song -> enqueue extraction (idempotent)
                    +-- Auto DJ refresh -> request recommendations
                                              |
                                    Oracle FastAPI coordinator
                                      |                |
                                      |                +-- ListenBrainz Labs
                                      +-- Qdrant
                                      +-- SQLite lease queue
                                               ^
                                               |
                                  home worker polls when online
                                  yt-dlp -> Essentia CPU -> upload
```

The home PC may disappear at any time without affecting search, rooms,
playback, extraction, or existing recommendations. Oracle continues processing
at a deliberately CPU-limited rate.

## 2. Recommendation source order

The source order is a room-level setting rather than hard-coded behavior:

```ts
type RecommendationSource =
  | "engine"
  | "listenbrainz"
  | "fallback_playlist";

autoDj: {
  enabled: boolean;
  sourceOrder: RecommendationSource[];
}
```

Recommended default:

```text
engine -> listenbrainz -> fallback_playlist
```

Other valid examples are `listenbrainz -> engine -> fallback_playlist`, or
`engine -> fallback_playlist` for a host who does not want collaborative data.
Validate that entries are unique and that a fallback is present unless the host
explicitly accepts silence.

The deployed API already accepts `source_order` and implements the three-stage
fallback. ListenBrainz Labs supplies recording-to-recording similarity, which
does not require a DemocraTune user account. It is experimental and must remain
best-effort. This is different from ListenBrainz's user collaborative-filtering
recommendation endpoint, which is tied to a ListenBrainz user.

User-queued songs always take precedence over every Auto DJ source. Auto DJ is
only consulted when the normal user queue has no eligible song.

## 3. When extraction work is created

Create an extraction job whenever a track is accepted into a room and has a
canonical MusicBrainz recording ID and a playable YouTube URL. Do not create
jobs from search impressions or keystrokes.

The sequence is:

1. The server accepts a selected track and resolves or confirms its recording
   MBID.
2. Convex stores the room/queue change first; recommendation infrastructure
   must never block adding a song.
3. A scheduled Convex action calls `POST /v1/jobs` with the MBID and source
   metadata.
4. The coordinator checks Qdrant. If the feature already exists, it returns
   `already_available`.
5. Otherwise SQLite performs `INSERT OR IGNORE` against the unique key
   `(mbid, pipeline_version)`.

This gives at-least-once delivery with idempotent storage. Retrying the Convex
action, selecting the same song in ten rooms, or a worker crash cannot create
ten extraction tasks.

Recommended application-side limits:

- enqueue only a track actually accepted into a room;
- cap newly accepted unique tracks per room/IP over a rolling interval;
- keep the coordinator token only in Convex server-side environment variables;
- never expose the extraction endpoint directly to browsers.

## 4. Extraction pipeline

The implemented worker uses:

- `yt-dlp` to download one best-audio source into a Python temporary directory;
- Essentia `MonoLoader` at 16 kHz;
- `TensorflowPredictEffnetDiscogs` with the official Discogs-EffNet BS1 graph;
- mean pooling across patches and L2 normalization to one 1,280-value vector;
- CPU signal extractors for BPM, key/scale, loudness, and dynamic complexity;
- an authenticated completion call followed by automatic temporary deletion.

The worker rejects playlists, live/upcoming streams, and sources over the
configured duration limit. It heartbeats its lease during work. Retriable
download/network failures use exponential backoff; deterministic extraction
failures stop after the configured attempt policy.

If a crash occurs after Qdrant accepts the vector but before SQLite records job
completion, the next lease detects the existing point and completes without
downloading the audio again.

### Does this need a GPU?

No. There are two kinds of computation:

- BPM, key, loudness, and related signal descriptors are ordinary CPU DSP.
- Discogs-EffNet is neural inference, but Essentia/TensorFlow supports CPU
  inference. A container test in this repository produced finite 1,280-value
  frames with CUDA unavailable.

The supplied worker explicitly sets `CUDA_VISIBLE_DEVICES=-1`. The RTX 2070
Super is only a possible throughput optimization. Benchmark CPU tracks/hour
first. A CUDA worker adds driver, toolkit, base-image, and version-management
cost, so it is not justified until a real backlog requires it.

The prebuilt `essentia-tensorflow` wheel used by the home worker is x86-64. The
separate Oracle image installs the ARM64 TensorFlow CPU wheel and compiles a
pinned Essentia revision against it in a multi-stage build. It runs with one
CPU and a 4 GB memory limit by default so Qdrant and the API retain headroom.

## 5. Feature spaces and AcousticBrainz

Never mix features produced by different extractors in one nearest-neighbour
index. They have different dimensions and geometry even when they describe the
same recording.

Create one Qdrant collection per immutable `pipeline_version`, for example:

- `essentia-discogs-effnet-1280-v1` for newly computed modern embeddings;
- `acousticbrainz-derived-128-v1` for a separately designed projection of the
  historical AcousticBrainz features.

AcousticBrainz contains roughly 29.46 million submissions for 7.56 million
unique recordings. The published compressed low-level JSON archive is about
589 GB and the high-level archive about 37 GB. This is a preservation dataset,
not something to place on Oracle or in Convex.

Recommended data placement:

| Data | Location | Availability requirement |
| --- | --- | --- |
| Raw AcousticBrainz archives | Home PC bulk disk + backup if valuable | Offline is acceptable |
| Compact derived AB vectors | Oracle Qdrant | Always available |
| Demand-created modern embeddings | Oracle Qdrant | Always available |
| Extraction queue | Oracle SQLite volume | Always available |
| Temporary source audio | Home worker temp directory | Deleted after each attempt |

Do not mirror the raw database merely because it exists. First download the
compact CSV or only the required archives, verify checksums, and build a
streaming importer. Retain the 600+ GB source only if preserving AcousticBrainz
is itself a goal and there is a second copy or reproducible download path.

For a full historical import, start with a compact 128-dimensional derived
vector. Approximate storage for 7.56 million recordings is:

| Representation | Raw float32 values | Practical Qdrant budget |
| --- | ---: | ---: |
| 128 dimensions | 3.9 GB | roughly 10–30 GB |
| 256 dimensions | 7.7 GB | roughly 20–50 GB |
| 1,280 dimensions | 38.7 GB | roughly 60–150+ GB |

Those practical estimates include index, payload, metadata, and operational
headroom, not just vector values. The deployed Qdrant config uses on-disk
vectors, an on-disk HNSW index, and int8 scalar quantization.

Do not attempt a full 7.56-million-track modern 1,280-dimensional rebuild as
the initial system. Import a compact AcousticBrainz-derived index for coverage,
then let modern embeddings grow demand-first for tracks used in DemocraTune.

## 6. Oracle Cloud hosting

Oracle is appropriate for both the always-on coordinator and low-throughput
CPU extraction. Design for the currently documented lower Always Free Ampere
allowance rather than relying on older pages that advertise more capacity.

The hosted stack consists of:

- Caddy: public TLS endpoint and compression;
- FastAPI: authenticated coordinator, fallback orchestration, and queue API;
- SQLite: persisted within the API volume, WAL mode, one API worker;
- Qdrant: private Compose network only, persistent vectors and snapshots.
- ARM64 Essentia worker: one CPU/4 GB by default, continuous low-priority
  extraction with no CUDA dependency.

The Oracle volume should contain the compact online index, not the raw
AcousticBrainz mirror. Leave enough block storage for the boot volume,
snapshots, Qdrant compaction, Docker layers, and logs.

Provisioning, secrets, firewall rules, deployment commands, verification,
worker setup, backups, upgrades, and rollback are maintained in the single
operational source of truth:
[`deployed-backend/DEPLOY.MD`](deployed-backend/DEPLOY.MD).

## 7. Why Convex Free and managed vector free tiers do not hold the corpus

As currently documented, Convex Free includes 0.5 GiB database storage and
0.5 GiB shared search storage, plus 1 GiB/month database bandwidth. It remains
useful for ephemeral room state but cannot hold millions of embeddings.

The headline managed-vector free tiers are also far smaller than this corpus:

- Qdrant Cloud Free: 1 GB RAM and 4 GB disk;
- Pinecone Starter: approximately 2 GB serverless storage in its published
  free-tier description;
- Weaviate free cloud sandbox: up to 100,000 objects and 10 GB disk.

Even the smallest plausible full 7.56-million-recording index needs operational
space beyond those allowances. Self-hosted Qdrant on already-owned Oracle
capacity is the free-tier path. The home PC can retain bulk/offline data, but it
must not be the only online copy used for live recommendations.

## 8. Recommendation generation

Trigger a refresh after a song starts, not at the end of playback. This hides
network latency and leaves time to resolve candidates to playable YouTube IDs.

Engine path:

1. Take up to the last 20 canonical MBID seeds, ordered oldest to newest.
2. Retrieve the subset with vectors in the chosen pipeline.
3. Compute a recency-weighted normalized centroid.
4. Ask Qdrant for more neighbours than needed.
5. Remove seeds, room history, current queue, explicit exclusions, and recently
   rejected candidates.
6. Add future ranking signals such as transition distance, vote feedback,
   artist repetition, tempo/key discontinuity, and source confidence.
7. Return MBIDs and metadata; Convex resolves candidates to playable YouTube
   Music tracks and stores a small ready buffer.

If the engine has no usable candidates, call ListenBrainz Labs for up to the
three most recent seeds. Normalize each seed's scores, merge duplicates, and
exclude room history. Cache responses. If that produces nothing—or the source
order says to skip it—return the fallback-playlist sentinel and let the existing
Convex scheduler choose a host fallback track.

External recommendation failure is normal. Playback must never wait for the
home worker, Qdrant, ListenBrainz, MusicBrainz, or YouTube search.

## 9. Application integration work

The deployed backend is implemented; these product-facing steps remain to wire
it into the current Convex application:

1. Extend room settings with `autoDj.enabled` and validated `sourceOrder`.
2. Add optional canonical MBID and embedding status/version fields to tracks.
3. After a song is accepted, schedule an action that resolves its MBID and
   calls `POST /v1/jobs` without blocking the mutation.
4. Add a room-scoped recommendation buffer containing only lightweight
   candidates and expiry/status metadata—not vectors.
5. When playback starts, schedule a refresh action using recent room history.
6. Resolve returned MBIDs to YouTube candidates, apply the existing playability
   check, and save 3–5 prepared tracks.
7. In the playback transition, preserve the ordering: user queue first, then
   prepared Auto DJ candidate, then host fallback.
8. Add host controls for enabling Auto DJ and reordering the three sources.
9. Label Auto DJ entries and record skips/downvotes as evaluation events.

Keep actions time-bounded. A coordinator outage should mark the refresh as
temporarily unavailable and allow the next scheduled refresh to retry.

## 10. Search remains separate

Search does not enqueue extraction work. Keep the existing minimum-three-
characters behavior, debounce and cancel stale requests in the client, cache
normalized queries locally, and use the CDN-cacheable same-origin search
adapter. A direct browser-to-YouTube-Music implementation is not a supported
public API contract and would be fragile across CORS, undocumented client
protocol changes, and abuse controls.

Only the selected/accepted song crosses into the recommendation pipeline. This
keeps typeahead traffic entirely separate from expensive processing.

## 11. Rollout

### Phase A — coordinator

- Deploy Compose on Oracle with an empty Qdrant store.
- Verify TLS, token rejection, health checks, persistence, and backups.
- Run the Oracle ARM64 worker CPU-only and measure tracks/hour, peak memory, and
  Qdrant latency while extraction is active.
- Optionally run the home worker to measure burst throughput.
- Enqueue a small curated test set and inspect nearest neighbours.

### Phase B — application wiring

- Enqueue accepted tracks idempotently.
- Add source-order settings and recommendation buffer.
- Ship behind an Auto DJ feature flag with fallback-first safety.

### Phase C — coverage

- Design and validate a compact AcousticBrainz feature projection.
- Stream-import a limited genre/sample slice first.
- Measure quality and Qdrant bytes per point before a full import.
- Preserve raw archives at home only if the storage and backup policy justify
  it.

### Phase D — ranking quality

- Compare engine, ListenBrainz, and fallback acceptance/skip rates.
- Add artist and repetition diversity constraints.
- Tune seed weighting and transitions using anonymous room-level events.
- Only investigate CUDA if the CPU backlog remains operationally significant.

## 12. Verification gates

- Duplicate `(mbid, pipeline_version)` enqueues create one job.
- Expired leases are reclaimed; stale owners cannot complete jobs.
- Completion is idempotent across a Qdrant/SQLite crash boundary.
- Temporary audio disappears on success and failure.
- No tokens or vectors enter browser bundles or Convex reactive room payloads.
- Each pipeline version has a separate, dimension-checked collection.
- Recommendation source ordering is validated and honored.
- Engine outage falls through to ListenBrainz; both outages fall through to the
  host playlist.
- Playback remains functional with Oracle and the home PC both offline.
- CPU extraction works on the real home host before any GPU work begins.

## References

- [Deployed backend runbook](deployed-backend/DEPLOY.MD)
- [Essentia Discogs-EffNet model catalogue](https://essentia.upf.edu/models.html)
- [Essentia TensorflowPredictEffnetDiscogs](https://essentia.upf.edu/reference/std_TensorflowPredictEffnetDiscogs.html)
- [Essentia CPU/GPU machine-learning documentation](https://essentia.upf.edu/machine_learning.html)
- [AcousticBrainz data downloads](https://acousticbrainz.org/download)
- [ListenBrainz Labs similar recordings](https://labs.api.listenbrainz.org/similar-recordings)
- [ListenBrainz user recommendation API](https://listenbrainz.readthedocs.io/en/latest/users/api/recommendation.html)
- [Convex limits](https://docs.convex.dev/production/state/limits)
- [Qdrant pricing](https://qdrant.tech/pricing/)
- [Qdrant capacity planning](https://qdrant.tech/documentation/operations/capacity-planning/)
- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)
