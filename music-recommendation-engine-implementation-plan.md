# Music Recommendation Engine — Implementation and Hosting Plan

Last reviewed: 2026-08-16

## 1. Executive decision

Build the recommender as an extension of the existing Convex backend rather
than as a new always-on service:

- Keep Next.js and the existing Python YouTube Music adapter on Vercel.
- Keep rooms, history, canonical tracks, recommendation jobs, recommendation
  buffers, and vector search in Convex.
- Run audio embedding inference asynchronously on Modal, scaled to zero.
- Generate recommendations while a song is playing, never while the client is
  waiting for the next song.
- Continue playing normally when recommendation generation is slow or fails.
- Do not add PostgreSQL, Redis, Qdrant, Kafka, or a standalone API server for
  V1.

The target runtime flow is:

```text
song begins playing
        |
        +--> Convex schedules a recommendation refresh
                    |
                    +--> load recent room history
                    +--> query cached audio vectors
                    +--> union audio / collaborative / metadata candidates
                    +--> rerank and remove repeats
                    +--> resolve playable YouTube Music IDs
                    +--> save 3-5 ready-to-play recommendations

song ends
        |
        +--> Convex mutation selects, in order:
             1. a user-queued song
             2. a prepared recommendation (when Auto DJ is enabled)
             3. the host's fallback playlist
             4. silence / the existing empty-room state
```

This is the lowest-complexity design that fits the existing app and keeps the
client path fast. It also keeps each expensive operation outside the playback
transition.

## 2. What already exists and should be reused

The current code has most of the non-ML foundation:

- `src/convex/schema.ts` already has short-lived rooms, queue rows, history,
  votes, and a service-independent `tracks` catalogue.
- `src/convex/playback.ts` is the single transition point for song completion,
  host skips, and vote skips. This is the correct integration point for
  refreshing and consuming recommendations.
- `src/convex/scheduling.ts` already guarantees that user songs precede
  fallback songs and applies the selected fairness algorithm.
- `src/convex/tracks.ts` lazily creates canonical track rows and already uses
  scheduled actions for external enrichment.
- `src/convex/rooms/manage.ts` expires rooms after 48 hours and the room deletion
  trigger removes room-scoped data.
- `api/index.py` already supplies same-origin YouTube Music search and performs
  a playback-embeddability check.
- `src/components/host/player.tsx` advances through one Convex mutation and has
  failure handling for unplayable YouTube videos.
- Vercel already deploys Next.js and the Python function, while Convex owns the
  live reactive state.

The recommender should fit these boundaries rather than create a parallel room,
queue, or identity system.

## 3. Important release constraint: audio rights

Actual audio similarity requires access to audio samples. YouTube's current
developer policies prohibit downloading/caching YouTube audiovisual content
and separating its audio without prior written approval. Therefore:

- YouTube Music remains the search and playback destination.
- DemocraTune must not download YouTube audio to create embeddings.
- Every stored audio embedding needs a recorded, auditable source and rights
  basis: owner-provided, openly licensed, contractually licensed, or supplied
  by a provider that explicitly permits this processing.
- Apple promotional previews are not a general workaround: Apple's Search API
  terms allow them for store promotion and say they must be streamed rather
  than downloaded or cached.
- If no permitted audio source exists for a track, mark it `unavailable` and
  use collaborative/metadata candidates. Do not repeatedly retry it.

This makes audio-source approval a launch gate for the sonic-similarity part,
not for the whole recommender. A useful recommendation product can ship first
with ListenBrainz, metadata, and YouTube Music radio candidates, then add true
audio similarity to the subset with authorized embeddings.

MERT is a good technical benchmark, but the published `MERT-v1-95M` weights are
CC-BY-NC-4.0. They are suitable only while this remains a non-commercial use
that complies with that licence. Benchmark at least one commercially
permissive alternative before treating the model as permanent. Hide the model
behind an embedding adapter and version every vector.

## 4. Product behavior for V1

Add an optional room setting:

```ts
autoDj: {
    enabled: boolean
    preferRecommendationsOverFallback: boolean // default true when enabled
}
```

Behavior:

1. User-added songs always win and retain the existing fair scheduler.
2. With Auto DJ enabled, a prepared recommendation fills an otherwise empty
   user queue.
