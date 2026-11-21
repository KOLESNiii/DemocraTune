import { Doc, Id } from "./_generated/dataModel"
import type { QueryCtx } from "./_generated/server"
import {
    type Contender,
    EMPTY_FAIR_SHARE,
    type FairShareState,
    nextTurn,
    planTurns,
    recordTurn,
} from "./fairShare"
import { getUserRatings } from "./ratings"
import { BASE_WEIGHT } from "./settings"

export type QueuedSong = Doc<"queuedSongs"> & {
    addedByNickname: string | undefined
}

/** Key used to bucket songs by the user who added them. */
const ANONYMOUS = "anon"

export async function attachNicknames(
    ctx: QueryCtx,
    songs: Doc<"queuedSongs">[],
): Promise<QueuedSong[]> {
    const nicknames = new Map<string, string | undefined>()

    for (const song of songs) {
        if (!song.addedBy || nicknames.has(song.addedBy)) continue
        const user = await ctx.db.get(song.addedBy)
        nicknames.set(song.addedBy, user?.nickname)
    }

    return songs.map((song) => ({
        ...song,
        addedByNickname: song.addedBy ? nicknames.get(song.addedBy) : undefined,
    }))
}

/**
 * Every song waiting in a room, oldest first.
 *
 * The `by_room_type` index sorts by (room, type, _creationTime), and the type
 * names sort as addedByUser, autoDj, fallback. The schedulers preserve that
 * priority: people first, recommendations second, host fallback last.
 */
async function collectQueue(
    ctx: QueryCtx,
    roomId: Id<"rooms">,
): Promise<Doc<"queuedSongs">[]> {
    return await ctx.db
        .query("queuedSongs")
        .withIndex("by_room_type", (q) => q.eq("room", roomId))
        .order("asc")
        .collect()
}

/** Splits a queue into per-user buckets plus both automatic queue tiers. */
function bucketByUser(songs: Doc<"queuedSongs">[]): {
    userQueues: Map<string, Doc<"queuedSongs">[]>
    autoDj: Doc<"queuedSongs">[]
    fallback: Doc<"queuedSongs">[]
} {
    const userQueues = new Map<string, Doc<"queuedSongs">[]>()
    const autoDj: Doc<"queuedSongs">[] = []
    const fallback: Doc<"queuedSongs">[] = []

    for (const song of songs) {
        if (song.type === "fallback") {
            fallback.push(song)
            continue
        }
        if (song.type === "autoDj") {
            autoDj.push(song)
            continue
        }
        const key = song.addedBy ?? ANONYMOUS
        const bucket = userQueues.get(key)
        if (bucket) bucket.push(song)
        else userQueues.set(key, [song])
    }

    for (const songsForUser of userQueues.values()) {
        songsForUser.sort(compareUserQueuePosition)
    }

    return { userQueues, autoDj, fallback }
}

function automaticQueue(
    autoDj: Doc<"queuedSongs">[],
    fallback: Doc<"queuedSongs">[],
    numItems: number,
): Doc<"queuedSongs">[] {
    return [...autoDj, ...fallback].slice(0, numItems)
}

function compareUserQueuePosition(
    a: Doc<"queuedSongs">,
    b: Doc<"queuedSongs">,
) {
    return (
        (a.userQueuePosition ?? Number.MAX_SAFE_INTEGER) -
            (b.userQueuePosition ?? Number.MAX_SAFE_INTEGER) ||
        a._creationTime - b._creationTime
    )
}

/**
 * First come, first served: the queue in the order it was added.
 *
 * Each user keeps the slots their songs arrived in, but can reorder which of
 * their own songs fills each slot.
 */
function fcfsOrder(
    songs: Doc<"queuedSongs">[],
    numItems: number,
): Doc<"queuedSongs">[] {
    const { userQueues } = bucketByUser(songs)
    const ordered = songs.map((song) => {
        // Only people's songs belong to a personal queue. AutoDJ songs have no
        // owner, and must not be swapped for an anonymous listener's song.
        if (song.type !== "addedByUser") return song
        return userQueues.get(song.addedBy ?? ANONYMOUS)?.shift() ?? song
    })
    return ordered.slice(0, numItems)
}

/** The scheduling weight of each user who has songs waiting. */
async function weightsFor(
    ctx: QueryCtx,
    room: Doc<"rooms">,
    userIds: string[],
): Promise<Map<string, number>> {
    // Round robin is fair share with everyone level.
    if (room.settings.scheduler !== "weighted") {
        return new Map(userIds.map((id) => [id, BASE_WEIGHT]))
    }

    // Anonymous songs have no owner to rate, so they sit at the base weight.
    const ratedUserIds = userIds.filter(
        (id): id is Id<"users"> => id !== ANONYMOUS,
    )
    const ratings = await getUserRatings(
        ctx,
        room._id,
        ratedUserIds,
        room.settings.numSongsToForget ?? -1,
    )

    return new Map(
        userIds.map((id) => [id, ratings[id]?.weight ?? BASE_WEIGHT]),
    )
}

async function contendersFor(
    ctx: QueryCtx,
    room: Doc<"rooms">,
    userQueues: Map<string, Doc<"queuedSongs">[]>,
): Promise<Contender[]> {
    const userIds = [...userQueues.keys()]
    const weights = await weightsFor(ctx, room, userIds)

    return userIds.map((id) => {
        const songs = userQueues.get(id)!
        return {
            id,
            weight: weights.get(id)!,
            queued: songs.length,
            queuedAt: Math.min(...songs.map((song) => song._creationTime)),
        }
    })
}

