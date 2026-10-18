/**
 * Tests for `pr_body_reconcile.ts` — the PR-scan pass that re-syncs a worker
 * PR body when the summary at the PR head no longer matches the digest the
 * body records, whoever pushed the head (Issue #3760).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  checkedGit,
  disposableHeadCheckout,
  headSummaryDigest,
  type PrepareHeadCheckout,
  type ReconcilePrBodiesDeps,
  type ReconcilePrBodiesOptions,
  reconcilePrBodyDigests,
} from "../lib/pr_body_reconcile.ts";
import {
  assemblePrBody,
  buildSummaryDigestMarker,
  prSummaryDigest,
  syncPrBodyFromSummary,
  type SyncPrBodyInput,
} from "../lib/pr_body_sync.ts";
import { buildIdempotencyMarker } from "../lib/pr_body.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  prSummaryDigestInput,
  prSummaryFactsPath,
} from "../lib/pr_summary_facts.ts";
import type { Logger } from "../types.ts";

const REPO = "owner/repo";
const PR_NUMBER = 7;
const ISSUE_NUMBER = 42;
const FLEET_LOGIN = "fleet-bot";
/** Forty lowercase hex characters, a valid commit SHA. */
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const ARCHIVE_PATH = `docs/archive/pr-summaries/pr-summary-${ISSUE_NUMBER}.md`;
const LEGACY_PATH = `docs/pr-summary-${ISSUE_NUMBER}.md`;
const FACTS_PATH = prSummaryFactsPath(ISSUE_NUMBER);
const NOT_FOUND = "gh command failed (exit 1): gh: Not Found (HTTP 404)";

const SUMMARY_V1 = "## Summary\n\nOriginal summary text. Closes #42.\n";
const SUMMARY_V2 = "## Summary\n\nRewritten summary text. Closes #42.\n";
const FACTS_V1 = '{"branchOutcomes":[]}\n';
const FACTS_V2 = '{"branchOutcomes":["changed"]}\n';

const OPTS: ReconcilePrBodiesOptions = {
  repos: [REPO],
  maintenanceAuthors: [FLEET_LOGIN],
  workerName: "worker-a",
  githubUser: "ghuser",
};

/** One recorded logger call: the level and every argument it received. */
interface LogCall {
  level: string;
  args: unknown[];
}

/** A logger that records every call, including the non-level methods. */
function recordingLogger(logs: LogCall[]): Logger {
  const note = (level: string) => (...args: unknown[]) => {
    logs.push({ level, args });
  };
  return {
    info: note("info"),
    warn: note("warn"),
    error: note("error"),
    debug: note("debug"),
    security: note("security"),
    skipReason: note("skipReason"),
    timing: note("timing"),
    scanSummary: note("scanSummary"),
    workerSummary: note("workerSummary"),
  };
}

/** The text of every warn call, for substring assertions. */
function warnText(logs: LogCall[]): string {
  return logs
    .filter((log) => log.level === "warn")
    .map((log) => JSON.stringify(log.args))
    .join("\n");
}

interface GhFixture {
  /** Listing entries returned by `gh pr list`. */
  prs?: unknown[];
  /** Raw file content per repo path. A path absent here answers HTTP 404. */
  files?: Record<string, string>;
  /** Paths whose contents read throws this message instead. */
  failing?: Record<string, string>;
  /** Reply to `gh pr view` (the end-to-end sync). */
  view?: string;
  /** Makes `gh pr view` throw this message instead of replying. */
  viewError?: string;
}

interface Harness {
  gh: (args: string[]) => Promise<string>;
  /** Every `gh` call, in order. */
  calls: string[][];
  /** The `--body-file` content of every `gh pr edit`, read before cleanup. */
  editBodies: string[];
  logs: LogCall[];
  logger: Logger;
}

function harness(fixture: GhFixture): Harness {
  const calls: string[][] = [];
  const editBodies: string[] = [];
  const logs: LogCall[] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(fixture.prs ?? []);
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (fixture.viewError !== undefined) throw new Error(fixture.viewError);
      return fixture.view ?? "";
    }
    if (args[0] === "pr" && args[1] === "edit") {
      const idx = args.indexOf("--body-file");
      const bodyFile = idx === -1 ? undefined : args[idx + 1];
      if (bodyFile !== undefined) {
        editBodies.push(await Deno.readTextFile(bodyFile));
      }
      return "";
    }
    if (args[0] === "api") {
      const match = /\/contents\/(.+?)\?ref=/.exec(args[1] ?? "");
      const path = match?.[1] ?? "";
      const failure = fixture.failing?.[path];
      if (failure !== undefined) throw new Error(failure);
      const content = fixture.files?.[path];
      if (content === undefined) throw new Error(NOT_FOUND);
      return content;
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls, editBodies, logs, logger: recordingLogger(logs) };
}

