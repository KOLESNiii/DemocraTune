import { v } from "convex/values"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import {
    internalAction,
    internalQuery,
    type MutationCtx,
} from "./_generated/server"
import { internalMutation } from "./functions"
import { recommendationSourceValidator } from "./recommendationSources"

const AUTO_DJ_BUFFER_SIZE = 3
const RECENT_SEED_LIMIT = 5
const RECOMMENDATION_CANDIDATE_LIMIT = 12

type RecommendationCandidate = {
    recording_mbid: string
    title: string
    artist: string
    source: "engine" | "listenbrainz"
}

type PlayableCandidate = RecommendationCandidate & {
    videoId: string
    duration: number
}

const playableCandidateValidator = v.object({
    recording_mbid: v.string(),
    title: v.string(),
    artist: v.string(),
    source: recommendationSourceValidator,
    videoId: v.string(),
    duration: v.number(),
})

/** Schedule all network work outside the mutation that accepted the song. */
export async function scheduleRecommendationTrack(
    ctx: MutationCtx,
    args: {
        roomId: Id<"rooms">
        trackId: Id<"tracks">
        videoId: string
    },
): Promise<void> {
    await ctx.scheduler.runAfter(
        0,
        internal.recommendations.resolveAndEnqueue,
        args,
    )
}

export const getTrack = internalQuery({
    args: { trackId: v.id("tracks") },
    handler: async (ctx, args) => await ctx.db.get(args.trackId),
})

export const saveMbid = internalMutation({
    args: {
        roomId: v.id("rooms"),
        trackId: v.id("tracks"),
        videoId: v.string(),
        mbid: v.optional(v.string()),
        unresolvable: v.boolean(),
    },
    handler: async (ctx, args) => {
        const track = await ctx.db.get(args.trackId)
        if (!track) return

        await ctx.db.patch(args.trackId, {
            mbid: args.mbid ?? track.mbid,
            mbidResolvedAt: Date.now(),
            mbidUnresolvable: args.unresolvable,
        })

        if (!args.mbid) return

        const room = await ctx.db.get(args.roomId)
        if (room?.currentSong?.videoId === args.videoId) {
            await ctx.db.patch(args.roomId, {
                currentSong: { ...room.currentSong, mbid: args.mbid },
            })
        }

        const queued = await ctx.db
            .query("queuedSongs")
            .withIndex("by_room_type", (q) => q.eq("room", args.roomId))
            .collect()
        for (const song of queued) {
            if (song.videoId === args.videoId && !song.mbid) {
                await ctx.db.patch(song._id, { mbid: args.mbid })
            }
        }

        const history = await ctx.db
            .query("history")
            .withIndex("by_room", (q) => q.eq("room", args.roomId))
            .collect()
        for (const song of history) {
            if (song.videoId === args.videoId && !song.mbid) {
                await ctx.db.patch(song._id, { mbid: args.mbid })
            }
        }
    },
})

export const getRoomContext = internalQuery({
    args: { roomId: v.id("rooms") },
    handler: async (ctx, args) => {
        const room = await ctx.db.get(args.roomId)
        if (!room?.settings.autoDj?.enabled) return null

        const queue = await ctx.db
            .query("queuedSongs")
            .withIndex("by_room_type", (q) => q.eq("room", args.roomId))
            .collect()
        const history = await ctx.db
            .query("history")
            .withIndex("by_room", (q) => q.eq("room", args.roomId))
            .order("desc")
            .take(100)

        const recentMbids = [
            room.currentSong?.mbid,
            ...history.map((song) => song.mbid),
        ].filter((mbid): mbid is string => Boolean(mbid))

        return {
            sourceOrder: room.settings.autoDj.sourceOrder,
            seedMbids: [...new Set(recentMbids)].slice(0, RECENT_SEED_LIMIT),
            excludedMbids: [
                ...new Set([
                    ...recentMbids,
                    ...queue.map((song) => song.mbid).filter(Boolean),
                ]),
            ] as string[],
            excludedVideoIds: [
                ...new Set(
                    [
                        room.currentSong?.videoId,
                        ...history.map((song) => song.videoId),
                        ...queue.map((song) => song.videoId),
                    ].filter((videoId): videoId is string => Boolean(videoId)),
                ),
            ],
            autoDjCount: queue.filter((song) => song.type === "autoDj").length,
        }
    },
})

