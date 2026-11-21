/// <reference types="vite/client" />

import { internal } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
    isRetryableMusicBrainzError,
    MUSICBRAINZ_MAX_ATTEMPTS,
} from "@/convex/musicBrainz"
import { readPlayableSong } from "@/convex/recommendations"
import schema from "@/convex/schema"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const modules = import.meta.glob("../../src/convex/**/*.ts")

const song = (videoId: string, mbid?: string) => ({
    videoId,
    title: `Title ${videoId}`,
    artist: "Artist",
    duration: 180,
    ...(mbid ? { mbid } : {}),
})

async function seedRoom(autoDj = true) {
    const t = convexTest(schema, modules)
    const ids = await t.run(async (ctx) => {
        const host = await ctx.db.insert("users", { nickname: "Host" })
        const roomId = await ctx.db.insert("rooms", {
            host,
            code: "AUTO",
            expiresAt: Date.now() + 3_600_000,
            settings: {
                maxSongsPerUser: 5,
                scheduler: "FCFS",
                numSongsToForget: -1,
                autoDj: {
                    enabled: autoDj,
                    sourceOrder: ["engine", "fallback_playlist"],
                },
            },
        })
        return { host, roomId }
    })
    return { t, ...ids }
}

describe("AutoDJ review fixes", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubEnv("RECOMMENDATION_API_URL", "")
        vi.stubEnv("RECOMMENDATION_API_TOKEN", "")
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllEnvs()
    })

    it("sends seeds oldest first, with the current song last", async () => {
        const { t, roomId } = await seedRoom()
        await t.run(async (ctx) => {
            for (const id of ["s1", "s2", "s3"]) {
                await ctx.db.insert("history", {
                    room: roomId,
                    type: "addedByUser",
                    ...song(id, `mbid-${id}`),
                })
            }
            await ctx.db.patch(roomId, {
                currentSong: { type: "addedByUser", ...song("s4", "mbid-s4") },
            })
        })

        const context = await t.query(internal.recommendations.getRoomContext, {
            roomId,
        })
        expect(context?.seedMbids).toEqual([
            "mbid-s1",
            "mbid-s2",
            "mbid-s3",
            "mbid-s4",
        ])
    })

    it("keeps the MBID an AutoDJ song already carries when it finishes", async () => {
        const { t, roomId } = await seedRoom()
        await t.run(async (ctx) => {
            await ctx.db.patch(roomId, {
                currentSong: { type: "autoDj", ...song("dj", "known-mbid") },
            })
        })
        await t.mutation(internal.playback.startIfSilent, { roomId })
        // startIfSilent leaves a playing room alone.
        expect(
            await t.run(async (ctx) => (await ctx.db.get(roomId))?.currentSong),
        ).toBeTruthy()

        const { advanceRoom } = await import("@/convex/playback")
        await t.run(async (ctx) => {
            await advanceRoom(ctx, roomId)
        })

        const track = await t.run(async (ctx) => ctx.db.query("tracks").first())
        expect(track?.mbid).toBe("known-mbid")
        expect(track?.mbidUnresolvable).toBeFalsy()
    })

    it("starts a silent room when an AutoDJ refill lands", async () => {
        const { t, roomId } = await seedRoom()
        await t.mutation(internal.recommendations.insertCandidates, {
            roomId,
            candidates: [
                {
                    recording_mbid: "rec-1",
                    title: "Recommended",
                    artist: "Artist",
                    source: "engine",
                    videoId: "rec-video",
                    duration: 200,
                },
            ],
        })
        await t.finishAllScheduledFunctions(vi.runAllTimers)

        const room = await t.run(async (ctx) => ctx.db.get(roomId))
        expect(room?.currentSong?.videoId).toBe("rec-video")
        expect(room?.currentSong?.type).toBe("autoDj")
    })

    it("gives up on MusicBrainz lookups that cannot succeed", async () => {
        const { t, roomId } = await seedRoom()
        const seedJob = (attempts: number) =>
            t.run(async (ctx) => {
                const track = await ctx.db.insert("tracks", {
                    title: "T",
                    artist: "A",
                    duration: 180,
                    fingerprint: `a|t${attempts}`,
                    providerIds: { youtube: `v${attempts}` },
                })
                const jobId = await ctx.db.insert(
                    "musicBrainzResolutionQueue",
                    {
                        track,
                        appearances: [{ roomId, videoId: `v${attempts}` }],
                        status: "leased",
                        attempts,
                        nextAttemptAt: Date.now(),
                        claimGeneration: 1,
                        leaseExpiresAt: Date.now() + 30_000,
                    },
                )
                return { track, jobId }
            })
        const after = (ids: {
            track: Id<"tracks">
            jobId: Id<"musicBrainzResolutionQueue">
        }) =>
            t.run(async (ctx) => ({
                track: await ctx.db.get(ids.track),
                job: await ctx.db.get(ids.jobId),
            }))

        // A transient failure early on is retried.
        const transient = await seedJob(0)
        await t.mutation(internal.musicBrainz.retryResolution, {
            jobId: transient.jobId,
            claimGeneration: 1,
            error: "timeout",
            retryable: true,
        })
        expect((await after(transient)).job?.status).toBe("pending")

        // A request MusicBrainz rejects outright is not.
        const rejected = await seedJob(0)
        await t.mutation(internal.musicBrainz.retryResolution, {
            jobId: rejected.jobId,
            claimGeneration: 1,
            error: "MusicBrainz returned 400",
            retryable: false,
        })
        let state = await after(rejected)
        expect(state.job).toBeNull()
        expect(state.track?.mbidUnresolvable).toBe(true)

        // Nor is one that has used up its attempts.
        const exhausted = await seedJob(MUSICBRAINZ_MAX_ATTEMPTS - 1)
        await t.mutation(internal.musicBrainz.retryResolution, {
            jobId: exhausted.jobId,
            claimGeneration: 1,
            error: "timeout",
            retryable: true,
        })
        state = await after(exhausted)
        expect(state.job).toBeNull()
        expect(state.track?.mbidUnresolvable).toBe(true)
    })

    it("only retries MusicBrainz failures that might clear up", () => {
        expect(isRetryableMusicBrainzError(new TypeError("fetch failed"))).toBe(
            true,
        )
    })
})

describe("readPlayableSong", () => {
    it("skips uploads the room has already heard", () => {
        const results = [
            { videoId: "played", duration_seconds: 200 },
            { videoId: "fresh", duration_seconds: 201 },
        ]
        expect(readPlayableSong(results, new Set(["played"]))).toEqual({
            videoId: "fresh",
            duration: 201,
        })
        expect(readPlayableSong(results, new Set(["played", "fresh"]))).toBe(
            null,
        )
    })
})