/** A git call that must never happen in the test that uses this. */
const REFUSE_GIT: ReconcilePrBodiesDeps["runGitCommand"] = async (args) => {
  throw new Error(`unexpected git call: ${args.join(" ")}`);
};

/** A checkout that must never be requested in the test that uses this. */
const REFUSE_PREPARE: PrepareHeadCheckout = async () => {
  throw new Error("prepareCheckout should not have been called");
};

/** A sync that must never run in the test that uses this. */
const REFUSE_SYNC: typeof syncPrBodyFromSummary = async () => {
  throw new Error("syncFn should not have been called");
};

function passDeps(
  h: Harness,
  inSync: Map<string, string>,
  extra: Partial<ReconcilePrBodiesDeps> = {},
): ReconcilePrBodiesDeps {
  return {
    runGhCommand: h.gh,
    runGitCommand: REFUSE_GIT,
    logger: h.logger,
    followUpFiling: undefined,
    inSync,
    prepareCheckout: REFUSE_PREPARE,
    syncFn: REFUSE_SYNC,
    ...extra,
  };
}

/** The listing entry `gh pr list --json number,headRefName,headRefOid,body,author` returns. */
function prEntry(
  body: string,
  opts: { headRefOid?: string; login?: string } = {},
): unknown {
  return {
    number: PR_NUMBER,
    headRefName: "issue-42-fix-thing",
    headRefOid: opts.headRefOid ?? HEAD_SHA,
    body,
    author: { login: opts.login ?? FLEET_LOGIN },
  };
}

async function digestOf(summary: string, facts: string | null = null) {
  return await prSummaryDigest(prSummaryDigestInput(summary, facts));
}

/** A worker PR body that records `digest` as the summary it was built from. */
async function bodyRecording(summary: string, digest: string): Promise<string> {
  return assemblePrBody({
    summaryContent: summary,
    issueNumber: ISSUE_NUMBER,
    extraSections: "",
    footer: "\n---\n\n🤖 Processed by: old-worker\n",
    summaryDigest: digest,
    subAgentTier: undefined,
  });
}

function editCalls(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === "pr" && c[1] === "edit");
}

function apiCalls(h: Harness): string[][] {
  return h.calls.filter((c) => c[0] === "api");
}

// --- Steady state and the memo ---------------------------------------------

Deno.test("reconcile - digest matches the head summary: silent, no edit, memo set", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V1 },
  });
  const inSync = new Map<string, string>();
  let prepared = 0;
  let synced = 0;

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, inSync, {
      prepareCheckout: async (repo, sha) => {
        prepared += 1;
        return REFUSE_PREPARE(repo, sha);
      },
      syncFn: async (input, deps) => {
        synced += 1;
        return REFUSE_SYNC(input, deps);
      },
    }),
  );

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(editCalls(h).length, 0);
  assertEquals(prepared, 0);
  assertEquals(synced, 0);
  assertEquals(h.logs, []);
  assertEquals(
    inSync.get(`${REPO}#${PR_NUMBER}`),
    `${HEAD_SHA}:${await digestOf(SUMMARY_V1)}`,
  );
});

Deno.test("reconcile - second pass with a memo hit makes no contents call", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V1 },
  });
  const inSync = new Map<string, string>();

  await reconcilePrBodyDigests(OPTS, passDeps(h, inSync));
  // The first pass reads the summary and the (absent) facts file.
  const afterFirst = apiCalls(h).length;
  assertEquals(afterFirst, 2);

  const second = await reconcilePrBodyDigests(OPTS, passDeps(h, inSync));
  assertEquals(
    apiCalls(h).length,
    afterFirst,
    "second pass must not read contents",
  );
  assertEquals(second, { checked: 0, rebuilt: 0, readFailures: 0 });
  assertEquals(h.logs, []);
});

// --- Mismatch --------------------------------------------------------------