3. The host fallback playlist is the safety net if no recommendation is ready.
4. With Auto DJ disabled, behavior is exactly as it is today.
5. A recommendation is visibly labelled "Recommended for this room" and is
   unowned, so it cannot affect a user's rating.
6. Existing voting applies. A poorly received recommendation becomes useful
   feedback for evaluation and later ranking improvements.
7. Do not generate recommendations until the room has at least two completed
   tracks, unless the host explicitly chooses a one-track radio start.

Keep the first release session-only. Do not add durable user taste profiles or
ALS/BPR training yet.

## 5. Data model changes

### 5.1 Extend the canonical track

Add optional fields to `tracks` so the migration remains backward compatible:

```ts
musicbrainzRecordingId?: string
canonicalMatchConfidence?: number
lastUsedAt?: number
playCount?: number
embeddingStatus?: "pending" | "ready" | "unavailable" | "failed"
embeddingVersion?: string
```

Add indexes:

```ts
.index("by_musicbrainz_recording", ["musicbrainzRecordingId"])
.index("by_youtube_id", ["providerIds.youtube"])
```

Do not put the vector directly on `tracks`. Normal room/history reads should
not repeatedly transfer several kilobytes of vector data.

The existing normalized `artist|title` fingerprint can remain the initial
lookup key, but it should not be treated as definitive canonical identity.
Record the match confidence and duration difference. Later, introduce a
provider-alias table if covers, remasters, live recordings, and alternate
uploads are being collapsed incorrectly.

### 5.2 Add `trackEmbeddings`

```ts
trackEmbeddings: defineTable({
    track: v.id("tracks"),
    modelVersion: v.string(), // e.g. "audio-v1-512"
    embedding: v.array(v.float64()),
    normalized: v.boolean(),
    sourceKind: v.string(), // open, licensed, owner-provided, etc.
    sourceReference: v.optional(v.string()),
    rightsBasis: v.string(),
    features: v.optional(
        v.object({
            tempo: v.optional(v.number()),
            energy: v.optional(v.number()),
        }),
    ),
    createdAt: v.number(),
})
    .index("by_track_model", ["track", "modelVersion"])
    .vectorIndex("by_embedding", {
        vectorField: "embedding",
        dimensions: 512,
        filterFields: ["modelVersion"],
        staged: true,
    })
```

Standardize V1 on 512 dimensions. If the selected model outputs 768 values,
evaluate a fixed PCA projection as part of the quality benchmark. A smaller
index materially extends the Convex free tier, and one fixed dimension makes
model upgrades operationally manageable.

### 5.3 Add `embeddingJobs`

```ts
embeddingJobs: defineTable({
    track: v.id("tracks"),
    modelVersion: v.string(),
    status: v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("complete"),
        v.literal("blocked"),
        v.literal("failed"),
    ),
    attempt: v.number(),
    nextAttemptAt: v.number(),
    leaseUntil: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    updatedAt: v.number(),
})
    .index("by_track_model", ["track", "modelVersion"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"])
```

The job row provides idempotency, retry state, cost controls, and operator
visibility. The audio URL or credential must not come from the browser.

### 5.4 Add `roomRecommendations`

```ts
roomRecommendations: defineTable({
    room: v.id("rooms"),
    generation: v.number(),
    rank: v.number(),
    track: v.id("tracks"),
    videoId: v.string(),
    title: v.string(),
    artist: v.string(),
    duration: v.number(),
    score: v.number(),
    sources: v.array(v.string()),
    reason: v.string(),
    status: v.union(
        v.literal("ready"),
        v.literal("consumed"),
        v.literal("rejected"),
    ),
    expiresAt: v.number(),
})
    .index("by_room_generation_rank", ["room", "generation", "rank"])
    .index("by_room_status", ["room", "status"])
```

Add `recommendationGeneration` to `rooms`. Every refresh increments it. A slow
action may only save results if its generation still matches, preventing stale
results from replacing a newer buffer.

Delete these rows in the existing room cascade trigger.

### 5.5 Extend the song source discriminator

Add `"recommendation"` to the song `type` validator used by `currentSong` and
history. Do not add recommendation rows to `queuedSongs`; keeping a separate
buffer prevents them from interfering with FCFS, round-robin, and weighted
fairness.

