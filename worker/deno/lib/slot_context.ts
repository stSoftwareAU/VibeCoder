/**
 * Slot attribution for log lines and status (Issue #4181, part of #4168).
 *
 * With N concurrent issue slots the worker log is an interleaved stream:
 * two issues' phase-progress lines (Issue #4169) land side by side and
 * neither the operator nor a scraper can tell them apart. Every slot
 * therefore runs its claim inside a slot context (AsyncLocalStorage — the
 * same mechanism the per-slot write-repo allowlist uses, Issue #4175), and
 * the logger prefixes every line written under that context with
 * `[sN owner/repo#issue]`. Nothing outside a slot (the serial loop, the
 * priority ladder, housekeeping) is prefixed, so at limit 1 the log reads
 * exactly as it does today.
 *
 * The status line is the same idea for the live slot table: rendered from
 * every active hold, so one slot finishing never blanks a sibling's status.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunDeadlineReporter, RunDeadlineState } from "./run_deadline.ts";

/** One slot's claim, for attribution. */
export interface SlotContext {
  /** Stable short id for the life of the claim, e.g. `s2`. */
  slotId: string;
  repo: string;
  issueNumber: number;
  /**
   * Where this slot's run reports the deadline it is working to (Issue
   * #4297). The pool wires it to the in-flight registry so the shutdown
   * drain can see a progress-extended run as in-flight. Absent outside the
   * pool (the CLI single-issue path), where nothing is watching.
   */
  onRunDeadline?: RunDeadlineReporter;
}

const storage = new AsyncLocalStorage<SlotContext>();

/** Run `fn` with every async continuation attributed to `context`. */
export function runInSlotContext<T>(
  context: SlotContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/** The slot the current async chain runs under, if any. */
export function currentSlotContext(): SlotContext | undefined {
  return storage.getStore();
}

/**
 * Report the deadline the current run is working to (Issue #4297).
 *
 * A no-op outside a slot, or when the slot wired no reporter. Returns
 * whether the state reached a reporter, so a caller that must know (a test,
 * or a future consumer) is not left guessing.
 */
export function reportRunDeadline(state: RunDeadlineState): boolean {
  const report = storage.getStore()?.onRunDeadline;
  if (!report) return false;
  report(state);
  return true;
}

/** `[s2 owner/repo#12]` for a context. */
export function formatSlotPrefix(context: SlotContext): string {
  return `[${context.slotId} ${context.repo}#${context.issueNumber}]`;
}

/**
 * Prefix `message` with the current slot's marker, unless there is no slot
 * or the message already carries this slot's marker (the pool's own lines
 * name their slot explicitly, and must not be double-stamped).
 */
export function attributeToSlot(message: string): string {
  const context = storage.getStore();
  if (!context) return message;
  if (
    message.startsWith(`[${context.slotId} `) ||
    message.startsWith(`[${context.slotId}]`)
  ) {
    return message;
  }
  return `${formatSlotPrefix(context)} ${message}`;
}

/**
 * Render the aggregate status line from the live slot table. One hold
 * keeps today's `owner/repo#issue` form; several are joined in slot order
 * with their ids so the line reads `s1 o/a#1 | s2 o/b#2`; none → "idle".
 */
export function renderSlotStatus(
  holds: readonly SlotContext[],
): string {
  if (holds.length === 0) return "idle";
  if (holds.length === 1) {
    return `${holds[0]!.repo}#${holds[0]!.issueNumber}`;
  }
  return [...holds]
    .sort((a, b) => a.slotId.localeCompare(b.slotId, "en", { numeric: true }))
    .map((h) => `${h.slotId} ${h.repo}#${h.issueNumber}`)
    .join(" | ");
}
