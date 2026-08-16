import {
    chooseRecordingMbid,
    readPlayableSong,
    readRecommendationCandidates,
} from "@/convex/recommendations"
import { describe, expect, it } from "vitest"

const track = {
    title: "Crazy in Love",
    artist: "Beyoncé feat. Jay-Z",
    duration: 236,
}

describe("chooseRecordingMbid", () => {
    it("prefers an exact recording match over a higher-scored fuzzy result", () => {
        expect(
            chooseRecordingMbid(
                {
                    recordings: [
                        {
                            id: "fuzzy",
                            score: 100,
                            title: "Crazy Love",
                            length: 236_000,
                            "artist-credit": [{ name: "Beyoncé" }],
                        },
                        {
                            id: "exact",
                            score: 91,
                            title: "Crazy in Love",
                            length: 235_000,
                            "artist-credit": [{ name: "Beyoncé" }],
                        },
                    ],
                },
                track,
            ),
        ).toBe("exact")
    })

    it("rejects low-confidence and wrong-duration matches", () => {
        expect(
            chooseRecordingMbid(
                {
                    recordings: [
                        {
                            id: "low-score",
                            score: 70,
                            title: track.title,
                            length: 236_000,
                            "artist-credit": [{ name: track.artist }],
                        },
                        {
                            id: "wrong-version",
                            score: 100,
                            title: track.title,
                            length: 400_000,
                            "artist-credit": [{ name: track.artist }],
                        },
                    ],
                },
                track,
            ),
        ).toBeUndefined()
    })
})

describe("recommendation response parsing", () => {
    it("keeps only candidates the app can resolve", () => {
        expect(
            readRecommendationCandidates({
                candidates: [
                    {
                        recording_mbid: "valid",
                        title: "Song",
                        artist: "Artist",
                        source: "engine",
                    },
                    {
                        recording_mbid: "missing-title",
                        artist: "Artist",
                        source: "listenbrainz",
                    },
                    {
                        recording_mbid: "bad-source",
                        title: "Song",
                        artist: "Artist",
                        source: "fallback_playlist",
                    },
                ],
            }),
        ).toEqual([
            {
                recording_mbid: "valid",
                title: "Song",
                artist: "Artist",
                source: "engine",
            },
        ])
    })

    it("accepts the first complete playable YouTube result", () => {
        expect(
            readPlayableSong([
                { videoId: "missing-duration" },
                { videoId: "playable", duration_seconds: 185.6 },
            ]),
        ).toEqual({ videoId: "playable", duration: 186 })
        expect(readPlayableSong({ error: "upstream unavailable" })).toBeNull()
    })
})
