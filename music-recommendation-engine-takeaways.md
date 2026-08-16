# Real-Time Session Music Recommendations --- Main Takeaways

## Goal

Build an automatic recommender for a **short-lived shared listening
room**.

-   A room represents one listening session, not a persistent user
    profile.
-   Recommendations should depend primarily on the songs already played
    in that session.
-   Long-term user taste can be added later as a separate signal.
-   **YouTube Music is the playback/music provider** and should remain
    the user-facing catalogue unless a better provider becomes
    necessary.
-   A major desired signal is **songs that actually sound similar**, not
    merely songs consumed by similar users.

## Session Model

For tracks (s_1,`\ldots`{=tex},s_n), represent each track with an
embedding (E(s_i)).

A simple session representation is:

\[ R = `\frac{\sum_i w_i E(s_i)}{\sum_i w_i}`{=tex} \]

Start with equal weighting, or use a mild logarithmic/slow recency
backoff rather than aggressive exponential decay.

For example:

\[ w_i = `\frac{1}{\log_2(2+\mathrm{age}_i)}`{=tex} \]

where `age = 0` is the newest song.

The session state can remain ephemeral and disappear when the room ends.

## Don't Rely Only on a Single Averaged Session Vector

Averaging can fail when a room contains multiple musical clusters. For
example, a session split between Metallica and Taylor Swift could
produce a mean embedding that corresponds poorly to either taste.

A better initial candidate score is:

\[ S(c) = 0.7`\frac{\sum_i w_i\,\cos(E(c),E(s_i))}{\sum_i w_i}`{=tex} +
0.3`\max`{=tex}\_i `\cos`{=tex}(E(c),E(s_i)) \]

This rewards candidates that fit the session overall while allowing a
strong relationship to one particular song.

Then apply penalties such as:

-   recently played track
-   excessive repetition of the same artist
-   duplicates / alternate versions where undesirable

Later, clustering the session history is another option.

## Audio Similarity

For finding songs that **sound similar**, collaborative filtering
algorithms such as ALS/BPR are not the primary tool.

Use a pretrained music/audio model to convert audio into an embedding:

``` text
audio
  ↓
pretrained music model
  ↓
vector (e.g. 512–1024 dimensions)
```

Then similar-sounding songs can be retrieved using cosine similarity /
approximate nearest-neighbour search.

Potential models include:

-   **MERT** --- music-specific representation model
-   **CLAP** --- joint audio/text embeddings; also useful for semantic
    queries such as "melancholic acoustic guitar"

There is no need to train a neural network from scratch initially.

## Offline Preprocessing

Almost all expensive audio analysis can happen offline.

Per track, potentially precompute:

-   audio embedding
-   BPM / tempo
-   key and mode
-   loudness
-   energy
-   genre/tag probabilities
-   vocal vs instrumental characteristics
-   instrumentation/acoustic characteristics

A 768-dimensional FP16 embedding is only about 1.5 KB of raw vector
data, so storing embeddings for millions of tracks is practical.

The expensive/problematic part is obtaining and decoding the audio, not
storing or querying the vectors.

## Lazy Embedding

Do **not** require the entire music catalogue to be processed before
launch.

A better approach:

1.  Seed embeddings for a useful set of popular tracks.
2.  When users encounter previously unseen tracks, enqueue them for
    processing.
3.  Persist the resulting track metadata/embedding.
4.  Every future room benefits from that cached result.

The recommendation database therefore grows according to actual usage.

## YouTube Music

YouTube Music is attractive as the playback/search catalogue because it
contains:

-   mainstream releases
-   obscure music
-   live versions
-   remixes
-   covers
-   unofficial/user-uploaded versions

However, proper YouTube Music search is awkward from an API perspective.

Google's official YouTube Data API is a YouTube API, not a full official
YouTube Music API. Libraries such as `ytmusicapi` reproduce YouTube
Music web behaviour but are unofficial.

For the UI, actual search results can serve as autocomplete:

``` text
user types "radiohead cr"
        ↓
debounce ~100–200 ms
        ↓
YouTube Music search
        ↓
Song / Artist / Album results
```

This is arguably more useful than only returning textual
query-completion strings.

## Separate Playback Identity from Canonical Track Identity

Avoid making the YouTube Music ID your only representation of a song.

A useful internal model is approximately:

``` ts
Track {
    id: UUID,

    // Playback/provider identity
    youtubeMusicId: string,

    // Canonical identity
    musicbrainzRecordingId?: UUID,
    isrc?: string,

    // Metadata
    title: string,
    artist: string,

    // Recommendation
    audioEmbedding?: vector
}
```

This allows recommendation infrastructure to remain independent of the
playback provider.

## MusicBrainz

