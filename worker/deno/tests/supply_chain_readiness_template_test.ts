/**
 * Tests for the supply-chain readiness idle-task template
 * (Issue #2398, template #5).
 *
 * Coverage:
 *   - registration: the template is registered at module load and
 *     `getTemplate("supply-chain-readiness")` / `listTemplates()`
 *     find it.
 *   - contract flags: cooldownHours === 168, skipMilestone === true,
 *     outputLabel === "supply-chain-readiness",
 *     requiresStructuredOutput === true.
 *   - title is the literal "Run a supply-chain readiness scan" (used
 *     for dispatch).
 *   - buildIssueBody output is recognised by BOTH the title match and
 *     the body fingerprint, and leaves no raw `{{...}}` placeholders.
 *   - assembleSupplyChainReadinessPrompt substitutes placeholders /
 *     `(none)` sentinel.
 *   - runTask happy path: ensures the `supply-chain-readiness` label
 *     before the scan, and returns the before/after diff summary.
 *   - runTask error path: runScanFn failure → ok:false summary.
 *   - runTask edge case: empty before/after diff → "no findings".
 *   - runTask passes known-open finding ids to the scan runner so
 *     Claude does not re-emit them (suppression-on-re-run path).
 *   - shouldFile vetoes while an open wrapper exists.
 *   - claim handler dispatches a "Run a supply-chain readiness scan"
 *     wrapper to runTask.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleSupplyChainReadinessPrompt,
  createSupplyChainReadinessTemplate,
  renderSupplyChainReadinessSummary,
  runSupplyChainReadinessScan,
  SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT,
  SUPPLY_CHAIN_READINESS_ISSUE_TITLE,
  SUPPLY_CHAIN_READINESS_LABEL,
  supplyChainReadinessTemplate,
} from "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type { Logger, Result } from "../types.ts";
import type { OpenIssueTitle } from "../lib/idle_task_snapshot.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Stub prompt body — H1 matches the production fingerprint. */
const STUB_PROMPT = [
  "# Supply-chain readiness — Repo Posture Audit (v1)",
  "",
  "Suppressed ids:",
  "{{SUPPRESSED_IDS}}",
  "",
  "Known open finding ids:",
  "{{KNOWN_OPEN_FINDING_IDS}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

/** A fleet login, so a stubbed wrapper reads as one the fleet filed. */
const FLEET_DEDUP_AUTHOR = "vibe-bot";

/** The fleet the finding-id dedup verifies against (Issue #1243). */
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_DEDUP_AUTHOR] };

