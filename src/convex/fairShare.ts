/**
 * Fair-share turn taking for the round robin and DemocraSchedule schedulers.
 *
 * This is weighted fair queueing over users rather than packets: start tags
 * are kept the way start-time fair queueing keeps them, but the next turn goes
 * to the smallest *finish* tag. Don't switch the selection to start tags; that
 * would favour low-weight users on ties and break the X/Y ratio below.
 *
 * Each user carries a virtual *tag*: the point on the room's virtual clock
 * where their next turn starts. A turn lasts `BASE_WEIGHT / weight`, and the
 * user whose turn would finish first plays next. Playing moves their tag on to the end of that
 * turn, so a weight-12 user's tag creeps forward a third as fast as a weight-4
 * user's, and they come round three times as often.
 *
 * That gives the property the room promises: while two users both have songs
 * waiting, a user with weight X gets X/Y as many turns as a user with weight Y,
 * for every pair in the room at once, and turns are interleaved rather than
 * played in blocks.
 *
 * The state has to persist between songs. The previous scheduler re-derived
 * everything from scratch each time a song ended, so only its very first pick
 * ever mattered: the highest weight user who wasn't playing always went next,
 * which ignored weights entirely and starved everyone else.
 *
 * Joining is the subtle part. Someone who has just arrived, or who sat out for
 * a while with nothing queued, starts from the room's clock ("now") instead of
 * cashing in turns they were never waiting for. Someone who has just played
 * keeps their tag, so emptying and refilling their queue doesn't let them jump
 * the line. Users who have been waiting all along are never pulled forward to
 * the clock, which is what keeps the ratios exact.
 *
 * Kept free of Convex runtime imports so it can be unit tested directly.
 */
import { BASE_WEIGHT } from "./settings"

export type FairShareUser = {
    /** Virtual time at which the user's next turn starts. */
    tag: number
    /** Value of `turnCount` when the user last played; -1 if never. */
    lastTurn: number
    /** Whether they still had songs queued when the last turn was recorded. */
    waiting: boolean
}

export type FairShareState = {
    /** The room's virtual clock: where the turn now playing started. */
    virtualTime: number
    /** How many turns have been recorded. */
    turnCount: number
    users: Record<string, FairShareUser>
}

export const EMPTY_FAIR_SHARE: FairShareState = {
    virtualTime: 0,
    turnCount: 0,
    users: {},
}

/** A user who may have songs waiting. */
export type Contender = {
    id: string
    /** Scheduling weight. Higher weights get proportionally more turns. */
    weight: number
    /** How many songs they have waiting. */
    queued: number
    /** Creation time of their oldest waiting song, to order first arrivals. */
    queuedAt: number
}

export type Turn = {
    id: string
    start: number
    finish: number
}

/**
 * Tags are sums of fractions such as 4/3, so two users who are exactly level
 * can differ by rounding error. Anything closer than this counts as equal.
 */
const EPSILON = 1e-9

function nearlyEqual(a: number, b: number): boolean {
    return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
}

/** Virtual length of one turn. A neutral user's turn lasts exactly 1. */
export function turnLength(weight: number): number {
    // Weights are always positive by construction, but a zero or NaN weight
    // here would make a turn infinitely long or poison every comparison.
    const safe = Number.isFinite(weight) && weight > 0 ? weight : EPSILON
    return BASE_WEIGHT / safe
}

/** Where `contender`'s next turn would start. */
function startOf(state: FairShareState, contender: Contender): number {
    const user = state.users[contender.id]
    if (user?.waiting) return user.tag
    // New, or back after a spell with nothing queued: join at the clock.
    return Math.max(user?.tag ?? 0, state.virtualTime)
}

type Candidate = Turn & { contender: Contender }