## 6. Canonicalisation and enrichment pipeline

Run this lazily whenever a track is first encountered, preferably as soon as
it is added rather than only after it has finished playing:

1. Upsert the existing `tracks` record.
2. Resolve or verify a MusicBrainz recording ID from ISRC first, then from
   normalized artist/title/duration.
3. Respect MusicBrainz's one-request-per-second guidance, set a meaningful
   contactable User-Agent, cache misses, and jitter background work.
4. Store match confidence. Do not merge low-confidence results automatically.
5. Query ListenBrainz's hosted recording datasets for collaborative neighbours,
   tags, and popularity where an MBID is available.
6. Retain the YouTube video ID as the playback identity.
7. Enqueue an audio embedding only when a permitted source has been found.

Move generic provider resolution out of `tracks.ts` into small adapters so the
pipeline can independently retry MusicBrainz, ListenBrainz, Odesli, and YouTube
resolution.

## 7. Embedding worker

### 7.1 Worker contract

Deploy a private Modal web function or queued function with this logical
contract:

```json
{
    "jobId": "...",
    "trackId": "...",
    "source": { "kind": "licensed", "reference": "..." },
    "modelVersion": "audio-v1-512"
}
```

Response:

```json
{
    "modelVersion": "audio-v1-512",
    "dimension": 512,
    "normalizedEmbedding": [0.01, -0.03],
    "features": {
        "tempo": 120.4,
        "energy": 0.72
    }
}
```

The worker must:

- authenticate requests from Convex;
- fetch audio only from an approved source adapter;
- decode a bounded sample rather than an entire recording where permitted;
- resample to the model's expected rate;
- take several fixed windows (for example early/middle/late), embed each, mean
  pool, and L2-normalize;
- return a stable 512-dimensional vector;
- delete temporary audio before returning;
- log model version and timing but not credentials or signed URLs;
- be idempotent by `jobId` and `modelVersion`.

### 7.2 Model selection gate

Benchmark MERT-v1-95M, a CLAP-family audio encoder, and at least one model with
clearly commercial-compatible weights. Evaluate on 100-300 manually labelled
track pairs and 30 realistic mixed-room sessions.

Select the model only after measuring:

- same-recording/alternate-upload retrieval;
- timbre/instrumentation similarity;
- genre and mood similarity;
- false similarity caused only by artist identity;
- CPU/GPU seconds per track;
- cold-start time and container size;
- licence compatibility.

The embedding interface and `modelVersion` must allow replacement without a
schema rewrite. Never mix vectors from different versions in one scoring run.

### 7.3 Retry behavior

Convex scheduled actions are at-most-once and are not automatically retried.
Implement explicit retries:

- network/429/5xx: exponential backoff with jitter, maximum 5 attempts;
- unauthorized/no permitted audio: mark `blocked`, no retry;
- deterministic decode/model failure: mark `failed`, retry only after a model
  version change;
- expired source URL: re-resolve once, then back off;
- lease timeout: a cron returns abandoned `running` jobs to `pending`.

Cap concurrency at a small number (initially 2) and cap new embeddings per day
(initially 200). These limits protect both the source provider and free credits.

## 8. Candidate generation

Use a union of independent sources. The system should remain useful when any
one source is unavailable.

### 8.1 Audio candidates

For a room with embedded history:

1. Load the most recent 20-30 played tracks and their vectors.
2. Assign `w_i = 1 / log2(2 + age_i)`.
3. Build a weighted session-mean vector.
4. Query Convex vector search for approximately 80 neighbours of the mean.
5. Query approximately 30 neighbours for up to three anchors: the newest track
   and two diverse representative tracks.
6. Union and deduplicate the result IDs.

Convex vector search accepts one query vector at a time and runs only in an
action, so these searches belong in the background recommendation action, not
in a query or playback mutation.

### 8.2 Collaborative candidates

For recent tracks with MusicBrainz IDs, query and cache ListenBrainz similar
recordings. Limit the number of seed tracks and run calls in parallel only
within the provider's published expectations. Treat the Labs dataset hoster as
an optional, no-SLA source.

This source answers "people who played this also played..." and provides useful
coverage before audio embeddings exist.

