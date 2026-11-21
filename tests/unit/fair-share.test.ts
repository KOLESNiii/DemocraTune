import {
    type Contender,
    EMPTY_FAIR_SHARE,
    type FairShareState,
    nextTurn,
    planTurns,
    recordTurn,
} from "@/convex/fairShare"
import { describe, expect, it } from "vitest"

/** Users who always have plenty queued, in arrival order. */
function backlogged(weights: Record<string, number>): Contender[] {
    return Object.entries(weights).map(([id, weight], index) => ({
        id,
        weight,
        queued: 1_000_000,
        queuedAt: index,
    }))
}

/**
 * Plays `turns` songs the way the room does: pick one, record it, repeat.
 * Returns the sequence and the final state.
 */
function play(
    contenders: Contender[],
    turns: number,
    state: FairShareState = EMPTY_FAIR_SHARE,
) {
    const sequence: string[] = []
    for (let i = 0; i < turns; i++) {
        const turn = nextTurn(state, contenders)
        if (!turn) break
        sequence.push(turn.id)
        state = recordTurn(state, turn, contenders)
        contenders.find((c) => c.id === turn.id)!.queued -= 1
    }
    return { sequence, state }
}

function count(sequence: string[]) {
    const counts: Record<string, number> = {}
    for (const id of sequence) counts[id] = (counts[id] ?? 0) + 1
    return counts
}

function longestRun(sequence: string[], id: string) {
    let best = 0
    let run = 0
    for (const entry of sequence) {
        run = entry === id ? run + 1 : 0
        best = Math.max(best, run)
    }
    return best
}

