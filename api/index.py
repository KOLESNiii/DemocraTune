"""
The YouTube Music side of DemocraTune.

Everything here exists because ytmusicapi is Python and the rest of the app
isn't. It runs as a single Vercel Function alongside the Next.js frontend, on
the same origin, which is why there is no CORS handling: there is no cross
origin any more.

Routes are declared at their full public paths (`/api/search`, not `/search`)
because Vercel hands a service the original request path rather than a stripped
one.
"""

import asyncio
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Registered against Starlette's class rather than FastAPI's subclass, so the
# handler also covers the framework's own errors - notably the 404 for an
# unmatched route, which FastAPI never routes through its own HTTPException.
from starlette.exceptions import HTTPException as AnyHTTPException
from ytmusicapi import YTMusic

load_dotenv(".env.local")

app = FastAPI()

NO_STORE_HEADERS = {"Cache-Control": "no-store"}


@app.exception_handler(AnyHTTPException)
async def as_error(request: Request, exc: AnyHTTPException) -> JSONResponse:
    """
    Answer failures as `{"error": ...}`.

    FastAPI's default shape is `{"detail": ...}`, but every caller in the
    frontend reads `.error`, and a mismatch here surfaces to the user as a
    generic "please try again" instead of the real reason.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
        headers=NO_STORE_HEADERS,
    )


@app.exception_handler(RequestValidationError)
async def as_validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """A malformed request body, in the same `{"error": ...}` shape as the rest."""
    fields = ", ".join(
        str(part)
        for error in exc.errors()
        for part in error.get("loc", ())
        if part != "body"
    )
    return JSONResponse(
        status_code=422,
        content={"error": f"Invalid request{f': {fields}' if fields else ''}"},
        headers=NO_STORE_HEADERS,
    )


@app.exception_handler(Exception)
async def as_json_error(request: Request, exc: Exception) -> JSONResponse:
    """
    Answer *anything* unhandled as JSON too.

    Without this, an exception nobody anticipated becomes a plain-text "Internal
    Server Error". Every caller in the frontend parses the body as JSON before
    looking at the status, so that reaches the user as a cryptic
    "JSON.parse: unexpected character" rather than as a failed request. The
    detail stays in the server log; the browser just gets something parseable.
    """
    print(f"Unhandled error on {request.url.path}: {exc!r}")
    return JSONResponse(
        status_code=500,
        content={"error": "Something went wrong on our end."},
        headers=NO_STORE_HEADERS,
    )


# ------------------------------
# YouTube Music clients
# ------------------------------

# Both clients are built on first use rather than at import. Constructing one
# makes a network call, and an exception at import time takes down the whole
# function - the caller then gets an HTML error page instead of JSON, which is
# a genuinely confusing failure to debug from the browser.
_anon: YTMusic | None = None
_authed: YTMusic | None = None


def anon() -> YTMusic:
    """The unauthenticated client, used for everything public."""
    global _anon
    if _anon is None:
        _anon = YTMusic()
    return _anon


def authed() -> YTMusic:
    """
    The client tied to the DemocraTune YouTube account.

    Only playlist writes need this. Raises rather than returning None so the
    routes don't each have to re-explain the same missing configuration.
    """
    global _authed
    if _authed is None:
        headers_json = os.environ.get("YTMUSIC_HEADERS_JSON")
        if not headers_json:
            raise HTTPException(
                status_code=503,
                detail="Playlist features aren't configured on this server.",
            )
        _authed = YTMusic(YTMusic.setup(headers_raw=headers_json))
    return _authed


# ------------------------------
# Search
# ------------------------------

# Search is intentionally cheap: one YouTube Music request on a CDN miss and no
# playability fan-out. A selected result is checked by `/api/playable/{videoId}`.
MIN_SEARCH_LENGTH = 3
SEARCH_LIMIT = 12
RESULT_LIMIT = 8
VERIFY_TIMEOUT_SECONDS = 3
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")

# Browsers keep repeat searches locally for an hour. Vercel's CDN can serve a
# query for a day without invoking Python, then continue serving the last good
# response while refreshing it for up to a week. Query parameters form part of
# the cache key, and the client sends normalized lowercase terms to maximise
# hits across users.
SEARCH_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "CDN-Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    "Vercel-CDN-Cache-Control": (
        "public, max-age=86400, stale-while-revalidate=604800"
    ),
}
PLAYABLE_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "CDN-Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000",
    "Vercel-CDN-Cache-Control": (
        "public, max-age=604800, stale-while-revalidate=2592000"
    ),
}
UNPLAYABLE_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    "CDN-Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "Vercel-CDN-Cache-Control": (
        "public, max-age=3600, stale-while-revalidate=86400"
    ),
}

# YouTube Music tags every result with a videoType. The `videos` filter used
# below returns OMV/UGC in practice, so this ranking is mostly defensive - it
# keeps ATV "art tracks" last if the filter ever starts surfacing them, since
# the labels that own those uploads commonly disallow embedded playback. The
# selected result still gets the authoritative oEmbed check below.
VIDEO_TYPE_RANK = {
    "MUSIC_VIDEO_TYPE_OMV": 0,  # official music video
    "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC": 1,
    "MUSIC_VIDEO_TYPE_UGC": 2,  # user upload
    "MUSIC_VIDEO_TYPE_ATV": 3,  # art track - usually embed-blocked
}
UNRANKED = len(VIDEO_TYPE_RANK)


@app.get("/api/search")
async def search(query: str = "", q: str = ""):
    term = " ".join((query or q).split()).lower()
    if len(term) < MIN_SEARCH_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Query must be at least {MIN_SEARCH_LENGTH} characters",
        )

    try:
        raw = await asyncio.to_thread(
            lambda: anon().search(term, filter="videos", limit=SEARCH_LIMIT)
        )
    except Exception as exc:  # noqa: BLE001 - upstream failures shouldn't 500
        print(f"YouTube Music search failed for {term!r}: {exc}")
        raise HTTPException(
            status_code=502, detail="Search is temporarily unavailable"
        ) from exc

    candidates = [song for song in (normalize(item) for item in raw) if song]
    candidates.sort(key=lambda song: song["_rank"])

    results = []
    seen_video_ids = set()
    for song in candidates:
        if song["videoId"] in seen_video_ids:
            continue
        seen_video_ids.add(song["videoId"])
        song.pop("_rank", None)
        results.append(song)
        if len(results) == RESULT_LIMIT:
            break

    return JSONResponse(content=results, headers=SEARCH_CACHE_HEADERS)


def normalize(item):
    """Reshape a raw search hit, or return None if it isn't queueable."""
    if not isinstance(item, dict):
        return None

    video_id = item.get("videoId")
    duration = item.get("duration_seconds")

    # Both are required to queue a song: without a duration the queue can't show
    # or schedule it, and without an id there is nothing to play.
    if not video_id or not duration:
        return None

    artists = [
        {"name": artist["name"]}
        for artist in (item.get("artists") or [])
        if isinstance(artist, dict) and artist.get("name")
    ]

    video_type = item.get("videoType") or ""

    return {
        "videoId": video_id,
        "title": item.get("title") or "Unknown title",
        "artists": artists or [{"name": "Unknown artist"}],
        "duration_seconds": int(duration),
        "videoType": video_type,
        "_rank": VIDEO_TYPE_RANK.get(video_type, UNRANKED),
    }