### 8.3 YouTube Music radio candidates

Add a cached Python endpoint around `ytmusicapi.get_watch_playlist` for a small
number of recent seed video IDs. This is cheap and maps directly to playable
IDs, but it remains an unofficial integration and must never be the only
candidate source.

### 8.4 Metadata candidates

Use MusicBrainz/ListenBrainz tags, artist relationships, era, and popularity to
fill sparse cases. Keep this deterministic and cache responses on the canonical
track.

## 9. Exact reranking

ANN retrieves candidates; it should not make the final decision. Load candidate
vectors and compute exact cosine scores against every embedded session track:

```text
base(c) = 0.7 * weighted_mean_i(cos(c, s_i))
        + 0.3 * max_i(cos(c, s_i))
```

Then apply:

- hard exclusion for the current track, queued tracks, and recently played
  canonical tracks;
- hard exclusion for the same YouTube video ID;
- penalty for the same artist appearing too recently;
- penalty for likely alternate versions with the same normalized title/artist;
- small boost when two independent candidate sources agree;
- source-confidence penalty for uncertain canonical matches;
- playability requirement before saving a ready recommendation;
- Maximal Marginal Relevance or a simple greedy diversity pass across the
  final 3-5 tracks.

Start with fixed, readable constants in a pure TypeScript scorer. Do not train a
ranking model yet. Record source scores so offline evaluation can reproduce
every choice.

Do not use dislikes as negative embeddings in the first release. First collect
evidence. Later, compare a simple satisfaction multiplier or a negative-profile
term using high-dislike tracks.

## 10. Resolving candidates back to YouTube Music

For every selected canonical candidate:

1. Reuse `providerIds.youtube` if it was recently verified.
2. Otherwise call a private absolute-URL endpoint on the existing Vercel Python
   API with title, artist, duration, and optional ISRC/MBID.
3. Search YouTube Music, score metadata/duration matches, and run the existing
   oEmbed playability check.
4. Cache the winning video ID and verification timestamp.
5. Drop a candidate if no confident playable result exists; do not delay the
   whole buffer.

The existing Convex actions that call `/api/...` with relative URLs should be
standardized on an environment variable such as `PUBLIC_API_BASE_URL`; server
actions do not have the browser's origin context.

## 11. Playback integration

Refactor `getNextSong`/`advanceRoom` into a discriminated next-playback helper:

```ts
type NextPlayback =
    | { source: "queue"; song: Doc<"queuedSongs"> }
    | { source: "recommendation"; song: Doc<"roomRecommendations"> }
    | null
```

Selection algorithm:

1. Ask the existing scheduler for its first row.
2. If it is user-added, use it.
3. If it is fallback and Auto DJ is enabled, atomically consume the first ready
   recommendation instead.
4. Otherwise use the fallback row.
5. Copy only playback fields into `rooms.currentSong` and mark its type.
6. Archive the old song exactly once as today.
7. After commit, schedule a buffer refresh for the new room generation.

The playback mutation must not call vector search, MusicBrainz, ListenBrainz,
YouTube Music search, or Modal. Its worst-case fallback is the existing queue
behavior.

Also refresh when:

- the first song begins;
- a track is added and the prepared buffer is now invalid;
- a recommendation is rejected/skipped;
- a recommendation buffer is close to expiry.

Deduplicate refresh requests by generation so reactive client updates do not
create backend work.

## 12. Client and UX work

### Host room setup

- Add an "Auto DJ" switch with a concise explanation.
- Default it off during beta; preserve saved behavior for old rooms.
- Explain that fallback playlist songs are used when no recommendation is
  ready.

### Host and listener queue

- Render recommendation source separately from "added by".
- Show a short reason such as "fits this room's recent mix" or "similar to X";
  do not expose raw scores.
- Keep the recommendation buffer out of the visible user queue unless showing
  it is a deliberate product choice. Revealing all candidates encourages users
  to game or prematurely judge them.

### Perceived performance

- No browser request should wait for an embedding or recommendation run.
- Subscribe to the saved recommendation status through Convex only where the UI
  needs it.
- Lazy-load any recommendation explanation panel.
- Preserve the current optimistic queue advance for normal queued songs; add a
  conservative optimistic case for already-saved recommendations only.
