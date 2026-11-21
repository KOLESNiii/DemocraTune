"use client"

import { NicknameForm } from "@/components/auth/nickname-form"
import { BrandMark } from "@/components/brand/brand-mark"
import { RoomCode } from "@/components/brand/room-code"
import { TallyField } from "@/components/brand/tally-field"
import { AddSong } from "@/components/room/add-song"
import { NowPlaying } from "@/components/room/current-song"
import { ExportPlaylist } from "@/components/room/export-playlist"
import { History } from "@/components/room/history"
import { Queue } from "@/components/room/queue"
import { VoteControls } from "@/components/room/vote-controls"
import { YourStanding } from "@/components/room/your-standing"
import { api } from "@/convex/_generated/api"
import { Id } from "@/convex/_generated/dataModel"
import { HEARTBEAT_INTERVAL_MS } from "@/convex/settings"
import { useAuthedMutation } from "@/lib/auth"
import {
    Preloaded,
    useConvexAuth,
    usePreloadedQuery,
    useQuery,
} from "convex/react"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { useEffect, useEffectEvent } from "react"

export default function Room({
    roomId,
    preloadedRoom,
}: {
    roomId: Id<"rooms">
    preloadedRoom: Preloaded<typeof api.rooms.getRoomByCode>
}) {
    const room = usePreloadedQuery(preloadedRoom)
    const { isLoading, isAuthenticated } = useConvexAuth()
    const nickname = useQuery(api.nicknames.getNickname)
    const songsLeftToAdd = useQuery(api.rooms.getSongsLeftToAdd, { roomId })

    const heartbeat = useAuthedMutation(api.voting.heartbeat)
    const sendHeartbeat = useEffectEvent(() => {
        void heartbeat({ roomId }).catch(() => {
            // The next heartbeat repairs a missed presence update.
        })
    })

    useEffect(() => {
        if (!isAuthenticated) return

        sendHeartbeat()
        const intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
        return () => clearInterval(intervalId)
    }, [roomId, isAuthenticated])

    const currentSong = room?.currentSong ?? null
    const isDemocraSchedule = room?.settings?.scheduler === "weighted"

    return (
        <div className="paper-field text-ink min-h-screen">
            <div className="mx-auto w-full max-w-6xl px-5 py-5 sm:px-8 sm:py-7">
                <RoomHeader code={room?.code ?? ""} />

                {isLoading || nickname === undefined ? (
                    <main className="flex min-h-[70svh] items-center">
                        <p className="font-code text-sm font-bold tracking-[0.16em] uppercase">
                            Tuning in…
                        </p>
                    </main>
                ) : !nickname ? (
                    <main className="grid min-h-[calc(100svh-7rem)] items-center gap-12 py-14 lg:grid-cols-[1.1fr_0.9fr]">
                        <section>
                            <h1 className="font-display max-w-3xl text-5xl leading-[0.88] font-extrabold tracking-[-0.06em] text-balance sm:text-8xl sm:leading-[0.86] sm:tracking-[-0.07em]">
                                What should the room call you?
                            </h1>
                            <p className="text-ink/60 mt-6 max-w-xl text-lg">
                                This nickname labels your songs and votes for
                                this room. No account, email, or password.
                            </p>
                            <div className="border-ink mt-9 max-w-md border-y-2 py-5">
                                <NicknameForm />
                            </div>
                        </section>
                        <div className="text-broadcast hidden h-[28rem] opacity-50 lg:block">
                            <TallyField />
                        </div>
                    </main>
                ) : (
                    <main className="py-10 sm:py-14">
                        {!currentSong && (
                            <section className="border-ink border-y-2 py-7">
                                <SectionLabel>Start the room</SectionLabel>
                                <div className="mt-3 flex flex-wrap items-end justify-between gap-5">
                                    <div>
                                        <h1 className="font-display text-4xl leading-[0.92] font-extrabold tracking-[-0.05em] sm:text-5xl">
                                            Choose something to play.
                                        </h1>
                                        <p className="text-ink/60 mt-3 max-w-xl text-base">
                                            Your queue and the room history stay
                                            here while the host gets playback
                                            started.
                                        </p>
                                    </div>
                                    <AddSong
                                        roomId={roomId}
                                        prominent
                                        disabled={(songsLeftToAdd ?? 0) <= 0}
                                    />
                                </div>
                            </section>
                        )}

                        {currentSong && <section>
                            <SectionLabel>Now playing</SectionLabel>
                            <NowPlaying currentSong={currentSong} />
                            <VoteControls
                                roomId={roomId}
                                videoId={currentSong.videoId}
                            />
                        </section>}

                        <div className="mt-14 grid gap-12 lg:grid-cols-[1.1fr_0.9fr]">
                            <div className="space-y-12">
                                <section>
                                    <div className="border-ink flex flex-wrap items-end justify-between gap-4 border-b-2 pb-4">
                                        <div>
                                            <SectionLabel>
                                                Your queue
                                            </SectionLabel>
                                            <p className="text-ink/55 mt-2 text-sm">
                                                {songsLeftToAdd == null
                                                    ? "Checking your limit…"
                                                    : songsLeftToAdd > 0
                                                      ? `${songsLeftToAdd} more ${songsLeftToAdd === 1 ? "track" : "tracks"} available`
                                                      : "Your queue is full for now"}
                                            </p>
                                        </div>
                                        <AddSong
                                            roomId={roomId}
                                            prominent
                                            disabled={
                                                (songsLeftToAdd ?? 0) <= 0
                                            }
                                        />
                                    </div>
                                    <Queue roomId={roomId} />
                                </section>

                                {isDemocraSchedule && (
                                    <section>
                                        <SectionLabel>
                                            Your standing
                                        </SectionLabel>
                                        <YourStanding roomId={roomId} />
                                    </section>
                                )}
                            </div>

                            <section>
                                <SectionLabel>Played tonight</SectionLabel>
                                <History
                                    roomId={roomId}
                                    playlistId={room?.playlistId}
                                />
                                <ExportPlaylist
                                    roomId={roomId}
                                    roomCode={room?.code ?? ""}
                                />
                            </section>
                        </div>
                    </main>
                )}
            </div>
        </div>
    )
}

function RoomHeader({ code }: { code: string }) {
    return (
        <header className="border-ink flex items-center justify-between gap-4 border-b-2 pb-4">
            <Link href="/" className="flex items-center gap-3">
                <ArrowLeft className="size-5" />
                <BrandMark compact className="text-xl sm:text-2xl" />
            </Link>
            <RoomCode
                code={code}
                label="Room"
                className="items-end [&>span:last-child]:text-2xl sm:[&>span:last-child]:text-3xl"
            />
        </header>
    )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="font-code text-xs font-bold tracking-[0.18em] uppercase opacity-60">
            {children}
        </h2>
    )
}
