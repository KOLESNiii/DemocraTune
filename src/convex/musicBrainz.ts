import { v } from "convex/values"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalAction, type MutationCtx } from "./_generated/server"
import { fingerprint } from "./fingerprint"
import { internalMutation } from "./functions"

const MUSICBRAINZ_RECORDINGS = "https://musicbrainz.org/ws/2/recording/"
export const MUSICBRAINZ_USER_AGENT =
    "DemocraTune/0.1 (https://github.com/KOLESNiii/DemocraTune)"

/** 1 / 1.05 seconds = at most 0.952 request starts per second. */
export const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1_050
const MUSICBRAINZ_MAX_RETRY_INTERVAL_MS = 10_000
const MUSICBRAINZ_LEASE_MS = 30_000
const STATE_KEY = "global" as const

type Appearance = { roomId: Id<"rooms">; videoId: string }

/** Capped exponential delay after the first failed request. */
export function musicBrainzRetryDelay(attempt: number): number {
    const exponent = Math.max(0, Math.floor(attempt) - 1)
    return Math.min(
        MUSICBRAINZ_REQUEST_INTERVAL_MS * 2 ** exponent,
        MUSICBRAINZ_MAX_RETRY_INTERVAL_MS,
    )
}

async function resolutionState(
    ctx: MutationCtx,
): Promise<Doc<"musicBrainzResolutionState">> {
    const existing = await ctx.db
        .query("musicBrainzResolutionState")
        .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
        .unique()
    if (existing) return existing

    const id = await ctx.db.insert("musicBrainzResolutionState", {
        key: STATE_KEY,
        nextRequestAt: 0,
        scheduleGeneration: 0,
    })
    const created = await ctx.db.get(id)
    if (!created) throw new Error("Could not create MusicBrainz queue state")
    return created
}

/**
 * Keep at most one current wake-up. An earlier newly scheduled wake invalidates
 * the older generation; the old action will harmlessly exit when it runs.
 */
async function ensureDrainScheduled(
    ctx: MutationCtx,
    state: Doc<"musicBrainzResolutionState">,
    targetTime: number,
): Promise<void> {
    const target = Math.max(Date.now(), targetTime)
    if (state.scheduledAt !== undefined && state.scheduledAt <= target) return

    const generation = state.scheduleGeneration + 1
    await ctx.scheduler.runAfter(
        Math.max(0, target - Date.now()),
        internal.musicBrainz.dispatchResolutionQueue,
        { generation },
    )
    await ctx.db.patch(state._id, {
        scheduledAt: target,
        scheduleGeneration: generation,
    })
}

/** Add a local catalogue miss to the single global MusicBrainz queue. */
export const enqueueResolution = internalMutation({
    args: {
        roomId: v.id("rooms"),
        trackId: v.id("tracks"),
        videoId: v.string(),
    },
    handler: async (ctx, args): Promise<void> => {
        const track = await ctx.db.get(args.trackId)
        if (!track || track.mbidUnresolvable) return

        // Another queue action may have resolved this track since the caller's
        // read. Resume enrichment without creating a redundant request.
        if (track.mbid) {
            await ctx.scheduler.runAfter(
                0,
                internal.recommendations.resolveAndEnqueue,
                args,
            )
            return
        }

        const appearance: Appearance = {
            roomId: args.roomId,
            videoId: args.videoId,
        }
        const existing = await ctx.db
            .query("musicBrainzResolutionQueue")
            .withIndex("by_track", (q) => q.eq("track", args.trackId))
            .unique()

        if (existing) {
            const alreadyWaiting = existing.appearances.some(
                (item) =>
                    item.roomId === appearance.roomId &&
                    item.videoId === appearance.videoId,
            )
            if (!alreadyWaiting) {
                await ctx.db.patch(existing._id, {
                    appearances: [...existing.appearances, appearance],
                })
            }
        } else {
            await ctx.db.insert("musicBrainzResolutionQueue", {
                track: args.trackId,
                appearances: [appearance],
                status: "pending",
                attempts: 0,
                nextAttemptAt: Date.now(),
                claimGeneration: 0,
            })
        }

        const state = await resolutionState(ctx)
        await ensureDrainScheduled(ctx, state, Date.now())
    },
})

/**
 * Atomically reserve the next request start, lease one due item, and schedule
 * its external lookup. Scheduled mutations are retried by Convex; the lookup
 * action itself is protected by the recoverable lease.
 */
