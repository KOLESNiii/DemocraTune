"use client"

import { cn } from "@/lib/utils"
import { useEffect, useRef, useState } from "react"

/**
 * Side of the canvas the album glow is drawn into, in pixels.
 *
 * The glow used to be two full-screen copies of the thumbnail with a 64px CSS
 * blur, one of them blended with `mix-blend-mode`, both rotating. Every frame
 * the browser had to re-blur and re-blend a layer bigger than the screen. TVs
 * have little GPU to spare, and that pinned their CPU and left the page
 * unusable; some TV browsers drop expensive blurs entirely, which turned the
 * glow into a giant pixelated thumbnail.
 *
 * Instead the thumbnail is painted once into a tiny canvas, softened while
 * it's small, and stretched to fill the screen. Stretching a tiny image with
 * bilinear filtering *is* a blur, the compositor does it for free from a
 * texture this size, and it looks the same on every browser.
 *
 * It also stays still. Any continuous motion across the whole screen means
 * redrawing the whole screen every frame, which on a TV without a capable GPU
 * is the CPU's job however cheap the layer is; the glow only changes when the
 * song does.
 */
const GLOW_SIZE = 32

export function HostBackground({ videoId }: { videoId?: string }) {
    return (
        <div className="bg-night pointer-events-none fixed inset-0 -z-10 overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_15%,rgba(8,120,255,0.2),transparent_32%),radial-gradient(circle_at_84%_82%,rgba(255,89,61,0.18),transparent_30%)]" />
            {/* Keyed so each song gets a fresh canvas that fades in. */}
            {videoId && <AlbumGlow key={videoId} videoId={videoId} />}
        </div>
    )
}

function AlbumGlow({ videoId }: { videoId: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [ready, setReady] = useState(false)

    useEffect(() => {
        const image = new window.Image()
        image.decoding = "async"
        image.onload = () => {
            const canvas = canvasRef.current
            const context = canvas?.getContext("2d")
            if (!canvas || !context) return

            // Crop the 16:9 thumbnail to its centre square, soften it while
            // it's tiny (a one-off cost), and let scaling do the rest.
            const side = Math.min(image.naturalWidth, image.naturalHeight)
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = "high"
            context.filter = "blur(2px) saturate(1.4)"
            context.drawImage(
                image,
                (image.naturalWidth - side) / 2,
                (image.naturalHeight - side) / 2,
                side,
                side,
                0,
                0,
                GLOW_SIZE,
                GLOW_SIZE,
            )
            setReady(true)
        }
        image.src = `https://i.ytimg.com/vi_webp/${videoId}/mqdefault.webp`

        return () => {
            image.onload = null
        }
    }, [videoId])

    return (
        <>
            <GlowLayer
                ref={canvasRef}
                className={cn(ready ? "opacity-90" : "opacity-0")}
            />
            {/* Darkens the glow so the white text on top stays readable. */}
            <div className="bg-night/55 absolute inset-0" />
        </>
    )
}

function GlowLayer({
    ref,
    className,
}: {
    ref: React.Ref<HTMLCanvasElement>
    className?: string
}) {
    return (
        <canvas
            ref={ref}
            width={GLOW_SIZE}
            height={GLOW_SIZE}
            aria-hidden="true"
            className={cn(
                "absolute inset-0 size-full object-cover transition-opacity duration-1000 motion-reduce:transition-none",
                className,
            )}
        />
    )
}
