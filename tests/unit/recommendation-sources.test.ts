import { normalizeSourceOrder } from "@/convex/recommendationSources"
import { describe, expect, it } from "vitest"

describe("normalizeSourceOrder", () => {
    it("uses the full failover chain by default", () => {
        expect(normalizeSourceOrder()).toEqual([
            "engine",
            "listenbrainz",
            "fallback_playlist",
        ])
    })

    it("deduplicates sources and keeps the playlist fallback last", () => {
        expect(
            normalizeSourceOrder([
                "fallback_playlist",
                "listenbrainz",
                "listenbrainz",
                "engine",
            ]),
        ).toEqual(["listenbrainz", "engine", "fallback_playlist"])
    })
})
