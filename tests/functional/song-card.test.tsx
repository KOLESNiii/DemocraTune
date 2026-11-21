import { SongCard } from "@/components/songs/song-card"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const song = {
    id: "1",
    videoId: "abc",
    title: "Song",
    artist: "Artist",
    duration: 180,
    links: { spotify: "https://open.spotify.com/track/1" },
}

describe("SongCard", () => {
    it("opens the song when Enter is pressed on the card itself", () => {
        const onOpen = vi.fn()
        render(<SongCard song={song} onOpen={onOpen} />)

        fireEvent.keyDown(screen.getByRole("link", { name: /Song/ }), {
            key: "Enter",
        })
        expect(onOpen).toHaveBeenCalledOnce()
    })

    it("leaves Enter on a streaming-service chip to that chip", () => {
        const onOpen = vi.fn()
        render(<SongCard song={song} onOpen={onOpen} />)

        const chip = screen.getByRole("link", { name: "Spotify" })
        const allowed = fireEvent.keyDown(chip, { key: "Enter" })

        expect(onOpen).not.toHaveBeenCalled()
        // Not cancelled, so the browser follows the chip's own link.
        expect(allowed).toBe(true)
    })
})
