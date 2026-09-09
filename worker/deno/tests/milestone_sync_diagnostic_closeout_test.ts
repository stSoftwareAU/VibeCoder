/**
 * A branch that syncs closes the diagnostics filed for it (Issue #1769).
 *
 * The old escalation path filed a `needs-human` issue per stuck branch and
 * per conflicting commit, and nothing ever retired them: the branch could sync
 * cleanly an hour later and the issue would still be asking for help. A
 * successful sync is the proof the reported condition is over, so it is what
 * closes the report — but only when the fleet wrote it. A same-titled issue
 * somebody else opened is their work, not ours.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  closeResolvedSyncDiagnostics,
  stuckSyncDiagnosticTitle,
} from "../lib/milestone_sync_diagnostic_closeout.ts";
import { conflictDiagnosticTitle } from "../lib/milestone_sync_conflict.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/fix-scan-issues-20260906";
const FLEET = "vibe-coder";
const SYNC_SHA = "a".repeat(40);

interface Row {
  number: number;
  title: string;
  author: { login: string };
  body: string;
}

/** A `gh` stub answering the two title searches and the branch-tip read. */
function ghStub(rows: Row[], options: { closeFails?: boolean } = {}): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: string[]): Promise<string> => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key.startsWith("issue list")) {
        const search = args[args.indexOf("--search") + 1] ?? "";
        const needle = search.replace(/"/g, "").replace(" in:title", "");
        return Promise.resolve(
          JSON.stringify(rows.filter((r) => r.title.startsWith(needle))),
        );
      }
      if (key.includes("/commits/")) {
        return Promise.resolve(`${SYNC_SHA} Merge main into ${BRANCH}`);
      }
      if (key.startsWith("issue close") && options.closeFails) {
        return Promise.reject(new Error("422 already closed"));
      }
      return Promise.resolve("");
    },
  };
}

const closeCalls = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === "issue" && c[1] === "close");

Deno.test("closeResolvedSyncDiagnostics - a fleet-authored stuck diagnostic is closed, naming the sync commit", async () => {
  const { gh, calls } = ghStub([{
    number: 1754,
    title: stuckSyncDiagnosticTitle(BRANCH),
    author: { login: FLEET },
    body: "",
  }]);

  const closed = await closeResolvedSyncDiagnostics({
    repo: REPO,
    milestoneBranch: BRANCH,
    ghCommandFn: gh,
    log: () => {},
    dedupAuthors: { fleetAuthors: [FLEET] },
  });

  assertEquals(closed, [1754]);
  const call = closeCalls(calls)[0]!;
  assertEquals(call[2], "1754");
  const comment = call[call.indexOf("--comment") + 1] ?? "";
  assertStringIncludes(comment, BRANCH);
  assertStringIncludes(comment, SYNC_SHA);
});

Deno.test("closeResolvedSyncDiagnostics - a conflict diagnostic is matched despite its per-commit title", async () => {
  const title = conflictDiagnosticTitle(BRANCH, "b".repeat(40));
  const { gh, calls } = ghStub([{
    number: 1764,
    title,
    author: { login: FLEET },
    body: "",
  }]);

  const closed = await closeResolvedSyncDiagnostics({
    repo: REPO,
    milestoneBranch: BRANCH,
    ghCommandFn: gh,
    log: () => {},
    dedupAuthors: { fleetAuthors: [FLEET] },
  });

  assertEquals(closed, [1764], `title searched: ${title}`);
  assertEquals(closeCalls(calls).length, 1);
});

Deno.test("closeResolvedSyncDiagnostics - a same-titled issue by a stranger is left alone", async () => {
  const { gh, calls } = ghStub([{
    number: 4242,
    title: stuckSyncDiagnosticTitle(BRANCH),
    author: { login: "passer-by" },
    body: "",
  }]);

  const closed = await closeResolvedSyncDiagnostics({
    repo: REPO,
    milestoneBranch: BRANCH,
    ghCommandFn: gh,
    log: () => {},
    dedupAuthors: { fleetAuthors: [FLEET] },
  });

  assertEquals(closed, []);
  assertEquals(
    closeCalls(calls).length,
    0,
    "a title is not evidence the fleet filed it",
  );
});

Deno.test("closeResolvedSyncDiagnostics - a diagnostic for another branch is not closed", async () => {
  const { gh, calls } = ghStub([{
    number: 999,
    title: stuckSyncDiagnosticTitle("milestone/some-other-branch"),
    author: { login: FLEET },
    body: "",
  }]);

  assertEquals(
    await closeResolvedSyncDiagnostics({
      repo: REPO,
      milestoneBranch: BRANCH,
      ghCommandFn: gh,
      log: () => {},
      dedupAuthors: { fleetAuthors: [FLEET] },
    }),
    [],
  );
  assertEquals(closeCalls(calls).length, 0);
});

Deno.test("closeResolvedSyncDiagnostics - nothing to close costs no commit lookup", async () => {
  const { gh, calls } = ghStub([]);

  assertEquals(
    await closeResolvedSyncDiagnostics({
      repo: REPO,
      milestoneBranch: BRANCH,
      ghCommandFn: gh,
      log: () => {},
      dedupAuthors: { fleetAuthors: [FLEET] },
    }),
    [],
  );
  assertEquals(
    calls.filter((c) => c.join(" ").includes("/commits/")).length,
    0,
    "the sync commit is only read when there is something to say it on",
  );
});

Deno.test("closeResolvedSyncDiagnostics - a close that fails is reported, not swallowed", async () => {
  const logs: string[] = [];
  const { gh } = ghStub([{
    number: 1756,
    title: stuckSyncDiagnosticTitle(BRANCH),
    author: { login: FLEET },
    body: "",
  }], { closeFails: true });

  const closed = await closeResolvedSyncDiagnostics({
    repo: REPO,
    milestoneBranch: BRANCH,
    ghCommandFn: gh,
    log: (m) => logs.push(m),
    dedupAuthors: { fleetAuthors: [FLEET] },
  });

  assertEquals(closed, [], "a failed close is not counted as done");
  assert(
    logs.some((l) => l.includes("422 already closed")),
    `the failure is said out loud; logs: ${JSON.stringify(logs)}`,
  );
});
