/**
 * Per-slot idle accounting and fleet slot utilisation (Issue #925).
 *
 * `fleet_telemetry.ts` (Issue #855) answers "was the *fleet* occupied?" —
 * occupancy there is deliberately "at least one stream held a claim", so a
 * two-slot pool with one slot working reads as fully occupied. That is the
 * right shape for the wall-clock partition it maintains, and the wrong shape
 * for the question this module exists to answer: **is any slot doing
 * nothing?**
 *
 * A two-slot fleet ran for 47 minutes with `s1` working an issue and `s2`
 * re-scanning every 30 seconds and finding nothing. The run
 * recorded zero idle time, emitted no `idle-detect` / `idle-census` /
 * `idle-hooks` line, and filed no idle-task, because every idle instrument
 * was gated on the per-cycle, fleet-wide `tracker.foundClaimableIssue` flag
 * that `s1`'s claim had set true. Half the fleet was invisible.
 *
 * # The accounting model
 *
 * The denominator is **capacity**, not wall time:
 *
 *   availableSlotSeconds = configuredSlots × runWallSeconds
 *
 * against which four non-overlapping spans are booked:
 *
 *   - **occupied** — slot-seconds a slot held a claim. Everything a claim
 *     does is occupied: setup, the agent run, running tests, the quality
 *     gate, review. A claim that sleeps on the agent's own rate-limit retry
 *     ladder is occupied too — the slot is holding work, not looking for it
 *     (the same call `fleet_telemetry.recordInRunBlockedSeconds` makes).
 *   - **blocked** — slot-seconds the whole fleet was paused waiting for a
 *     quota to refresh, split by {@link FleetBlockKind} — `rate_limited`
 *     (GitHub API) and `token_blocked` (model usage). Recorded from the
 *     loop-level pauses, where the waiting actually happens: a slot that
 *     meets an active rate-limit signal at its pre-claim guard drains the
 *     pool immediately rather than waiting in the slot, so the seconds
 *     accrue outside any slot. The stop is still counted, per reason, in
 *     {@link SlotUtilisationSnapshot.blockedStops}.
 *   - **idle** — slot-seconds a live slot spent looking for work and not
 *     finding any. This is the number the operator wants near zero, and the
 *     number that read as zero for 47 minutes.
 *   - **unstaffed** — the remainder: capacity that existed while no slot was
 *     running at all (start-up, the serial priority ladder, the end-of-cycle
 *     sleep). Reported rather than folded into idle, because a slot that
 *     does not exist cannot be said to be looking for work.
 *
 * Idle and occupied are recorded **per slot**, so `s2` idling beside a busy
 * `s1` is visible by name.
 *
 * A fifth span sits outside that partition because it describes a host that
 * ran **no** slot at all: **unavailable** — capacity lost because the host
 * cannot start a container (Issue #997). It is produced by the launcher, not
 * by the ledger, and carries the reason with it; see
 * {@link parkedHostCapacity}.
 *
 * # Why the reasons are not invented here
 *
 * The operator's demand is that idle time be near zero *and visible*, not
 * that every non-claiming second be called idle. The vocabulary for the
 * legitimately-occupied states already exists and is reused verbatim:
 * {@link FleetBlockKind} from `fleet_telemetry.ts`, which is itself derived
 * from `RateLimitBlockKind` in `rate_limit_signal.ts` (`github` →
 * `rate_limited`, `usage` → `token_blocked`). The reason a *cycle* was idle
 * stays where it already lives — the census's `FleetIdleReason`.
 *
 * # Lifecycle
 *
 * {@link SlotIdleLedger} is a plain class with an injected clock, so the
 * behaviour is testable without touching process state. A module-level
 * singleton plus thin wrappers mirrors the convention `fleet_telemetry.ts`
 * and `cycle_timings.ts` already use for the main loop's own wiring.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { FleetBlockKind } from "./fleet_telemetry.ts";

/**
 * What a slot is doing.
 *
 * `claim` covers every second a slot holds an issue — setup, the agent run,
 * tests, the quality gate. `idle` is the state that must not hide: the slot
 * is alive, scanning, and finding nothing claimable.
 */
export type SlotActivity = "idle" | "claim";