function usesFairShare(room: Doc<"rooms">): boolean {
    const scheduler = room.settings.scheduler
    return scheduler === "roundRobin" || scheduler === "weighted"
}

/**
 * Round robin and DemocraSchedule: fair-share turn taking (see `fairShare.ts`).
 *
 * Round robin gives every listener the same weight, which makes it a strict
 * rotation that carries across songs. DemocraSchedule weights each listener by
 * their voting record, so someone with twice the weight gets twice the turns.
 *
 * The order is deterministic. The queue is a live query that re-runs on every
 * room update, so a random ordering would reshuffle the displayed queue under
 * the listeners' feet.
 */
async function fairShareOrder(
    ctx: QueryCtx,
    room: Doc<"rooms">,
    songs: Doc<"queuedSongs">[],
    numItems: number,
): Promise<Doc<"queuedSongs">[]> {
    const { userQueues, autoDj, fallback } = bucketByUser(songs)
    const contenders = await contendersFor(ctx, room, userQueues)
    const state =
        room.fairShare ??
        (await bootstrapFairShare(ctx, room)) ??
        EMPTY_FAIR_SHARE
    const turns = planTurns(state, contenders, numItems)

    const ordered = turns.map((id) => userQueues.get(id)!.shift()!)

    // Automatic songs only fill space the users didn't, with AutoDJ first.
    if (ordered.length < numItems) {
        ordered.push(
            ...automaticQueue(autoDj, fallback, numItems - ordered.length),
        )
    }

    return ordered
}

/**
 * Runs the room's configured scheduler. FCFS is the fallback for rooms whose
 * settings predate a scheduler being stored.
 */
export async function scheduleQueue(
    ctx: QueryCtx,
    roomId: Id<"rooms">,
    numItems: number,
): Promise<Doc<"queuedSongs">[]> {
    if (numItems <= 0) return []

    const room = await ctx.db.get(roomId)
    if (!room) return []

    const songs = await collectQueue(ctx, roomId)
    if (!songs.length) return []

    if (usesFairShare(room)) {
        return fairShareOrder(ctx, room, songs, numItems)
    }
    return fcfsOrder(songs, numItems)
}

/** The scheduled queue, enriched with the nicknames the UI displays. */
export async function getScheduledQueue(
    ctx: QueryCtx,
    roomId: Id<"rooms">,
    numItems: number,
): Promise<QueuedSong[]> {
    return attachNicknames(ctx, await scheduleQueue(ctx, roomId, numItems))
}

export type NextSong = {
    song: Doc<"queuedSongs"> | null
    /**
     * The room's fair-share state once `song` starts playing. Undefined when
     * there is nothing to record: the room doesn't use fair share, or the song
     * is an automatic one that belongs to nobody.
     */
    fairShare?: FairShareState
}

/**
 * The song the room should play next, and the turn bookkeeping to store with
 * it. Callers must persist `fairShare` when they start the song, or the next
 * decision will be made as if this turn never happened.
 */
export async function chooseNextSong(
    ctx: QueryCtx,
    roomId: Id<"rooms">,
): Promise<NextSong> {
    const room = await ctx.db.get(roomId)
    if (!room) return { song: null }

    const songs = await collectQueue(ctx, roomId)
    if (!songs.length) return { song: null }

    if (!usesFairShare(room)) {
        return { song: fcfsOrder(songs, 1)[0] ?? null }
    }

    const { userQueues, autoDj, fallback } = bucketByUser(songs)
    if (!userQueues.size) {
        return { song: automaticQueue(autoDj, fallback, 1)[0] ?? null }
    }

    const contenders = await contendersFor(ctx, room, userQueues)
    const state = room.fairShare ?? EMPTY_FAIR_SHARE
    const turn = nextTurn(state, contenders)!

    return {
        song: userQueues.get(turn.id)![0],
        fairShare: recordTurn(state, turn, contenders),
    }
}

/**
 * Turn bookkeeping for a song that skips the queue entirely because the room
 * was silent when it was added. It still counts as that listener's turn.
 *
 * Returns undefined when the room doesn't use fair share.
 */
export async function chargeDirectPlay(
    ctx: QueryCtx,
    room: Doc<"rooms">,
    userId: Id<"users">,
): Promise<FairShareState | undefined> {
    if (!usesFairShare(room)) return undefined

    const weights = await weightsFor(ctx, room, [userId])
    const contenders: Contender[] = [
        {
            id: userId,
            weight: weights.get(userId)!,
            queued: 1,
            queuedAt: Date.now(),
        },
    ]
    const state = room.fairShare ?? EMPTY_FAIR_SHARE
    const turn = nextTurn(state, contenders)!
    return recordTurn(state, turn, contenders)
}

/**
 * Turn state for a room that has none yet but is already playing someone's
 * song, as rooms open when turn tracking shipped are. That song counts as its
 * owner's turn, exactly as if it had been recorded when it started.
 *
 * Returns undefined when the room already has state or there's nothing to
 * charge.
 */
export async function bootstrapFairShare(
    ctx: QueryCtx,
    room: Doc<"rooms">,
): Promise<FairShareState | undefined> {
    if (room.fairShare) return undefined
    const current = room.currentSong
    if (current?.type !== "addedByUser" || !current.addedBy) return undefined
    return chargeDirectPlay(ctx, room, current.addedBy)
}