/**
 * gh stub. Distinguishes the snapshot calls (`--json number`), the
 * known-open lookup (`--json number,body,author` scoped to the label), and
 * the wrapper-veto title search (`--json number,title`). Snapshot
 * calls return the first/second entry of `snapshots`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  knownOpen?: Array<{ number: number; body: string }>;
  /** Open wrapper titles returned by the `--json number,title` query. */
  openWrapperTitles?: string[];
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  let snapshotCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify(result.map((n) => ({ number: n }))),
      );
    }
    if (jsonField === "number,body,author") {
      // Author-verified dedup (Issue #1243): only a fleet-authored
      // finding-id marker counts as an already-filed finding.
      return Promise.resolve(
        JSON.stringify(
          (scenario.knownOpen ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    // The wrapper-veto search now also asks for `author`, because a
    // title alone is text anybody may write and only the author is
    // authenticated. The stub answers as a fleet account so the veto
    // under test is a genuine fleet-filed wrapper.
    if (jsonField === "number,title" || (jsonField ?? "").includes("author")) {
      const titles = scenario.openWrapperTitles ?? [];
      return Promise.resolve(
        JSON.stringify(
          titles.map((title, i) => ({
            number: i + 1,
            title,
            author: { login: FLEET_DEDUP_AUTHOR },
          })),
        ),
      );
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function makeLogger(): { logger: Logger; records: string[] } {
  const records: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: (m) => records.push(`info:${m}`),
    warn: (m) => records.push(`warn:${m}`),
    error: (m) => records.push(`error:${m}`),
    debug: (m) => records.push(`debug:${m}`),
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, records };
}

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("supply-chain-readiness - registered at module load", () => {
  const t = getTemplate("supply-chain-readiness");
  assert(
    t !== undefined,
    "expected supply-chain-readiness template to be registered",
  );
  assertEquals(t, supplyChainReadinessTemplate);
  assert(
    listTemplates().some((x) => x.name === "supply-chain-readiness"),
    "expected listTemplates() to include supply-chain-readiness",
  );
});

Deno.test("supply-chain-readiness - contract flags", () => {
  assertEquals(supplyChainReadinessTemplate.cooldownHours, 168);
  assertEquals(supplyChainReadinessTemplate.skipMilestone, true);
  assertEquals(
    supplyChainReadinessTemplate.outputLabel,
    SUPPLY_CHAIN_READINESS_LABEL,
  );
  assertEquals(supplyChainReadinessTemplate.requiresStructuredOutput, true);
  assertEquals(
    supplyChainReadinessTemplate.buildIssueTitle("acme/widget"),
    SUPPLY_CHAIN_READINESS_ISSUE_TITLE,
  );
});

Deno.test("supply-chain-readiness - buildIssueBody matches title and fingerprint", async () => {
  const t = createSupplyChainReadinessTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-05-25T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  // Title match (dispatch signal #2).
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    SUPPLY_CHAIN_READINESS_ISSUE_TITLE,
  );
  // Body fingerprint (dispatch signal #3).
  assert(
    t.matchesIdleTaskBody?.(body) === true,
    "expected buildIssueBody output to match the body fingerprint",
  );
  assert(SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT.test(body));
  // No raw placeholders survive — they collapse to the (none) sentinel.
  assert(!body.includes("{{"), "expected no raw placeholders in body");
  assertStringIncludes(body, "(none)");
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

Deno.test("assembleSupplyChainReadinessPrompt - empty lists render (none)", () => {
  const out = assembleSupplyChainReadinessPrompt(STUB_PROMPT, {
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assert(!out.includes("{{SUPPRESSED_IDS}}"));
  assert(!out.includes("{{KNOWN_OPEN_FINDING_IDS}}"));
  assertStringIncludes(out, "(none)");
});

Deno.test("assembleSupplyChainReadinessPrompt - populated lists are joined", () => {
  const out = assembleSupplyChainReadinessPrompt(STUB_PROMPT, {
    suppressedIds: ["BP-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["BP-bbbbbbbbbbbb", "BP-cccccccccccc"],
  });
  assertStringIncludes(out, "BP-aaaaaaaaaaaa");
  assertStringIncludes(out, "BP-bbbbbbbbbbbb\nBP-cccccccccccc");
});

Deno.test("renderSupplyChainReadinessSummary - wording", () => {
  assertEquals(renderSupplyChainReadinessSummary([]), "no findings");
  assertEquals(
    renderSupplyChainReadinessSummary([12, 3]),
    "Supply-chain readiness scan complete. Filed 2 issues: #3, #12",
  );
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

Deno.test("runTask - happy path ensures label and diffs snapshot", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[1, 2], [1, 2, 7, 9]],
    knownOpen: [{ number: 2, body: "<!-- finding-id: BP-existing0001 -->" }],
  });
  const ensureCalls: string[] = [];
  const scanCalls: { knownOpenFindingIds: string[] }[] = [];
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: (repo) => {
      ensureCalls.push(repo);
      return Promise.resolve({ ok: true, value: undefined });
    },
    runScanFn: (opts) => {
      scanCalls.push({ knownOpenFindingIds: opts.knownOpenFindingIds });
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(
    result.summary,
    "Supply-chain readiness scan complete. Filed 2 issues: #7, #9",
  );
  // Label ensured before the scan.
  assertEquals(ensureCalls, ["acme/widget"]);
  // Known-open ids flow into the scan runner — drives the
  // "suppression drops a finding on re-run" expectation: the runner
  // sees the existing ids and the prompt's dedup rule does the rest.
  assertEquals(scanCalls.length, 1);
  assertEquals(scanCalls[0]!.knownOpenFindingIds, ["BP-existing0001"]);
  // The label-scoped snapshot query was issued.
  assert(
    calls.some((c) =>
      c.includes("--label") && c.includes(SUPPLY_CHAIN_READINESS_LABEL) &&
      c.includes("number")
    ),
  );
});

Deno.test("runTask - scan failure surfaces ok:false", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "claude", message: "boom" },
      }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "supply-chain-readiness failed");
  assertStringIncludes(result.summary, "claude");
  assertStringIncludes(result.summary, "boom");
});

Deno.test("runTask - empty diff reports no findings", async () => {
  const { gh } = makeGhStub({ snapshots: [[5], [5]] });
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
});

// ---------------------------------------------------------------------------
// shouldFile veto
// ---------------------------------------------------------------------------

Deno.test("shouldFile - vetoes while an open wrapper exists", async () => {
  const { gh } = makeGhStub({
    openWrapperTitles: [SUPPLY_CHAIN_READINESS_ISSUE_TITLE],
  });
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    // The wrapper veto now counts a title match only when the fleet
    // authored it, so the test states the fleet rather than writing
    // a config file.
    dedupAuthors: { fleetAuthors: [FLEET_DEDUP_AUTHOR] },
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, false);
});

Deno.test("shouldFile - allows filing when no open wrapper exists", async () => {
  const { gh } = makeGhStub({ openWrapperTitles: [] });
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
  });
  const allowed = await t.shouldFile!({ repo: "acme/widget" });
  assertEquals(allowed, true);
});