export const insertCandidates = internalMutation({
    args: {
        roomId: v.id("rooms"),
        candidates: v.array(playableCandidateValidator),
    },
    handler: async (ctx, args) => {
        const room = await ctx.db.get(args.roomId)
        if (!room?.settings.autoDj?.enabled) return 0

        const queue = await ctx.db
            .query("queuedSongs")
            .withIndex("by_room_type", (q) => q.eq("room", args.roomId))
            .collect()
        let remaining = Math.max(
            0,
            AUTO_DJ_BUFFER_SIZE -
                queue.filter((song) => song.type === "autoDj").length,
        )
        if (!remaining) return 0

        const mbids = new Set(
            queue
                .map((song) => song.mbid)
                .filter((mbid): mbid is string => !!mbid),
        )
        const videoIds = new Set(queue.map((song) => song.videoId))
        if (room.currentSong?.mbid) mbids.add(room.currentSong.mbid)
        if (room.currentSong?.videoId) videoIds.add(room.currentSong.videoId)

        let inserted = 0
        for (const candidate of args.candidates) {
            if (!remaining) break
            if (
                mbids.has(candidate.recording_mbid) ||
                videoIds.has(candidate.videoId)
            ) {
                continue
            }

            await ctx.db.insert("queuedSongs", {
                room: args.roomId,
                type: "autoDj",
                videoId: candidate.videoId,
                mbid: candidate.recording_mbid,
                recommendationSource: candidate.source,
                title: candidate.title,
                artist: candidate.artist,
                duration: candidate.duration,
            })
            mbids.add(candidate.recording_mbid)
            videoIds.add(candidate.videoId)
            inserted++
            remaining--
        }
        return inserted
    },
})

export const resolveAndEnqueue = internalAction({
    args: {
        roomId: v.id("rooms"),
        trackId: v.id("tracks"),
        videoId: v.string(),
    },
    handler: async (ctx, args): Promise<void> => {
        const config = recommendationConfig()
        if (!config) return

        const track: Doc<"tracks"> | null = await ctx.runQuery(
            internal.recommendations.getTrack,
            { trackId: args.trackId },
        )
        if (!track || track.mbidUnresolvable) return

        const mbid = track.mbid
        if (!mbid) {
            await ctx.runMutation(internal.musicBrainz.enqueueResolution, args)
            return
        }

        await ctx.runMutation(internal.recommendations.saveMbid, {
            roomId: args.roomId,
            trackId: args.trackId,
            videoId: args.videoId,
            mbid,
            unresolvable: false,
        })

        try {
            await fetchJson(new URL("/v1/jobs", config.url), {
                method: "POST",
                headers: recommendationHeaders(config.token),
                body: JSON.stringify({
                    mbid,
                    youtube_url: `https://www.youtube.com/watch?v=${args.videoId}`,
                    title: track.title,
                    artist: track.artist,
                    duration: Math.max(1, Math.round(track.duration)),
                }),
            })
        } catch (error) {
            // Indexing is enrichment. A Qdrant or coordinator outage must not
            // make adding or playing a song fail.
            console.error(
                `Could not enqueue recommendation job for ${mbid}`,
                error,
            )
        }

        await ctx.scheduler.runAfter(0, internal.recommendations.refreshRoom, {
            roomId: args.roomId,
        })
    },
})