/**
 * Capacity a host has but cannot staff at all, and why (Issue #997).
 *
 * The four spans above all describe a host that is *running*. A host whose
 * containers cannot reach the network runs no slot at all, and reporting that
 * as an absence — no line, no numbers — is what let GRQ-23 sit parked and
 * unnoticed. It is capacity the fleet has lost, so it is reported as capacity,
 * with the one vocabulary word that says why.
 */
export interface UnavailableCapacity {
  /** Slot-seconds no slot could be run for. */
  slotSeconds: number;
  /** Why, e.g. `container_egress_blocked`. */
  reason: string;
}

/** Per-slot and fleet-wide slot-second totals plus the derived rates. */
export interface SlotUtilisationSnapshot {
  /** Configured slot count — the capacity the denominator is built from. */
  slots: number;
  /**
   * The machine these numbers describe (Issue #997). Set only where the line
   * is produced outside the run it is about — the launcher reporting a parked
   * host — since a running worker's line already rides that host's own log.
   */
  host?: string;
  /**
   * Capacity that could not be staffed at all, and why (Issue #997). Absent
   * on a host that is running: a live pool books every slot-second to one of
   * the four spans above.
   */
  unavailable?: UnavailableCapacity;
  /** Wall seconds observed since the window opened. */
  wallSeconds: number;
  /** `slots × wallSeconds`. */
  availableSlotSeconds: number;
  /** Slot-seconds a slot held a claim. */
  occupiedSlotSeconds: number;
  /** Slot-seconds a live slot found no claimable work. */
  idleSlotSeconds: number;
  /** Slot-seconds the fleet was paused on a quota, summed over reasons. */
  blockedSlotSeconds: number;
  /** Blocked slot-seconds split by reason; sums to `blockedSlotSeconds`. */
  blockedByReason: Record<string, number>;
  /** How many times a slot stopped before its next claim, by block reason. */
  blockedStops: Record<string, number>;
  /** Capacity that existed while no slot was running. */
  unstaffedSlotSeconds: number;
  /** Occupied seconds per slot id. */
  occupiedBySlot: Record<string, number>;
  /** Idle seconds per slot id. */
  idleBySlot: Record<string, number>;
  /** `occupiedSlotSeconds / availableSlotSeconds`, or 0 before any wall. */
  utilisation: number;
}

interface SlotSpan {
  activity: SlotActivity;
  sinceMs: number;
}

function addTo(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function secondsFrom(ms: number): number {
  return Math.round(ms / 1000);
}

function secondsMap(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].map(([key, ms]) => [key, secondsFrom(ms)]),
  );
}

/**
 * Accumulates per-slot idle/occupied slot-seconds against the fleet's
 * configured capacity. Every method takes the clock as a parameter, so a
 * test drives it without a timer.
 */
export class SlotIdleLedger {
  private slots = 1;
  private startMs: number | undefined;
  private readonly open = new Map<string, SlotSpan>();
  private readonly occupiedMsBySlot = new Map<string, number>();
  private readonly idleMsBySlot = new Map<string, number>();
  private readonly blockedMsByReason = new Map<string, number>();
  private readonly blockedStopsByReason = new Map<string, number>();

  /**
   * Open the accumulation window. `slots` is the configured concurrency —
   * the capacity the operator asked for, which is what "1 of 2 slots busy"
   * is measured against.
   */
  start(nowMs: number, slots: number): void {
    this.slots = Math.max(1, Math.floor(slots));
    this.startMs = nowMs;
    this.open.clear();
    this.occupiedMsBySlot.clear();
    this.idleMsBySlot.clear();
    this.blockedMsByReason.clear();
    this.blockedStopsByReason.clear();
  }

  /** Close the span a slot is in, banking its seconds under its activity. */
  private closeSpan(slotId: string, nowMs: number): void {
    const span = this.open.get(slotId);
    if (span === undefined) return;
    const ms = Math.max(0, nowMs - span.sinceMs);
    if (span.activity === "claim") addTo(this.occupiedMsBySlot, slotId, ms);
    else addTo(this.idleMsBySlot, slotId, ms);
    this.open.delete(slotId);
  }