Deno.test("reconcile - mismatch: one checkout at the head, one sync at its path, cleaned up", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });
  const inSync = new Map<string, string>();
  const prepareCalls: Array<[string, string]> = [];
  const syncInputs: SyncPrBodyInput[] = [];
  let cleaned = 0;

  const prepareCheckout: PrepareHeadCheckout = async (repo, headSha) => {
    prepareCalls.push([repo, headSha]);
    return {
      ok: true,
      value: {
        path: "/tmp/fake-pr-head-checkout",
        cleanup: async () => {
          cleaned += 1;
        },
      },
    };
  };
  const syncFn: typeof syncPrBodyFromSummary = async (input) => {
    syncInputs.push(input);
    return {
      ok: true,
      value: { status: "updated", issueNumber: ISSUE_NUMBER },
    };
  };

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, inSync, { prepareCheckout, syncFn }),
  );

  assertEquals(summary, { checked: 1, rebuilt: 1, readFailures: 0 });
  assertEquals(prepareCalls, [[REPO, HEAD_SHA]]);
  assertEquals(syncInputs.length, 1);
  assertEquals(syncInputs[0]?.repoPath, "/tmp/fake-pr-head-checkout");
  assertEquals(syncInputs[0]?.beforeSha, undefined);
  assertEquals(syncInputs[0]?.prNumber, PR_NUMBER);
  assertEquals(syncInputs[0]?.branchName, "issue-42-fix-thing");
  assert(
    h.calls.some((args) =>
      args[0] === "pr" && args[1] === "list" &&
      (args[args.indexOf("--json") + 1] ?? "").split(",").includes(
        "headRefName",
      )
    ),
    "the real listing must request the branch passed to body sync",
  );
  assertEquals(cleaned, 1);
  assertEquals(inSync.size, 0, "a rebuild is not memoised");
});

Deno.test("reconcile - end to end: mismatch rebuilds through the real sync with the new digest", async () => {
  const oldBody = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const checkoutDir = await Deno.makeTempDir({
    prefix: "pr-body-reconcile-e2e-",
  });
  try {
    const git = async (...args: string[]): Promise<string> => {
      const out = await new Deno.Command("git", {
        args,
        cwd: checkoutDir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!out.success) {
        throw new Error(
          `git ${args.join(" ")} failed: ${
            new TextDecoder().decode(out.stderr)
          }`,
        );
      }
      return new TextDecoder().decode(out.stdout).trim();
    };
    await git("init", "-q");
    await git("config", "user.name", "Test Author");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await Deno.mkdir(`${checkoutDir}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${checkoutDir}/${ARCHIVE_PATH}`, SUMMARY_V2);
    await git("add", "-A");
    await git("commit", "-q", "-m", "rewrite summary");
    const headSha = await git("rev-parse", "HEAD");
    assert(/^[0-9a-f]{40}$/.test(headSha), `unexpected HEAD ${headSha}`);

    const h = harness({
      prs: [prEntry(oldBody, { headRefOid: headSha })],
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      view: JSON.stringify({ body: oldBody, files: [], headRefOid: headSha }),
    });
    const prepareCheckout: PrepareHeadCheckout = async () => ({
      ok: true,
      value: { path: checkoutDir, cleanup: async () => {} },
    });

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        prepareCheckout,
        // The real sync and the real git runner: nothing stubbed past checkout.
        syncFn: syncPrBodyFromSummary,
        runGitCommand,
      }),
    );

    assertEquals(summary.rebuilt, 1);
    const edits = editCalls(h);
    assertEquals(edits.length, 1, "exactly one gh pr edit");
    assertEquals(h.editBodies.length, 1);
    const newDigest = await digestOf(SUMMARY_V2);
    assertStringIncludes(
      h.editBodies[0] ?? "",
      buildSummaryDigestMarker(newDigest),
    );
    assertStringIncludes(h.editBodies[0] ?? "", "Rewritten summary text.");
  } finally {
    await Deno.remove(checkoutDir, { recursive: true });
  }
});

// --- Skips that are quiet --------------------------------------------------

Deno.test("reconcile - legacy body with no digest marker: skipped, no contents call, no log", async () => {
  const legacy = `## Summary\n\nOld.\n\n${
    buildIdempotencyMarker(ISSUE_NUMBER)
  }\n`;
  const h = harness({
    prs: [prEntry(legacy)],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 0 });
  assertEquals(apiCalls(h).length, 0);
  assertEquals(h.logs, []);
});

Deno.test("reconcile - body with no worker marker: skipped, no contents call, no log", async () => {
  const foreign = `## Summary\n\nNot ours.\n\n${
    buildSummaryDigestMarker(
      await digestOf(SUMMARY_V1),
    )
  }\n`;
  const h = harness({
    prs: [prEntry(foreign)],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 0 });
  assertEquals(apiCalls(h).length, 0);
  assertEquals(h.logs, []);
});

Deno.test("reconcile - invalid head SHA: no contents call, no log", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body, { headRefOid: "abc?x=1" })],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 0 });
  assertEquals(apiCalls(h).length, 0);
  assertEquals(h.logs, []);
});