- Cache Python search/radio responses at the CDN with bounded `s-maxage` and
  `stale-while-revalidate`.

## 13. Free-tier hosting design

### Vercel Hobby — frontend and lightweight provider adapter

Keep:

- Next.js App Router;
- static/SSR pages;
- `api/index.py` search, radio, playability, and canonical-to-YouTube resolution.

As of this review, Hobby includes 1 million function invocations, 4 active CPU
hours, 360 GB-hours of provisioned memory, and 100 GB Fast Data Transfer per
month. Hobby is restricted to personal, non-commercial use; if DemocraTune
becomes commercial, Vercel Pro or another host must be included in the budget.
Do not load MERT/CLAP in a Vercel function: model size, cold start, and active
CPU would consume the allowance and harm search latency.

### Convex Free — realtime state, jobs, and vectors

As of this review, Free includes 0.5 GB database storage, 0.5 GB shared
text/vector search storage, 1 GB database I/O per month, 1 million function
calls, 20 GB-hours of action compute, and 3,000 search query-GB per month.

A 512-value Convex vector is stored as float64 values, so the raw values alone
are roughly 4 KiB per track before document and vector-index overhead. Start
with a hard operational target of 25,000 embedded tracks, measure actual search
storage, and stop new low-value embeddings at 70% of the free allowance. Do not
assume the FP16 storage estimate from the takeaways applies to Convex.

Use `npx convex deployment usage --json` in a scheduled CI report and configure
Convex usage limits/alerts.

### Modal Starter — embedding inference only

As of this review, Modal Starter is $0 and includes $30/month of compute credit;
T4 GPU time is listed at $0.000164/second. Functions scale to zero by default.

Use:

- `min_containers=0`;
- a bounded `scaledown_window` only if measurements justify it;
- a T4 initially;
- model weights baked into the image or a Modal Volume;
- batch multiple pending tracks per cold start;
- no public unauthenticated endpoint.

At the listed T4 rate, the included credit is far more inference time than a
small beta should need, but cold-start/model-loading time is still billable and
must be measured.

### External metadata

- MusicBrainz: free for non-commercial use, no API key, meaningful User-Agent,
  maximum one request/second per application/IP unless agreed otherwise.
- ListenBrainz dataset/API: use as a cached optional candidate source and plan
  for outages or response changes.
- YouTube Music through `ytmusicapi`: already used, but unofficial; isolate it
  behind the Python adapter and cache aggressively.

### Expected baseline cost

```text
Vercel Hobby       $0
Convex Free        $0
Modal Starter      $0 while monthly work remains inside the $30 credit
MusicBrainz/LB     $0 for the current non-commercial use and rate limits
Domain             existing cost
---------------------------------------------------------------
Expected beta      $0/month incremental infrastructure cost
```

Free tiers are hard capacity ceilings, not reliability guarantees. The product
must degrade to the existing queue/fallback behavior rather than stop playback.

### First paid step if usage grows

Do not re-architect first. Move Convex from Free to Starter for metered overage
and pay Modal overage only after measuring it. At current published rates,
small search-storage overage is likely cheaper than operating and maintaining a
second vector database.

Consider a dedicated vector store only when measured index size/query cost or
catalogue scale—not a forecast—requires it.

## 14. Cost controls

Implement these before enabling Auto DJ broadly:

- at most one active recommendation generation per room;
- a 3-5 track buffer, not an unbounded generated playlist;
- maximum 20-30 history vectors per run;
- maximum four Convex vector searches per generation;
- maximum 256 ANN results per search, normally much less;
- cache provider candidates for 7-30 days according to source stability;
- cache failed canonical/audio resolutions with reason-specific TTLs;
- embed a track once per model version globally, never once per room;
- daily embedding limit and maximum worker concurrency;
- prioritize embedding tracks by global play count and recency;
- stop automatic catalogue growth when Convex search storage reaches 70%;
- sampled recommendation-run telemetry rather than a verbose row per scoring
  intermediate;
- alerts at 50%, 70%, and 90% of Vercel, Convex, and Modal allowances.

## 15. Security and privacy