// ---------------------------------------------------------------------------
// Claim-handler dispatch
// ---------------------------------------------------------------------------

Deno.test("claim handler - dispatches a supply-chain-readiness wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], [11]] });
  const template = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
  });
  const { logger } = makeLogger();
  const deps: HandleIdleTaskIssueDeps = {
    logger,
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 100,
      issueTitle: SUPPLY_CHAIN_READINESS_ISSUE_TITLE,
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "irrelevant",
      workDir: "/tmp/widget",
    },
    deps,
  );

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(
    result.summary,
    "Supply-chain readiness scan complete. Filed 1 issues: #11",
  );
});

// ---------------------------------------------------------------------------
// Model tier threading (Issue #4010)
// ---------------------------------------------------------------------------

Deno.test(
  "runTask - a stamped modelTier reaches the scan runner as `model`",
  async () => {
    const { gh } = makeGhStub({ snapshots: [[], []] });
    const captured: Array<Record<string, unknown>> = [];
    const t = createSupplyChainReadinessTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      runScanFn: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true, value: true });
      },
    });

    await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 12,
      modelTier: "fable",
    });
    assertEquals(captured.length, 1);
    assertEquals(captured[0]!.model, "fable");
  },
);

Deno.test(
  "runTask - an unstamped wrapper passes no `model` to the scan runner",
  async () => {
    const { gh } = makeGhStub({ snapshots: [[], []] });
    const captured: Array<Record<string, unknown>> = [];
    const t = createSupplyChainReadinessTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      loadPromptFn: okPrompt,
      ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
      runScanFn: (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return Promise.resolve({ ok: true, value: true });
      },
    });

    await t.runTask({
      repo: "acme/widget",
      workDir: "/tmp/widget",
      idleTaskIssueNumber: 12,
    });
    assert(
      !Object.hasOwn(captured[0]!, "model"),
      "expected no model key on the scan options",
    );
  },
);