Deno.test("reconcile - non-fleet author: skipped, no contents call, no log", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body, { login: "someone-else" })],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 0 });
  assertEquals(apiCalls(h).length, 0);
  assertEquals(h.logs, []);
});

// --- Failures --------------------------------------------------------------

Deno.test("reconcile - contents read failure: warn with the cause, no checkout, no edit, not memoised", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    failing: { [ARCHIVE_PATH]: "gh command failed (exit 1): HTTP 502" },
  });
  const inSync = new Map<string, string>();

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, inSync));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 1 });
  assertStringIncludes(warnText(h.logs), "502");
  assertStringIncludes(warnText(h.logs), ARCHIVE_PATH);
  assertEquals(editCalls(h).length, 0);
  assertEquals(inSync.size, 0, "a failed read is not memoised");
});

Deno.test("reconcile - prepareCheckout failure: warn with its message, sync not called", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });
  let synced = 0;

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, new Map(), {
      prepareCheckout: async () => ({
        ok: false,
        error: new Error("clone exploded"),
      }),
      syncFn: async (input, deps) => {
        synced += 1;
        return REFUSE_SYNC(input, deps);
      },
    }),
  );

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(synced, 0);
  assertStringIncludes(warnText(h.logs), "clone exploded");
  assertEquals(editCalls(h).length, 0);
});

// --- Prefetched listing entries (no body) -----------------------------------

/** A stale head, distinct from HEAD_SHA, that the cached entry records. */
const STALE_SHA = "f".repeat(40);

/** A prefetched `prs_maint_<author>` entry: the `toMaintenanceEntry` shape, no body. */
function bodylessCacheEntry(headRefOid: string): unknown {
  return {
    number: PR_NUMBER,
    headRefName: "fix-branch",
    headRefOid,
    baseRefName: "main",
    author: { login: FLEET_LOGIN },
  };
}

/** An issue cache holding the prefetched `prs_maint_<author>` entry for `REPO`. */
async function seededCache(entry: unknown) {
  const dir = await Deno.makeTempDir({ prefix: "pr-body-reconcile-cache-" });
  const cache = new IssueCache(dir);
  await cache.write(REPO, `prs_maint_${FLEET_LOGIN}`, [entry]);
  return { cache, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("reconcile - a cached listing entry with no body is fetched with gh pr view and a mismatch is still rebuilt", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(STALE_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      view: JSON.stringify({ body, headRefOid: HEAD_SHA }),
    });
    const prepareCalls: Array<[string, string]> = [];
    const syncInputs: SyncPrBodyInput[] = [];

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        cache,
        prepareCheckout: async (repo, sha) => {
          prepareCalls.push([repo, sha]);
          return {
            ok: true,
            value: {
              path: "/tmp/fake-pr-head-checkout",
              cleanup: async () => {},
            },
          };
        },
        syncFn: async (input) => {
          syncInputs.push(input);
          return {
            ok: true,
            value: { status: "updated", issueNumber: ISSUE_NUMBER },
          };
        },
      }),
    );

    assertEquals(summary, { checked: 1, rebuilt: 1, readFailures: 0 });
    assertEquals(
      h.calls.filter((c) => c[0] === "pr" && c[1] === "view"),
      [[
        "pr",
        "view",
        String(PR_NUMBER),
        "--repo",
        REPO,
        "--json",
        "body,headRefOid",
      ]],
      "one gh pr view for the bodyless entry",
    );
    assertEquals(
      prepareCalls,
      [[REPO, HEAD_SHA]],
      "the fetched head is checked out, not the cached one",
    );
    assertEquals(syncInputs.length, 1, "exactly one sync");
  } finally {
    await cleanup();
  }
});

