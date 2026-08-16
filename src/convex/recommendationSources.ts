import { v } from "convex/values"

export const RECOMMENDATION_SOURCES = [
    "engine",
    "listenbrainz",
    "fallback_playlist",
] as const

export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number]

export const recommendationSourceValidator = v.union(
    v.literal("engine"),
    v.literal("listenbrainz"),
    v.literal("fallback_playlist"),
)

/**
 * Keep user-provided source preferences valid and complete. The fallback
 * playlist is always last because it produces no recommendation candidates;
 * reaching it tells the backend to stop trying remote sources.
 */
export function normalizeSourceOrder(
    sourceOrder?: readonly RecommendationSource[],
): RecommendationSource[] {
    const unique = [...new Set(sourceOrder ?? RECOMMENDATION_SOURCES)]
        .filter((source) => source !== "fallback_playlist")
        .filter((source) => RECOMMENDATION_SOURCES.includes(source))

    return [...unique, "fallback_playlist"]
}
