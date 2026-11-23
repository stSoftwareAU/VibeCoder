/**
 * Bounded replay of archived silent-guest watchdog kills (Issues #4815, #5250).
 *
 * GRQ-3 posted the redacted facts of three completion-phase watchdog kills on
 * Issue #4815 (PR #5294 backfill). In every one the guest did not answer its
 * exec probe, and the last step logged differs (`agent turn` twice,
 * `pre-PR verifier` once): the guest VM itself hung, not one completion step.
 * GRQ-25 posted one issue-phase kill on Issue #5250 (`agent turn`). The guest
 * did not answer, and it was silent for 31m 22s before capture. It was
 * captured on 17 November, before the early silent-guest reap from Issue #5161
 * landed, so it ran to the full watchdog deadline.
 * The repair for a hung guest is the launcher's early silent-guest reap
 * (Issue #5161). This replay drives each kill's recorded silence through the
 * real `checkGuestSilence` decision on a synthetic five-minute cadence.
 * It compares wedge verdicts with the recorded silence. No private log content
 * is used: only the public timestamps posted on the issue.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { EvidenceSeams } from "../lib/hard_kill_evidence.ts";
import {
  checkGuestSilence,
  DEFAULT_GUEST_SILENCE_SECONDS,
  GUEST_SILENCE_PROBE_TIMEOUT_MS,
  GUEST_SILENCE_PROBES,
} from "../lib/guest_silence_watch.ts";

const REPLAY_INTERVAL_SECONDS = 300;

/** Archived kills whose facts were posted on Issue #4815 and Issue #5250. */
const KILLS = [
  {
    issue: 4815,
    host: "GRQ-3",
    container: "vibe-coder-46887",
    lastStep: "pre-PR verifier",
    lastLog: "2026-11-04T21:16:02Z",
    capturedAt: "2026-11-04T22:17:09.220Z",
  },
  {
    issue: 4815,
    host: "GRQ-3",
    container: "vibe-coder-53371",
    lastStep: "agent turn",
    lastLog: "2026-11-03T04:28:08Z",
    capturedAt: "2026-11-03T04:58:25.232Z",
  },
  {
    issue: 4815,
    host: "GRQ-3",
    container: "vibe-coder-9753",
    lastStep: "agent turn",
    lastLog: "2026-11-02T20:17:17Z",
    capturedAt: "2026-11-02T21:47:37.378Z",
  },
  {
    issue: 5250,
    host: "GRQ-25",
    container: "vibe-coder-98651",
    lastStep: "agent turn",
    lastLog: "2026-11-17T11:25:47Z",
    capturedAt: "2026-11-17T11:57:09.137Z",
  },
] as const;

/** Seams for one replayed check: the worker log frozen at its last write. */
function replaySeams(
  lastLogMs: number,
  guestAnswers: boolean,
  host: string,
): EvidenceSeams {
  return {
    runRuntime: () =>
      Promise.resolve(
        guestAnswers
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "exec timed out" },
      ),
    listLogFiles: () =>
      Promise.resolve([{ name: "worker.log", mtimeMs: lastLogMs }]),
    readTail: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
    diskReading: () => Promise.resolve(null),
    memoryReading: () => Promise.resolve({ level: "unknown" }),
    hostname: () => host,
    timeout: () => ({ promise: new Promise<void>(() => {}), cancel: () => {} }),
  };
}

/**
 * Sample the silence decision from the last log line, one every `cadence`
 * seconds starting `offset` seconds in, and return the silence at which the
 * guest is first judged wedged — or null if it never is before `limit`.
 */
async function firstWedgedSilence(
  kill: (typeof KILLS)[number],
  cadence: number,
  offset: number,
  limit: number,
  guestAnswers: boolean,
): Promise<number | null> {
  const lastLogMs = Date.parse(kill.lastLog);
  for (let silent = offset; silent < limit; silent += cadence) {
    const nowMs = lastLogMs + silent * 1000;
    const seams = replaySeams(lastLogMs, guestAnswers, kill.host);
    const verdict = await checkGuestSilence(seams, {
      containerName: kill.container,
      evidenceDir: "/logs",
      silenceSeconds: DEFAULT_GUEST_SILENCE_SECONDS,
      nowMs,
      now: () => nowMs,
    });
    if (silent < DEFAULT_GUEST_SILENCE_SECONDS) {
      assertEquals(verdict.wedged, false);
    }
    if (verdict.wedged) return silent;
  }
  return null;
}

for (const kill of KILLS) {
  Deno.test(`replay #${kill.issue} ${kill.container} (${kill.lastStep}) - the guest is judged wedged before the recorded silence`, async () => {
    const cadence = REPLAY_INTERVAL_SECONDS;
    const observed = (Date.parse(kill.capturedAt) - Date.parse(kill.lastLog)) /
      1000;
    // Worst case for the reap: two probes each running to their bound.
    const probeSeconds = GUEST_SILENCE_PROBES * GUEST_SILENCE_PROBE_TIMEOUT_MS /
      1000;
    // Three offsets of the simulated check clock against the last log line.
    for (const offset of [1, Math.floor(cadence / 2), cadence - 1]) {
      const reapAt = await firstWedgedSilence(
        kill,
        cadence,
        offset,
        observed,
        false,
      );
      assert(
        reapAt !== null,
        `${kill.container}: never reaped early within ${observed}s`,
      );
      assert(reapAt >= DEFAULT_GUEST_SILENCE_SECONDS);
      assert(reapAt < DEFAULT_GUEST_SILENCE_SECONDS + cadence);
      assert(
        reapAt + probeSeconds < observed,
        `${kill.container}: reap at ${reapAt}s is not before ${observed}s`,
      );
    }
  });

  Deno.test(`replay #${kill.issue} ${kill.container} (${kill.lastStep}) - a guest that still answers is never judged wedged`, async () => {
    const cadence = REPLAY_INTERVAL_SECONDS;
    const observed = (Date.parse(kill.capturedAt) - Date.parse(kill.lastLog)) /
      1000;
    assertEquals(
      await firstWedgedSilence(kill, cadence, 1, observed, true),
      null,
    );
  });
}
