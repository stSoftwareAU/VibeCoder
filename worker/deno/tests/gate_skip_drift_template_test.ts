/**
 * Tests for the gate-skip drift idle-task template (Issue #1597,
 * follow-up from #1574 — template #19).
 *
 * Coverage:
 *   - registration at module load; contract flags
 *   - title + body fingerprint dispatch signals; no raw placeholders
 *   - pure rendering: the issue names each tool and both lines
 *   - runTask happy path: drift → one issue with the label and severity
 *   - runTask edge case: no drift → "no findings", nothing filed
 *   - runTask fail-loud path: a scanner error → ok:false, nothing filed
 *   - the scanner is pointed at the repo checkout, not the parent work dir
 *   - shouldFile veto while a wrapper is open
 *   - claim handler dispatches the wrapper to runTask
 *
 * Every test exercises the real functions against injected stubs — no
 * network, no filesystem, no Claude. Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  createGateSkipDriftTemplate,
  GATE_SKIP_DRIFT_BODY_FINGERPRINT,
  GATE_SKIP_DRIFT_FINDING_ID,
  GATE_SKIP_DRIFT_ISSUE_TITLE,
  GATE_SKIP_DRIFT_LABEL,
  gateSkipDriftTemplate,
  renderGateSkipDriftBody,
  renderGateSkipDriftSummary,
  renderGateSkipDriftTitle,
} from "../lib/idle_task_templates/gate_skip_drift_template.ts";
import type {
  GateSkipDrift,
  GateSkipDriftResult,
} from "../lib/gate_skip_drift_scanner.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_PROMPT = [
  "# Gate-Skip Drift Audit",
  "",
  "Body describing the native audit.",
  "",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

const okLabel = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

/** The NEAT-AI-core `bats` drift, as the scanner reports it. */
function batsDrift(): GateSkipDrift {
  return {
    findingId: "BP-GATE-SKIP-BATS",
    tool: "bats",
    skip: {
      tool: "bats",
      guardLine: 41,
      skipLine: 46,
      skipText: 'echo "⚠️  bats not installed — skipping shell helper tests"',
    },
    enforcement: {
      tool: "bats",
      file: ".github/workflows/ci.yml",
      line: 551,
      text: "bats tests/scripts",
      kind: "run",
      installLine: 547,
      installText: "sudo apt-get install -y bats",
    },
  };
}

/** A scan result carrying the supplied drifts. */
function scanValue(drifts: GateSkipDrift[]): GateSkipDriftResult {
  return {
    ok: true,
    value: {
      drifts,
      skips: drifts.map((d) => d.skip),
      suppressedTools: [],
      gateScriptPath: "quality.sh",
      workflowsLoaded: true,
    },
  };
}

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. `--json number` calls are the before/after snapshots; the
 * `--json number,body,author` call is the finding dedup lookup; the wrapper
 * lookup answers `wrapperOpen`; `issue create` returns a synthetic URL.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  dedup?: Array<{ number: number; body: string }>;
  createNumbers?: number[];
  wrapperOpen?: boolean;
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  let snapshotCount = 0;
  let createCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "create") {
      const nums = scenario.createNumbers ?? [];
      const n = nums[createCount] ?? 999;
      createCount += 1;
      return Promise.resolve(`https://github.com/acme/widget/issues/${n}`);
    }
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number,body,author") {
      return Promise.resolve(
        JSON.stringify(
          (scenario.dedup ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    if (jsonField === "number,title" || (jsonField ?? "").includes("author")) {
      return Promise.resolve(
        scenario.wrapperOpen
          ? JSON.stringify([{
            number: 1,
            title: GATE_SKIP_DRIFT_ISSUE_TITLE,
            author: { login: FLEET_DEDUP_AUTHOR },
          }])
          : "[]",
      );
    }
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify((result ?? []).map((n) => ({ number: n }))),
      );
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function makeLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("gate-skip-drift - registered at module load", () => {
  const t = getTemplate("gate-skip-drift");
  assert(t !== undefined);
  assertEquals(t, gateSkipDriftTemplate);
  assert(listTemplates().some((x) => x.name === "gate-skip-drift"));
});

Deno.test("gate-skip-drift - contract flags", () => {
  assertEquals(gateSkipDriftTemplate.cooldownHours, 168);
  assertEquals(gateSkipDriftTemplate.skipMilestone, true);
  assertEquals(gateSkipDriftTemplate.outputLabel, GATE_SKIP_DRIFT_LABEL);
  assertEquals(gateSkipDriftTemplate.requiresStructuredOutput, true);
  assertEquals(
    gateSkipDriftTemplate.buildIssueTitle("acme/widget"),
    GATE_SKIP_DRIFT_ISSUE_TITLE,
  );
});

Deno.test("gate-skip-drift - buildIssueBody matches title and fingerprint", async () => {
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    loadPromptFn: okPrompt,
  });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-05T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    GATE_SKIP_DRIFT_ISSUE_TITLE,
  );
  assert(t.matchesIdleTaskBody?.(body) === true);
  assert(GATE_SKIP_DRIFT_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders");
  assertStringIncludes(
    body,
    "🏷️ Filed by idle-task template: `gate-skip-drift`",
  );
});

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

Deno.test("renderGateSkipDriftTitle - names every drifting tool", () => {
  assertEquals(
    renderGateSkipDriftTitle([batsDrift()]),
    "🔴 Local gate skips `bats` — this repo's CI enforces it",
  );
  const two = renderGateSkipDriftTitle([
    batsDrift(),
    { ...batsDrift(), tool: "codespell", findingId: "BP-GATE-SKIP-CODESPELL" },
  ]);
  assertStringIncludes(two, "`bats`, `codespell`");
  assertStringIncludes(two, "enforces them");
});

