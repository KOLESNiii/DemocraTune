/// <reference types="vite/client" />

import { internal } from "@/convex/_generated/api"
import schema from "@/convex/schema"
import { convexTest } from "convex-test"
import { afterEach, describe, expect, it, vi } from "vitest"

const modules = import.meta.glob("../../src/convex/**/*.ts")

describe("MusicBrainz resolution queue", () => {
    afterEach(() => vi.useRealTimers())

    it("deduplicates misses and serializes leases at 1.05 seconds", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-17T00:00:00Z"))
        const t = convexTest(schema, modules)

        const seeded = await t.run(async (ctx) => {
            const host = await ctx.db.insert("users", { nickname: "Host" })
            const roomId = await ctx.db.insert("rooms", {
                host,
                code: "RATE",
                expiresAt: Date.now() + 60_000,
                settings: {
                    maxSongsPerUser: 2,
                    scheduler: "FCFS",
                    numSongsToForget: -1,
                },
            })
            const firstTrack = await ctx.db.insert("tracks", {
                title: "First",
                artist: "Artist",
                duration: 180,
                fingerprint: "artist|first",
                providerIds: { youtube: "first-video" },
            })
            const secondTrack = await ctx.db.insert("tracks", {
                title: "Second",
                artist: "Artist",
                duration: 200,
                fingerprint: "artist|second",
                providerIds: { youtube: "second-video" },
            })
            return { roomId, firstTrack, secondTrack }
        })

        await t.mutation(internal.musicBrainz.enqueueResolution, {
            roomId: seeded.roomId,
            trackId: seeded.firstTrack,
            videoId: "first-video",
        })
        await t.mutation(internal.musicBrainz.enqueueResolution, {
            roomId: seeded.roomId,
            trackId: seeded.firstTrack,
            videoId: "first-video",
        })
        await t.mutation(internal.musicBrainz.enqueueResolution, {
            roomId: seeded.roomId,
            trackId: seeded.secondTrack,
            videoId: "second-video",
        })

        let snapshot = await t.run(async (ctx) => ({
            jobs: await ctx.db.query("musicBrainzResolutionQueue").collect(),
            state: await ctx.db.query("musicBrainzResolutionState").unique(),
        }))
        expect(snapshot.jobs).toHaveLength(2)
        expect(snapshot.jobs[0].appearances).toHaveLength(1)
        expect(snapshot.state?.scheduledAt).toBe(Date.now())

        await t.mutation(internal.musicBrainz.dispatchResolutionQueue, {
            generation: snapshot.state!.scheduleGeneration,
        })
        snapshot = await t.run(async (ctx) => ({
            jobs: await ctx.db.query("musicBrainzResolutionQueue").collect(),
            state: await ctx.db.query("musicBrainzResolutionState").unique(),
        }))
        const leased = snapshot.jobs.find((job) => job.status === "leased")!
        expect(
            snapshot.jobs.filter((job) => job.status === "leased"),
        ).toHaveLength(1)
        expect(
            snapshot.jobs.filter((job) => job.status === "pending"),
        ).toHaveLength(1)

        await t.mutation(internal.musicBrainz.completeResolution, {
            jobId: leased._id,
            claimGeneration: leased.claimGeneration,
            mbid: "8a49dba0-253a-4535-b87f-78bb035336ce",
        })
        snapshot = await t.run(async (ctx) => ({
            jobs: await ctx.db.query("musicBrainzResolutionQueue").collect(),
            state: await ctx.db.query("musicBrainzResolutionState").unique(),
        }))
        expect(snapshot.jobs).toHaveLength(1)
        expect(snapshot.state?.nextRequestAt).toBe(Date.now() + 1_050)

        // An early dispatcher consumes no work and replaces itself at the
        // original rate-limit boundary.
        await t.mutation(internal.musicBrainz.dispatchResolutionQueue, {
            generation: snapshot.state!.scheduleGeneration,
        })
        let pending = await t.run(async (ctx) => ({
            job: await ctx.db.query("musicBrainzResolutionQueue").unique(),
            state: await ctx.db.query("musicBrainzResolutionState").unique(),
        }))
        expect(pending.job?.status).toBe("pending")

        vi.advanceTimersByTime(1_050)
        await t.mutation(internal.musicBrainz.dispatchResolutionQueue, {
            generation: pending.state!.scheduleGeneration,
        })
        pending = await t.run(async (ctx) => ({
            job: await ctx.db.query("musicBrainzResolutionQueue").unique(),
            state: await ctx.db.query("musicBrainzResolutionState").unique(),
        }))
        expect(pending.job?.status).toBe("leased")
    })
})
