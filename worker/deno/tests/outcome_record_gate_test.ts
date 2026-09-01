/**
 * Tests for the outcome-record gate (Issue #709).
 *
 * The behaviour under test is the fault the fleet actually filed: an
 * invocation of `container-restart-backoff` that Deno refuses the hostname
 * read to, whose escalation is therefore titled `unknown-host` and shared by
 * every host in the fleet.
 *
 * Two halves: the finder against sources whose contents are known, then the
 * four real call sites — `run.sh`, `run.ps1`, `loop.sh`, `loop.ps1` — which is
 * the gate that holds the fix.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findOutcomeRecordInvocations,
  HOSTNAME_PERMISSION,
} from "../lib/outcome_record_gate.ts";
import { REPO_ROOT } from "./fixtures/launcher_harness.ts";

Deno.test("findOutcomeRecordInvocations - a bash invocation without the permission cannot name its host", () => {
  const source = [
    "record_outcome() {",
    '  "${DENO_CMD}" run \\',
    "    --allow-env --allow-read \\",
    '    "${BASE_DIR}/mod.ts" container-restart-backoff \\',
    '    --exit-status "${status}"',
    "}",
  ].join("\n");

  const found = findOutcomeRecordInvocations("run.sh", source, "bash");
  assertEquals(found.length, 1);
  assertEquals(found[0]!.line, 4);
  assertEquals(found[0]!.namesHost, false);
  assertStringIncludes(found[0]!.fault ?? "", "unknown-host");
});

Deno.test("findOutcomeRecordInvocations - a bash invocation carrying the permission is clean", () => {
  const source = [
    "record_outcome() {",
    '  "${DENO_CMD}" run \\',
    "    --allow-env --allow-read \\",
    `    ${HOSTNAME_PERMISSION} \\`,
    '    "${BASE_DIR}/mod.ts" container-restart-backoff \\',
    '    --exit-status "${status}"',
    "}",
  ].join("\n");

  const found = findOutcomeRecordInvocations("run.sh", source, "bash");
  assertEquals(found.length, 1);
  assertEquals(found[0]!.namesHost, true);
  assertEquals(found[0]!.fault, undefined);
});

Deno.test("findOutcomeRecordInvocations - a PowerShell argument array is read the same way", () => {
  const hostless = [
    "function Write-RestartOutcome {",
    "    Invoke-HostCommand -FilePath $DenoCmd -ArgumentList @(",
    '        "run",',
    '        "--allow-env", "--allow-read",',
    '        "$BaseDir/mod.ts", "container-restart-backoff",',
    '        "--exit-status", "$Status"',
    "    )",
    "}",
  ].join("\n");
  const before = findOutcomeRecordInvocations("run.ps1", hostless, "powershell");
  assertEquals(before.length, 1);
  assertEquals(before[0]!.namesHost, false);

  const clean = hostless.replace(
    '"--allow-env", "--allow-read",',
    `"--allow-env", "--allow-read", "${HOSTNAME_PERMISSION}",`,
  );
  const after = findOutcomeRecordInvocations("run.ps1", clean, "powershell");
  assertEquals(after.length, 1);
  assertEquals(after[0]!.namesHost, true);
});

Deno.test("findOutcomeRecordInvocations - the permission in a comment does not satisfy the gate", () => {
  const source = [
    `# ${HOSTNAME_PERMISSION}: the alert names the machine it is about.`,
    '"${DENO_CMD}" run \\',
    '  "${BASE_DIR}/mod.ts" container-restart-backoff \\',
    '  --exit-status "${status}"',
  ].join("\n");

  const found = findOutcomeRecordInvocations("run.sh", source, "bash");
  assertEquals(found.length, 1, "a comment cannot grant a permission");
  assertEquals(found[0]!.namesHost, false);
});

Deno.test("findOutcomeRecordInvocations - prose naming the recorder is not an invocation", () => {
  const source = [
    "# The worker's `container-restart-backoff` command grows the wait.",
    "",
    'echo "loop.sh: container-restart-backoff gave no usable interval" >&2',
  ].join("\n");

  assertEquals(findOutcomeRecordInvocations("loop.sh", source, "bash"), []);
});

Deno.test("findOutcomeRecordInvocations - every invocation in a file is judged, not just the first", () => {
  const one = [
    '"${DENO_CMD}" run \\',
    "  container-restart-backoff \\",
    '  --exit-status "${a}"',
  ].join("\n");
  const source = `${one}\n\n${one}\n`;

  const found = findOutcomeRecordInvocations("x.sh", source, "bash");
  assertEquals(found.length, 2);
  assertEquals(found.map((invocation) => invocation.namesHost), [false, false]);
});

// ---------------------------------------------------------------------------
// The real call sites — the gate that holds the Issue #709 fix
// ---------------------------------------------------------------------------

const CALL_SITES: ReadonlyArray<[string, "bash" | "powershell"]> = [
  ["run.sh", "bash"],
  ["loop.sh", "bash"],
  ["run.ps1", "powershell"],
  ["loop.ps1", "powershell"],
];

Deno.test("every launcher and supervisor records its outcome with a readable hostname (Issue #709)", async () => {
  const faults: string[] = [];

  for (const [name, dialect] of CALL_SITES) {
    const source = await Deno.readTextFile(`${REPO_ROOT}/${name}`);
    const found = findOutcomeRecordInvocations(name, source, dialect);
    // A gate that only counts faults passes just as quietly when the call
    // site it watches is renamed away, so the absence is a failure too.
    assert(
      found.length > 0,
      `${name} makes no outcome record — the gate is watching a call site ` +
        "that has moved",
    );
    faults.push(
      ...found.filter((invocation) => !invocation.namesHost)
        .map((invocation) => invocation.fault ?? ""),
    );
  }

  assertEquals(faults, []);
});
