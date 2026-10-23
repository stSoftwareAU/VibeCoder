/**
 * Tests for the simple-on-purpose-ledger idle-task template (Issue #4027,
 * group B). The scanner is injected, so these tests never read a repository.
 *
 * Covered: one report is created when markers exist; an open report is
 * refreshed (edited, not re-created) when its content differs; an identical
 * report is a no-op even though the attribution footer's run id differs;
 * nothing is filed for zero markers with no open report; a scanner failure
 * surfaces as `ok: false` and files nothing.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  createSimpleOnPurposeLedgerTemplate,
  renderSimpleOnPurposeLedgerContent,
  renderSimpleOnPurposeLedgerTitle,
  SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID,
  SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE,
  simpleOnPurposeLedgerContentOf,
} from "../lib/idle_task_templates/simple_on_purpose_ledger_template.ts";
import type {
  SimpleOnPurposeLedger,
  SimpleOnPurposeMarker,
  SimpleOnPurposeScanResult,
} from "../lib/simple_on_purpose_scanner.ts";
import { getTemplate } from "../lib/idle_task_template.ts";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";

const NAME = "simple-on-purpose-ledger";
const FLEET_AUTHOR = "vibe-bot";
const DEDUP_AUTHORS = { fleetAuthors: [FLEET_AUTHOR] };

const MARKER_FLAGGED: SimpleOnPurposeMarker = {
  path: "worker/deno/lib/y.ts",
  line: 9,
  ceiling: "single retry",
  upgradeWhen: null,
};
const MARKER_CLEAR: SimpleOnPurposeMarker = {
  path: "worker/deno/lib/x.ts",
  line: 4,
  ceiling: "linear scan",
  upgradeWhen: "over 10k rows",
};

function ledgerOf(markers: SimpleOnPurposeMarker[]): SimpleOnPurposeLedger {
  return {
    markers,
    missingUpgradeWhen: markers.filter((m) => m.upgradeWhen === null),
  };
}

function scanOk(ledger: SimpleOnPurposeLedger): SimpleOnPurposeScanResult {
  return { ok: true, value: ledger };
}

const okLabel = () => Promise.resolve({ ok: true as const, value: undefined });

/**
 * gh stub. `issue list --json number,body,author` is the finding-id dedup
 * lookup; `issue view` returns the open report's title and body; `issue
 * create` returns a synthetic URL; `issue edit` succeeds silently.
 */
function makeGhStub(scenario: {
  dedup?: Array<{ number: number; body: string }>;
  view?: { title: string; body: string };
  createNumber?: number;
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "create") {
      const n = scenario.createNumber ?? 50;
      return Promise.resolve(`https://github.com/acme/widget/issues/${n}`);
    }
    if (args[0] === "issue" && args[1] === "edit") return Promise.resolve("");
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify(scenario.view ?? { title: "", body: "" }),
      );
    }
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number,body,author") {
      return Promise.resolve(
        JSON.stringify(
          (scenario.dedup ?? []).map((i) => ({
            ...i,
            author: { login: FLEET_AUTHOR },
          })),
        ),
      );
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function verbCalls(calls: string[][], verb: string): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === verb);
}

const RUN_OPTS = {
  repo: "acme/widget",
  workDir: "/tmp/ledger",
  idleTaskIssueNumber: 1,
};

// ---------------------------------------------------------------------------
// Registration and identity
// ---------------------------------------------------------------------------

Deno.test("simple-on-purpose-ledger - registered at module load", () => {
  assertEquals(getTemplate(NAME)?.name, NAME);
});

Deno.test("simple-on-purpose-ledger - report is not matched as the wrapper", () => {
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
  });
  const report = renderSimpleOnPurposeLedgerContent(
    ledgerOf([MARKER_CLEAR]),
  );
  // The wrapper veto keys on the wrapper title and fingerprint; a report
  // matching either would be vetoed forever.
  assertEquals(t.matchesIdleTaskBody?.(report), false);
  assertEquals(
    t.buildIssueTitle("acme/widget"),
    SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE,
  );
  assert(
    renderSimpleOnPurposeLedgerTitle(ledgerOf([MARKER_CLEAR])) !==
      SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE,
  );
});

Deno.test("simple-on-purpose-ledger - contract flags", () => {
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
  });
  assertEquals(t.skipMilestone, true);
  assertEquals(t.outputLabel, NAME);
  assertEquals(t.requiresStructuredOutput, true);
  assertEquals(t.cooldownHours, 168);
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