  /**
   * Record what a slot is doing from `nowMs`. Repeating the current
   * activity is a no-op, so a slot that re-scans every 30 seconds keeps one
   * continuous idle span rather than a hundred fragments.
   */
  setSlotActivity(
    slotId: string,
    activity: SlotActivity,
    nowMs: number,
  ): void {
    const span = this.open.get(slotId);
    if (span !== undefined && span.activity === activity) return;
    this.closeSpan(slotId, nowMs);
    this.open.set(slotId, { activity, sinceMs: nowMs });
  }

  /** A slot has left the pool: close its span and stop accruing for it. */
  retireSlot(slotId: string, nowMs: number): void {
    this.closeSpan(slotId, nowMs);
  }

  /**
   * How many slots are idle right now (Issue #1083): the configured
   * capacity less the slots currently holding a claim.
   *
   * This module is already the authority on "is any slot doing nothing?",
   * so it is also the authority on how much idle work the fleet can pick
   * up. The idle-task filer bounds its filing by this rather than by a
   * constant, so the fleet fills its empty slots without flooding itself
   * with more issues than it can handle.
   *
   * A slot with no open span is counted idle: at the end-of-cycle gate
   * every slot has drained, and a drained pool is idle capacity, not
   * occupancy.
   */
  idleSlotCapacity(): number {
    let claiming = 0;
    for (const span of this.open.values()) {
      if (span.activity === "claim") claiming += 1;
    }
    return Math.max(0, this.slots - claiming);
  }

  /**
   * Fleet-wide pause on a quota. Every configured slot was blocked for that
   * wall time, so the capacity it consumed is `seconds × slots` — booked to
   * the block, never to idle.
   */
  recordBlockedSlotSeconds(kind: FleetBlockKind, seconds: number): void {
    const ms = Math.max(0, seconds) * 1000 * this.slots;
    if (ms === 0) return;
    addTo(this.blockedMsByReason, kind, ms);
  }

  /**
   * A slot stopped before its next claim because a quota was exhausted.
   * Counted, not timed: the pool drains immediately and the waiting happens
   * at the loop level, where {@link recordBlockedSlotSeconds} books it.
   */
  recordBlockedStop(kind: FleetBlockKind): void {
    addTo(this.blockedStopsByReason, kind, 1);
  }

  /** Every accumulator, with spans still open counted up to `nowMs`. */
  snapshot(nowMs: number): SlotUtilisationSnapshot {
    const wallSeconds = this.startMs === undefined
      ? 0
      : Math.max(0, secondsFrom(nowMs - this.startMs));
    const occupied = new Map(this.occupiedMsBySlot);
    const idle = new Map(this.idleMsBySlot);
    for (const [slotId, span] of this.open) {
      const ms = Math.max(0, nowMs - span.sinceMs);
      addTo(span.activity === "claim" ? occupied : idle, slotId, ms);
    }
    const occupiedBySlot = secondsMap(occupied);
    const idleBySlot = secondsMap(idle);
    const blockedByReason = secondsMap(this.blockedMsByReason);
    const sum = (r: Record<string, number>) =>
      Object.values(r).reduce((a, b) => a + b, 0);
    const availableSlotSeconds = this.slots * wallSeconds;
    const occupiedSlotSeconds = sum(occupiedBySlot);
    const idleSlotSeconds = sum(idleBySlot);
    const blockedSlotSeconds = sum(blockedByReason);
    return {
      slots: this.slots,
      wallSeconds,
      availableSlotSeconds,
      occupiedSlotSeconds,
      idleSlotSeconds,
      blockedSlotSeconds,
      blockedByReason,
      blockedStops: Object.fromEntries(this.blockedStopsByReason),
      unstaffedSlotSeconds: Math.max(
        0,
        availableSlotSeconds - occupiedSlotSeconds - idleSlotSeconds -
          blockedSlotSeconds,
      ),
      occupiedBySlot,
      idleBySlot,
      utilisation: availableSlotSeconds > 0
        ? occupiedSlotSeconds / availableSlotSeconds
        : 0,
    };
  }
}

