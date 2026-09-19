/**
 * A stand-in for the phase's `prepareRtkRun` dependency (Issue #2383).
 *
 * The phase tests need the *real* `prepareRtkRun` — a hand-written fake would
 * re-implement the indivisible hook/prompt pairing the tests exist to prove —
 * so this seam injects a scripted subprocess runner instead of `rtk` itself.
 * No binary is spawned and nothing sleeps, so the tests stay well inside the
 * unit-test speed budget.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  type PrepareRtkRunOptions,
  prepareRtkRun,
  type RtkRun,
} from "../../lib/rtk_output.ts";
import type { SubprocessResult } from "../../lib/subprocess_timeout.ts";
import type { Result } from "../../types.ts";

/** One scripted answer from the `rtk` seam. */
export type RtkReply = Result<SubprocessResult>;

/** An `rtk` invocation that exited with `code`. */
export function rtkExited(code: number, stdout = ""): RtkReply {
  return {
    ok: true,
    value: { success: code === 0, code, stdout, stderr: "", timedOut: false },
  };
}

/** A healthy `rtk --version` answer. */
export function rtkVersion(): RtkReply {
  return rtkExited(0, "rtk 0.37.2");
}

/** A healthy `rtk gain --all --format json` answer. */
export function rtkGain(totalSaved: number): RtkReply {
  return rtkExited(0, JSON.stringify({ summary: { total_saved: totalSaved } }));
}

/** A host with no `rtk` on its PATH: the process never started. */
export function rtkMissing(): RtkReply {
  return { ok: false, error: new Error("rtk: command not found") };
}

/** A scripted `prepareRtkRun` dependency and what the run asked of it. */
export interface RtkSeam {
  /** The dependency a phase is wired with. */
  prepare: (options: PrepareRtkRunOptions) => Promise<RtkRun>;
  /** The options each preparation received, in call order. */
  prepared: PrepareRtkRunOptions[];
  /** The arguments of every `rtk` invocation the run made, in call order. */
  calls: string[][];
}

/**
 * Build a `prepareRtkRun` dependency answering `replies` in order.
 *
 * @param replies - Scripted answers, one per `rtk` invocation
 * @returns The dependency plus the calls it recorded
 */
export function rtkSeam(replies: RtkReply[]): RtkSeam {
  const pending = [...replies];
  const prepared: PrepareRtkRunOptions[] = [];
  const calls: string[][] = [];

  const run = (_executable: string, args: string[]) => {
    calls.push(args);
    const reply = pending.shift();
    // Fail loud: an unscripted call means the test's expectations drifted.
    if (reply === undefined) {
      throw new Error(`unexpected rtk call: ${args.join(" ")}`);
    }
    return Promise.resolve(reply);
  };

  return {
    prepared,
    calls,
    prepare: (options: PrepareRtkRunOptions) => {
      prepared.push(options);
      return prepareRtkRun({ ...options, run });
    },
  };
}

/** A prepared run on a Claude host whose preflight succeeded. */
export function healthyRtkSeam(baseline: number, after?: number): RtkSeam {
  return rtkSeam([
    rtkVersion(),
    rtkGain(baseline),
    ...(after === undefined ? [] : [rtkGain(after)]),
  ]);
}
