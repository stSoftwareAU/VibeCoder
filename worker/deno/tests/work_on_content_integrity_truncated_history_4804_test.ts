/**
 * Regression tests for Issue #4804 — the content-integrity gate must not judge
 * a truncated body-edit history as though it were complete.
 *
 * GitHub lists `userContentEdits` newest first. The editor lookup reads
 * `first: 100` (the newest 100 body edits) and reports `totalCount`, so an issue
 * with more edits than that is recognised as truncated. The previous `last: 100`
 * returned the OLDEST 100, which hid any newer edit from the gate: the
 * since-snapshot set came back empty and the gate re-baselined on content an
 * untrusted editor had changed.
 *
 * The fake `gh` below models GitHub's windowing: `first: N` is the newest N,
 * `last: N` is the oldest N (still listed newest first), and `totalCount` always
 * reports the complete history.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { TimelineCache } from "../lib/timeline_cache.ts";
import { suppressesLowerTiers } from "../lib/skip_reason_clearing.ts";
import {
  verifyWorkOnContentIntegrityDetailed,
  type WorkOnContentIntegrityOutcome,
} from "../lib/work_on_content_integrity.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
  loadContentApprovalState,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMemoryFs(): ContentApprovalDeps {
  const files = new Map<string, string>();
  return {
    readFile: (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(new Deno.errors.NotFound(`Not found: ${path}`));
      }
      return Promise.resolve(content);
    },
    writeFile: (path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve();
    },
    renameFile: (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content === undefined) {
        return Promise.reject(new Error(`Not found: ${oldPath}`));
      }
      files.set(newPath, content);
      files.delete(oldPath);
      return Promise.resolve();
    },
    removeFile: (path: string) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: "/tmp/work-integrity-truncated-history-4804-test",
  };
}

function makeIssue(author: string): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-05-01T00:00:00Z",
    author,
    milestone: "",
  };
}

const STATE_FILE = ".content_approval_state.json";

/** A snapshot captured long before every body edit in the histories below. */
const LONG_AGO_ISO = "2026-04-30T00:00:00Z";
const LONG_AGO_UNIX = Math.floor(Date.parse(LONG_AGO_ISO) / 1000);

/**
 * Falls between the 3rd-newest edit (11:58) and the 4th-newest (11:57) of the
 * history built by `bodyHistory`, so exactly the three newest edits post-date
 * it. The oldest edit inside the newest-100 window (10:21) predates it.
 */
const WINDOW_SNAPSHOT_ISO = "2026-05-01T11:57:30Z";
const WINDOW_SNAPSHOT_UNIX = Math.floor(
  Date.parse(WINDOW_SNAPSHOT_ISO) / 1000,
);

/** Label applied before every snapshot, so it never counts as a re-approval. */
const LABEL_ADDED_AT = "2026-04-29T08:00:00Z";

const NEWEST_EDIT_MS = Date.parse("2026-05-01T12:00:00Z");
const MINUTE_MS = 60_000;

interface BodyEdit {
  login: string;
  at: string;
}

/**
 * Build a body-edit history in GitHub's newest-first order: index 0 is the
 * newest, and each older edit is one minute earlier than the one before it.
 */
function bodyHistory(
  count: number,
  loginFor: (index: number) => string,
): BodyEdit[] {
  return Array.from({ length: count }, (_, index) => ({
    login: loginFor(index),
    at: new Date(NEWEST_EDIT_MS - index * MINUTE_MS).toISOString(),
  }));
}

/**
 * Title renames in GitHub's chronological (oldest first) timeline order, built
 * from the same spacing as `bodyHistory`: index 0 (newest) is 12:00.
 */
function renameHistory(
  count: number,
  loginFor: (index: number) => string,
): BodyEdit[] {
  return bodyHistory(count, loginFor).reverse();
}

/** Force the stored snapshot's `capturedAt` to a deterministic instant. */
async function setCapturedAt(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  iso: string,
): Promise<void> {
  const stateDir = resolveContentApprovalStateDir(config.workDir);
  const state = await loadContentApprovalState(stateDir, deps);
  const snapshot = state.snapshots["owner/repo|42"];
  if (snapshot) {
    snapshot.capturedAt = Math.floor(Date.parse(iso) / 1000);
  }
  await deps.writeFile!(`${stateDir}/${STATE_FILE}`, JSON.stringify(state));
}

