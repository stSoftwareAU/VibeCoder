/**
 * Regression tests for Issue #5018 — the edit boundary is GitHub's own
 * `updatedAt` for the read that produced the hashed bytes, never the worker
 * clock at write time.
 *
 * Fixture times sit in May 2026, well before the real `Date.now()`, which
 * reproduces a worker clock that runs ahead of GitHub's: the old gate stamped
 * `capturedAt` with the worker clock, filtered edits with
 * `editedAt >= capturedAt`, found none, and blessed an untrusted edit through
 * the `[SNAPSHOT_SELF_MISMATCH]` branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  verifyWorkOnContentIntegrityDetailed,
} from "../lib/work_on_content_integrity.ts";
import { verifyPickupContentIntegrity } from "../lib/pickup_content_integrity.ts";
import {
  captureContentSnapshot,
  CONTENT_HASH_ENCODING_V1,
  type ContentApprovalDeps,
  type ContentSnapshot,
  CURRENT_CONTENT_HASH_ENCODING,
  loadContentApprovalState,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TITLE = "Fix the bug";
const B0 = "Approved specification";
const B1 = "Specification with an edit";
const B2 = "Specification with another edit";
const LABELLED_AT = "2026-05-01T08:00:00Z";
const R0 = Math.floor(Date.parse("2026-05-01T09:00:00Z") / 1000);
const T0 = R0;
const T1 = R0 + 600;
const T2 = R0 + 1200;
const KEY = "owner/repo|42";

const iso = (unix: number): string => new Date(unix * 1000).toISOString();

function createMemoryFs(): {
  deps: ContentApprovalDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const deps: ContentApprovalDeps = {
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
  return { deps, files };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: "/tmp/work-integrity-revision-boundary-5018-test",
  };
}

function makeIssue(body: string, updatedAt?: string): FilterableIssue {
  return {
    number: 42,
    title: TITLE,
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-05-01T00:00:00Z",
    author: "alice",
    milestone: "",
    body,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

interface World {
  title: string;
  body: string;
  /** `updatedAt` served by a live `gh issue view`. */
  updatedAt: string;
  bodyEdits: Array<{ login: string; at: number }>;
  /** Overrides the reported body edit `totalCount` (truncated history). */
  bodyTotal?: number;
  labelledBy: Array<{ login: string; at: string }>;
  actions: string[];
  addedLabels: string[];
}

function newWorld(): World {
  return {
    title: TITLE,
    body: B0,
    updatedAt: iso(T0),
    bodyEdits: [],
    labelledBy: [{ login: "alice", at: LABELLED_AT }],
    actions: [],
    addedLabels: [],
  };
}

function ghFor(w: World): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "api" && command.includes("userContentEdits")) {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              userContentEdits: {
                totalCount: w.bodyTotal ?? w.bodyEdits.length,
                nodes: [...w.bodyEdits].sort((a, b) => b.at - a.at).map((
                  e,
                ) => ({
                  editedAt: iso(e.at),
                  editor: { login: e.login },
                })),
              },
              timelineItems: { totalCount: 0, nodes: [] },
            },
          },
        },
      }));
    }
    if (command.includes("api") && command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(
        w.labelledBy.map((l) => ({
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: l.login },
          created_at: l.at,
        })),
      ));
    }
    if (args[0] === "issue" && args[1] === "view") {
      // Like `gh issue view --json a,b`: only the requested fields come back.
      const fields = (args[args.indexOf("--json") + 1] ?? "").split(",");
      const everything: Record<string, string> = {
        title: w.title,
        body: w.body,
        updatedAt: w.updatedAt,
      };
      return Promise.resolve(JSON.stringify(
        Object.fromEntries(
          Object.entries(everything).filter(([k]) => fields.includes(k)),
        ),
      ));
    }
    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/labels") && args.some((a) => a.startsWith("labels[]="))
    ) {
      w.actions.push("add-label");
      const match = args.find((a) => a.startsWith("labels[]="));
      if (match) w.addedLabels.push(match.slice("labels[]=".length));
      return Promise.resolve("");
    }
    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/comments")
    ) {
      w.actions.push("post-comment");
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
}

async function readSnapshot(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
): Promise<ContentSnapshot | undefined> {
  const state = await loadContentApprovalState(
    resolveContentApprovalStateDir(config.workDir),
    deps,
  );
  return state.snapshots[KEY];
}

/** Capture a baseline, then pin its worker-clock and revision stamps. */
async function seedSnapshot(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  files: Map<string, string>,
  stamps: { capturedAt?: number; contentRevisionAt?: number | null },
  body = B0,
): Promise<void> {
  const stateDir = resolveContentApprovalStateDir(config.workDir);
  await captureContentSnapshot(
    stateDir,
    "owner/repo",
    42,
    TITLE,
    body,
    "alice",
    null,
    deps,
  );
  const path = `${stateDir}/.content_approval_state.json`;
  const state = JSON.parse(files.get(path)!);
  const snap = state.snapshots[KEY];
  if (stamps.capturedAt !== undefined) snap.capturedAt = stamps.capturedAt;
  if (
    stamps.contentRevisionAt === null || stamps.contentRevisionAt === undefined
  ) {
    delete snap.contentRevisionAt;
  } else snap.contentRevisionAt = stamps.contentRevisionAt;
  files.set(path, JSON.stringify(state));
}

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error;
  const wn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.warn = wn;
  }
}