Deno.test("renderSimpleOnPurposeLedgerTitle - counts markers and flagged markers", () => {
  assertEquals(
    renderSimpleOnPurposeLedgerTitle(ledgerOf([MARKER_CLEAR])),
    "SIMPLE-ON-PURPOSE ledger: 1 marker",
  );
  assertEquals(
    renderSimpleOnPurposeLedgerTitle(ledgerOf([MARKER_CLEAR, MARKER_FLAGGED])),
    "SIMPLE-ON-PURPOSE ledger: 2 markers, 1 missing upgrade when",
  );
});

Deno.test("renderSimpleOnPurposeLedgerContent - leads with the finding id", () => {
  const content = renderSimpleOnPurposeLedgerContent(ledgerOf([MARKER_CLEAR]));
  assert(content.startsWith(
    `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->`,
  ));
});

Deno.test("simpleOnPurposeLedgerContentOf - strips the footer and its run id", () => {
  const content = renderSimpleOnPurposeLedgerContent(ledgerOf([MARKER_CLEAR]));
  const withFooter = appendIdleTaskAttribution(content, {
    template: NAME,
    runId: "run-abc",
  });
  assertEquals(simpleOnPurposeLedgerContentOf(withFooter), content);
});

// ---------------------------------------------------------------------------
// runTask behaviour
// ---------------------------------------------------------------------------

Deno.test("simple-on-purpose-ledger runTask - markers and no open report files one report", async () => {
  const { gh, calls } = makeGhStub({ createNumber: 50 });
  const scanPaths: string[] = [];
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: (repoPath) => {
      scanPaths.push(repoPath);
      return Promise.resolve(scanOk(ledgerOf([MARKER_CLEAR, MARKER_FLAGGED])));
    },
  });

  const result = await t.runTask(RUN_OPTS);

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Filed report #50");
  assertEquals(
    scanPaths,
    ["/tmp/ledger/widget"],
    "Issue #3292: repo checkout path",
  );
  const creates = verbCalls(calls, "create");
  assertEquals(creates.length, 1, "one report per repository");
  assertEquals(verbCalls(calls, "edit").length, 0);
  const create = creates[0]!;
  assert(create.includes("simple-on-purpose-ledger"));
  assert(create.includes(
    "SIMPLE-ON-PURPOSE ledger: 2 markers, 1 missing upgrade when",
  ));
  const body = create[create.indexOf("--body") + 1] ?? "";
  assertStringIncludes(
    body,
    `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->`,
  );
  assertStringIncludes(body, "worker/deno/lib/y.ts:9");
});

Deno.test("simple-on-purpose-ledger runTask - open report with different content is edited, not re-created", async () => {
  const stale = {
    title: "SIMPLE-ON-PURPOSE ledger: 1 marker",
    body:
      `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->\n\nold listing`,
  };
  const { gh, calls } = makeGhStub({
    dedup: [{ number: 7, body: stale.body }],
    view: stale,
  });
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () =>
      Promise.resolve(scanOk(ledgerOf([MARKER_CLEAR, MARKER_FLAGGED]))),
  });

  const result = await t.runTask(RUN_OPTS);

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Refreshed report #7");
  assertEquals(
    verbCalls(calls, "create").length,
    0,
    "must not create a second report",
  );
  const edits = verbCalls(calls, "edit");
  assertEquals(edits.length, 1);
  assert(edits[0]!.includes("7"));
  const title = edits[0]![edits[0]!.indexOf("--title") + 1];
  assertEquals(
    title,
    "SIMPLE-ON-PURPOSE ledger: 2 markers, 1 missing upgrade when",
  );
});

Deno.test("simple-on-purpose-ledger runTask - identical open report is a no-op despite a new run id", async () => {
  const ledger = ledgerOf([MARKER_CLEAR]);
  const content = renderSimpleOnPurposeLedgerContent(ledger);
  const footered = appendIdleTaskAttribution(content, {
    template: NAME,
    runId: "run-previous",
  });
  const title = renderSimpleOnPurposeLedgerTitle(ledger);
  const { gh, calls } = makeGhStub({
    dedup: [{ number: 7, body: footered }],
    view: { title, body: footered },
  });
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanOk(ledger)),
  });

  const result = await t.runTask(RUN_OPTS);

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Report #7 unchanged");
  assertEquals(verbCalls(calls, "create").length, 0);
  assertEquals(
    verbCalls(calls, "edit").length,
    0,
    "identical content must not edit",
  );
});

