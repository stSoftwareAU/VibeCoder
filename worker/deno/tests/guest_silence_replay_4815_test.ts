/**
 * Bounded replay of the archived completion wedges (Issue #4815).
 *
 * GRQ-3 posted the redacted facts of three completion-phase watchdog kills on
 * Issue #4815 (PR #5294 backfill). In every one the guest did not answer its
 * exec probe, and the last step logged differs (`agent turn` twice,
 * `pre-PR verifier` once): the guest VM itself hung, not one completion step.
 * The repair for a hung guest is the launcher's early silent-guest reap
 * (Issue #5161). This replay drives each kill's recorded silence through the
 * real `checkGuestSilence` decision at the launcher's real check cadence and
 * proves the guest is reaped before the silence each kill actually ran to —
 * and that a guest that still answers is never reaped. No private log content
 * is used: only the public timestamps posted on the issue.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { EvidenceSeams } from "../lib/hard_kill_evidence.ts";
import {
  checkGuestSilence,
  DEFAULT_GUEST_SILENCE_CHECK_SECONDS,
  DEFAULT_GUEST_SILENCE_SECONDS,
  GUEST_SILENCE_PROBE_TIMEOUT_MS,
  GUEST_SILENCE_PROBES,
} from "../lib/guest_silence_watch.ts";

/** The three kills whose facts were posted on Issue #4815. */
const KILLS = [
  {
    container: "vibe-coder-46887",
    lastStep: "pre-PR verifier",
    lastLog: "2026-11-04T21:16:02Z",
    capturedAt: "2026-11-04T22:17:09.220Z",
  },
  {
    container: "vibe-coder-53371",
    lastStep: "agent turn",
    lastLog: "2026-11-03T04:28:08Z",
    capturedAt: "2026-11-03T04:58:25.232Z",
  },
  {
    container: "vibe-coder-9753",
    lastStep: "agent turn",
    lastLog: "2026-11-02T20:17:17Z",
    capturedAt: "2026-11-02T21:47:37.378Z",
  },
] as const;

/** Seams for one replayed check: the worker log frozen at its last write. */
function replaySeams(
  container: string,
  lastLogMs: number,
  guestAnswers: boolean,
): { seams: EvidenceSeams; probes: string[][] } {
  const probes: string[][] = [];
  const seams: EvidenceSeams = {
    runRuntime: (args) => {
      probes.push([...args]);
      assertEquals(args, ["exec", container, "true"]);
      return Promise.resolve(
        guestAnswers
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: "exec timed out" },
      );
    },
    listLogFiles: () =>
      Promise.resolve([{ name: "worker.log", mtimeMs: lastLogMs }]),
    readTail: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
    hostname: () => "GRQ-3",
    timeout: () => ({ promise: new Promise<void>(() => {}), cancel: () => {} }),
  };
  return { seams, probes };
}

/**
 * Replay the launcher's checks from the last log line, one every `cadence`
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
    const { seams, probes } = replaySeams(
      kill.container,
      lastLogMs,
      guestAnswers,
    );
    const verdict = await checkGuestSilence(seams, {
      containerName: kill.container,
      evidenceDir: "/logs",
      silenceSeconds: DEFAULT_GUEST_SILENCE_SECONDS,
      nowMs,
      now: () => nowMs,
    });
    if (silent < DEFAULT_GUEST_SILENCE_SECONDS) {
      assertEquals(verdict.wedged, false);
      assertEquals(probes.length, 0, "no probe while the log is fresh");
    }
    if (verdict.wedged) return silent;
  }
  return null;
}

for (const kill of KILLS) {
  Deno.test(`replay #4815 ${kill.container} (${kill.lastStep}) - the early reap fires before the recorded silence`, async () => {
    const cadence = DEFAULT_GUEST_SILENCE_CHECK_SECONDS;
    const observed = (Date.parse(kill.capturedAt) - Date.parse(kill.lastLog)) /
      1000;
    // Worst case for the reap: two probes each running to their bound.
    const probeSeconds = GUEST_SILENCE_PROBES * GUEST_SILENCE_PROBE_TIMEOUT_MS /
      1000;
    // Every phase of the launcher's check clock against the last log line.
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

  Deno.test(`replay #4815 ${kill.container} (${kill.lastStep}) - a guest that still answers is never reaped`, async () => {
    const cadence = DEFAULT_GUEST_SILENCE_CHECK_SECONDS;
    const observed = (Date.parse(kill.capturedAt) - Date.parse(kill.lastLog)) /
      1000;
    assertEquals(
      await firstWedgedSilence(kill, cadence, 1, observed, true),
      null,
    );
  });
}