Deno.test("reconcile - a gh pr view failure for a bodyless entry is logged with the cause, no checkout, no rebuild", async () => {
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(HEAD_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      viewError: "gh command failed (exit 1): HTTP 502 Bad Gateway",
    });
    let prepared = 0;
    let synced = 0;

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        cache,
        prepareCheckout: async (repo, sha) => {
          prepared += 1;
          return REFUSE_PREPARE(repo, sha);
        },
        syncFn: async (input, deps) => {
          synced += 1;
          return REFUSE_SYNC(input, deps);
        },
      }),
    );

    assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 1 });
    assertStringIncludes(warnText(h.logs), "HTTP 502 Bad Gateway");
    assertEquals(prepared, 0, "no checkout");
    assertEquals(synced, 0, "no rebuild");
    assertEquals(editCalls(h).length, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("reconcile - a bodyless cached entry whose fetched body digest matches stays silent", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(HEAD_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V1 },
      view: JSON.stringify({ body, headRefOid: HEAD_SHA }),
    });
    const inSync = new Map<string, string>();

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, inSync, { cache }),
    );

    assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
    assertEquals(h.logs, []);
    assertEquals(editCalls(h).length, 0);
    assertEquals(
      inSync.get(`${REPO}#${PR_NUMBER}`),
      `${HEAD_SHA}:${await digestOf(SUMMARY_V1)}`,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("reconcile - a gh pr view reply that is not JSON is a read failure: warn with the cause, no contents read, no rebuild", async () => {
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(HEAD_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      view: "this is not JSON",
    });
    let prepared = 0;
    let synced = 0;

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        cache,
        prepareCheckout: async (repo, sha) => {
          prepared += 1;
          return REFUSE_PREPARE(repo, sha);
        },
        syncFn: async (input, deps) => {
          synced += 1;
          return REFUSE_SYNC(input, deps);
        },
      }),
    );

    assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 1 });
    assertStringIncludes(warnText(h.logs), "Failed to read PR");
    assertEquals(prepared, 0, "no checkout");
    assertEquals(synced, 0, "no rebuild");
    assertEquals(editCalls(h).length, 0);
    assertEquals(apiCalls(h).length, 0, "no contents read");
  } finally {
    await cleanup();
  }
});

Deno.test("reconcile - a gh pr view reply with no string body is a read failure: warn, no contents read, no rebuild", async () => {
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(HEAD_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      view: JSON.stringify({ headRefOid: HEAD_SHA }),
    });
    let prepared = 0;
    let synced = 0;

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        cache,
        prepareCheckout: async (repo, sha) => {
          prepared += 1;
          return REFUSE_PREPARE(repo, sha);
        },
        syncFn: async (input, deps) => {
          synced += 1;
          return REFUSE_SYNC(input, deps);
        },
      }),
    );

    assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 1 });
    assertStringIncludes(warnText(h.logs), "returned no body");
    assertEquals(prepared, 0, "no checkout");
    assertEquals(synced, 0, "no rebuild");
    assertEquals(editCalls(h).length, 0);
    assertEquals(apiCalls(h).length, 0, "no contents read");
  } finally {
    await cleanup();
  }
});

Deno.test("reconcile - a gh pr view reply whose headRefOid is not a string is skipped silently, no contents read", async () => {
  // The body's digest mismatches the contents, so a reached digest check would log or rebuild.
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const { cache, cleanup } = await seededCache(bodylessCacheEntry(HEAD_SHA));
  try {
    const h = harness({
      files: { [ARCHIVE_PATH]: SUMMARY_V2 },
      view: JSON.stringify({ body, headRefOid: 12345 }),
    });
    let prepared = 0;
    let synced = 0;

    const summary = await reconcilePrBodyDigests(
      OPTS,
      passDeps(h, new Map(), {
        cache,
        prepareCheckout: async (repo, sha) => {
          prepared += 1;
          return REFUSE_PREPARE(repo, sha);
        },
        syncFn: async (input, deps) => {
          synced += 1;
          return REFUSE_SYNC(input, deps);
        },
      }),
    );

    assertEquals(summary, { checked: 0, rebuilt: 0, readFailures: 0 });
    assertEquals(h.logs, []);
    assertEquals(apiCalls(h).length, 0, "no contents read");
    assertEquals(prepared, 0, "no checkout");
    assertEquals(synced, 0, "no rebuild");
    assertEquals(editCalls(h).length, 0);
  } finally {
    await cleanup();
  }
});

// --- Facts file and summary candidates --------------------------------------

Deno.test("reconcile - facts file absent (404): digest of the summary alone matches, quiet", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V1 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(h.logs, []);
  assert(
    apiCalls(h).some((c) => c[1]?.includes(FACTS_PATH)),
    "facts read attempted",
  );
});

Deno.test("reconcile - facts-only change: mismatch, rebuild", async () => {
  const body = await bodyRecording(
    SUMMARY_V1,
    await digestOf(SUMMARY_V1, FACTS_V1),
  );
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V1, [FACTS_PATH]: FACTS_V2 },
  });
  let prepared = 0;

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, new Map(), {
      prepareCheckout: async () => {
        prepared += 1;
        return { ok: false, error: new Error("stop after the digest check") };
      },
    }),
  );

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(prepared, 1);
});

Deno.test("reconcile - archive 404 but legacy summary present: legacy used, quiet", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [LEGACY_PATH]: SUMMARY_V1 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(h.logs, []);
  assert(
    apiCalls(h).some((c) => c[1]?.includes(LEGACY_PATH)),
    "legacy read attempted",
  );
});