Deno.test("simple-on-purpose-ledger runTask - zero markers and no open report files nothing", async () => {
  const { gh, calls } = makeGhStub({});
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanOk(ledgerOf([]))),
  });

  const result = await t.runTask(RUN_OPTS);

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "nothing filed");
  assertEquals(verbCalls(calls, "create").length, 0);
  assertEquals(verbCalls(calls, "edit").length, 0);
});

Deno.test("simple-on-purpose-ledger runTask - scanner failure surfaces and files nothing", async () => {
  const { gh, calls } = makeGhStub({});
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () =>
      Promise.resolve({
        ok: false as const,
        error: "could not list tracked files in /tmp/ledger/widget",
      }),
  });

  const result = await t.runTask(RUN_OPTS);

  assertEquals(result.ok, false, "a scanner failure must not read as clean");
  assertStringIncludes(result.summary, "scanner error");
  assertStringIncludes(result.summary, "Nothing filed");
  assertEquals(verbCalls(calls, "create").length, 0);
  assertEquals(verbCalls(calls, "edit").length, 0);
});

// ---------------------------------------------------------------------------
// gh argument shapes, label, wrapper body and wrapper veto (Issue #4027)
// ---------------------------------------------------------------------------

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

Deno.test("simple-on-purpose-ledger runTask - creates the report in the target repo with the title and label", async () => {
  const { gh, calls } = makeGhStub({ createNumber: 50 });
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanOk(ledgerOf([MARKER_CLEAR]))),
  });

  await t.runTask(RUN_OPTS);

  const create = verbCalls(calls, "create")[0]!;
  assertEquals(create.slice(0, 5), [
    "issue",
    "create",
    "--repo",
    "acme/widget",
    "--title",
  ]);
  assertEquals(
    valueAfter(create, "--title"),
    "SIMPLE-ON-PURPOSE ledger: 1 marker",
  );
  assertEquals(valueAfter(create, "--label"), "simple-on-purpose-ledger");
});

Deno.test("simple-on-purpose-ledger runTask - reads the open report from the target repo as title,body JSON", async () => {
  const ledger = ledgerOf([MARKER_CLEAR]);
  const content = renderSimpleOnPurposeLedgerContent(ledger);
  const { gh, calls } = makeGhStub({
    dedup: [{ number: 7, body: content }],
    view: { title: renderSimpleOnPurposeLedgerTitle(ledger), body: content },
  });
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    scanFn: () => Promise.resolve(scanOk(ledger)),
  });

  await t.runTask(RUN_OPTS);

  assertEquals(verbCalls(calls, "view"), [
    ["issue", "view", "7", "--repo", "acme/widget", "--json", "title,body"],
  ]);
});

Deno.test("simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed", async () => {
  for (const raw of ["not json", "null", '{"title":"t"}']) {
    const calls: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      calls.push([...args]);
      if (args[1] === "view") return Promise.resolve(raw);
      if (args.includes("number,body,author")) {
        return Promise.resolve(JSON.stringify([{
          number: 7,
          body: `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->`,
          author: { login: FLEET_AUTHOR },
        }]));
      }
      return Promise.resolve("[]");
    };
    const t = createSimpleOnPurposeLedgerTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      ensureLabelFn: okLabel,
      scanFn: () => Promise.resolve(scanOk(ledgerOf([MARKER_CLEAR]))),
    });

    const result = await t.runTask(RUN_OPTS);

    assertEquals(result.ok, false, raw);
    assertStringIncludes(result.summary, "could not read open report #7");
    assertEquals(verbCalls(calls, "edit").length, 0, raw);
  }
});

Deno.test("simple-on-purpose-ledger runTask - ensures the label exists in the target repo before filing", async () => {
  const { gh } = makeGhStub({});
  const ensured: string[] = [];
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: gh,
    ensureLabelFn: (repo) => {
      ensured.push(repo);
      return okLabel();
    },
    scanFn: () => Promise.resolve(scanOk(ledgerOf([]))),
  });

  await t.runTask(RUN_OPTS);

  assertEquals(ensured, ["acme/widget"]);
});

