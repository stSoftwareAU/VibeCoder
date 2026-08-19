/**
 * Regression test for Issue #3963 — a hash-encoding upgrade must not invalidate
 * the baselines already on disk.
 *
 * The #3878 encoding change shipped with no version stamp, so on the first scan
 * after deploy every pre-existing snapshot re-hashed differently, was judged
 * `changed`, and — with no recorded editor to attribute the phantom change to —
 * had its approval label stripped fleet-wide. The gate must instead verify
 * under the encoding the snapshot was *stored* under, and re-baseline when that
 * proves the content unchanged.
 *
 * The mock deliberately makes the editor lookup fail: the migration path must
 * hold on its own, without leaning on the #3964 "no edits recorded" fallback,
 * which needs a working GitHub round-trip.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import {
  CONTENT_HASH_ENCODING_V1,
  CONTENT_HASH_ENCODING_V2,
  type ContentApprovalDeps,
  loadContentApprovalState,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const TITLE = "Fix the bug";
const BODY = "Approved specification";
const SNAPSHOT_AT_UNIX = Math.floor(Date.parse("2026-05-01T09:00:00Z") / 1000);

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
    workDir: "/tmp/work-integrity-encoding-test",
  };
}

function makeIssue(): FilterableIssue {
  return {
    number: 42,
    title: TITLE,
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-05-01T00:00:00Z",
    author: "alice",
    milestone: "",
  };
}

/** The pre-#3878 digest, computed independently of the module under test. */
async function legacyV1Hash(title: string, body: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${title}\n${body}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Seed a snapshot exactly as a pre-migration worker left it on disk. */
async function seedV1Snapshot(
  config: WorkerConfig,
  files: Map<string, string>,
  stamped: boolean,
): Promise<void> {
  const stateDir = resolveContentApprovalStateDir(config.workDir);
  files.set(
    `${stateDir}/.content_approval_state.json`,
    JSON.stringify({
      snapshots: {
        "owner/repo|42": {
          contentHash: await legacyV1Hash(TITLE, BODY),
          capturedAt: SNAPSHOT_AT_UNIX,
          issueAuthor: "alice",
          ...(stamped ? { encoding: CONTENT_HASH_ENCODING_V1 } : {}),
        },
      },
    }),
  );
}

/** Serves unchanged content; every other gh call fails. */
function createGhMock(actions: string[]): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({ title: TITLE, body: BODY }));
    }
    actions.push(command);
    return Promise.reject(new Error("gh unavailable in this test"));
  };
}

async function readSnapshot(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
): Promise<{ capturedAt: number; encoding?: string } | undefined> {
  const state = await loadContentApprovalState(
    resolveContentApprovalStateDir(config.workDir),
    deps,
  );
  return state.snapshots["owner/repo|42"];
}

Deno.test(
  "work_on_content_integrity - a v1-stamped snapshot over unchanged content proceeds and is re-baselined under v2 (Issue #3963)",
  async () => {
    const { deps, files } = createMemoryFs();
    const config = makeConfig();
    await seedV1Snapshot(config, files, true);

    const actions: string[] = [];
    const verdict = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      config,
      createGhMock(actions),
      undefined,
      deps,
    );

    assertEquals(
      verdict,
      "proceed",
      "An encoding upgrade must not de-schedule an unedited issue",
    );
    assertEquals(
      actions,
      [],
      "No timeline lookup, label change or comment is warranted",
    );

    const snapshot = await readSnapshot(config, deps);
    assert(snapshot, "The baseline must survive the migration");
    assertEquals(snapshot.encoding, CONTENT_HASH_ENCODING_V2);
    assertEquals(
      snapshot.capturedAt > SNAPSHOT_AT_UNIX,
      true,
      "The baseline must be refreshed under the current encoding",
    );
  },
);

Deno.test(
  "work_on_content_integrity - an unstamped legacy snapshot over unchanged content proceeds (Issue #3963)",
  async () => {
    // The fleet's snapshots carried no tag at all when #3878 landed — this is
    // the exact state that produced the mass label strip.
    const { deps, files } = createMemoryFs();
    const config = makeConfig();
    await seedV1Snapshot(config, files, false);

    const actions: string[] = [];
    const verdict = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      config,
      createGhMock(actions),
      undefined,
      deps,
    );

    assertEquals(verdict, "proceed");
    assertEquals(actions, []);
    assertEquals(
      (await readSnapshot(config, deps))?.encoding,
      CONTENT_HASH_ENCODING_V2,
    );
  },
);
