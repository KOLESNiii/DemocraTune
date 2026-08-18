import Image from "next/image"

export function HostBackground({ videoId }: { videoId?: string }) {
    return (
        <div className="bg-night pointer-events-none fixed inset-0 -z-10 overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_15%,rgba(8,120,255,0.2),transparent_32%),radial-gradient(circle_at_84%_82%,rgba(255,89,61,0.18),transparent_30%)]" />
            {videoId && (
                <>
                    {/* This darkens the image a bit to show the white text better */}
                    <div className="bg-night/45 absolute inset-0 z-10" />
                    <Image
                        src={`https://i.ytimg.com/vi_webp/${videoId}/mqdefault.webp`}
                        className="animate-rotate absolute top-1/2 left-1/2 z-0 h-[140vmax] w-[140vmax] max-w-none -translate-x-1/2 -translate-y-1/2 origin-center scale-100 mix-blend-color blur-3xl"
                        width={600}
                        height={600}
                        alt="DemocraTune background"
                        unoptimized
                    />
                    <Image
                        src={`https://i.ytimg.com/vi_webp/${videoId}/mqdefault.webp`}
                        width={600}
                        height={600}
                        className="direction-reverse animate-rotate absolute top-1/2 left-1/2 z-0 h-[140vmax] w-[140vmax] max-w-none -translate-x-1/2 -translate-y-1/2 origin-center scale-100 blur-3xl delay-10000"
                        alt="DemocraTune background"
                        unoptimized
                    />
                </>
            )}
        </div>
    )
}
