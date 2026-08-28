/**
 * A claim gate silences the derivative alert (Issue #479).
 *
 * `mis_classification` exists to catch the audit disagreeing with a claim
 * scan that ran (Issue #2106). While a host-level gate is active the scan did
 * not run at all, so the "disagreement" is guaranteed and says nothing: the
 * audit found claimable work, and of course the scan claimed none, because
 * the gate stopped it.
 *
 * Measured on GRQ-23, the alert count tracked the `HOST_DISK_LOW` count
 * almost exactly one-for-one across three days (16 disk-low / 15
 * mis-classification in a single run). That is the signature of a derivative
 * signal, and its noise is what let the real condition hide: operators
 * learned to read the alert as a known false positive.
 *
 * The per-repo lines and the claimable total stay — they are the evidence
 * that work was waiting — only the ALERT goes.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { auditClaimableState } from "../lib/idle_detect_diagnostics.ts";

/** One repo with a single unassigned `work-on` issue: plainly claimable. */
function ghStub(): (args: string[]) => Promise<string> {
  return (_args: string[]) =>
    Promise.resolve(JSON.stringify([
      {
        number: 1,
        labels: [{ name: "work-on" }],
        assignees: [],
        milestone: null,
        body: "",
      },
    ]));
}

async function auditLines(
  claimGateActive: boolean | undefined,
): Promise<string[]> {
  const lines: string[] = [];
  await auditClaimableState({
    repos: ["org/a"],
    workerUser: "bot",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: ghStub(),
    hostnameFn: () => "host",
    pidFn: () => 1,
    log: (line: string) => lines.push(line),
    ...(claimGateActive === undefined ? {} : { claimGateActive }),
  });
  return lines;
}

Deno.test("audit - a claim gate suppresses the mis_classification ALERT (Issue #479)", async () => {
  const lines = await auditLines(true);

  assertEquals(
    lines.some((l) => l.includes("ALERT mis_classification")),
    false,
    `while a gate is active the disagreement is guaranteed and carries no ` +
      `information; its noise is what let the real condition hide: ` +
      lines.join("\n"),
  );
});

Deno.test("audit - the evidence survives the suppression (Issue #479)", async () => {
  const lines = await auditLines(true);

  assert(
    lines.some((l) => l.includes("claimable_total=1")),
    `the claimable total is the evidence that work was waiting and must ` +
      `still be logged: ${lines.join("\n")}`,
  );
  assert(
    lines.some((l) => l.includes("repo=org/a") && l.includes("claimable=1")),
    `the per-repo lines must survive too: ${lines.join("\n")}`,
  );
});

Deno.test("audit - with no gate the ALERT still fires (Issue #479)", async () => {
  const lines = await auditLines(false);

  assert(
    lines.some((l) => l.includes("ALERT mis_classification")),
    `#2106's alert must keep firing when a scan that actually ran ` +
      `disagreed with the audit: ${lines.join("\n")}`,
  );
});

Deno.test("audit - omitting the flag preserves the historical behaviour (Issue #479)", async () => {
  const lines = await auditLines(undefined);

  assert(
    lines.some((l) => l.includes("ALERT mis_classification")),
    `callers that do not know about gates must be unaffected: ` +
      lines.join("\n"),
  );
});
