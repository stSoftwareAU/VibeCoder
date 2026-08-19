/**
 * Tests for the per-repo idle-task cooldown gate (Issue #2104).
 *
 * The helper enforces a rolling per-repo window per template — a given
 * template fires at most once per `cooldownHours` per repo. The cooldown
 * clock is keyed off the previous wrapper's (or finding's) `createdAt`,
 * not `closedAt`, so fast-failing scans still count.
 *
 * All tests stub the gh runner so they never touch the network and
 * cover every decision branch:
 *   - no history → null / not cooled down
 *   - wrapper-only history → uses wrapper createdAt
 *   - finding-only history → uses outputLabel createdAt
 *   - mixed history → picks the most recent across both
 *   - cooldown window honoured (default 24h)
 *   - per-template cooldownHours override honoured
 *   - gh failure warns and degrades to "not cooled down"
 *   - createdAt is consulted, not closedAt
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  DEFAULT_COOLDOWN_HOURS,
  getLastFiledCreatedAt,
  isRepoCooledDown,
} from "../lib/idle_task_cooldown_gate.ts";
import type {
  IdleTaskRunOptions,
  IdleTaskRunResult,
  IdleTaskTemplate,
} from "../lib/idle_task_template.ts";
import {
  createWorkflowAnnotationScanTemplate,
  WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
} from "../lib/idle_task_templates/workflow_annotation_scan_template.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  args: string[];
}

/**
 * Builds a stub gh runner that returns a different canned response
 * depending on which `--label` argument is present. A label not in the
 * map yields an empty JSON array.
 */
function makeLabelStub(byLabel: Record<string, string | Error>) {
  const calls: RecordedCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const idx = args.indexOf("--label");
    const label = idx === -1 ? "" : args[idx + 1] ?? "";
    const response = byLabel[label];
    if (response === undefined) return Promise.resolve("[]");
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  };
  return { fn, calls };
}

/**
 * Build a minimal template fixture. Only the fields the cooldown gate
 * actually reads are populated; runTask is a no-op because the gate
 * never invokes it.
 */
function makeTemplate(opts: {
  name?: string;
  title?: string;
  outputLabel?: string;
  cooldownHours?: number;
} = {}): IdleTaskTemplate {
  return {
    name: opts.name ?? "demo-scan",
    description: "fixture template",
    buildIssueTitle: () => opts.title ?? "Run a demo scan",
    buildIssueBody: () => "body",
    runTask: (_o: IdleTaskRunOptions): Promise<IdleTaskRunResult> =>
      Promise.resolve({ ok: true, summary: "" }),
    ...(opts.outputLabel !== undefined
      ? { outputLabel: opts.outputLabel }
      : {}),
    ...(opts.cooldownHours !== undefined
      ? { cooldownHours: opts.cooldownHours }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// getLastFiledCreatedAt
// ---------------------------------------------------------------------------

Deno.test("getLastFiledCreatedAt - returns null when no history exists", async () => {
  const gh = makeLabelStub({ "idle-task": "[]", "security": "[]" });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  assertEquals(result, null);
});

Deno.test("getLastFiledCreatedAt - returns wrapper createdAt when only wrapper history exists", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-10T09:00:00Z", title: "Run a demo scan" },
    { createdAt: "2026-05-09T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers, "security": "[]" });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  assert(result !== null, "expected a date");
  assertEquals(result.toISOString(), "2026-05-10T09:00:00.000Z");
});

Deno.test("getLastFiledCreatedAt - ignores wrapper rows whose title does not match", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-17T09:00:00Z", title: "Run a different scan" },
    { createdAt: "2026-05-10T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate(),
    ghCommandFn: gh.fn,
  });
  assert(result !== null, "expected a date");
  assertEquals(result.toISOString(), "2026-05-10T09:00:00.000Z");
});

Deno.test("getLastFiledCreatedAt - returns finding createdAt when only finding history exists", async () => {
  const findings = JSON.stringify([
    { createdAt: "2026-05-12T10:00:00Z" },
    { createdAt: "2026-05-08T10:00:00Z" },
  ]);
  const gh = makeLabelStub({ "idle-task": "[]", "security": findings });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  assert(result !== null);
  assertEquals(result.toISOString(), "2026-05-12T10:00:00.000Z");
});

Deno.test("getLastFiledCreatedAt - picks the most recent across wrappers and findings", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-10T09:00:00Z", title: "Run a demo scan" },
  ]);
  const findings = JSON.stringify([
    { createdAt: "2026-05-15T10:00:00Z" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers, "security": findings });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  assert(result !== null);
  assertEquals(result.toISOString(), "2026-05-15T10:00:00.000Z");
});

Deno.test("getLastFiledCreatedAt - skips finding query when outputLabel is unset", async () => {
  const gh = makeLabelStub({ "idle-task": "[]" });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate(),
    ghCommandFn: gh.fn,
  });
  assertEquals(result, null);
  // Only the wrapper query should have run.
  assertEquals(gh.calls.length, 1);
  const args = gh.calls[0]!.args;
  assertEquals(args[args.indexOf("--label") + 1], "idle-task");
});

Deno.test("getLastFiledCreatedAt - bounded gh query (--state all, --limit 5)", async () => {
  const gh = makeLabelStub({ "idle-task": "[]", "security": "[]" });
  await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  for (const c of gh.calls) {
    assert(c.args.includes("--state"));
    assertEquals(c.args[c.args.indexOf("--state") + 1], "all");
    assert(c.args.includes("--limit"));
    assertEquals(c.args[c.args.indexOf("--limit") + 1], "5");
  }
});