Deno.test("simple-on-purpose-ledger buildIssueBody - substitutes the footer with this template and run id", async () => {
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    loadPromptFn: () =>
      Promise.resolve({ ok: true, value: "body\n{{ATTRIBUTION_FOOTER}}" }),
  });
  const opts = { repo: "acme/widget", workDir: "/tmp" } as never;
  const previous = Deno.env.get("VIBE_RUN_ID");
  try {
    Deno.env.set("VIBE_RUN_ID", "run-xyz");
    const body = await t.buildIssueBody(opts);
    assertStringIncludes(body, `\`${NAME}\``);
    assertStringIncludes(body, "`run-xyz`");
    assert(!body.includes("{{ATTRIBUTION_FOOTER}}"));

    Deno.env.delete("VIBE_RUN_ID");
    assertStringIncludes(await t.buildIssueBody(opts), "`unknown`");
  } finally {
    if (previous === undefined) Deno.env.delete("VIBE_RUN_ID");
    else Deno.env.set("VIBE_RUN_ID", previous);
  }
});

Deno.test("simple-on-purpose-ledger buildIssueBody - a prompt that fails to load throws naming the template", async () => {
  const t = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    loadPromptFn: () =>
      Promise.resolve({ ok: false, error: new Error("missing file") }),
  });
  let message = "";
  try {
    await t.buildIssueBody({ repo: "acme/widget", workDir: "/tmp" } as never);
  } catch (err) {
    message = (err as Error).message;
  }
  assertStringIncludes(message, "simple-on-purpose-ledger");
  assertStringIncludes(message, "missing file");
});

Deno.test("simple-on-purpose-ledger shouldFile - vetoed by a fleet-authored wrapper in the same repo, allowed otherwise", async () => {
  const lists: string[][] = [];
  const wrapperRow = {
    number: 3,
    title: SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE,
    body: "",
    author: { login: FLEET_AUTHOR },
  };
  const ghWith = (rows: unknown[]) => (args: string[]): Promise<string> => {
    lists.push([...args]);
    return Promise.resolve(JSON.stringify(rows));
  };
  const opts = { repo: "acme/widget", workDir: "/tmp/ledger" } as never;

  const vetoed = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: ghWith([wrapperRow]),
  });
  assertEquals(await vetoed.shouldFile?.(opts), false);
  assertEquals(valueAfter(lists[0]!, "--repo"), "acme/widget");

  const clear = createSimpleOnPurposeLedgerTemplate({
    dedupAuthors: DEDUP_AUTHORS,
    ghCommandFn: ghWith([]),
  });
  assertEquals(await clear.shouldFile?.(opts), true);
});

Deno.test("simple-on-purpose-ledger shouldFile - a malformed lookup is logged under the wrapper context", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.join(" "));
  };
  try {
    const t = createSimpleOnPurposeLedgerTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: () => Promise.resolve("not json"),
    });
    await t.shouldFile?.({ repo: "acme/widget", workDir: "/tmp" } as never);
  } finally {
    console.error = original;
  }
  assert(
    logged.some((line) => line.includes("simple-on-purpose-ledger wrapper")),
    logged.join("\n"),
  );
});

Deno.test("simple-on-purpose-ledger runTask - report-only: only issue commands reach gh, never a pull request or commit", async () => {
  const stale = {
    title: "SIMPLE-ON-PURPOSE ledger: 1 marker",
    body:
      `<!-- finding-id: ${SIMPLE_ON_PURPOSE_LEDGER_FINDING_ID} -->\n\nold listing`,
  };
  for (
    const scenario of [{}, {
      dedup: [{ number: 7, body: stale.body }],
      view: stale,
    }]
  ) {
    const { gh, calls } = makeGhStub(scenario);
    const t = createSimpleOnPurposeLedgerTemplate({
      dedupAuthors: DEDUP_AUTHORS,
      ghCommandFn: gh,
      ensureLabelFn: okLabel,
      scanFn: () =>
        Promise.resolve(scanOk(ledgerOf([MARKER_CLEAR, MARKER_FLAGGED]))),
    });

    const result = await t.runTask(RUN_OPTS);

    assertEquals(result.ok, true);
    assert(calls.length > 0);
    for (const call of calls) {
      assertEquals(
        call[0],
        "issue",
        `unexpected gh command: ${call.join(" ")}`,
      );
    }
  }
});