- Keep Modal tokens, source credentials, and Convex deploy keys server-only.
- Authenticate Convex-to-Modal calls with a short-lived signed request or
  provider-native private invocation; include timestamp and job ID to prevent
  replay.
- Validate response dimension, finite numeric values, and L2 norm before
  writing a vector.
- Restrict all job/result mutations to `internalMutation`.
- Apply rate limiting to public search/radio endpoints and never allow a client
  to choose an arbitrary URL for the worker to fetch (SSRF risk).
- Store rights provenance but avoid storing expiring signed source URLs.
- Keep room history ephemeral with room deletion as it is today.
- Global aggregate play counts must not contain user identity.
- Update privacy/terms text before collecting any new durable listening
  aggregate or using YouTube API Services beyond the current behavior.

## 16. Observability and quality metrics

Record low-cardinality metrics:

- recommendation refresh requested/completed/failed;
- buffer ready latency p50/p95;
- source coverage: audio, collaborative, metadata, YouTube radio;
- percentage of played tracks with canonical ID and embedding;
- candidate-to-playable-YouTube resolution rate;
- recommendation selected, skipped, liked, and disliked;
- fallback activation because no recommendation was ready;
- duplicate/artist-repeat filters applied;
- Modal inference seconds and cold-start count;
- Convex vector query count and indexed-track count.

Suggested release targets:

- playback transition p95 under 250 ms excluding client network latency;
- prepared recommendation available before song end in at least 95% of eligible
  rooms;
- at least 90% of saved recommendations pass playability verification;
- no regression in user-song ordering for any scheduler;
- no recommendation repeats from the last 20 canonical tracks;
- recommendation skip/downvote rate no worse than the host fallback baseline
  before enabling by default.

Use PostHog for product aggregates already sent from the client, and Convex/
Modal/Vercel logs for backend failures. Do not send embedding vectors or source
credentials to analytics.

## 17. Testing strategy

### Unit tests

- recency weights and empty/single/mixed-session behavior;
- exact `0.7 mean + 0.3 max` score;
- vector normalization and cosine math;
- duplicate, recent-track, and artist penalties;
- deterministic diversity ordering and tie breaks;
- generation-version stale-write rejection;
- candidate-source union and provenance;
- canonical match duration/confidence rules.

### Convex functional tests

- user song beats recommendation and fallback;
- recommendation beats fallback only when Auto DJ is enabled/configured;
- all three existing schedulers preserve user fairness;
- recommendation consumption is atomic under two simultaneous advances;
- old song is archived once under end/skip/vote races;
- failed/stale generation cannot replace the current buffer;
- room deletion removes `roomRecommendations` but preserves reusable global
  track embeddings and embedding jobs;
- missing vectors and provider outages fall back safely.

### Python API tests

- radio/search normalization;
- canonical candidate duration matching;
- oEmbed verification timeout/fallback;
- cache headers and error JSON contract;
- no untrusted URL reaches a fetch primitive.

### Worker contract tests

- approved vs forbidden source kinds;
- fixed output dimension and normalization;
- temporary file cleanup;
- idempotency and model versioning;
- timeout, corrupt audio, and out-of-memory handling.

### End-to-end tests

- create Auto DJ room, play two fixtures, observe a prepared recommendation,
  exhaust user queue, and advance into it;
- add a user song just before advance and verify it wins;
- simulate worker/provider failure and verify fallback continues;
- vote-skip a recommendation and verify history/votes remain correct.

Use deterministic synthetic vectors and stub provider responses in CI. Do not
make CI quality depend on live YouTube, MusicBrainz, ListenBrainz, or Modal.

## 18. Deployment and CI/CD

### Environments

```text
local    Next.js + local/cloud Convex dev + stub or Modal dev worker
preview  Vercel Preview + fresh Convex preview deployment + stub embeddings
prod     Vercel Production + Convex Production + Modal Production
```

Preview deployments should not point at production Convex data. Convex supports
a Preview Deploy Key that creates a fresh backend per Vercel branch.

### Fix the current build behavior

The current `vercel-build` deploys Convex only when `VERCEL_ENV=production`.
Change it to run the same `convex deploy --cmd ...` flow for both Preview and
Production, with environment-scoped deploy keys:

