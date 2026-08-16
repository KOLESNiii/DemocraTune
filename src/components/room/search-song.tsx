"use client"

import { formatDuration } from "@/lib/utils"
import { LoaderCircleIcon, PlusCircleIcon, SearchXIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ImageWithFallback } from "../image-with-fallback"
import { Input } from "../ui/input"
import { SubmitButton } from "../ui/submit-button"

type SearchResult = {
    videoId: string
    title: string
    artists: { name: string }[]
    duration_seconds: number
}

const MIN_SEARCH_LENGTH = 3
const SEARCH_DEBOUNCE_MS = 350
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_CACHED_SEARCHES = 100

const searchCache = new Map<
    string,
    { results: SearchResult[]; expiresAt: number }
>()

function normalizeQuery(query: string) {
    return query.trim().replace(/\s+/g, " ").toLowerCase()
}

export function SearchSong({
    onSelect,
    disabled = false,
}: {
    onSelect: (song: {
        videoId: string
        title: string
        artist: string
        duration: number
    }) => Promise<void>
    disabled?: boolean
}) {
    const [query, setQuery] = useState("")
    const [results, setResults] = useState<SearchResult[]>([])
    const [error, setError] = useState<string | null>(null)
    const [searched, setSearched] = useState(false)
    const [searching, setSearching] = useState(false)
    const requestSequence = useRef(0)

    useEffect(() => {
        const normalizedQuery = normalizeQuery(query)
        const requestId = ++requestSequence.current

        setError(null)
        if (normalizedQuery.length < MIN_SEARCH_LENGTH) {
            setResults([])
            setSearched(false)
            setSearching(false)
            return
        }

        const cached = searchCache.get(normalizedQuery)
        if (cached && cached.expiresAt > Date.now()) {
            setResults(cached.results)
            setSearched(true)
            setSearching(false)
            return
        }
        if (cached) searchCache.delete(normalizedQuery)

        const controller = new AbortController()
        const timer = window.setTimeout(async () => {
            setSearching(true)

            try {
                const response = await fetch(
                    `/api/search?query=${encodeURIComponent(normalizedQuery)}`,
                    {
                        signal: controller.signal,
                        headers: {
                            "ngrok-skip-browser-warning": "true",
                        },
                    },
                )
                const body: unknown = await response.json()

                if (requestId !== requestSequence.current) return

                // The API answers with `{ error }` on failure, so anything
                // that isn't an array would blow up the list below.
                if (!response.ok || !Array.isArray(body)) {
                    setResults([])
                    setSearched(true)
                    setError(
                        typeof (body as { error?: unknown })?.error === "string"
                            ? (body as { error: string }).error
                            : "Failed to search for songs. Please try again.",
                    )
                    return
                }

                const nextResults = body as SearchResult[]
                if (searchCache.size >= MAX_CACHED_SEARCHES) {
                    const oldestQuery = searchCache.keys().next().value
                    if (oldestQuery) searchCache.delete(oldestQuery)
                }
                searchCache.set(normalizedQuery, {
                    results: nextResults,
                    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
                })
                setResults(nextResults)
                setSearched(true)
            } catch (error) {
                if (
                    controller.signal.aborted ||
                    (error instanceof Error && error.name === "AbortError")
                ) {
                    return
                }
                if (requestId !== requestSequence.current) return

                setResults([])
                setSearched(true)
                setError("Failed to search for songs. Please try again.")
                console.error(error)
            } finally {
                if (requestId === requestSequence.current) {
                    setSearching(false)
                }
            }
        }, SEARCH_DEBOUNCE_MS)

        return () => {
            window.clearTimeout(timer)
            controller.abort()
        }
    }, [query])

    async function handleSelectSong(formData: FormData) {
        const song = {
            videoId: formData.get("videoId") as string,
            title: formData.get("title") as string,
            artist: formData.get("artist") as string,
            duration: Number(formData.get("duration")),
        }

        setError(null)

        try {
            const response = await fetch(
                `/api/playable/${encodeURIComponent(song.videoId)}`,
                {
                    headers: {
                        "ngrok-skip-browser-warning": "true",
                    },
                },
            )
            const body: unknown = await response.json()

            if (
                !response.ok ||
                typeof body !== "object" ||
                body === null ||
                !("playable" in body)
            ) {
                throw new Error(
                    typeof (body as { error?: unknown })?.error === "string"
                        ? (body as { error: string }).error
                        : "Could not check whether that song can be played.",
                )
            }

            if ((body as { playable: unknown }).playable !== true) {
                throw new Error(
                    "That version cannot be played here. Please choose another result.",
                )
            }

            await onSelect(song)
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : "Failed to add that song. Please try again.",
            )
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="relative">
                <Input
                    name="query"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search title or artist"
                    autoComplete="off"
                    minLength={MIN_SEARCH_LENGTH}
                    disabled={disabled}
                    className="border-ink bg-paper h-12 rounded-none border-2 pr-12 text-base shadow-none"
                />
                {searching && (
                    <LoaderCircleIcon
                        aria-label="Searching"
                        className="text-muted-foreground absolute top-3 right-4 size-6 animate-spin"
                    />
                )}
            </div>
            {query.length > 0 &&
                normalizeQuery(query).length < MIN_SEARCH_LENGTH && (
                    <p className="text-muted-foreground text-center text-sm">
                        Type at least {MIN_SEARCH_LENGTH} characters to search.
                    </p>
                )}
            {error && (
                <p className="text-center text-sm text-red-500">{error}</p>
            )}
            {searched && !searching && !error && results.length === 0 && (
                <div className="text-muted-foreground flex flex-col items-center gap-2 py-6">
                    <SearchXIcon className="size-6" />
                    <p className="text-sm">
                        Nothing found. Try a different search.
                    </p>
                </div>
            )}
            <ul className="flex flex-col gap-2">
                {results.map((song) => {
                    const artist = song.artists
                        .map((artist) => artist.name)
                        .join(", ")

                    return (
                        <li key={song.videoId}>
                            <form
                                action={handleSelectSong}
                                className="border-ink/20 flex items-center justify-between gap-3 border-b py-3 transition-colors hover:bg-white/45"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <ImageWithFallback
                                        src={`https://i.ytimg.com/vi_webp/${song.videoId}/mqdefault.webp`}
                                        alt={`${song.title}`}
                                        width={64}
                                        height={36}
                                        className="aspect-video w-20 shrink-0 object-cover"
                                        unoptimized
                                    />
                                    <div className="min-w-0 text-left">
                                        <p className="truncate text-sm font-semibold">
                                            {song.title}
                                        </p>
                                        <p className="text-muted-foreground truncate text-xs">
                                            {artist} &middot;{" "}
                                            {formatDuration(
                                                song.duration_seconds,
                                            )}
                                        </p>
                                    </div>
                                </div>
                                <input
                                    type="hidden"
                                    name="videoId"
                                    value={song.videoId}
                                />
                                <input
                                    type="hidden"
                                    name="title"
                                    value={song.title}
                                />
                                <input
                                    type="hidden"
                                    name="artist"
                                    value={artist}
                                />
                                <input
                                    type="hidden"
                                    name="duration"
                                    value={song.duration_seconds}
                                />
                                <SubmitButton
                                    size="sm"
                                    aria-label="Add song"
                                    className="rounded-none"
                                >
                                    <PlusCircleIcon className="size-4" />
                                </SubmitButton>
                            </form>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}