function compareCandidates(
    a: Candidate,
    b: Candidate,
    state: FairShareState,
): number {
    if (!nearlyEqual(a.finish, b.finish)) return a.finish - b.finish

    // Level: whoever has been waiting since earlier on the clock goes first.
    // That puts a newcomer at the end of the current round rather than in
    // front of people who were already waiting.
    if (!nearlyEqual(a.start, b.start)) return a.start - b.start

    // Then whoever played least recently, which makes equal weights a strict
    // rotation while everyone stays queued. Users who have never played go
    // after the existing rotation. So do users who left and came back once
    // `recordTurn` has forgotten them; they rejoin in arrival order.
    const lastA = state.users[a.id]?.lastTurn ?? -1
    const lastB = state.users[b.id]?.lastTurn ?? -1
    if (lastA !== lastB) {
        if (lastA < 0) return 1
        if (lastB < 0) return -1
        return lastA - lastB
    }

    // Then first come, first served, and finally a stable order so the queue
    // a live query shows never flickers between equivalent orderings.
    if (a.contender.queuedAt !== b.contender.queuedAt) {
        return a.contender.queuedAt - b.contender.queuedAt
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Who should play next, or null if nobody has anything queued. */
export function nextTurn(
    state: FairShareState,
    contenders: readonly Contender[],
): Turn | null {
    let best: Candidate | null = null

    for (const contender of contenders) {
        if (contender.queued <= 0) continue
        const start = startOf(state, contender)
        const candidate = {
            id: contender.id,
            start,
            finish: start + turnLength(contender.weight),
            contender,
        }
        if (!best || compareCandidates(candidate, best, state) < 0) {
            best = candidate
        }
    }

    if (!best) return null
    return { id: best.id, start: best.start, finish: best.finish }
}

/**
 * The state after `turn` has started playing. `contenders` is the queue the
 * turn was chosen from, i.e. before the chosen song left it.
 *
 * Does not mutate its arguments.
 */
export function recordTurn(
    state: FairShareState,
    turn: Turn,
    contenders: readonly Contender[],
): FairShareState {
    const users: Record<string, FairShareUser> = {}

    // Anyone not in the queue any more is no longer waiting. Their tag is kept
    // so leaving and coming straight back can't skip ahead of their turn.
    for (const [id, user] of Object.entries(state.users)) {
        users[id] = { ...user, waiting: false }
    }

    // Fix the start of everyone who was waiting for this decision, so the ones
    // still queued keep their place from here on.
    for (const contender of contenders) {
        if (contender.queued <= 0) continue
        const queuedAfter =
            contender.queued - (contender.id === turn.id ? 1 : 0)
        users[contender.id] = {
            tag: startOf(state, contender),
            lastTurn: state.users[contender.id]?.lastTurn ?? -1,
            waiting: queuedAfter > 0,
        }
    }

    users[turn.id] = {
        tag: turn.finish,
        lastTurn: state.turnCount,
        waiting: users[turn.id]?.waiting ?? false,
    }

    const virtualTime = Math.max(state.virtualTime, turn.start)

    // Forget anyone who isn't waiting and whose tag the clock has passed:
    // `startOf` would put them at the clock anyway. This keeps the stored map
    // to roughly the people active right now, however long the room runs.
    for (const [id, user] of Object.entries(users)) {
        if (!user.waiting && user.tag <= virtualTime) delete users[id]
    }

    return {
        virtualTime,
        turnCount: state.turnCount + 1,
        users,
    }
}

/**
 * The order the next `numItems` turns will be taken in, assuming nobody adds or
 * removes songs and weights stay where they are.
 *
 * This replays exactly what `nextTurn` + `recordTurn` will do as songs end, so
 * the upcoming queue a listener sees is the order the room will really play.
 */
export function planTurns(
    state: FairShareState,
    contenders: readonly Contender[],
    numItems: number,
): string[] {
    let remaining = contenders.map((contender) => ({ ...contender }))
    const order: string[] = []
    let current = state

    while (order.length < numItems) {
        const turn = nextTurn(current, remaining)
        if (!turn) break
        order.push(turn.id)
        current = recordTurn(current, turn, remaining)
        remaining = remaining.map((contender) =>
            contender.id === turn.id
                ? { ...contender, queued: contender.queued - 1 }
                : contender,
        )
    }

    return order
}