- production `CONVEX_DEPLOY_KEY`: production deploy key;
- preview `CONVEX_DEPLOY_KEY`: preview deploy key;
- optional `--preview-run` function: insert synthetic recommendation fixtures,
  never production catalogue data.

### CI gates on every pull request

1. Install the pinned Bun version and dependencies from `bun.lock`.
2. Run formatting/lint checks.
3. Run `bun run typecheck`.
4. Run unit and functional tests.
5. Run Python tests.
6. Run `bun run build`.
7. Deploy the Vercel/Convex preview.
8. Run Playwright against the preview with provider/worker stubs.

Pin CLI/action versions rather than installing `latest` during CI.

### Production rollout order

Use multiple backward-compatible deployments:

1. **Schema deployment:** optional fields, new tables, and staged vector index;
   feature flag off.
2. Wait for the vector index to report ready.
3. **Worker deployment:** Modal image/function and secrets; exercise with test
   audio whose rights are known.
4. **Backend deployment:** canonicalisation, jobs, candidate generation,
   reranking, and buffer writing; feature flag off.
5. Seed a small authorized catalogue and verify storage/inference cost.
6. **UI deployment:** host Auto DJ setting, labels, and status; enable only for
   an allowlist/beta percentage.
7. Expand gradually after quality and cost thresholds hold for at least one
   week.

Deploy the worker before code that calls a new worker contract. Keep the old
worker model/version available until no active job references it.

### Secrets/configuration

Vercel:

- production and preview Convex deploy keys;
- `NEXT_PUBLIC_CONVEX_URL` supplied by the Convex deploy command;
- existing YouTube Music auth secret;
- `PUBLIC_API_BASE_URL` where needed by server-to-server callers.

Convex:

- Modal invocation secret/credentials;
- production Vercel API base URL;
- MusicBrainz contact User-Agent;
- active embedding model version;
- feature flag and daily/concurrency limits.

Modal:

- expected Convex caller secret/verification key;
- approved audio-source credentials;
- model version/configuration.

Never expose these with a `NEXT_PUBLIC_` prefix except the public Convex URL.

### Rollback

- Turn off Auto DJ in one Convex environment variable/feature flag.
- Existing user queue and fallback path remains functional.
- Old clients tolerate optional schema fields.
- Do not remove a vector field/index or old model version during an emergency
  rollback.
- Roll back Vercel by promoting the last known-good deployment.
- Roll back Modal independently to the prior worker version.

## 19. Delivery milestones

### Milestone 0 — baseline and decisions (2-3 days)

- Define Auto DJ priority/UX.
- Confirm non-commercial/commercial intent.
- Approve an audio source or explicitly scope sonic similarity to an authorized
  seed corpus.
- Capture current queue transition latency, skip rate, fallback use, Vercel
  usage, and Convex usage.
- Build a fixed evaluation session set.

Exit: product behavior and rights basis are written down; baseline metrics
exist.

### Milestone 1 — recommendation skeleton (4-6 days)

- Add optional schema fields and room recommendation buffer.
- Refactor playback selection without changing current behavior.
- Implement pure deterministic scorer, repeat filters, and diversity pass.
- Add collaborative, metadata, and YouTube radio candidate adapters with
  caching.
- Add feature flag and test fixtures.

Exit: background recommendations work without audio vectors and every failure
falls back to today's queue.

### Milestone 2 — vector storage and model benchmark (5-8 days)

- Add staged Convex vector index and embedding job table.
- Implement Modal worker and Convex retry/lease flow.
- Benchmark candidate models and 512-dimensional projection if needed.
- Seed only authorized test/popular tracks.
- Measure real Convex storage per 1,000 vectors and Modal cost per 1,000 tracks.

Exit: model/licence gate passed, quality report accepted, measured capacity
replaces estimates.

### Milestone 3 — session audio reranker (4-6 days)

- Implement mean/anchor ANN retrieval.
- Implement exact session-wide mean/max scoring.
- Union all sources and resolve to playable YouTube IDs.
- Precompute and atomically save the buffer.
- Add backend metrics and operational limits.

Exit: prepared buffer meets latency/playability targets in staging.

### Milestone 4 — beta UX and deployment (3-5 days)