/** Capture an approval baseline, then pin its `capturedAt`. */
async function seedSnapshot(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  capturedIso: string,
): Promise<void> {
  await captureContentSnapshot(
    resolveContentApprovalStateDir(config.workDir),
    "owner/repo",
    42,
    "Fix the bug",
    "Approved specification",
    "alice",
    deps,
  );
  await setCapturedAt(config, deps, capturedIso);
}

async function capturedAt(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
): Promise<number | undefined> {
  const state = await loadContentApprovalState(
    resolveContentApprovalStateDir(config.workDir),
    deps,
  );
  return state.snapshots["owner/repo|42"]?.capturedAt;
}

interface HistoryMockOptions {
  /** Current title/body served by `gh issue view`. */
  title: string;
  body: string;
  /** Complete body-edit history, newest first; the fake windows it. */
  bodyEdits: BodyEdit[];
  /** Overrides the reported `totalCount` (defaults to `bodyEdits.length`). */
  totalBodyEdits?: number;
  /** Title renames, oldest first; the fake serves only the newest 100 (`last: 100`). */
  renames?: BodyEdit[];
  /** Overrides the reported timeline `totalCount` (defaults to `renames.length`). */
  totalRenames?: number;
  actions: string[];
  addedLabels: string[];
  commentBodies: string[];
  /** Timeline events served by the REST timeline call (default: one early `work-on` add). */
  timeline?: unknown[];
}

/**
 * Serve the `userContentEdits` connection the way GitHub windows it. `first: N`
 * is the newest N edits; `last: N` is the oldest N, still listed newest first.
 * `totalCount` reports the complete history unless a test overrides it.
 */
function windowBodyEdits(
  query: string,
  edits: BodyEdit[],
  totalCount: number,
) {
  const match = /userContentEdits\((first|last):(\d+)\)/.exec(query);
  if (!match) {
    throw new Error("Fake gh: no userContentEdits window in the query");
  }
  const size = Number(match[2]);
  const nodes = match[1] === "first"
    ? edits.slice(0, size)
    : edits.slice(Math.max(0, edits.length - size));
  return {
    totalCount,
    nodes: nodes.map((e) => ({ editedAt: e.at, editor: { login: e.login } })),
  };
}

function createGhMock(
  opts: HistoryMockOptions,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (args[0] === "api" && command.includes("userContentEdits")) {
      const query = args.find((a) => a.startsWith("query=")) ?? "";
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              userContentEdits: windowBodyEdits(
                query,
                opts.bodyEdits,
                opts.totalBodyEdits ?? opts.bodyEdits.length,
              ),
              timelineItems: {
                totalCount: opts.totalRenames ?? (opts.renames ?? []).length,
                nodes: (opts.renames ?? []).slice(-100).map((e) => ({
                  createdAt: e.at,
                  actor: { login: e.login },
                })),
              },
            },
          },
        },
      }));
    }

    if (command.includes("api") && command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(
        opts.timeline ?? [
          {
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: "alice" },
            created_at: LABEL_ADDED_AT,
          },
        ],
      ));
    }

    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: opts.title, body: opts.body }),
      );
    }

    if (command.includes("--remove-label")) {
      opts.actions.push("remove-label");
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/labels") && args.some((a) => a.startsWith("labels[]="))
    ) {
      opts.actions.push("add-label");
      const match = args.find((a) => a.startsWith("labels[]="));
      if (match) opts.addedLabels.push(match.slice("labels[]=".length));
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/comments")
    ) {
      opts.actions.push("post-comment");
      for (const arg of args) {
        if (arg.startsWith("body=")) {
          opts.commentBodies.push(arg.slice("body=".length));
        }
      }
      return Promise.resolve("");
    }

    return Promise.resolve("");
  };
}

interface ConsoleLines {
  errors: string[];
  warnings: string[];
}

/** Run `fn` with `console.error` and `console.warn` captured. */
async function captureConsole(fn: () => Promise<void>): Promise<ConsoleLines> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  return { errors, warnings };
}