function joinCounts(counts: Record<string, number>, suffix: string): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value}${suffix}`);
  return parts.length > 0 ? parts.join(",") : "none";
}

function pct(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0";
}

/**
 * One machine-readable line, emitted beside `fleet-summary:`. The two
 * numbers the issue asks for lead: occupied slot-seconds against available
 * slot-seconds, so `1 of 2 slots busy` reads as `occupied_pct=50.0` rather
 * than silently as a fully occupied fleet.
 *
 * The `host=` and `unavailable*=` fields appear only on a parked host's line
 * (Issue #997), so a running pool's line is exactly the one Issue #925
 * defined.
 */
export function formatSlotUtilisation(
  snapshot: SlotUtilisationSnapshot,
): string {
  const available = snapshot.availableSlotSeconds;
  const unavailable = snapshot.unavailable;
  return [
    "slot-utilisation:",
    ...(snapshot.host ? [`host=${snapshot.host}`] : []),
    `slots=${snapshot.slots}`,
    `wall=${snapshot.wallSeconds}s`,
    `available=${available}s`,
    `occupied=${snapshot.occupiedSlotSeconds}s`,
    `occupied_pct=${pct(snapshot.occupiedSlotSeconds, available)}`,
    `idle=${snapshot.idleSlotSeconds}s`,
    `idle_pct=${pct(snapshot.idleSlotSeconds, available)}`,
    `blocked=${snapshot.blockedSlotSeconds}s`,
    `unstaffed=${snapshot.unstaffedSlotSeconds}s`,
    `occupied_by_slot=${joinCounts(snapshot.occupiedBySlot, "s")}`,
    `idle_by_slot=${joinCounts(snapshot.idleBySlot, "s")}`,
    `blocked_by_reason=${joinCounts(snapshot.blockedByReason, "s")}`,
    `blocked_stops=${joinCounts(snapshot.blockedStops, "")}`,
    ...(unavailable
      ? [
        `unavailable=${unavailable.slotSeconds}s`,
        `unavailable_pct=${pct(unavailable.slotSeconds, available)}`,
        `unavailable_reason=${unavailable.reason}`,
      ]
      : []),
  ].join(" ");
}

/** What {@link parkedHostCapacity} is told about a parked host. */
export interface ParkedHostCapacityInput {
  /** The machine, when the caller knows its name. */
  host?: string;
  /** The host's configured concurrency — the capacity it can no longer offer. */
  slots: number;
  /** How long it is parked before it re-probes. */
  parkedSeconds: number;
  /** Why it cannot run, e.g. `container_egress_blocked`. */
  reason: string;
}

/**
 * A host that cannot run containers at all, as slot-utilisation (Issue #997).
 *
 * Every slot-second in the window is unavailable: no slot was occupied, none
 * was idle looking for work, and none was blocked on a quota — the host could
 * not start one. Reporting it in this shape means "why is that host claiming
 * nothing?" is answered by the same line an operator already reads for the
 * hosts that *are* running, rather than by their absence.
 *
 * A host whose configured capacity cannot be resolved reports one slot: the
 * lost capacity is then understated, never invented.
 */
export function parkedHostCapacity(
  input: ParkedHostCapacityInput,
): SlotUtilisationSnapshot {
  const slots = Math.max(1, Math.floor(input.slots));
  const wallSeconds = Math.max(0, Math.floor(input.parkedSeconds));
  const availableSlotSeconds = slots * wallSeconds;
  return {
    slots,
    ...(input.host ? { host: input.host } : {}),
    wallSeconds,
    availableSlotSeconds,
    occupiedSlotSeconds: 0,
    idleSlotSeconds: 0,
    blockedSlotSeconds: 0,
    blockedByReason: {},
    blockedStops: {},
    unstaffedSlotSeconds: 0,
    occupiedBySlot: {},
    idleBySlot: {},
    utilisation: 0,
    unavailable: {
      slotSeconds: availableSlotSeconds,
      reason: input.reason,
    },
  };
}

/**
 * Capacity guard for the idle-task filer (Issues #925, #1083).
 *
 * Making the filer per-slot introduced a multiplication the fleet-wide gate
 * never had: the filer picks a repository with no open `idle-task` issue, so
 * one slot re-scanning 74 times would file 74 issues. Issue #925 answered
 * that with a single boolean — one filing per idle *episode* per host — and
 * in doing so also refused the case the operator actually wants: **N slots
 * going idle should produce up to N idle tasks**, because an idle slot is a
 * fault rather than a resting state. That latch alone held a host at one
 * idle task however many of its slots were empty (Issue #1083).
 *
 * The unit of filing is therefore an *idle observer within an episode*,
 * bounded by the fleet's idle capacity:
 *
 *   - {@link tryConsume} succeeds once per `observerId` per episode, so a
 *     slot re-scanning 74 times still files once, while six idle slots may
 *     file six. The observer is recorded synchronously, before the caller's
 *     first `await`, so two slots cannot both win one permit;
 *   - the total is bounded by `capacityFn()` — the slots not currently
 *     holding a claim, from this module's own ledger — so the fleet never
 *     files more idle work than it can pick up. A fully occupied fleet has
 *     capacity zero and files nothing;
 *   - {@link release} is called when any slot takes a claim, so once the
 *     fleet is supplied again a later idle episode may file again;
 *   - {@link fired} and {@link filedCount} let the end-of-cycle gate see
 *     what the slots already did this episode.
 */
export class IdleFilerLatch {
  private readonly consumedBy = new Set<string>();

  /**
   * @param capacityFn How many slots are idle right now. Read at each
   * {@link tryConsume} rather than captured at construction, because the
   * fleet's occupancy changes across an episode. Defaults to one — the
   * pre-#1083 bound, and the honest answer for a caller with no ledger.
   */
  constructor(private readonly capacityFn: () => number = () => 1) {}

  /**
   * True the first time `observerId` observes this idle episode, while the
   * episode's filings remain under the fleet's idle capacity.
   */
  tryConsume(observerId: string): boolean {
    if (this.consumedBy.has(observerId)) return false;
    const capacity = Math.floor(this.capacityFn());
    if (this.consumedBy.size >= capacity) return false;
    this.consumedBy.add(observerId);
    return true;
  }

  /** A slot took a claim: the next idle episode may file again. */
  release(): void {
    this.consumedBy.clear();
  }

  /** Whether this episode has already filed. */
  get fired(): boolean {
    return this.consumedBy.size > 0;
  }

  /** How many observers have filed this episode. */
  get filedCount(): number {
    return this.consumedBy.size;
  }
}

// ---------------------------------------------------------------------------
// Module singleton — the main loop's wiring
// ---------------------------------------------------------------------------

let ledger = new SlotIdleLedger();

/** Open a fresh accumulation window for a run. */
export function startSlotIdleAccounting(nowMs: number, slots: number): void {
  ledger = new SlotIdleLedger();
  ledger.start(nowMs, slots);
}

/** See {@link SlotIdleLedger.setSlotActivity}. */
export function noteSlotActivity(
  slotId: string,
  activity: SlotActivity,
  nowMs: number,
): void {
  ledger.setSlotActivity(slotId, activity, nowMs);
}

/** See {@link SlotIdleLedger.retireSlot}. */
export function noteSlotRetired(slotId: string, nowMs: number): void {
  ledger.retireSlot(slotId, nowMs);
}

/** See {@link SlotIdleLedger.recordBlockedSlotSeconds}. */
export function recordBlockedSlotSeconds(
  kind: FleetBlockKind,
  seconds: number,
): void {
  ledger.recordBlockedSlotSeconds(kind, seconds);
}

/** See {@link SlotIdleLedger.recordBlockedStop}. */
export function recordSlotBlockedStop(kind: FleetBlockKind): void {
  ledger.recordBlockedStop(kind);
}

/** See {@link SlotIdleLedger.idleSlotCapacity}. */
export function getIdleSlotCapacity(): number {
  return ledger.idleSlotCapacity();
}

/** See {@link SlotIdleLedger.snapshot}. */
export function getSlotUtilisation(nowMs: number): SlotUtilisationSnapshot {
  return ledger.snapshot(nowMs);
}

/** The `slot-utilisation:` line for the current window. */
export function formatSlotUtilisationSummary(nowMs: number): string {
  return formatSlotUtilisation(ledger.snapshot(nowMs));
}