export const refreshRoom = internalAction({
    args: { roomId: v.id("rooms") },
    handler: async (ctx, args): Promise<void> => {
        const config = recommendationConfig()
        const searchBaseUrl = process.env.FASTAPI_BASE_URL
        if (!config || !searchBaseUrl) return

        const context = await ctx.runQuery(
            internal.recommendations.getRoomContext,
            args,
        )
        if (
            !context ||
            !context.seedMbids.length ||
            context.autoDjCount >= AUTO_DJ_BUFFER_SIZE
        ) {
            return
        }

        let response: unknown
        try {
            response = await fetchJson(
                new URL("/v1/recommendations", config.url),
                {
                    method: "POST",
                    headers: recommendationHeaders(config.token),
                    body: JSON.stringify({
                        seed_mbids: context.seedMbids,
                        excluded_mbids: context.excludedMbids,
                        source_order: context.sourceOrder,
                        limit: RECOMMENDATION_CANDIDATE_LIMIT,
                    }),
                },
            )
        } catch (error) {
            console.error("Could not refresh AutoDJ recommendations", error)
            return
        }

        const candidates = readRecommendationCandidates(response)
        const playable: PlayableCandidate[] = []
        const excludedVideoIds = new Set(context.excludedVideoIds)
        const needed = AUTO_DJ_BUFFER_SIZE - context.autoDjCount

        for (const candidate of candidates) {
            if (playable.length >= needed) break
            try {
                const song = await findPlayableSong(searchBaseUrl, candidate)
                if (!song || excludedVideoIds.has(song.videoId)) continue
                excludedVideoIds.add(song.videoId)
                playable.push({ ...candidate, ...song })
            } catch (error) {
                console.error(
                    `Could not resolve recommendation ${candidate.recording_mbid}`,
                    error,
                )
            }
        }

        if (playable.length) {
            await ctx.runMutation(internal.recommendations.insertCandidates, {
                roomId: args.roomId,
                candidates: playable,
            })
        }
    },
})

function recommendationConfig(): { url: string; token: string } | null {
    const url = process.env.RECOMMENDATION_API_URL
    const token = process.env.RECOMMENDATION_API_TOKEN
    if (!url || !token) return null
    return { url, token }
}

function recommendationHeaders(token: string): Record<string, string> {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
    }
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
        throw new Error(`${url.pathname} returned ${response.status}`)
    }
    return await response.json()
}

export function readRecommendationCandidates(
    body: unknown,
): RecommendationCandidate[] {
    if (!body || typeof body !== "object") return []
    const rows = (body as { candidates?: unknown }).candidates
    if (!Array.isArray(rows)) return []

    return rows.flatMap((value): RecommendationCandidate[] => {
        if (!value || typeof value !== "object") return []
        const row = value as Record<string, unknown>
        if (
            typeof row.recording_mbid !== "string" ||
            typeof row.title !== "string" ||
            typeof row.artist !== "string" ||
            (row.source !== "engine" && row.source !== "listenbrainz")
        ) {
            return []
        }
        return [
            {
                recording_mbid: row.recording_mbid,
                title: row.title,
                artist: row.artist,
                source: row.source,
            },
        ]
    })
}

async function findPlayableSong(
    searchBaseUrl: string,
    candidate: RecommendationCandidate,
): Promise<{ videoId: string; duration: number } | null> {
    const url = new URL("/api/search", searchBaseUrl)
    url.search = new URLSearchParams({
        q: `${candidate.artist} ${candidate.title}`,
    }).toString()
    const body = await fetchJson(url, {
        headers: { Accept: "application/json" },
    })
    return readPlayableSong(body)
}

export function readPlayableSong(
    body: unknown,
): { videoId: string; duration: number } | null {
    if (!Array.isArray(body)) return null

    for (const value of body) {
        if (!value || typeof value !== "object") continue
        const row = value as Record<string, unknown>
        if (
            typeof row.videoId === "string" &&
            typeof row.duration_seconds === "number" &&
            row.duration_seconds > 0
        ) {
            return {
                videoId: row.videoId,
                duration: Math.round(row.duration_seconds),
            }
        }
    }
    return null
}
