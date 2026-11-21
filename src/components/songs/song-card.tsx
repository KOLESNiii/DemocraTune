"use client"

import { cn } from "@/lib/utils"
import { ImageWithFallback } from "../image-with-fallback"
import { ServiceLinks } from "./service-links"

export type SongView = {
    id: string
    videoId: string
    title: string
    artist: string
    duration: number
    addedByNickname?: string
    /** Where else this song can be heard. Only history knows these. */
    links?: Record<string, string>
}

export function SongCard({
    song,
    tone = "dark",
}: {
    song: SongView
    tone?: "dark" | "light"
}) {
    return (
        <div
            className={cn(
                // Sized by its own width, not the screen's: the host's queue
                // column is narrow even on a wide TV.
                "group @container relative flex min-w-0 items-center justify-between gap-3 border-b py-3 transition-colors",
                tone === "dark"
                    ? "border-white/15 hover:bg-white/5"
                    : "border-ink/20 hover:bg-white/40",
            )}
            // onClick={onClick}
        >
            <ImageWithFallback
                src={`https://i.ytimg.com/vi_webp/${song.videoId}/mqdefault.webp`}
                width={128}
                height={128}
                alt={`${song.title}`}
                className="aspect-video h-16 w-28 shrink-0 object-cover @md:h-20 @md:w-36"
                unoptimized
            />
            <div className="w-full min-w-0">
                <h4 className="font-display text-lg leading-tight font-bold tracking-[-0.025em] @md:text-xl">
                    {song.title}
                </h4>
                <p
                    className={cn(
                        "mt-1 text-sm @md:text-base",
                        tone === "dark" ? "text-white/65" : "text-ink/55",
                    )}
                >
                    {song.artist}
                </p>
                <ServiceLinks
                    links={song.links}
                    tone={tone}
                    className="mt-1.5"
                />
            </div>
            <div className="min-w-0 shrink-0">
                {song.addedByNickname && (
                    <p
                        className={cn(
                            "max-w-24 truncate text-right text-xs @md:max-w-36 @md:text-sm",
                            tone === "dark" ? "text-white/55" : "text-ink/50",
                        )}
                    >
                        by {song.addedByNickname}
                    </p>
                )}
            </div>
            {/* {onDelete && (
                <div className="absolute top-0 right-0 z-10 hidden group-hover:block">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                            e.stopPropagation()
                            onDelete()
                        }}
                    >
                        <Trash2Icon className="size-4" />
                    </Button>
                </div>
            )} */}
        </div>
    )
}