export const dispatchResolutionQueue = internalMutation({
    args: { generation: v.number() },
    handler: async (ctx, args): Promise<void> => {
        const state = await resolutionState(ctx)
        if (
            state.scheduledAt === undefined ||
            state.scheduleGeneration !== args.generation
        ) {
            return
        }

        await ctx.db.patch(state._id, { scheduledAt: undefined })
        const activeState = { ...state, scheduledAt: undefined }
        const now = Date.now()

        // A scheduled action is at-most-once. If it disappears after claiming,
        // the next wake recovers its expired lease and retries the item.
        const expired = await ctx.db
            .query("musicBrainzResolutionQueue")
            .withIndex("by_status_lease_expiry", (q) =>
                q.eq("status", "leased").lte("leaseExpiresAt", now),
            )
            .take(100)
        for (const job of expired) {
            await ctx.db.patch(job._id, {
                status: "pending",
                nextAttemptAt: now,
                leaseExpiresAt: undefined,
            })
        }

        // Only one MusicBrainz action may be active. New catalogue misses can
        // wake the dispatcher, but they wait behind the current lease.
        const activeLease = await ctx.db
            .query("musicBrainzResolutionQueue")
            .withIndex("by_status_lease_expiry", (q) =>
                q.eq("status", "leased"),
            )
            .first()
        if (activeLease?.leaseExpiresAt !== undefined) {
            await ensureDrainScheduled(
                ctx,
                activeState,
                activeLease.leaseExpiresAt,
            )
            return
        }

        if (activeState.nextRequestAt > now) {
            await ensureDrainScheduled(
                ctx,
                activeState,
                activeState.nextRequestAt,
            )
            return
        }

        const job = await ctx.db
            .query("musicBrainzResolutionQueue")
            .withIndex("by_status_next_attempt", (q) =>
                q.eq("status", "pending").lte("nextAttemptAt", now),
            )
            .first()

        if (!job) {
            const nextPending = await ctx.db
                .query("musicBrainzResolutionQueue")
                .withIndex("by_status_next_attempt", (q) =>
                    q.eq("status", "pending"),
                )
                .first()
            const nextLease = await ctx.db
                .query("musicBrainzResolutionQueue")
                .withIndex("by_status_lease_expiry", (q) =>
                    q.eq("status", "leased"),
                )
                .first()
            const nextWake = Math.min(
                nextPending?.nextAttemptAt ?? Number.POSITIVE_INFINITY,
                nextLease?.leaseExpiresAt ?? Number.POSITIVE_INFINITY,
            )
            if (Number.isFinite(nextWake)) {
                await ensureDrainScheduled(ctx, activeState, nextWake)
            }
            return
        }

        const claimGeneration = job.claimGeneration + 1
        const leaseExpiresAt = now + MUSICBRAINZ_LEASE_MS
        await ctx.db.patch(job._id, {
            status: "leased",
            claimGeneration,
            leaseExpiresAt,
        })
        // This is a watchdog. Successful/error completion replaces it with an
        // earlier wake; if the at-most-once action vanishes, the lease recovers.
        await ensureDrainScheduled(ctx, activeState, leaseExpiresAt)
        await ctx.scheduler.runAfter(
            0,
            internal.musicBrainz.resolveClaimedTrack,
            {
                jobId: job._id,
                trackId: job.track,
                claimGeneration,
            },
        )
    },
})

export const completeResolution = internalMutation({
    args: {
        jobId: v.id("musicBrainzResolutionQueue"),
        claimGeneration: v.number(),
        mbid: v.optional(v.string()),
    },
    handler: async (ctx, args): Promise<void> => {
        const job = await ctx.db.get(args.jobId)
        if (
            !job ||
            job.status !== "leased" ||
            job.claimGeneration !== args.claimGeneration
        ) {
            return
        }

        const track = await ctx.db.get(job.track)
        if (track) {
            await ctx.db.patch(track._id, {
                mbid: args.mbid ?? track.mbid,
                mbidResolvedAt: Date.now(),
                mbidUnresolvable: !args.mbid,
            })
            if (args.mbid) {
                for (const appearance of job.appearances) {
                    if (!(await ctx.db.get(appearance.roomId))) continue
                    await ctx.scheduler.runAfter(
                        0,
                        internal.recommendations.resolveAndEnqueue,
                        {
                            roomId: appearance.roomId,
                            trackId: track._id,
                            videoId: appearance.videoId,
                        },
                    )
                }
            }
        }
        await ctx.db.delete(job._id)

        const state = await resolutionState(ctx)
        const nextRequestAt = Date.now() + MUSICBRAINZ_REQUEST_INTERVAL_MS
        await ctx.db.patch(state._id, { nextRequestAt })
        await ensureDrainScheduled(
            ctx,
            { ...state, nextRequestAt },
            nextRequestAt,
        )
    },
})

export const retryResolution = internalMutation({
    args: {
        jobId: v.id("musicBrainzResolutionQueue"),
        claimGeneration: v.number(),
        error: v.string(),
    },
    handler: async (ctx, args): Promise<void> => {
        const job = await ctx.db.get(args.jobId)
        if (
            !job ||
            job.status !== "leased" ||
            job.claimGeneration !== args.claimGeneration
        ) {
            return
        }

        const attempts = job.attempts + 1
        const nextAttemptAt = Date.now() + musicBrainzRetryDelay(attempts)
        await ctx.db.patch(job._id, {
            status: "pending",
            attempts,
            nextAttemptAt,
            leaseExpiresAt: undefined,
            lastError: args.error.slice(0, 1_000),
        })

        const state = await resolutionState(ctx)
        const nextRequestAt = Date.now() + MUSICBRAINZ_REQUEST_INTERVAL_MS
        await ctx.db.patch(state._id, { nextRequestAt })
        await ensureDrainScheduled(
            ctx,
            { ...state, nextRequestAt },
            nextRequestAt,
        )
    },
})