Deno.test(
  "runSupplyChainReadinessScan - the tier becomes RunClaudeOptions.model",
  async () => {
    const captured: RunClaudeOptions[] = [];
    const result = await runSupplyChainReadinessScan(
      {
        repo: "acme/widget",
        workDir: "/tmp/widget",
        knownOpenFindingIds: [],
        openIssueTitles: [],
        suppressedIds: [],
        model: "sonnet",
      },
      okPrompt,
      (options) => {
        captured.push(options);
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        });
      },
    );
    assertEquals(result.ok, true);
    assertEquals(captured[0]!.model, "sonnet");
    // The idle-task budget still applies (Issue #3657).
    assert(
      (captured[0]!.timeoutSeconds ?? 0) > 0,
      "expected the idle-task timeout to be applied",
    );
  },
);

Deno.test(
  "runSupplyChainReadinessScan - no tier means no `model` key (regression pin)",
  async () => {
    const captured: RunClaudeOptions[] = [];
    await runSupplyChainReadinessScan(
      {
        repo: "acme/widget",
        workDir: "/tmp/widget",
        knownOpenFindingIds: [],
        openIssueTitles: [],
        suppressedIds: [],
      },
      okPrompt,
      (options) => {
        captured.push(options);
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        });
      },
    );
    const options = captured[0] as unknown as Record<string, unknown>;
    assertEquals(Object.hasOwn(options, "model"), false);
  },
);

// ---------------------------------------------------------------------------
// Repo-wide open-issue titles (Issue #537)
// ---------------------------------------------------------------------------

/**
 * gh stub for the repo-wide open-issue title lookup — `issue list --json
 * number,title` with neither `--label` nor `--search`. Every other call
 * returns an empty list, so the snapshot diff stays empty and the only
 * behaviour under test is what reaches the scan runner. `fail` makes the
 * title lookup (and only that lookup) throw.
 */
function makeTitleGhStub(
  titles: Array<{ number: number; title: string }>,
  fail = false,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (
      jsonField === "number,title" && !args.includes("--label") &&
      !args.includes("--search")
    ) {
      return fail
        ? Promise.reject(new Error("gh: rate limited"))
        : Promise.resolve(JSON.stringify(titles));
    }
    return Promise.resolve("[]");
  };
}

Deno.test("assembleSupplyChainReadinessPrompt - open issue titles are substituted", () => {
  const out = assembleSupplyChainReadinessPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    {
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [
        { number: 37, title: "Add a CODEOWNERS file" },
        { number: 64, title: "Repo has no CODEOWNERS" },
      ],
    },
  );
  assert(!out.includes("{{OPEN_ISSUE_TITLES}}"));
  assertStringIncludes(out, "#37 — Add a CODEOWNERS file");
  assertStringIncludes(out, "#64 — Repo has no CODEOWNERS");
});

Deno.test("assembleSupplyChainReadinessPrompt - an empty open-issue list renders (none)", () => {
  const out = assembleSupplyChainReadinessPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    {
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [],
    },
  );
  assertEquals(out, "Already open:\n(none)");
});

Deno.test("runTask - repo-wide open issue titles reach the scan runner", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([
      { number: 37, title: "Add a CODEOWNERS file" },
    ]),
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  assertEquals(result.ok, true);
  assertEquals(seen, [[{ number: 37, title: "Add a CODEOWNERS file" }]]);
});

Deno.test("runTask - a gh failure listing titles degrades to an empty list", async () => {
  const seen: OpenIssueTitle[][] = [];
  const t = createSupplyChainReadinessTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: makeTitleGhStub([], true),
    loadPromptFn: okPrompt,
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: (opts) => {
      seen.push(opts.openIssueTitles);
      return Promise.resolve({ ok: true, value: true });
    },
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp/widget",
    idleTaskIssueNumber: 100,
  });

  // The scan still ran, with the `(none)` sentinel's empty list.
  assertEquals(result.ok, true);
  assertEquals(seen, [[]]);
});
