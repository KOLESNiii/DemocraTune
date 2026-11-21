import { v } from "convex/values"
import { internal } from "./_generated/api"
import { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import { internalMutation } from "./functions"
import { tallyVoteDocs } from "./ratings"
import { scheduleRecommendationTrack } from "./recommendations"
import { bootstrapFairShare, chooseNextSong } from "./scheduling"
import { upsertTrack } from "./tracks"

/**
 * Ends the room's current song and starts the next one.
 *
 * Shared by every path that can advance a room - the host's player reaching the
 * end of a song, the host skipping manually, and listeners voting to skip - so
 * that history, vote cleanup and playlist archiving happen exactly once no
 * matter who triggered it.
 */
export async function advanceRoom(
    ctx: MutationCtx,
    roomId: Id<"rooms">,
): Promise<Doc<"queuedSongs"> | null> {
    const room = await ctx.db.get(roomId)
    if (!room) {
        throw new Error("Room not found")
    }

    const oldSong = room.currentSong

    if (oldSong) {
        // Freeze the song's votes onto its history row. Ratings read these
        // totals afterwards, so the live votes can be cleared away. The
        // downvotes that ended a song early are included, which is the point:
        // being skipped should cost the person who queued it.
        const votes = await ctx.db
            .query("songVotes")
            .withIndex("by_room_video", (q) =>
                q.eq("room", roomId).eq("videoId", oldSong.videoId),
            )
            .collect()

        const { likes, dislikes } = tallyVoteDocs(votes)

        const trackId = await upsertTrack(ctx, oldSong)
        await ctx.db.insert("history", {
            room: roomId,
            ...oldSong,
            likes,
            dislikes,
            // Gives the played song an identity that outlives YouTube, so the
            // night can be exported somewhere else later.
            track: trackId,
        })
        // People's songs were sent for recommendation indexing when they were
        // added. AutoDJ and fallback songs never went through `addSong`, so
        // this is their only chance. advanceRoom refreshes AutoDJ itself.
        if (oldSong.type !== "addedByUser") {
            await scheduleRecommendationTrack(ctx, {
                roomId,
                trackId,
                videoId: oldSong.videoId,
                mbid: oldSong.mbid,
                refresh: false,
            })
        }

        for (const vote of votes) {
            await ctx.db.delete(vote._id)
        }

        // The old song is history now. Take it off the room before choosing,
        // or its owner's rating would count it twice (once as the current
        // song, once from history) and squeeze their forget window by one.
        await ctx.db.patch(roomId, { currentSong: undefined })

        // A room that was already playing before turn tracking existed hasn't
        // charged whoever was just on. Do that first, so they don't go again.
        // `room` is the snapshot from before the patch, so it still says who.
        const fairShare = await bootstrapFairShare(ctx, room)
        if (fairShare) await ctx.db.patch(roomId, { fairShare })
    }

    const { song: nextSong, fairShare } = await chooseNextSong(ctx, roomId)

    if (nextSong) {
        // Copy only the song fields; the queue doc also carries Convex metadata
        // and a room reference that don't belong on the room.
        const {
            addedBy,
            type,
            videoId,
            mbid,
            recommendationSource,
            title,
            artist,
            duration,
        } = nextSong
        await ctx.db.patch(roomId, {
            currentSong: {
                addedBy,
                type,
                videoId,
                mbid,
                recommendationSource,
                title,
                artist,
                duration,
            },
            // Record the turn, so the next decision knows it happened.
            ...(fairShare ? { fairShare } : {}),
        })
        await ctx.db.delete(nextSong._id)
        await ctx.scheduler.runAfter(0, internal.recommendations.refreshRoom, {
            roomId,
        })
    } else {
        await ctx.db.patch(roomId, { currentSong: undefined })
        // Out of songs. If AutoDJ is on, ask it for more; when they arrive,
        // `startIfSilent` gets the room going again.
        await ctx.scheduler.runAfter(0, internal.recommendations.refreshRoom, {
            roomId,
        })
    }

    if (oldSong && room.playlistId) {
        await ctx.scheduler.runAfter(0, internal.functions.addSongToPlaylist, {
            roomId,
            videoId: oldSong.videoId,
            playlistId: room.playlistId,
        })
    }

    return nextSong
}

/**
 * Starts the next song in a room that has gone quiet, e.g. once an AutoDJ
 * refill lands after the queue ran dry. Does nothing if something is playing.
 */
export const startIfSilent = internalMutation({
    args: { roomId: v.id("rooms") },
    handler: async (ctx, { roomId }) => {
        const room = await ctx.db.get(roomId)
        if (!room || room.currentSong) return
        await advanceRoom(ctx, roomId)
    },
})