export const validateResolutionLease = internalMutation({
    args: {
        jobId: v.id("musicBrainzResolutionQueue"),
        claimGeneration: v.number(),
    },
    handler: async (ctx, args): Promise<boolean> => {
        const job = await ctx.db.get(args.jobId)
        const valid =
            job?.status === "leased" &&
            job.claimGeneration === args.claimGeneration &&
            job.leaseExpiresAt !== undefined &&
            job.leaseExpiresAt > Date.now()
        if (valid) return true

        const state = await resolutionState(ctx)
        await ensureDrainScheduled(ctx, state, Date.now())
        return false
    },
})

/** Performs the external lookup for one item already leased by the dispatcher. */
export const resolveClaimedTrack = internalAction({
    args: {
        jobId: v.id("musicBrainzResolutionQueue"),
        trackId: v.id("tracks"),
        claimGeneration: v.number(),
    },
    handler: async (ctx, args): Promise<void> => {
        const leaseIsValid = await ctx.runMutation(
            internal.musicBrainz.validateResolutionLease,
            {
                jobId: args.jobId,
                claimGeneration: args.claimGeneration,
            },
        )
        if (!leaseIsValid) return

        const track: Doc<"tracks"> | null = await ctx.runQuery(
            internal.recommendations.getTrack,
            { trackId: args.trackId },
        )
        if (!track) {
            await ctx.runMutation(internal.musicBrainz.completeResolution, {
                jobId: args.jobId,
                claimGeneration: args.claimGeneration,
            })
            return
        }

        try {
            const mbid = await resolveRecordingMbid(track)
            await ctx.runMutation(internal.musicBrainz.completeResolution, {
                jobId: args.jobId,
                claimGeneration: args.claimGeneration,
                mbid,
            })
        } catch (error) {
            console.error("MusicBrainz recording resolution failed", error)
            await ctx.runMutation(internal.musicBrainz.retryResolution, {
                jobId: args.jobId,
                claimGeneration: args.claimGeneration,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    },
})

function escapeLucene(value: string): string {
    return value.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, "\\$&")
}

async function resolveRecordingMbid(
    track: Doc<"tracks">,
): Promise<string | undefined> {
    const query = track.isrc
        ? `isrc:${escapeLucene(track.isrc)}`
        : `recording:"${escapeLucene(track.title)}" AND artist:"${escapeLucene(track.artist)}"`
    const url = new URL(MUSICBRAINZ_RECORDINGS)
    url.search = new URLSearchParams({
        query,
        fmt: "json",
        limit: "8",
    }).toString()

    const response = await fetch(url, {
        headers: {
            Accept: "application/json",
            "User-Agent": MUSICBRAINZ_USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
        throw new Error(`MusicBrainz returned ${response.status}`)
    }
    return chooseRecordingMbid(await response.json(), track)
}

export function chooseRecordingMbid(
    body: unknown,
    track: Pick<Doc<"tracks">, "artist" | "title" | "duration">,
): string | undefined {
    if (!body || typeof body !== "object") return undefined
    const recordings = (body as { recordings?: unknown }).recordings
    if (!Array.isArray(recordings)) return undefined

    const target = fingerprint(track.artist, track.title)
    const matches = recordings
        .map((recording) => readMusicBrainzRecording(recording))
        .filter(
            (recording): recording is NonNullable<typeof recording> =>
                !!recording,
        )
        .filter((recording) => recording.score >= 80)
        .filter(
            (recording) =>
                recording.length === undefined ||
                Math.abs(recording.length / 1000 - track.duration) <= 15,
        )
        .sort((left, right) => {
            const leftExact =
                fingerprint(left.artist, left.title) === target ? 1 : 0
            const rightExact =
                fingerprint(right.artist, right.title) === target ? 1 : 0
            return rightExact - leftExact || right.score - left.score
        })

    return matches[0]?.id
}

function readMusicBrainzRecording(value: unknown) {
    if (!value || typeof value !== "object") return null
    const row = value as Record<string, unknown>
    if (typeof row.id !== "string" || typeof row.title !== "string") return null

    const artistCredit = Array.isArray(row["artist-credit"])
        ? row["artist-credit"]
        : []
    const artist = artistCredit
        .map((credit) => {
            if (!credit || typeof credit !== "object") return ""
            const entry = credit as Record<string, unknown>
            if (typeof entry.name === "string") return entry.name
            const nested = entry.artist
            return nested &&
                typeof nested === "object" &&
                typeof (nested as Record<string, unknown>).name === "string"
                ? ((nested as Record<string, unknown>).name as string)
                : ""
        })
        .filter(Boolean)
        .join(" & ")

    return {
        id: row.id,
        title: row.title,
        artist,
        score: Number(row.score ?? 0),
        length: typeof row.length === "number" ? row.length : undefined,
    }
}