MusicBrainz is useful as a **canonical metadata/identity layer**, not as
the playback provider.

A recommendation can internally identify a MusicBrainz recording and
then resolve:

``` text
canonical recording
      ↓
artist + title / ISRC
      ↓
YouTube Music search
      ↓
playable YouTube Music ID
```

This avoids coupling the recommender to provider-specific IDs.

## Candidate Generation

Eventually, use several independent sources of recommendation
candidates.

### 1. Audio similarity

``` text
session tracks
    ↓
audio embeddings
    ↓
nearest neighbours
```

Answers:

> What sounds like the music currently being played?

### 2. Collaborative similarity

Use aggregate listening behaviour / ListenBrainz / eventually your own
usage data.

Answers:

> What else do people who listen to these tracks tend to play?

### 3. Metadata relationships

Artist, genre, release, tags, era, etc.

The candidate sets can be unioned and reranked against the current
session.

## ALS / BPR

ALS and BPR are **collaborative filtering** techniques, not
audio-analysis algorithms.

### ALS --- Alternating Least Squares

Factorises a user/session × track interaction matrix:

\[ M `\approx `{=tex}UV\^`\top`{=tex} \]

and learns latent vectors representing behavioural similarity.

Useful for:

> Rooms/users that consume X also tend to consume Y.

### BPR --- Bayesian Personalized Ranking

Learns pairwise ranking preferences so that observed/positive tracks
rank above unobserved/negative tracks.

Both become more useful after accumulating substantial real interaction
data.

They complement audio embeddings rather than replacing them.

## Long-Term Architecture

A strong mature system could combine:

``` text
                       session history
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
    audio similarity    collaborative       metadata
      "sounds like"       behaviour          signals
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
                       candidate union
                             │
                             ▼
                       session reranker
                             │
                   ┌─────────┼─────────┐
                   ▼         ▼         ▼
                diversity  repetition  context
                             │
                             ▼
                     recommended tracks
                             │
                             ▼
                       YouTube Music
```

Later, persistent user taste can simply become another reranking/context
signal without changing the session model.

## Storage / Search

For an initial implementation, **PostgreSQL + pgvector** is likely
sufficient.

Store persistent:

-   canonical track metadata
-   provider IDs
-   embeddings
-   derived audio features
-   eventually global transition/collaborative statistics

Keep room/session history ephemeral in application state, Redis, or a
short-lived database representation.

At millions rather than hundreds of millions of embeddings, pgvector may
be enough before requiring dedicated FAISS/vector-search infrastructure.

## Catalogue Scale

The global streaming catalogue contains hundreds of millions of tracks,
but listening is extremely concentrated in a much smaller subset.

You probably do **not** need to preprocess the complete catalogue.

A reasonable strategy is:

-   seed perhaps 100k--500k popular/relevant tracks
-   lazily process tracks encountered through real usage
-   grow toward the low millions if demand warrants it

A rough earlier estimate was that **a few million tracks could cover a
very large fraction of realistic mainstream listening**, but there is no
precise public dataset establishing an exact "N tracks = 80% of all
plays over 60 years" figure.

## Major Practical Constraint

The difficult part of audio embeddings is **not the ML**.

It is obtaining audio at catalogue scale in a technically and legally
appropriate way.

A pipeline such as:

``` text
YouTube Music
     ↓
audio stream
     ↓
decode sample
     ↓
MERT / CLAP
     ↓
embedding
```

is technically straightforward, but bulk extraction/processing of
YouTube Music audio has API, licensing, copyright and Terms-of-Service
considerations.

Therefore, keep the architecture flexible enough that embeddings or
acoustic features could eventually come from another licensed/open
source while YouTube Music remains the final playback provider.

## Recommended V1

Keep it simple:

``` text
YouTube Music search/playback
           │
           ▼
     canonicalise track
           │
           ▼
     cached embedding
           │
           ▼
    room/session history
           │
           ▼
audio-similarity candidates
           │
           ▼
session-wide similarity score
           │
           ▼
repetition/diversity filtering
           │
           ▼
      recommended song
```

Core principles:

1.  **Session-first**, no persistent user profile required.
2.  **Audio embeddings** for actual sonic similarity.
3.  **Mild or no recency weighting** across the short session.
4.  **Don't rely solely on one averaged room vector**.
5.  **YouTube Music remains the playback/search provider**.
6.  **Canonical IDs should be provider-independent** where possible.
7.  **Precompute/cache embeddings lazily** instead of processing the
    whole world.
8.  Add **collaborative filtering** once sufficient usage data exists.
9.  Add persistent user taste later as an additional signal, not as the
    foundation.
10. Keep audio acquisition separate from the recommendation architecture
    because it is the main external constraint.