Deno.test("getLastFiledCreatedAt - keyed off createdAt, not closedAt", async () => {
  // The finding payload includes a much-newer `closedAt`. The gate
  // must ignore it and use `createdAt` only.
  const findings = JSON.stringify([
    {
      createdAt: "2026-05-10T09:00:00Z",
      closedAt: "2026-05-17T09:00:00Z",
    },
  ]);
  const gh = makeLabelStub({ "idle-task": "[]", "security": findings });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
  });
  assert(result !== null);
  assertEquals(result.toISOString(), "2026-05-10T09:00:00.000Z");
});

Deno.test("getLastFiledCreatedAt - gh failure warns and degrades to null", async () => {
  const gh = makeLabelStub({
    "idle-task": new Error("gh exploded"),
    "security": new Error("gh exploded"),
  });
  const warnings: string[] = [];
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
    warn: (m) => warnings.push(m),
  });
  assertEquals(result, null);
  // One warn per failed query (wrapper + finding).
  assertEquals(warnings.length, 2);
  for (const w of warnings) {
    assert(w.includes("gh exploded"));
  }
});

Deno.test("getLastFiledCreatedAt - one query failure still surfaces the other source", async () => {
  // Wrapper query fails, finding query succeeds — caller still gets a
  // result.
  const findings = JSON.stringify([
    { createdAt: "2026-05-12T10:00:00Z" },
  ]);
  const gh = makeLabelStub({
    "idle-task": new Error("transient"),
    "security": findings,
  });
  const warnings: string[] = [];
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate({ outputLabel: "security" }),
    ghCommandFn: gh.fn,
    warn: (m) => warnings.push(m),
  });
  assert(result !== null);
  assertEquals(result.toISOString(), "2026-05-12T10:00:00.000Z");
  assertEquals(warnings.length, 1);
});

Deno.test("getLastFiledCreatedAt - malformed JSON degrades to null", async () => {
  const gh = makeLabelStub({ "idle-task": "not json at all" });
  const result = await getLastFiledCreatedAt({
    repo: "org/foo",
    template: makeTemplate(),
    ghCommandFn: gh.fn,
  });
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// isRepoCooledDown
// ---------------------------------------------------------------------------

Deno.test("isRepoCooledDown - returns false when no history exists", async () => {
  const gh = makeLabelStub({ "idle-task": "[]" });
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate(),
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, false);
});

Deno.test("isRepoCooledDown - true when (now - last) < 24h (default)", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-18T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate(),
    now: new Date("2026-05-18T20:00:00Z"), // 11h after
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, true);
});

Deno.test("isRepoCooledDown - false when (now - last) >= 24h (default)", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-17T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate(),
    now: new Date("2026-05-18T10:00:00Z"), // 25h after
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, false);
});

Deno.test("isRepoCooledDown - per-template cooldownHours override honoured (6h shrinks window)", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-18T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  // 7h after — outside a 6h window, inside the default 24h window.
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate({ cooldownHours: 6 }),
    now: new Date("2026-05-18T16:00:00Z"),
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, false);
});

Deno.test("isRepoCooledDown - per-template cooldownHours override honoured (6h inside window)", async () => {
  const wrappers = JSON.stringify([
    { createdAt: "2026-05-18T09:00:00Z", title: "Run a demo scan" },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  // 3h after — inside a 6h window.
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate({ cooldownHours: 6 }),
    now: new Date("2026-05-18T12:00:00Z"),
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, true);
});

Deno.test("isRepoCooledDown - gh failure returns false (not cooled down) with warn", async () => {
  const gh = makeLabelStub({
    "idle-task": new Error("gh exploded"),
  });
  const warnings: string[] = [];
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: makeTemplate(),
    ghCommandFn: gh.fn,
    warn: (m) => warnings.push(m),
  });
  assertEquals(cooledDown, false);
  assertEquals(warnings.length, 1);
});

Deno.test("DEFAULT_COOLDOWN_HOURS is 24 (Issue #2104)", () => {
  assertEquals(DEFAULT_COOLDOWN_HOURS, 24);
});

// ---------------------------------------------------------------------------
// workflow-annotation-scan weekly cadence (Issue #3488)
// ---------------------------------------------------------------------------

Deno.test("isRepoCooledDown - workflow-annotation-scan cooled down within its 168h window", async () => {
  const wrappers = JSON.stringify([
    {
      createdAt: "2026-05-18T09:00:00Z",
      title: WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
    },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: createWorkflowAnnotationScanTemplate({ ghCommandFn: gh.fn }),
    // 100h after — inside the 168h weekly window, well past the 24h default.
    now: new Date("2026-05-22T13:00:00Z"),
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, true);
});

Deno.test("isRepoCooledDown - workflow-annotation-scan fires once the 168h window elapses", async () => {
  const wrappers = JSON.stringify([
    {
      createdAt: "2026-05-18T09:00:00Z",
      title: WORKFLOW_ANNOTATION_SCAN_ISSUE_TITLE,
    },
  ]);
  const gh = makeLabelStub({ "idle-task": wrappers });
  const cooledDown = await isRepoCooledDown({
    repo: "org/foo",
    template: createWorkflowAnnotationScanTemplate({ ghCommandFn: gh.fn }),
    // 169h after — the weekly window has elapsed, so the repo is not cooled down.
    now: new Date("2026-05-25T10:00:00Z"),
    ghCommandFn: gh.fn,
  });
  assertEquals(cooledDown, false);
});
