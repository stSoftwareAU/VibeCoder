/**
 * A held repository silences the derivative alert too (Issue #898).
 *
 * The idle-inversion escalation and the `mis_classification` ALERT read the
 * same fact from opposite ends: the census says work is claimable, the scan
 * says it claimed none. When a slot — or the maintenance lane (Issue #213) —
 * holds the repository, the scan never saw it, so the disagreement is
 * guaranteed and says nothing. Both alerts named `stSoftwareAU/VibeCoder` on
 * every affected cycle; fixing only one of them would leave the fleet's own
 * diagnosis contradicting itself.
 *
 * Same shape as the claim-gate suppression (Issue #479): the per-repo lines
 * and the claimable total stay — they are the evidence that work was waiting,
 * and the idle-task filer must stay suppressed while it is — only the ALERT
 * goes.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { auditClaimableState } from "../lib/idle_detect_diagnostics.ts";

/** Every repo answers with a single unassigned `work-on` issue. */
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

async function audit(
  repos: string[],
  heldRepos?: string[],
): Promise<{ lines: string[]; total: number; alertRepos: string[] }> {
  const lines: string[] = [];
  const result = await auditClaimableState({
    repos,
    workerUser: "bot",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: ghStub(),
    hostnameFn: () => "host",
    pidFn: () => 1,
    log: (line: string) => lines.push(line),
    ...(heldRepos === undefined ? {} : { heldRepos }),
  });
  return {
    lines,
    total: result.claimableTotal,
    alertRepos: result.misClassificationRepos,
  };
}

Deno.test("audit - a held repo raises no mis_classification ALERT (Issue #898)", async () => {
  const { lines, alertRepos } = await audit(
    ["stSoftwareAU/VibeCoder"],
    ["stSoftwareAU/VibeCoder"],
  );

  assertEquals(alertRepos, []);
  assert(
    !lines.some((l) => l.includes("ALERT mis_classification")),
    `no alert expected, got: ${lines.join("\n")}`,
  );
});

Deno.test("audit - a held repo keeps its claimable evidence (Issue #898)", async () => {
  const { lines, total } = await audit(
    ["stSoftwareAU/VibeCoder"],
    ["stSoftwareAU/VibeCoder"],
  );

  // The work is real: the total still suppresses the idle-task filer, and the
  // per-repo line still reports it (Issue #2813).
  assertEquals(total, 1);
  assert(lines.some((l) => l.includes("claimable_total=1")));
  assert(lines.some((l) => l.includes("repo=stSoftwareAU/VibeCoder")));
});

Deno.test("audit - an unheld repo still alerts beside a held one (Issue #898)", async () => {
  const { lines, alertRepos } = await audit(
    ["org/held", "org/scanned"],
    ["org/held"],
  );

  assertEquals(alertRepos, ["org/scanned"]);
  const alert = lines.find((l) => l.includes("ALERT mis_classification"))!;
  assert(alert.includes("repos=org/scanned"));
  assert(!alert.includes("org/held"));
});

Deno.test("audit - no held repos keeps the historical behaviour (Issue #898)", async () => {
  const { lines, alertRepos } = await audit(["org/a"]);

  assertEquals(alertRepos, ["org/a"]);
  assert(lines.some((l) => l.includes("ALERT mis_classification")));
});