function runGate(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  gh: (args: string[]) => Promise<string>,
): Promise<WorkOnContentIntegrityOutcome> {
  return verifyWorkOnContentIntegrityDetailed(
    "owner/repo",
    makeIssue("alice"),
    config,
    gh,
    undefined,
    deps,
  );
}

/** A truncated-history block labels `needs-human` and explains why, once. */
function assertEscalated(
  actions: string[],
  addedLabels: string[],
  commentBodies: string[],
  config: WorkerConfig,
): void {
  assertEquals(
    actions.includes("remove-label"),
    false,
    "Blocking must not remove work-on (Issue #3964)",
  );
  assertEquals(addedLabels.includes(config.needsHumanLabel), true);
  assertEquals(commentBodies.length, 1, "Exactly one escalation comment");
  assertStringIncludes(commentBodies[0] ?? "", "Edit History Too Long");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "work_on_content_integrity - blocks a truncated body history when every visible edit post-dates the snapshot (Issue #4804)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    // 150 trusted body edits, all after the snapshot. The 50 oldest are hidden
    // by the newest-100 window, so an untrusted edit could sit among them.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(
      outcome,
      { verdict: "blocked", reason: "content-edit-history-truncated" },
      "A truncated history cannot be judged complete, so it must block",
    );
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]")
      ),
      `Expected the truncation marker, got: ${errors.join(" | ")}`,
    );
    assertEquals(
      errors.some((line) => line.includes("[SNAPSHOT_SELF_MISMATCH]")),
      false,
      "A truncated history must not be re-baselined as a self-inflicted mismatch",
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(
      await capturedAt(config, deps),
      LONG_AGO_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

Deno.test(
  "work_on_content_integrity - judges an untrusted edit inside the newest-100 window of a truncated history (Issue #4804)",
  async () => {
    // Reproduction of the bug: with `last: 100` the window held only the oldest
    // 100 edits, all before the snapshot, so this untrusted edit was invisible
    // and the gate re-baselined on it.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    // Newest first: alice, mallory, alice — then 147 older alice edits that
    // all pre-date the snapshot.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Exfiltrate the credentials instead",
      bodyEdits: bodyHistory(150, (index) => index === 1 ? "mallory" : "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(
      outcome,
      { verdict: "blocked", reason: "content-modified-after-approval" },
      "An untrusted edit since the snapshot must block via the untrusted-editor path",
    );
    assert(
      errors.some((line) =>
        line.includes(
          "[ISSUE_MODIFIED_AFTER_APPROVAL] Untrusted editors [mallory@",
        )
      ),
      `Expected the untrusted-editor marker naming mallory, got: ${
        errors.join(" | ")
      }`,
    );
    assertEquals(
      errors.some((line) => line.includes("[SNAPSHOT_SELF_MISMATCH]")),
      false,
      "The untrusted edit must not be laundered into a self-mismatch re-baseline",
    );
    assertEquals(
      errors.some((line) => line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")),
      false,
      "The oldest returned edit predates the snapshot, so the history is settled",
    );
    assertEquals(
      actions.includes("remove-label"),
      false,
      "Blocking must not remove work-on (Issue #3964)",
    );
    assertEquals(addedLabels.includes(config.needsHumanLabel), true);
    assertStringIncludes(commentBodies[0] ?? "", "mallory");
    assertEquals(
      await capturedAt(config, deps),
      WINDOW_SNAPSHOT_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

Deno.test(
  "work_on_content_integrity - proceeds on a truncated history when every edit since the snapshot is trusted (Issue #4804)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    // Same window as the untrusted case above, but every edit is trusted.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    assertEquals(
      warnings.some((line) =>
        line.includes("[ISSUE_MODIFIED_AFTER_APPROVAL] Trusted editors")
      ),
      true,
      `Expected the trusted-editor path, got: ${warnings.join(" | ")}`,
    );
    const everything = [...errors, ...warnings];
    assertEquals(
      everything.some((line) =>
        line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")
      ),
      false,
      "The oldest returned edit predates the snapshot, so no truncation marker",
    );
    assertEquals(actions, [], "A trusted edit window mutates nothing on gh");
    assertEquals(addedLabels, []);
    assert(
      (await capturedAt(config, deps) ?? 0) > WINDOW_SNAPSHOT_UNIX,
      "An all-trusted edit window refreshes the baseline",
    );
  },
);

Deno.test(
  "work_on_content_integrity - proceeds on a complete three-edit history with no truncation (Issue #4804 control)",
  async () => {
    // Control for the first test: identical snapshot and identical trusted
    // post-snapshot edits, but the history is complete, so nothing is hidden.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(3, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    const everything = [...errors, ...warnings];
    assertEquals(
      everything.some((line) =>
        line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")
      ),
      false,
      "A complete history must not carry the truncation marker",
    );
    assertEquals(actions, [], "A trusted edit window mutates nothing on gh");
    assertEquals(addedLabels, []);
  },
);

Deno.test(
  "work_on_content_integrity - blocks a truncated history whose newest-100 window is empty (Issue #4804)",
  async () => {
    // GitHub can report edits beyond the window while returning no node for
    // the window itself. No edit places the snapshot, so the truncated history
    // is unresolved and must block rather than be read as nothing since the
    // approval.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      totalBodyEdits: 150,
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(
      outcome,
      { verdict: "blocked", reason: "content-edit-history-truncated" },
      "An empty window over a truncated history must block",
    );
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]") &&
        line.includes("no body edit in the window places the snapshot")
      ),
      `Expected the truncation marker for an empty window, got: ${
        errors.join(" | ")
      }`,
    );
    assertEquals(
      errors.some((line) => line.includes("[SNAPSHOT_SELF_MISMATCH]")),
      false,
      "An empty truncated window must not be re-baselined as a self-inflicted mismatch",
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertStringIncludes(commentBodies[0] ?? "", "make a new body edit");
    assertStringIncludes(commentBodies[0] ?? "", "after that edit");
    assertEquals(
      await capturedAt(config, deps),
      LONG_AGO_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

/** A `work-on` add by `by` at `at`, in the REST timeline shape the gate reads. */
function workOnAdded(by: string, at: string) {
  return {
    event: "labeled",
    label: { name: "work-on" },
    actor: { login: by },
    created_at: at,
  };
}

Deno.test(
  "work_on_content_integrity - an old rename cannot place a truncated body window (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      renames: [{ login: "alice", at: "2026-04-29T00:00:00Z" }],
      actions,
      addedLabels,
      commentBodies,
    });
    let outcome: WorkOnContentIntegrityOutcome | undefined;
    await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });
    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(await capturedAt(config, deps), LONG_AGO_UNIX);
  },
);

