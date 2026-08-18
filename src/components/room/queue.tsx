"use client"

import { api } from "@/convex/_generated/api"
import { Id } from "@/convex/_generated/dataModel"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { useQuery } from "convex/react"
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useAuthedMutation } from "@/lib/auth"
import { Button } from "../ui/button"
import { ImageWithFallback } from "../image-with-fallback"
import { ScrollArea } from "../ui/scroll-area"

export function Queue({ roomId }: { roomId: Id<"rooms"> }) {
    const queue = useQuery(api.rooms.getPersonalQueue, {
        roomId,
    })

    const [animationParent] = useAutoAnimate<HTMLUListElement>()
    const removeSong = useAuthedMutation(api.rooms.removeFromQueue)
    const moveSong = useAuthedMutation(api.rooms.moveInQueue)
    const [pendingSong, setPendingSong] = useState<string | null>(null)

    async function updateQueue(
        songId: string,
        action: () => Promise<unknown>,
    ) {
        setPendingSong(songId)
        try {
            await action()
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Queue update failed",
            )
        } finally {
            setPendingSong(null)
        }
    }

    return (
        <ScrollArea className="h-full max-h-[40vh] grow overflow-y-auto">
            <ul ref={animationParent}>
                {queue && queue.length > 0 ? (
                    queue.map((song) => (
                        <li key={song._id}>
                                <div className="group border-ink/25 relative flex min-w-0 items-center gap-3 border-b py-4 transition-colors hover:bg-white/35 sm:gap-4">
                                <ImageWithFallback
                                    src={`https://i.ytimg.com/vi_webp/${song.videoId}/mqdefault.webp`}
                                    width={128}
                                    height={128}
                                    alt={`${song.title}`}
                                    className="aspect-video h-16 w-28 shrink-0 object-cover sm:h-20 sm:w-36"
                                    unoptimized
                                />
                                <div className="min-w-0 flex-1">
                                    <h4 className="font-display truncate text-lg leading-tight font-bold tracking-[-0.025em] md:text-xl">
                                        {song.title}
                                    </h4>
                                    <p className="text-ink/55 mt-1 truncate text-sm md:text-base">
                                        {song.artist}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Move ${song.title} up`}
                                        disabled={pendingSong === song._id}
                                        onClick={() =>
                                            void updateQueue(song._id, () =>
                                                moveSong({
                                                    songId: song._id,
                                                    direction: "up",
                                                }),
                                            )
                                        }
                                    >
                                        <ArrowUp className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Move ${song.title} down`}
                                        disabled={pendingSong === song._id}
                                        onClick={() =>
                                            void updateQueue(song._id, () =>
                                                moveSong({
                                                    songId: song._id,
                                                    direction: "down",
                                                }),
                                            )
                                        }
                                    >
                                        <ArrowDown className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Remove ${song.title} from your queue`}
                                        disabled={pendingSong === song._id}
                                        onClick={() =>
                                            void updateQueue(song._id, () =>
                                                removeSong({ songId: song._id }),
                                            )
                                        }
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        </li>
                    ))
                ) : (
                    <p className="border-ink/25 text-ink/55 border-b py-5">
                        Your queue is clear. Add something when inspiration
                        strikes.
                    </p>
                )}
            </ul>
        </ScrollArea>
    )
}
