import { SearchSong } from "@/components/room/search-song"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

describe("SearchSong", () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("searches, renders results and passes the selected song to the room", async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn().mockResolvedValue(undefined)
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            if (url.startsWith("/api/playable/")) {
                return Promise.resolve({
                    ok: true,
                    json: vi.fn().mockResolvedValue({ playable: true }),
                })
            }

            return Promise.resolve({
                ok: true,
                json: vi.fn().mockResolvedValue([
                    {
                        videoId: "dQw4w9WgXcQ",
                        title: "Once in a Lifetime",
                        artists: [{ name: "Talking Heads" }],
                        duration_seconds: 260,
                    },
                ]),
            })
        })
        vi.stubGlobal("fetch", fetchMock)
        render(<SearchSong onSelect={onSelect} />)

        await user.type(
            screen.getByPlaceholderText("Search title or artist"),
            "  talking heads  ",
        )

        expect(
            await screen.findByText("Once in a Lifetime"),
        ).toBeInTheDocument()
        expect(screen.getByText(/Talking Heads/)).toHaveTextContent(
            "Talking Heads · 4:20",
        )
        expect(
            screen.getByRole("button", {
                name: "Add Once in a Lifetime by Talking Heads",
            }),
        ).toBeInTheDocument()
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/search?query=talking%20heads",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "ngrok-skip-browser-warning": "true",
                }),
                signal: expect.any(AbortSignal),
            }),
        )

        await user.click(screen.getByText("Once in a Lifetime"))

        await waitFor(() => {
            expect(onSelect).toHaveBeenCalledWith({
                videoId: "dQw4w9WgXcQ",
                title: "Once in a Lifetime",
                artist: "Talking Heads",
                duration: 260,
            })
        })
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/playable/dQw4w9WgXcQ",
            expect.objectContaining({
                headers: expect.objectContaining({
                    "ngrok-skip-browser-warning": "true",
                }),
            }),
        )
    })

    it("shows the API error and clears stale results", async () => {
        const user = userEvent.setup()
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: false,
                json: vi.fn().mockResolvedValue({ error: "Search is offline" }),
            }),
        )
        render(<SearchSong onSelect={vi.fn()} />)

        await user.type(
            screen.getByPlaceholderText("Search title or artist"),
            "anything",
        )

        expect(await screen.findByText("Search is offline")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Add song" })).toBeNull()
    })

    it("shows a useful empty state for a successful search with no matches", async () => {
        const user = userEvent.setup()
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue([]),
            }),
        )
        render(<SearchSong onSelect={vi.fn()} />)

        await user.type(
            screen.getByPlaceholderText("Search title or artist"),
            "obscure song",
        )

        expect(
            await screen.findByText("Nothing found. Try a different search."),
        ).toBeInTheDocument()
    })

    it("does not search until the normalized query has three characters", async () => {
        const user = userEvent.setup()
        const fetchMock = vi.fn()
        vi.stubGlobal("fetch", fetchMock)
        render(<SearchSong onSelect={vi.fn()} />)

        await user.type(
            screen.getByPlaceholderText("Search title or artist"),
            " a ",
        )

        expect(
            screen.getByText("Type at least 3 characters to search."),
        ).toBeInTheDocument()
        await new Promise((resolve) => window.setTimeout(resolve, 400))
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("checks playability and refuses an unplayable selection", async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce({
                    ok: true,
                    json: vi.fn().mockResolvedValue([
                        {
                            videoId: "abcdefghijk",
                            title: "Blocked song",
                            artists: [{ name: "An Artist" }],
                            duration_seconds: 180,
                        },
                    ]),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: vi.fn().mockResolvedValue({ playable: false }),
                }),
        )
        render(<SearchSong onSelect={onSelect} />)

        await user.type(
            screen.getByPlaceholderText("Search title or artist"),
            "blocked track",
        )
        await user.click(
            await screen.findByRole("button", {
                name: "Add Blocked song by An Artist",
            }),
        )

        expect(
            await screen.findByText(
                "That version cannot be played here. Please choose another result.",
            ),
        ).toBeInTheDocument()
        expect(onSelect).not.toHaveBeenCalled()
    })
})