Deno.test(
  "work_on_content_integrity - a rename cannot make an empty body window re-approvable (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      totalBodyEdits: 150,
      renames: [{ login: "alice", at: "2026-05-01T12:00:00Z" }],
      timeline: [workOnAdded("alice", "2026-05-01T12:05:00Z")],
      actions,
      addedLabels,
      commentBodies,
    });
    let outcome: WorkOnContentIntegrityOutcome | undefined;
    await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });
    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(await capturedAt(config, deps), LONG_AGO_UNIX);
  },
);

Deno.test(
  "work_on_content_integrity - a trusted work-on re-add after the newest edit clears a truncated history (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    // 150 trusted edits, newest at 12:00. alice re-approves at 12:05.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("alice", "2026-05-01T12:05:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    assert(
      warnings.some((line) =>
        line.includes("[ISSUE_REAPPROVED_AFTER_MODIFICATION]")
      ),
      `Expected the re-approval marker, got: ${warnings.join(" | ")}`,
    );
    assertEquals(
      errors.some((line) => line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")),
      false,
      "A re-approved truncated history must not log the block",
    );
    assertEquals(actions, [], "A re-approval mutates nothing on gh");
    assert(
      (await capturedAt(config, deps) ?? 0) > LONG_AGO_UNIX,
      "A re-approval refreshes the baseline",
    );
  },
);

Deno.test(
  "work_on_content_integrity - a work-on add that predates the newest edit does not clear a truncated history (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    // The label add is after the snapshot but before the newest edit (12:00),
    // so it cannot bless content its approver never saw.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("alice", "2026-05-01T11:59:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(
      warnings.filter((line) => line.includes("[REAPPROVAL_PREDATES_EDIT]"))
        .length,
      1,
      `Expected the stale-approval marker on the truncated path, got: ${
        warnings.join(" | ")
      }`,
    );
  },
);