Deno.test("renderGateSkipDriftBody - cites the skip line and the CI line", () => {
  const body = renderGateSkipDriftBody("quality.sh", [batsDrift()], "footer");

  assertStringIncludes(
    body,
    `<!-- finding-id: ${GATE_SKIP_DRIFT_FINDING_ID} -->`,
  );
  assertStringIncludes(body, "quality.sh:46");
  assertStringIncludes(body, "bats not installed — skipping");
  assertStringIncludes(body, ".github/workflows/ci.yml:551");
  assertStringIncludes(body, "bats tests/scripts");
  // The install step is supporting evidence, cited when the workflow has one.
  assertStringIncludes(body, ".github/workflows/ci.yml:547");
  assertStringIncludes(body, "sudo apt-get install -y bats");
  // Both fixes are named, and the waiver id the scanner keys on.
  assertStringIncludes(body, "container/tools.json");
  assertStringIncludes(body, "BP-GATE-SKIP-BATS");
  assertStringIncludes(body, "footer");
});

Deno.test("renderGateSkipDriftSummary - wording", () => {
  assertEquals(renderGateSkipDriftSummary([]), "no findings");
  assertEquals(
    renderGateSkipDriftSummary([7, 3]),
    "Gate-skip drift audit complete. Filed 2 issues: #3, #7",
  );
  assertStringIncludes(
    renderGateSkipDriftSummary([], "quality.sh could not be read"),
    "Scanner error: quality.sh could not be read.",
  );
  // A failed audit must never read as a clean one: the "no findings" count
  // is dropped entirely when the scanner errored.
  assertEquals(
    renderGateSkipDriftSummary([], "quality.sh could not be read", ""),
    "Scanner error: quality.sh could not be read.",
  );
  // An active or rejected waiver is visible in the report, not only in the
  // source it silences.
  assertEquals(
    renderGateSkipDriftSummary([], null, "Rejected suppressions (1): x."),
    "no findings Rejected suppressions (1): x.",
  );
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("gate-skip-drift runTask - drift files one issue with label + severity", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[], [50]],
    createNumbers: [50],
  });
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanValue([batsDrift()])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Filed 1 issues: #50");
  const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
  assertEquals(creates.length, 1, "one finding per repository");
  const create = creates[0]!;
  assert(create.includes(GATE_SKIP_DRIFT_LABEL));
  assert(create.includes("severity:high"));
  const bodyIdx = create.indexOf("--body");
  assertStringIncludes(
    create[bodyIdx + 1]!,
    `<!-- finding-id: ${GATE_SKIP_DRIFT_FINDING_ID} -->`,
  );
});

Deno.test("gate-skip-drift runTask - two drifting tools stay on one issue", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[], [51]],
    createNumbers: [51],
  });
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () =>
      Promise.resolve(scanValue([
        batsDrift(),
        {
          ...batsDrift(),
          tool: "codespell",
          findingId: "BP-GATE-SKIP-CODESPELL",
        },
      ])),
  });

  await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  const creates = calls.filter((c) => c[0] === "issue" && c[1] === "create");
  assertEquals(creates.length, 1);
  const body = creates[0]![creates[0]!.indexOf("--body") + 1]!;
  assertStringIncludes(body, "`bats`");
  assertStringIncludes(body, "`codespell`");
});

Deno.test("gate-skip-drift runTask - no drift files nothing", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanValue([])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assert(!calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("gate-skip-drift runTask - a scanner error fails loud", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "read", message: "quality.sh could not be read" },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "quality.sh could not be read");
  assert(!calls.some((c) => c[0] === "issue" && c[1] === "create"));
});

Deno.test("gate-skip-drift runTask - a thrown scanner never throws out of runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.reject(new Error("boom")),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 1,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "gate-skip-drift threw: boom");
});

Deno.test("gate-skip-drift runTask - the scanner reads the repo checkout, not the parent work dir (Issue #3292)", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const seen: Array<[string, string]> = [];
  const t = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: (repoPath, repo) => {
      seen.push([repoPath, repo]);
      return Promise.resolve(scanValue([]));
    },
  });

  await t.runTask({
    repo: "stSoftwareAU/private-repo-9",
    workDir: "/work",
    idleTaskIssueNumber: 1,
  });

  assertEquals(seen, [["/work/private-repo-9", "stSoftwareAU/private-repo-9"]]);
});

// ---------------------------------------------------------------------------
// shouldFile veto
// ---------------------------------------------------------------------------

Deno.test("gate-skip-drift shouldFile - vetoes while a wrapper is open", async () => {
  const openStub = makeGhStub({ wrapperOpen: true });
  const cleanStub = makeGhStub({ wrapperOpen: false });
  const openT = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: openStub.gh,
  });
  const cleanT = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: cleanStub.gh,
  });
  assertEquals(await openT.shouldFile!({ repo: "acme/widget" }), false);
  assertEquals(await cleanT.shouldFile!({ repo: "acme/widget" }), true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("gate-skip-drift - claim handler dispatches wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const template = createGateSkipDriftTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanValue([])),
  });
  const deps: HandleIdleTaskIssueDeps = {
    logger: makeLogger(),
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue({
    repo: "acme/widget",
    issueNumber: 7,
    issueTitle: GATE_SKIP_DRIFT_ISSUE_TITLE,
    issueLabels: ["idle-task"],
    issueBody: "",
    workDir: "/tmp/widget",
  }, deps);

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
});