function pickup(
  w: World,
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  body: string,
  updatedAt: string | null,
) {
  return silently(() =>
    verifyPickupContentIntegrity({
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: TITLE,
      issueBody: body,
      issueLabels: ["work-on"],
      issueAuthor: "alice",
      issueUpdatedAt: updatedAt,
      config,
      githubUser: "worker-bot",
    }, { ghFn: ghFor(w), contentDeps: deps })
  );
}

function scan(
  w: World,
  config: WorkerConfig,
  deps: ContentApprovalDeps,
  issue: FilterableIssue,
) {
  return silently(() =>
    verifyWorkOnContentIntegrityDetailed(
      "owner/repo",
      issue,
      config,
      ghFor(w),
      undefined,
      deps,
    )
  );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

Deno.test("revision boundary #5018 (a) - a cached listing older than the write cannot hide a later untrusted edit", async () => {
  const { deps } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();

  const outcome = await scan(w, config, deps, makeIssue(B0, iso(T0)));
  assertEquals(outcome, { verdict: "proceed" });
  const snap = await readSnapshot(config, deps);
  assertEquals(snap?.contentRevisionAt, T0, "stamped with GitHub's clock");
  assert(snap!.capturedAt > T0, "capturedAt remains the worker clock");

  w.body = B1;
  w.bodyEdits = [{ login: "mallory", at: T1 }];
  const result = await pickup(w, config, deps, B1, iso(T1));
  assertEquals(result, {
    blocked: true,
    reason: "content-modified-after-approval",
  });
  assert(w.addedLabels.includes(config.needsHumanLabel), "needs-human added");
});

Deno.test("revision boundary #5018 (b) - an edit between a live read and the capture is judged after a trusted re-baseline", async () => {
  const { deps, files } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  await seedSnapshot(config, deps, files, {
    capturedAt: R0 + 5,
    contentRevisionAt: R0,
  });

  w.bodyEdits = [{ login: "alice", at: T1 }];
  const first = await pickup(w, config, deps, B1, iso(T1));
  assertEquals(first, { blocked: false });
  assertEquals((await readSnapshot(config, deps))?.contentRevisionAt, T1);
  assertEquals(w.addedLabels, []);

  w.bodyEdits = [{ login: "alice", at: T1 }, { login: "mallory", at: T2 }];
  const second = await pickup(w, config, deps, B2, iso(T2));
  assertEquals(second, {
    blocked: true,
    reason: "content-modified-after-approval",
  });
  assert(w.addedLabels.includes(config.needsHumanLabel), "needs-human added");
});

Deno.test("revision boundary #5018 (c) - a worker clock ahead of GitHub's does not bless an untrusted edit", async () => {
  const { deps, files } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  const tEdit = T1;
  await seedSnapshot(config, deps, files, {
    capturedAt: tEdit + 120,
    contentRevisionAt: tEdit - 60,
  });
  w.bodyEdits = [{ login: "mallory", at: tEdit }];

  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  let result;
  try {
    result = await verifyPickupContentIntegrity({
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: TITLE,
      issueBody: B1,
      issueLabels: ["work-on"],
      issueAuthor: "alice",
      issueUpdatedAt: iso(tEdit),
      config,
      githubUser: "worker-bot",
    }, { ghFn: ghFor(w), contentDeps: deps });
  } finally {
    console.error = original;
  }
  assertEquals(result, {
    blocked: true,
    reason: "content-modified-after-approval",
  });
  assert(!logged.some((l) => l.includes("SNAPSHOT_SELF_MISMATCH")));
  assert(w.addedLabels.includes(config.needsHumanLabel), "needs-human added");
});

Deno.test("revision boundary #5018 (d) - the encoding migration keeps the original boundary", async () => {
  const { deps, files } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  const C0 = R0 + 30;
  const stateDir = resolveContentApprovalStateDir(config.workDir);
  const v1 = new TextEncoder().encode(`${TITLE}\n${B0}`);
  const digest = await crypto.subtle.digest("SHA-256", v1);
  const v1Hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  files.set(
    `${stateDir}/.content_approval_state.json`,
    JSON.stringify({
      snapshots: {
        [KEY]: {
          contentHash: v1Hash,
          capturedAt: C0,
          contentRevisionAt: R0,
          issueAuthor: "alice",
          encoding: CONTENT_HASH_ENCODING_V1,
        },
      },
    }),
  );

  const outcome = await scan(w, config, deps, makeIssue(B0, iso(T1)));
  assertEquals(outcome, { verdict: "proceed" });
  assertEquals(w.addedLabels, []);
  const snap = await readSnapshot(config, deps);
  assertEquals(snap?.encoding, CURRENT_CONTENT_HASH_ENCODING);
  assertEquals(snap?.capturedAt, C0);
  assertEquals(snap?.contentRevisionAt, R0);
  assertEquals(snap?.issueAuthor, "alice");

  w.bodyEdits = [{ login: "mallory", at: T1 }];
  const result = await pickup(w, config, deps, B1, iso(T1));
  assertEquals(result, {
    blocked: true,
    reason: "content-modified-after-approval",
  });
  assert(w.addedLabels.includes(config.needsHumanLabel), "needs-human added");
});

Deno.test("revision boundary #5018 (e) - a genuine unchanged self-mismatch still recovers", async () => {
  const { deps, files } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  await seedSnapshot(config, deps, files, {
    capturedAt: R0 + 5,
    contentRevisionAt: R0,
  });
  // Corrupt the digest so the unchanged content no longer matches it.
  const path = `${
    resolveContentApprovalStateDir(config.workDir)
  }/.content_approval_state.json`;
  const state = JSON.parse(files.get(path)!);
  state.snapshots[KEY].contentHash = "0".repeat(64);
  files.set(path, JSON.stringify(state));
  // An edit before the content revision is already reflected in the bytes.
  w.bodyEdits = [{ login: "mallory", at: R0 - 100 }];

  const result = await pickup(w, config, deps, B0, iso(R0 + 5));
  assertEquals(result, { blocked: false });
  assertEquals(w.addedLabels, []);
  const snap = await readSnapshot(config, deps);
  assertEquals(snap?.contentRevisionAt, R0 + 5);
  assert(snap!.contentHash !== "0".repeat(64), "re-baselined");
});

Deno.test("revision boundary #5018 (f) - a legacy snapshot without a revision judges the whole history", async () => {
  const config = makeConfig();

  // (i) an untrusted edit stamped before capturedAt, content changed.
  {
    const { deps, files } = createMemoryFs();
    const w = newWorld();
    await seedSnapshot(config, deps, files, {
      capturedAt: R0 + 3600,
      contentRevisionAt: null,
    });
    w.bodyEdits = [{ login: "mallory", at: R0 + 60 }];
    const result = await pickup(w, config, deps, B1, iso(T1));
    assertEquals(result, {
      blocked: true,
      reason: "content-modified-after-approval",
    });
    assert(w.addedLabels.includes(config.needsHumanLabel));
  }

  // (ii) no edit recorded at all: provably unchanged, self-mismatch recovers.
  {
    const { deps, files } = createMemoryFs();
    const w = newWorld();
    await seedSnapshot(config, deps, files, {
      capturedAt: R0 + 3600,
      contentRevisionAt: null,
    });
    const result = await pickup(w, config, deps, B1, iso(T1));
    assertEquals(result, { blocked: false });
    assertEquals(w.addedLabels, []);
    assertEquals((await readSnapshot(config, deps))?.contentRevisionAt, T1);
  }

  // (iii) truncated body history can never be settled with an unknown boundary.
  {
    const { deps, files } = createMemoryFs();
    const w = newWorld();
    await seedSnapshot(config, deps, files, {
      capturedAt: R0 + 3600,
      contentRevisionAt: null,
    });
    w.bodyEdits = [{ login: "mallory", at: R0 + 1800 }];
    w.bodyTotal = 150;
    const result = await pickup(w, config, deps, B1, iso(T1));
    assertEquals(result, {
      blocked: true,
      reason: "content-edit-history-truncated",
    });
    assert(w.addedLabels.includes(config.needsHumanLabel));
  }
});

Deno.test("revision boundary #5018 (g) - a trusted re-approval re-baselines to the new revision", async () => {
  const { deps, files } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  await seedSnapshot(config, deps, files, {
    capturedAt: R0 + 5,
    contentRevisionAt: R0,
  });
  w.bodyEdits = [{ login: "mallory", at: T1 }];
  w.labelledBy = [
    { login: "alice", at: LABELLED_AT },
    { login: "alice", at: iso(T2) },
  ];

  const result = await pickup(w, config, deps, B1, iso(T2));
  assertEquals(result, { blocked: false });
  assertEquals(w.addedLabels, []);
  assertEquals((await readSnapshot(config, deps))?.contentRevisionAt, T2);
});

Deno.test("revision boundary #5018 (h) - a listed row without updatedAt is read live, bytes and revision together", async () => {
  const { deps } = createMemoryFs();
  const config = makeConfig();
  const w = newWorld();
  // The cached listing row is stale: older bytes and no usable `updatedAt`.
  // GitHub now holds the edited content, and the untrusted edit is recorded.
  w.body = B1;
  w.updatedAt = iso(T1);
  w.bodyEdits = [{ login: "mallory", at: T1 }];

  const outcome = await scan(w, config, deps, makeIssue(B0));
  assertEquals(outcome, { verdict: "proceed" });
  const snap = await readSnapshot(config, deps);
  assertEquals(snap?.contentRevisionAt, T1, "revision came from the live read");

  // The baseline must hold the live bytes: re-checking that same content is
  // unchanged. Stale bytes under the live revision would hash differently and
  // the edit at the revision would then be judged and block.
  const result = await pickup(w, config, deps, B1, iso(T1));
  assertEquals(result, { blocked: false });
  assertEquals(w.addedLabels, []);
});