Deno.test(
  "work_on_content_integrity - a stale approval is reported once, not again by the uncached re-read, on a truncated history (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);
    const dir = Deno.makeTempDirSync({ prefix: "truncated-history-stale-" });

    try {
      // Cached and live timelines both hold the same approval, which
      // post-dates the snapshot but predates the newest edit (12:00).
      const stale = [workOnAdded("alice", "2026-05-01T11:59:00Z")];
      const cache = new TimelineCache(300, dir);
      await cache.write("owner/repo", 42, stale, true);

      const actions: string[] = [];
      const addedLabels: string[] = [];
      const commentBodies: string[] = [];
      const gh = createGhMock({
        title: "Fix the bug",
        body: "Approved specification, reworded",
        bodyEdits: bodyHistory(150, () => "alice"),
        actions,
        addedLabels,
        commentBodies,
        timeline: stale,
      });

      let outcome: WorkOnContentIntegrityOutcome | undefined;
      const { warnings } = await captureConsole(async () => {
        outcome = await verifyWorkOnContentIntegrityDetailed(
          "owner/repo",
          makeIssue("alice"),
          config,
          gh,
          undefined,
          deps,
          cache,
        );
      });

      assertEquals(outcome, {
        verdict: "blocked",
        reason: "content-edit-history-truncated",
      });
      assertEquals(
        warnings.filter((line) => line.includes("[REAPPROVAL_PREDATES_EDIT]"))
          .length,
        1,
        `The same stale approval must be reported once, got: ${
          warnings.join(" | ")
        }`,
      );
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
);

Deno.test(
  "work_on_content_integrity - an unattributable edit blocks even when the trusted list holds an empty login (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    // A stray empty entry must not make an actor-less edit trusted.
    const config = { ...makeConfig(), allowedAuthors: ["alice", ""] };
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      // GitHub recorded the edit but not the editor (empty login).
      bodyEdits: bodyHistory(1, () => ""),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-modified-after-approval",
    });
    assertEquals(addedLabels.includes(config.needsHumanLabel), true);
  },
);

Deno.test(
  "work_on_content_integrity - an untrusted work-on add does not clear a truncated history (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("mallory", "2026-05-01T12:05:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
  },
);