Deno.test("reconcile - no summary at either path: quiet, memoised, no checkout", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({ prs: [prEntry(body)], files: {} });
  const inSync = new Map<string, string>();

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, inSync));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(h.logs, []);
  assertEquals(editCalls(h).length, 0);
  assertEquals(
    inSync.get(`${REPO}#${PR_NUMBER}`),
    `${HEAD_SHA}:${await digestOf(SUMMARY_V1)}`,
  );
});

Deno.test("reconcile - whitespace-only archive summary falls through to the legacy path", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: "  \n\n\t ", [LEGACY_PATH]: SUMMARY_V1 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
  assertEquals(h.logs, []);
});

// --- Memo pruning -----------------------------------------------------------

Deno.test("reconcile - memo prunes a PR of this repo that is no longer listed", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V1 },
  });
  const inSync = new Map<string, string>([
    [`${REPO}#999`, "stale"],
    ["other/repo#5", "kept"],
  ]);

  await reconcilePrBodyDigests(OPTS, passDeps(h, inSync));

  assertEquals(inSync.has(`${REPO}#999`), false, "closed PR pruned");
  assertEquals(inSync.get("other/repo#5"), "kept", "other repo untouched");
  assert(inSync.has(`${REPO}#${PR_NUMBER}`), "listed PR memoised");
});

// --- headSummaryDigest ------------------------------------------------------

Deno.test("headSummaryDigest - a non-404 read failure names the path and the cause", async () => {
  const gh = async (args: string[]): Promise<string> => {
    if (args[1]?.includes(ARCHIVE_PATH)) {
      throw new Error("gh command failed (exit 1): HTTP 502");
    }
    throw new Error(NOT_FOUND);
  };

  const result = await headSummaryDigest(REPO, ISSUE_NUMBER, HEAD_SHA, gh);

  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertStringIncludes(result.reason, ARCHIVE_PATH);
    assertStringIncludes(result.reason, "HTTP 502");
  }
});

// --- disposableHeadCheckout -------------------------------------------------

Deno.test("disposableHeadCheckout - rejects a non-40-hex SHA without calling gh", async () => {
  const ghCalls: string[][] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: async (args) => {
      ghCalls.push(args);
      return "";
    },
    runGitCommand: REFUSE_GIT,
  });

  const result = await prepare(REPO, "not-a-sha");

  assertEquals(result.ok, false);
  assertEquals(ghCalls.length, 0);
});

Deno.test("disposableHeadCheckout - a failing git fetch quotes stderr and removes its temp dir", async () => {
  const cloneDirs: string[] = [];
  const gitCalls: string[][] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: async (args) => {
      cloneDirs.push(args[3] ?? "");
      return "";
    },
    runGitCommand: async (args) => {
      gitCalls.push(args);
      return {
        ok: true,
        value: {
          code: 128,
          stdout: "",
          stderr: "fatal: couldn't find remote ref HEAD-missing\n",
        },
      };
    },
  });

  const result = await prepare(REPO, HEAD_SHA);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "fatal: couldn't find remote ref HEAD-missing",
    );
  }
  assertEquals(gitCalls.length, 1, "stops at the first failed step");
  assertEquals(gitCalls[0]?.[0], "fetch");
  const cloneDir = cloneDirs[0] ?? "";
  assert(cloneDir.endsWith("/checkout"), `unexpected clone dir ${cloneDir}`);
  const tmp = cloneDir.slice(0, -"/checkout".length);
  await assertRejects(() => Deno.stat(tmp), Deno.errors.NotFound);
});

// --- Coverage top-up (Issue #3760 mutation check) ---------------------------

/** A recorded git call: its argv and the directory it ran in. */
interface GitCall {
  args: string[];
  cwd: string | undefined;
}

/** A git runner answering every step with exit 0, and `stdout` for rev-parse. */
function okGit(
  calls: GitCall[],
  revParse: string,
): ReconcilePrBodiesDeps["runGitCommand"] {
  return async (args, options) => {
    calls.push({ args, cwd: options?.cwd });
    return {
      ok: true,
      value: {
        code: 0,
        stdout: args[0] === "rev-parse" ? revParse : "",
        stderr: "",
      },
    };
  };
}