- Add host control and recommendation labels.
- Configure Convex preview deployments and CI stubs.
- Run full E2E, concurrency, and provider-failure tests.
- Enable for an allowlist or 5-10% of rooms.

Exit: one week inside cost limits with no queue regressions.

### Milestone 5 — controlled expansion

- Raise rollout percentage gradually.
- Prioritize embeddings by real global usage.
- Compare recommendation skip/like rate with fallback baseline.
- Tune constants from evidence.
- Only then consider vote-aware ranking, session clustering, long-term taste,
  or ALS/BPR.

## 20. Work breakdown by repository area

```text
src/convex/schema.ts
  optional track fields, Auto DJ setting, embeddings/jobs/recommendations

src/convex/tracks.ts
  earlier upsert, canonicalisation orchestration, embedding enqueue

src/convex/recommendations.ts (new)
  generation lifecycle, ANN, reranking, buffer writes/reads

src/convex/embeddingJobs.ts (new)
  leases, retries, worker call, validated vector save

src/convex/playback.ts
  source-aware next playback and refresh scheduling

src/convex/scheduling.ts
  expose user/fallback distinction without changing fairness

src/convex/functions.ts
  room deletion cascade for recommendation data; absolute server API URLs

src/convex/crons.ts
  abandoned-job recovery, expired buffer cleanup, usage aggregation

api/index.py
  cached radio candidates and canonical-to-YouTube resolver

worker/modal_app.py (new)
  authorized audio fetch, decode, model inference, normalization

src/components/host/create-room.tsx
  Auto DJ setting

src/components/host/queue.tsx
src/components/room/current-song.tsx
src/components/room/history.tsx
  source label/reason presentation

tests/unit/recommendations.test.ts (new)
tests/functional/recommendations.test.tsx (new)
tests/e2e/recommendations.spec.ts (new)
tests/python/test_recommendations.py (new)
  deterministic coverage described above
```

## 21. Explicit non-goals for V1

- persistent personal taste profiles;
- training a neural network from scratch;
- ALS/BPR before enough real interaction data exists;
- preprocessing the full YouTube Music catalogue;
- downloading or extracting YouTube audio;
- a separate Postgres/pgvector, Redis, vector DB, or queue cluster;
- synchronous recommendation generation from a client request;
- guaranteeing a recommendation when providers or free-tier services are down;
- replacing the host's and listeners' explicit queue decisions.

## 22. Go/no-go checklist

Do not enable Auto DJ in production until all are true:

- [ ] Audio source and model licences are documented and acceptable.
- [ ] Existing user/fallback queue behavior passes regression tests.
- [ ] Playback transition performs no external network/ML call.
- [ ] Recommendation generation is idempotent and stale writes are rejected.
- [ ] Every saved recommendation has a recently verified playable YouTube ID.
- [ ] Provider/worker failures fall back without interrupting playback.
- [ ] Actual vector storage and inference cost have been measured.
- [ ] Usage alerts and hard caps are configured.
- [ ] Preview deployments use isolated Convex data.
- [ ] Privacy/terms changes are complete where required.
- [ ] Beta quality is at least as good as the fallback-playlist baseline.

## 23. References used for hosting and feasibility

- [Convex vector search](https://docs.convex.dev/search/vector-search)
- [Convex limits and free-tier quotas](https://docs.convex.dev/production/state/limits)
- [Convex scheduled-function guarantees](https://docs.convex.dev/scheduling/scheduled-functions)
- [Convex with Vercel previews](https://docs.convex.dev/production/hosting/vercel)
- [Vercel function usage and pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel Hobby plan and non-commercial restriction](https://vercel.com/docs/plans/hobby)
- [Vercel platform limits](https://vercel.com/docs/limits)
- [Modal pricing](https://modal.com/pricing)
- [Modal scale-to-zero behavior](https://modal.com/docs/guide/scale)
- [MERT-v1-95M model card and licence](https://huggingface.co/m-a-p/MERT-v1-95M)
- [MusicBrainz API and rate limit](https://musicbrainz.org/doc/MusicBrainz_API)
- [ListenBrainz hosted datasets](https://labs.api.listenbrainz.org/)
- [YouTube developer policy guidance](https://developers.google.com/youtube/terms/developer-policies-guide)
- [Apple iTunes Search API terms](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/)
