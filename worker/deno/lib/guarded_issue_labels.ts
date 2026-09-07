/**
 * Guarded `--label` arguments for `gh issue create` (Issue #1276).
 *
 * `worker_label_guard.ts` documents a single invariant: every label the
 * worker applies passes its positive allowlist. Until #1276 that invariant
 * only held for labels applied to an **existing** issue — `addLabelToIssue`
 * and `escalateToHuman` were the guard's only two call sites. The scan and
 * idle-task templates apply their labels at *creation* time, pushing
 * `"--label", <value>` straight into the `gh issue create` argv, so nothing
 * checked them.
 *
 * This module is the creation-time chokepoint that closes that half. Every
 * `gh issue create` argv in `worker/deno/` builds its label arguments here,
 * and the `issue-create label guard` quality check
 * (`issue_create_label_check.ts`) fails the build on any new `--label`
 * argument that skips it.
 *
 * Fail loud: a refused label throws rather than being silently dropped, so a
 * future template that derives a label from scan data cannot quietly file an
 * issue carrying an operational or reserved label. The refusal is also
 * recorded on stderr by the guard itself as a `[SECURITY]` audit line.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertWorkerCanApplyLabel } from "./worker_label_guard.ts";

/**
 * Build the `--label` arguments for a `gh issue create` invocation, asserting
 * every label against the worker label allowlist first.
 *
 * @param labels - Labels to attach to the issue being created. Empty entries
 *   are a programming error and are refused like any other off-list label.
 * @param caller - Callsite hint (repo-relative file path) recorded in the
 *   `[SECURITY] [WORKER_LABEL_REFUSED]` audit line.
 * @returns A flat `["--label", a, "--label", b, …]` argument list.
 * @throws Error naming every refused label, if any label is not appliable.
 */
export function guardedLabelArgs(
  labels: readonly string[],
  caller: string,
): string[] {
  const refused: string[] = [];
  const args: string[] = [];

  for (const label of labels) {
    const check = assertWorkerCanApplyLabel(label, { caller });
    if (!check.ok) {
      refused.push(label);
      continue;
    }
    args.push("--label", label);
  }

  if (refused.length > 0) {
    throw new Error(
      `Refusing to create an issue with label(s) the worker may not apply: ` +
        `${refused.map((l) => `'${l}'`).join(", ")} (caller=${caller}). ` +
        `Add the label to worker/deno/lib/worker_label_guard.ts if it is ` +
        `legitimate worker content.`,
    );
  }

  return args;
}