/** A `gh repo clone` stand-in that creates the clone dir with one file in it. */
function populatingClone(cloneCalls: string[][]) {
  return async (args: string[]): Promise<string> => {
    cloneCalls.push(args);
    const dir = args[3] ?? "";
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/README.md`, "cloned\n");
    return "";
  };
}

/** The temp dir that owns a `<tmp>/checkout` clone dir. */
function tempDirOf(cloneDir: string): string {
  assert(cloneDir.endsWith("/checkout"), `unexpected clone dir ${cloneDir}`);
  return cloneDir.slice(0, -"/checkout".length);
}

Deno.test("headSummaryDigest - reads the summary and facts as raw content at the ref and returns a digest result", async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1]?.includes(ARCHIVE_PATH)) return SUMMARY_V1;
    if (args[1]?.includes(FACTS_PATH)) return FACTS_V1;
    throw new Error(NOT_FOUND);
  };

  const result = await headSummaryDigest(REPO, ISSUE_NUMBER, HEAD_SHA, gh);

  assertEquals(result, {
    kind: "digest",
    digest: await digestOf(SUMMARY_V1, FACTS_V1),
  });
  assertEquals(calls, [
    [
      "api",
      `repos/${REPO}/contents/${ARCHIVE_PATH}?ref=${HEAD_SHA}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
    [
      "api",
      `repos/${REPO}/contents/${FACTS_PATH}?ref=${HEAD_SHA}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
  ]);
});

Deno.test("headSummaryDigest - the error reason quotes the failure message, not the Error's string form", async () => {
  const gh = async (): Promise<string> => {
    throw new Error("gh command failed (exit 1): HTTP 502");
  };

  const result = await headSummaryDigest(REPO, ISSUE_NUMBER, HEAD_SHA, gh);

  assertEquals(result, {
    kind: "error",
    reason:
      `Failed to read ${ARCHIVE_PATH} at ${HEAD_SHA}: gh command failed (exit 1): HTTP 502`,
  });
});

Deno.test("checkedGit - a git runner failure is an error naming the step", async () => {
  const result = await checkedGit(
    async () => ({ ok: false, error: new Error("spawn failed") }),
    "fetch",
    ["fetch"],
    "/tmp/x",
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "git fetch failed: spawn failed");
  }
});

Deno.test("checkedGit - a non-zero exit is an error quoting the exit code and stderr", async () => {
  const result = await checkedGit(
    async () => ({
      ok: true,
      value: { code: 2, stdout: "", stderr: "fatal: bad ref\n" },
    }),
    "checkout",
    ["checkout"],
    "/tmp/x",
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      "git checkout failed (exit 2): fatal: bad ref",
    );
  }
});

Deno.test("checkedGit - exit 0 returns the stdout and runs in the given directory", async () => {
  const calls: GitCall[] = [];

  const result = await checkedGit(
    okGit(calls, `${HEAD_SHA}\n`),
    "rev-parse",
    ["rev-parse", "HEAD"],
    "/tmp/x",
  );

  assertEquals(result, { ok: true, value: `${HEAD_SHA}\n` });
  assertEquals(calls, [{ args: ["rev-parse", "HEAD"], cwd: "/tmp/x" }]);
});

Deno.test("disposableHeadCheckout - success: shallow blobless clone, detached checkout at the SHA, cleanup removes it", async () => {
  const cloneCalls: string[][] = [];
  const gitCalls: GitCall[] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: populatingClone(cloneCalls),
    runGitCommand: okGit(gitCalls, `${HEAD_SHA}\n`),
  });

  const result = await prepare(REPO, HEAD_SHA);

  assert(result.ok, "checkout should succeed");
  const dir = cloneCalls[0]?.[3] ?? "";
  const tmp = tempDirOf(dir);
  assertEquals(cloneCalls, [[
    "repo",
    "clone",
    REPO,
    dir,
    "--",
    "--depth=1",
    "--no-checkout",
    "--filter=blob:none",
  ]]);
  assertEquals(gitCalls, [
    { args: ["fetch", "--depth=1", "origin", HEAD_SHA], cwd: dir },
    {
      args: [
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--detach",
        "FETCH_HEAD",
      ],
      cwd: dir,
    },
    { args: ["rev-parse", "HEAD"], cwd: dir },
  ]);
  assertEquals(result.value.path, dir);
  await result.value.cleanup();
  await assertRejects(() => Deno.stat(tmp), Deno.errors.NotFound);
});

Deno.test("disposableHeadCheckout - a failing clone quotes the message and removes its temp dir", async () => {
  const cloneDirs: string[] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: async (args) => {
      cloneDirs.push(args[3] ?? "");
      await populatingClone([])(args);
      throw new Error("clone refused");
    },
    runGitCommand: REFUSE_GIT,
  });

  const result = await prepare(REPO, HEAD_SHA);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      `Failed to clone ${REPO}: clone refused`,
    );
  }
  // The clone dir holds a file, so only a recursive removal clears it.
  await assertRejects(
    () => Deno.stat(tempDirOf(cloneDirs[0] ?? "")),
    Deno.errors.NotFound,
  );
});

Deno.test("disposableHeadCheckout - a temp dir that cannot be removed is appended to the original failure", async () => {
  const prepare = disposableHeadCheckout({
    runGhCommand: async (args) => {
      // Remove the temp dir out from under the cleanup so its removal fails.
      await Deno.remove(tempDirOf(args[3] ?? ""), { recursive: true });
      throw new Error("clone refused");
    },
    runGitCommand: REFUSE_GIT,
  });

  const result = await prepare(REPO, HEAD_SHA);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      `Failed to clone ${REPO}: clone refused (and the temporary directory `,
    );
    assertStringIncludes(result.error.message, "could not be removed");
  }
});

Deno.test("disposableHeadCheckout - a failing rev-parse fails the checkout and removes its temp dir", async () => {
  const cloneCalls: string[][] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: populatingClone(cloneCalls),
    runGitCommand: async (args) => ({
      ok: true,
      value: {
        code: args[0] === "rev-parse" ? 1 : 0,
        stdout: "",
        stderr: args[0] === "rev-parse" ? "fatal: no HEAD\n" : "",
      },
    }),
  });

  const result = await prepare(REPO, HEAD_SHA);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      "git rev-parse failed (exit 1): fatal: no HEAD",
    );
  }
  await assertRejects(
    () => Deno.stat(tempDirOf(cloneCalls[0]?.[3] ?? "")),
    Deno.errors.NotFound,
  );
});

Deno.test("disposableHeadCheckout - a checkout resolving to another SHA fails and removes its temp dir", async () => {
  const other = "f".repeat(40);
  const cloneCalls: string[][] = [];
  const prepare = disposableHeadCheckout({
    runGhCommand: populatingClone(cloneCalls),
    runGitCommand: okGit([], `${other}\n`),
  });

  const result = await prepare(REPO, HEAD_SHA);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      `Checkout of ${REPO} resolved to ${other}, not ${HEAD_SHA}`,
    );
  }
  await assertRejects(
    () => Deno.stat(tempDirOf(cloneCalls[0]?.[3] ?? "")),
    Deno.errors.NotFound,
  );
});

Deno.test("reconcile - a listing entry with no author is still reconciled", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [{ number: PR_NUMBER, headRefOid: HEAD_SHA, body }],
    files: { [ARCHIVE_PATH]: SUMMARY_V1 },
  });

  const summary = await reconcilePrBodyDigests(OPTS, passDeps(h, new Map()));

  assertEquals(summary, { checked: 1, rebuilt: 0, readFailures: 0 });
});

Deno.test("reconcile - a cleanup failure after the rebuild is logged, not thrown", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const h = harness({
    prs: [prEntry(body)],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, new Map(), {
      prepareCheckout: async () => ({
        ok: true,
        value: {
          path: "/tmp/fake-pr-head-checkout",
          cleanup: async () => {
            throw new Error("rm refused");
          },
        },
      }),
      syncFn: async () => ({
        ok: true,
        value: { status: "updated", issueNumber: ISSUE_NUMBER },
      }),
    }),
  );

  assertEquals(summary, { checked: 1, rebuilt: 1, readFailures: 0 });
  const warns = warnText(h.logs);
  assertStringIncludes(
    warns,
    "Could not remove the disposable PR head checkout",
  );
  assertStringIncludes(warns, "rm refused");
});

Deno.test("reconcile - an unexpected throw for one PR is logged and the pass moves on to the next", async () => {
  const body = await bodyRecording(SUMMARY_V1, await digestOf(SUMMARY_V1));
  const second = { ...(prEntry(body) as Record<string, unknown>), number: 8 };
  const h = harness({
    prs: [prEntry(body), second],
    files: { [ARCHIVE_PATH]: SUMMARY_V2 },
  });
  const prepared: string[] = [];

  const summary = await reconcilePrBodyDigests(
    OPTS,
    passDeps(h, new Map(), {
      prepareCheckout: async () => {
        prepared.push("called");
        throw new Error("checkout blew up");
      },
    }),
  );

  assertEquals(prepared.length, 2, "the second PR is still reached");
  assertEquals(summary, { checked: 2, rebuilt: 0, readFailures: 0 });
  const warns = warnText(h.logs);
  assertStringIncludes(warns, "PR body digest check failed unexpectedly");
  assertStringIncludes(warns, "checkout blew up");
});