@app.get("/api/playable/{video_id}")
async def playable(video_id: str):
    """Check only the song the user selected, rather than every search hit."""
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Invalid YouTube video ID")

    can_play = await asyncio.to_thread(is_embeddable, video_id)
    headers = PLAYABLE_CACHE_HEADERS if can_play else UNPLAYABLE_CACHE_HEADERS
    return JSONResponse(content={"playable": can_play}, headers=headers)


def is_embeddable(video_id: str):
    url = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
        {
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "format": "json",
        }
    )
    request = urllib.request.Request(url, headers={"User-Agent": "DemocraTune"})
    try:
        with urllib.request.urlopen(request, timeout=VERIFY_TIMEOUT_SECONDS) as response:
            return response.status == 200
    except urllib.error.HTTPError:
        # 401 = embedding disabled, 403 = restricted, 404 = private or removed.
        return False
    except Exception:  # noqa: BLE001 - timeouts, DNS, TLS
        # Don't punish a song for our own network trouble.
        return True


# ------------------------------
# Browsing
# ------------------------------

# Moods and their playlists are the same for everyone and change about never,
# so let the CDN keep them for a day.
BROWSE_CACHE = "public, max-age=86400"
MOOD_PLAYLIST_LIMIT = 15


@app.get("/api/get-mood-categories")
async def get_mood_categories():
    categories = await asyncio.to_thread(
        lambda: anon().get_mood_categories()["Moods & moments"]
    )
    return JSONResponse(content=categories, headers={"Cache-Control": BROWSE_CACHE})


@app.get("/api/get-mood-playlists")
async def get_mood_playlists(mood_category: str = ""):
    if not mood_category:
        raise HTTPException(status_code=400, detail="Mood category is required")

    playlists = await asyncio.to_thread(
        lambda: anon().get_mood_playlists(mood_category)[:MOOD_PLAYLIST_LIMIT]
    )
    return JSONResponse(content=playlists, headers={"Cache-Control": BROWSE_CACHE})


@app.get("/api/get-playlist")
async def get_playlist(playlistId: str = ""):
    if not playlistId:
        raise HTTPException(status_code=400, detail="playlistId is required")

    try:
        playlist = await asyncio.to_thread(lambda: anon().get_playlist(playlistId))
    except Exception as exc:  # noqa: BLE001 - a bad id shouldn't read as a crash
        raise HTTPException(status_code=404, detail="Playlist not found") from exc

    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


# ------------------------------
# Room history playlists
# ------------------------------


class PlaylistData(BaseModel):
    title: str | None = None
    description: str | None = None


class AddSongData(BaseModel):
    playlistId: str
    videoId: str


class DeletePlaylistData(BaseModel):
    playlistId: str


@app.put("/api/rooms/{room_id}/playlist")
async def create_room_playlist(room_id: str, data: PlaylistData):
    title = data.title or f"DemocraTune Room {room_id}"
    description = data.description or f"Playlist for room {room_id}"

    client = authed()
    try:
        playlist_id = await asyncio.to_thread(
            lambda: client.create_playlist(
                title, description, privacy_status="UNLISTED"
            )
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # The caller saves this against the room.
    return {"playlistId": playlist_id}


@app.post("/api/rooms/{room_id}/playlist")
async def add_song(room_id: str, data: AddSongData):
    client = authed()
    try:
        await asyncio.to_thread(
            lambda: client.add_playlist_items(data.playlistId, [data.videoId])
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"status": "added"}


@app.delete("/api/rooms/{room_id}/playlist")
async def delete_room_playlist(room_id: str, data: DeletePlaylistData):
    client = authed()
    try:
        await asyncio.to_thread(lambda: client.delete_playlist(data.playlistId))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"status": "deleted"}