Deno.test(
  "work_on_content_integrity - a re-approval cannot clear a truncated history whose window is empty (PR #4944 review)",
  async () => {
    // No node in the window means the newest edit is unknown, so no
    // re-approval can be shown to post-date it.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      totalBodyEdits: 150,
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("alice", "2026-05-01T12:05:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assertEscalated(actions, addedLabels, commentBodies, config);
  },
);

Deno.test("work_on_content_integrity - the truncated-history reason does not hold lower tiers (PR #4944 review)", () => {
  assertEquals(suppressesLowerTiers("content-edit-history-truncated"), false);
  // The transient reason it used to share still serialises the repo.
  assertEquals(suppressesLowerTiers("content-editor-unresolved"), true);
});

Deno.test(
  "work_on_content_integrity - a stale cached timeline gets one live re-read before a truncated history blocks (PR #4944 review)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);
    const dir = Deno.makeTempDirSync({ prefix: "truncated-history-cache-" });

    try {
      // The cache predates alice's 12:05 re-approval; the live timeline has it.
      const cache = new TimelineCache(300, dir);
      await cache.write(
        "owner/repo",
        42,
        [workOnAdded("alice", LABEL_ADDED_AT)],
        true,
      );

      const actions: string[] = [];
      const gh = createGhMock({
        title: "Fix the bug",
        body: "Approved specification, reworded",
        bodyEdits: bodyHistory(150, () => "alice"),
        actions,
        addedLabels: [],
        commentBodies: [],
        timeline: [
          workOnAdded("alice", LABEL_ADDED_AT),
          workOnAdded("alice", "2026-05-01T12:05:00Z"),
        ],
      });

      let outcome: WorkOnContentIntegrityOutcome | undefined;
      const { warnings } = await captureConsole(async () => {
        outcome = await verifyWorkOnContentIntegrityDetailed(
          "owner/repo",
          makeIssue("alice"),
          config,
          gh,
          undefined,
          deps,
          cache,
        );
      });

      assertEquals(outcome, { verdict: "proceed" });
      assert(
        warnings.some((line) => line.includes("(truncated history, uncached")),
        `Expected the uncached re-read marker, got: ${warnings.join(" | ")}`,
      );
      assertEquals(actions, []);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Truncated title-rename windows (Issue #4947)
// ---------------------------------------------------------------------------

Deno.test(
  "work_on_content_integrity - blocks a truncated rename history when every visible rename post-dates the snapshot (Issue #4947)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    // 150 trusted renames, all after the snapshot. The 50 oldest are hidden by
    // the newest-100 window, so an untrusted rename could sit among them.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames: renameHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(
      outcome,
      { verdict: "blocked", reason: "content-edit-history-truncated" },
      "A truncated rename history cannot be judged complete, so it must block",
    );
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]") &&
        line.includes("has title renames beyond GitHub's newest-100 window")
      ),
      `Expected the rename truncation marker, got: ${errors.join(" | ")}`,
    );
    assertEquals(
      errors.some((line) => line.includes("[SNAPSHOT_SELF_MISMATCH]")),
      false,
      "A truncated rename history must not be re-baselined as a self-inflicted mismatch",
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(
      await capturedAt(config, deps),
      LONG_AGO_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

Deno.test(
  "work_on_content_integrity - proceeds on a truncated rename history whose oldest visible rename predates the snapshot and is trusted (Issue #4947)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    // The newest-100 window reaches back to 10:21, before the snapshot, so
    // every rename since the snapshot is inside it and all are trusted.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames: renameHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    assertEquals(
      warnings.some((line) =>
        line.includes("[ISSUE_MODIFIED_AFTER_APPROVAL] Trusted editors")
      ),
      true,
      `Expected the trusted-editor path, got: ${warnings.join(" | ")}`,
    );
    const everything = [...errors, ...warnings];
    assertEquals(
      everything.some((line) =>
        line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")
      ),
      false,
      "The oldest visible rename predates the snapshot, so no truncation marker",
    );
    assertEquals(actions, [], "A trusted rename window mutates nothing on gh");
    assertEquals(addedLabels, []);
    assert(
      (await capturedAt(config, deps) ?? 0) > WINDOW_SNAPSHOT_UNIX,
      "An all-trusted rename window refreshes the baseline",
    );
  },
);

Deno.test(
  "work_on_content_integrity - judges an untrusted rename inside the newest-100 window of a truncated rename history (Issue #4947)",
  async () => {
    // Mirrors the body case: mallory's rename sits inside the visible window,
    // after the snapshot, so it must be judged rather than hidden by truncation.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames: renameHistory(
        150,
        (index) => index === 1 ? "mallory" : "alice",
      ),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(
      outcome,
      { verdict: "blocked", reason: "content-modified-after-approval" },
      "An untrusted rename since the snapshot must block via the untrusted-editor path",
    );
    assert(
      errors.some((line) =>
        line.includes(
          "[ISSUE_MODIFIED_AFTER_APPROVAL] Untrusted editors [mallory@",
        )
      ),
      `Expected the untrusted-editor marker naming mallory, got: ${
        errors.join(" | ")
      }`,
    );
    assertEquals(
      errors.some((line) => line.includes("[SNAPSHOT_SELF_MISMATCH]")),
      false,
      "The untrusted rename must not be laundered into a self-mismatch re-baseline",
    );
    assertEquals(
      errors.some((line) => line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")),
      false,
      "The oldest visible rename predates the snapshot, so the rename window is settled",
    );
    assertEquals(
      actions.includes("remove-label"),
      false,
      "Blocking must not remove work-on (Issue #3964)",
    );
    assertEquals(addedLabels.includes(config.needsHumanLabel), true);
    assertStringIncludes(commentBodies[0] ?? "", "mallory");
    assertEquals(
      await capturedAt(config, deps),
      WINDOW_SNAPSHOT_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

Deno.test(
  "work_on_content_integrity - blocks when the body window is settled but the rename window is not (Issue #4947)",
  async () => {
    // The body window reaches back past the snapshot (settled), but the three
    // visible renames all post-date it while 147 older ones are hidden.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(150, () => "alice"),
      renames: renameHistory(3, () => "alice"),
      totalRenames: 150,
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]") &&
        line.includes("has title renames beyond GitHub's newest-100 window")
      ),
      `Expected the rename truncation marker, got: ${errors.join(" | ")}`,
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(await capturedAt(config, deps), WINDOW_SNAPSHOT_UNIX);
  },
);

Deno.test(
  "work_on_content_integrity - blocks when the rename window is settled but the body window is not (Issue #4947)",
  async () => {
    // Mirror of the case above: the rename window reaches back past the
    // snapshot, but the three visible body edits all post-date it.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, WINDOW_SNAPSHOT_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: bodyHistory(3, () => "alice"),
      totalBodyEdits: 150,
      renames: renameHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]") &&
        line.includes("body edits")
      ),
      `Expected the body truncation marker, got: ${errors.join(" | ")}`,
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(await capturedAt(config, deps), WINDOW_SNAPSHOT_UNIX);
  },
);

