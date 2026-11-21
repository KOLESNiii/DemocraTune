/// <reference types="vite/client" />

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import schema from "@/convex/schema"
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const modules = import.meta.glob("../../src/convex/**/*.ts")

type Scheduler = "FCFS" | "roundRobin" | "weighted"

/**
 * A room with listeners who each have `queued` songs waiting. `score` seeds a
 * listener's voting record with that many net upvotes, which DemocraSchedule
 * turns into a weight of 4 + score.
 */
async function seedRoom(
    scheduler: Scheduler,
    listeners: { name: string; queued: number; score?: number }[],
) {
    const t = convexTest(schema, modules)

    const seeded = await t.run(async (ctx) => {
        const host = await ctx.db.insert("users", { nickname: "Host" })
        const roomId = await ctx.db.insert("rooms", {
            host,
            code: "FAIR",
            expiresAt: Date.now() + 3_600_000,
            settings: {
                maxSongsPerUser: 1_000,
                scheduler,
                numSongsToForget: -1,
            },
        })

        const users: Record<string, Id<"users">> = {}
        const names: Record<string, string> = {}
        for (const listener of listeners) {
            const userId = await ctx.db.insert("users", {
                nickname: listener.name,
            })
            users[listener.name] = userId
            names[userId] = listener.name

            if (listener.score) {
                await ctx.db.insert("history", {
                    room: roomId,
                    addedBy: userId,
                    videoId: `${listener.name}-rated`,
                    type: "addedByUser",
                    title: "Rated",
                    artist: listener.name,
                    duration: 180,
                    likes: Math.max(0, listener.score),
                    dislikes: Math.max(0, -listener.score),
                })
            }
        }

        // Interleave arrivals so creation order alone favours nobody.
        const most = Math.max(...listeners.map((l) => l.queued))
        for (let i = 0; i < most; i++) {
            for (const listener of listeners) {
                if (i >= listener.queued) continue
                await ctx.db.insert("queuedSongs", {
                    room: roomId,
                    addedBy: users[listener.name],
                    userQueuePosition: i,
                    videoId: `${listener.name}-${i}`,
                    type: "addedByUser",
                    title: `${listener.name} ${i}`,
                    artist: listener.name,
                    duration: 180,
                })
            }
        }

        return { host, roomId, users, names }
    })

    const asHost = t.withIdentity({ subject: `${seeded.host}|session` })
    return { t, asHost, ...seeded }
}

/**
 * Advances the room `turns` times. Before each advance, checks that the head of
 * the queue the room is showing is the song that really plays next.
 */
async function playThrough(
    room: Awaited<ReturnType<typeof seedRoom>>,
    turns: number,
) {
    const played: string[] = []
    for (let i = 0; i < turns; i++) {
        const preview = await room.t.query(api.rooms.getQueue, {
            roomId: room.roomId,
            numItems: 1,
        })
        await room.asHost.mutation(api.rooms.popSong, { roomId: room.roomId })
        const current = await room.t.run(
            async (ctx) => (await ctx.db.get(room.roomId))?.currentSong,
        )
        if (!current) break
        expect(current.videoId).toBe(preview[0]?.videoId)
        played.push(room.names[current.addedBy!] ?? "?")
    }
    return played
}

function count(sequence: string[]) {
    const counts: Record<string, number> = {}
    for (const id of sequence) counts[id] = (counts[id] ?? 0) + 1
    return counts
}

describe("room scheduling end to end", () => {
    // Scheduled follow-up work (recommendations, playlist sync) is irrelevant
    // here; frozen timers keep it from running.
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("plays a weight-8 listener twice as often as a weight-4 one", async () => {
        const room = await seedRoom("weighted", [
            { name: "A", queued: 40, score: 4 },
            { name: "B", queued: 40 },
        ])
        const played = await playThrough(room, 30)
        expect(count(played)).toEqual({ A: 20, B: 10 })
    })

    it("keeps every pairwise ratio in a three-person room", async () => {
        const room = await seedRoom("weighted", [
            { name: "A", queued: 40 },
            { name: "B", queued: 40, score: 4 },
            { name: "C", queued: 40, score: 8 },
        ])
        const played = await playThrough(room, 36)
        expect(count(played)).toEqual({ A: 6, B: 12, C: 18 })
    })

    it("never starves listeners who share a weight", async () => {
        const room = await seedRoom("weighted", [
            { name: "A", queued: 30 },
            { name: "B", queued: 30 },
            { name: "C", queued: 30 },
            { name: "D", queued: 30 },
        ])
        const played = await playThrough(room, 12)
        expect(played.join("")).toBe("ABCDABCDABCD")
    })

    it("keeps the round robin rotation when someone runs out", async () => {
        const room = await seedRoom("roundRobin", [
            { name: "A", queued: 5 },
            { name: "B", queued: 1 },
            { name: "C", queued: 5 },
        ])
        const played = await playThrough(room, 7)
        expect(played.join("")).toBe("ABCACAC")
    })

    it("charges the song already playing in a room that predates turn tracking", async () => {
        const room = await seedRoom("roundRobin", [
            { name: "A", queued: 3 },
            { name: "B", queued: 3 },
        ])
        // Mid-session at deploy: A is on, nothing recorded yet. A's queued
        // songs are older, so first-come order alone would pick A again.
        await room.t.run(async (ctx) => {
            await ctx.db.patch(room.roomId, {
                currentSong: {
                    addedBy: room.users.A,
                    type: "addedByUser",
                    videoId: "A-playing",
                    title: "A playing",
                    artist: "A",
                    duration: 180,
                },
            })
        })
        expect(await playThrough(room, 4)).toEqual(["B", "A", "B", "A"])
    })

    it("counts a song added to a silent room as that listener's turn", async () => {
        const room = await seedRoom("roundRobin", [])
        const ids = await room.t.run(async (ctx) => ({
            a: await ctx.db.insert("users", { nickname: "A" }),
            b: await ctx.db.insert("users", { nickname: "B" }),
        }))
        room.names[ids.a] = "A"
        room.names[ids.b] = "B"
        const asA = room.t.withIdentity({ subject: `${ids.a}|s` })
        const asB = room.t.withIdentity({ subject: `${ids.b}|s` })
        const song = (videoId: string) => ({
            roomId: room.roomId,
            videoId,
            title: videoId,
            artist: "x",
            duration: 180,
        })

        // A starts the silent room, then both queue more.
        await asA.mutation(api.rooms.addSong, song("a0"))
        await asA.mutation(api.rooms.addSong, song("a1"))
        await asB.mutation(api.rooms.addSong, song("b0"))
        await asA.mutation(api.rooms.addSong, song("a2"))
        await asB.mutation(api.rooms.addSong, song("b1"))

        // A has just had a turn, so B goes next.
        expect(await playThrough(room, 4)).toEqual(["B", "A", "B", "A"])
    })
})