describe("fair share scheduling", () => {
    it("gives a weight-X user X/Y as many turns as a weight-Y user", () => {
        const { sequence } = play(backlogged({ A: 8, B: 4 }), 120)
        expect(count(sequence)).toEqual({ A: 80, B: 40 })
    })

    it("keeps every pairwise ratio at once in a larger room", () => {
        const { sequence } = play(backlogged({ A: 4, B: 8, C: 12 }), 120)
        expect(count(sequence)).toEqual({ A: 20, B: 40, C: 60 })
    })

    it("never starves users who tie on weight", () => {
        const { sequence } = play(backlogged({ A: 12, B: 4, C: 4 }), 100)
        expect(count(sequence)).toEqual({ A: 60, B: 20, C: 20 })
    })

    it("honours ratios that are small or fractional", () => {
        const { sequence } = play(backlogged({ A: 1, B: 1.5 }), 100)
        expect(count(sequence)).toEqual({ A: 40, B: 60 })

        const lopsided = play(backlogged({ A: 1, B: 12 }), 130).sequence
        expect(count(lopsided)).toEqual({ A: 10, B: 120 })
    })

    it("stays within one turn of the exact share at every point", () => {
        const weights = { A: 5, B: 3, C: 1, D: 7 }
        const total = 16
        const { sequence } = play(backlogged(weights), 400)
        const seen: Record<string, number> = {}
        sequence.forEach((id, index) => {
            seen[id] = (seen[id] ?? 0) + 1
            for (const [user, weight] of Object.entries(weights)) {
                const ideal = ((index + 1) * weight) / total
                expect(Math.abs((seen[user] ?? 0) - ideal)).toBeLessThan(
                    1 + 1e-9,
                )
            }
        })
    })

    it("never drifts more than two turns from the exact share", () => {
        // Deterministic LCG so a failure is reproducible.
        let seed = 42
        const random = () =>
            (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31

        // Track the worst case and assert once: hundreds of thousands of
        // expect() calls are slow enough to time out under coverage in CI.
        let worst = 0
        for (let trial = 0; trial < 200; trial++) {
            const size = 2 + Math.floor(random() * 7)
            const weights = Object.fromEntries(
                Array.from({ length: size }, (_, i) => [
                    `u${i}`,
                    1 + Math.floor(random() * 12),
                ]),
            )
            const total = Object.values(weights).reduce((a, b) => a + b, 0)
            const { sequence } = play(backlogged(weights), 200)

            const seen: Record<string, number> = {}
            sequence.forEach((id, index) => {
                seen[id] = (seen[id] ?? 0) + 1
                for (const [user, weight] of Object.entries(weights)) {
                    const ideal = ((index + 1) * weight) / total
                    worst = Math.max(worst, Math.abs((seen[user] ?? 0) - ideal))
                }
            })
        }
        expect(worst).toBeLessThanOrEqual(2)
    })

    it("interleaves turns instead of playing one user in a block", () => {
        const { sequence } = play(backlogged({ A: 8, B: 4 }), 60)
        expect(longestRun(sequence, "A")).toBe(2)
        expect(longestRun(sequence, "B")).toBe(1)
    })

    it("is plain round robin when weights are equal", () => {
        const { sequence } = play(backlogged({ A: 4, B: 4, C: 4, D: 4 }), 12)
        expect(sequence.join("")).toBe("ABCDABCDABCD")
    })

    it("lets a newcomer join the rotation without a burst of turns", () => {
        const contenders = backlogged({ A: 4, B: 4 })
        let { state } = play(contenders, 50)

        contenders.push({ id: "C", weight: 4, queued: 1_000, queuedAt: 99 })
        const after = play(contenders, 30, state)
        state = after.state

        expect(count(after.sequence)).toEqual({ A: 10, B: 10, C: 10 })
        expect(longestRun(after.sequence, "C")).toBe(1)
    })

    it("does not bank turns for someone who had nothing queued", () => {
        const contenders = backlogged({ A: 4, B: 4 })
        contenders[1].queued = 0
        const { state } = play(contenders, 40)

        contenders[1].queued = 1_000
        const after = play(contenders, 20, state)
        expect(count(after.sequence)).toEqual({ A: 10, B: 10 })
    })

    it("keeps someone at the back after they play, even if they requeue", () => {
        const contenders = backlogged({ A: 4, B: 4, C: 4 })
        contenders[0].queued = 1
        const first = play(contenders, 1)
        expect(first.sequence).toEqual(["A"])

        // A's queue is empty for a moment, then they add another song.
        contenders[0].queued = 5
        expect(play(contenders, 3, first.state).sequence).toEqual([
            "B",
            "C",
            "A",
        ])
    })

    it("applies a changed weight from the next decision onwards", () => {
        const contenders = backlogged({ A: 4, B: 4 })
        const { state } = play(contenders, 20)
        contenders[0].weight = 12
        const after = play(contenders, 40, state)
        expect(count(after.sequence)).toEqual({ A: 30, B: 10 })
    })

    it("serves first arrivals first in a fresh room", () => {
        const contenders: Contender[] = [
            { id: "late", weight: 4, queued: 1, queuedAt: 20 },
            { id: "early", weight: 4, queued: 1, queuedAt: 10 },
        ]
        expect(planTurns(EMPTY_FAIR_SHARE, contenders, 2)).toEqual([
            "early",
            "late",
        ])
    })

    it("previews exactly the order the room goes on to play", () => {
        const make = () => backlogged({ A: 7, B: 3, C: 5 })
        const warm = play(make(), 17).state
        const preview = planTurns(warm, make(), 25)
        expect(play(make(), 25, warm).sequence).toEqual(preview)
    })

    it("stops when everyone runs out of songs", () => {
        const contenders: Contender[] = [
            { id: "A", weight: 12, queued: 2, queuedAt: 0 },
            { id: "B", weight: 1, queued: 1, queuedAt: 1 },
        ]
        expect(planTurns(EMPTY_FAIR_SHARE, contenders, 10)).toHaveLength(3)
        expect(contenders.map((c) => c.queued)).toEqual([2, 1])
    })

    it("treats a nonsensical weight as negligible rather than crashing", () => {
        const contenders = backlogged({ A: 4, B: 0 })
        const { sequence } = play(contenders, 10)
        expect(count(sequence).A).toBeGreaterThanOrEqual(9)
    })
})