Deno.test(
  "work_on_content_integrity - a trusted work-on re-add after the newest rename clears a truncated rename history (Issue #4947)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    // 150 trusted renames, newest at 12:00. alice re-approves at 12:05.
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames: renameHistory(150, () => "alice"),
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("alice", "2026-05-01T12:05:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    assert(
      warnings.some((line) =>
        line.includes("[ISSUE_REAPPROVED_AFTER_MODIFICATION]")
      ),
      `Expected the re-approval marker, got: ${warnings.join(" | ")}`,
    );
    assertEquals(
      errors.some((line) => line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")),
      false,
      "A re-approved truncated rename history must not log the block",
    );
    assertEquals(actions, [], "A re-approval mutates nothing on gh");
    assert(
      (await capturedAt(config, deps) ?? 0) > LONG_AGO_UNIX,
      "A re-approval refreshes the baseline",
    );
  },
);

Deno.test(
  "work_on_content_integrity - a re-approval cannot clear a truncated rename history whose window is empty (Issue #4947)",
  async () => {
    // No rename in the window means the newest rename is unknown, so no
    // re-approval can be shown to post-date it.
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames: [],
      totalRenames: 5,
      actions,
      addedLabels,
      commentBodies,
      timeline: [workOnAdded("alice", "2026-05-01T12:05:00Z")],
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, {
      verdict: "blocked",
      reason: "content-edit-history-truncated",
    });
    assert(
      errors.some((line) =>
        line.includes("[SECURITY] [CONTENT_EDIT_HISTORY_TRUNCATED]") &&
        line.includes("title renames")
      ),
      `Expected the rename truncation marker for an empty window, got: ${
        errors.join(" | ")
      }`,
    );
    assertEquals(
      warnings.some((line) =>
        line.includes("[ISSUE_REAPPROVED_AFTER_MODIFICATION]")
      ),
      false,
      "An empty truncated rename window must not honour a re-approval",
    );
    assertEscalated(actions, addedLabels, commentBodies, config);
    assertEquals(
      await capturedAt(config, deps),
      LONG_AGO_UNIX,
      "Blocked content must leave the approval baseline untouched",
    );
  },
);

Deno.test(
  "work_on_content_integrity - proceeds on a complete three-rename history with no truncation (Issue #4947 control)",
  async () => {
    // Control for the rename cases: the same all-trusted, post-snapshot shape,
    // but the history is complete (totalRenames equals the renames served).
    const deps = createMemoryFs();
    const config = makeConfig();
    await seedSnapshot(config, deps, LONG_AGO_ISO);

    const renames = renameHistory(3, () => "alice");
    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Approved specification, reworded",
      bodyEdits: [],
      renames,
      totalRenames: renames.length,
      actions,
      addedLabels,
      commentBodies,
    });

    let outcome: WorkOnContentIntegrityOutcome | undefined;
    const { errors, warnings } = await captureConsole(async () => {
      outcome = await runGate(config, deps, gh);
    });

    assertEquals(outcome, { verdict: "proceed" });
    const everything = [...errors, ...warnings];
    assertEquals(
      everything.some((line) =>
        line.includes("[CONTENT_EDIT_HISTORY_TRUNCATED]")
      ),
      false,
      "A complete rename history must not carry the truncation marker",
    );
    assertEquals(actions, [], "A trusted rename window mutates nothing on gh");
    assertEquals(addedLabels, []);
  },
);
