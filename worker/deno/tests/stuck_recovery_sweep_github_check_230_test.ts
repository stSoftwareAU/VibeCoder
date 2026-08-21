/**
 * WHAT-tests for the GitHub pre-check in `recoverStuckIssue` (Issue #230).
 *
 * A leftover local heartbeat file proves this host once ran the issue, not
 * that GitHub still shows the claim. Observed live: after a crash the fleet
 * recovered both of host GRQ-23's issues within the hour and one closed with
 * its PR merged; when the host came back ten hours later the start-up sweep
 * posted "unassigned … no heartbeat" on both. With a same-account sibling
 * holding a fresh claim, the blind `--remove-assignee` would drop it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  detectAndRecoverStuckHeartbeats,
  recoverStuckIssue,
} from "../lib/stuck_recovery.ts";
import { heartbeatFilePath } from "../lib/heartbeat_storage.ts";
import {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
} from "../lib/recovery_telemetry.ts";

const NOW = 1_786_000_000;

type Responses = {
  view?: string;
  comments?: string;
};

function fakeGh(responses: Responses, calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(responses.view ?? "");
    }
    if (args[0] === "api" && String(args[1]).endsWith("/comments")) {
      return Promise.resolve(responses.comments ?? "[]");
    }
    return Promise.resolve("");
  };
}

function mutations(calls: string[][]): string[] {
  return calls
    .filter((c) => c[0] === "issue" && (c[1] === "edit" || c[1] === "comment"))
    .map((c) => c[1]!);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("recoverStuckIssue - a closed issue gets no unassign and no comment; the stale file is removed", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const hb = heartbeatFilePath(workDir, "org/repo", 219);
    await Deno.writeTextFile(hb, `${NOW - 36_000}`);
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      219,
      "worker-bot",
      7200,
      fakeGh({ view: '{"state":"CLOSED","assignees":[]}' }, calls),
      { machineId: "vibe-coder-1736-aaaa", nowFn: () => NOW },
    );
    assertEquals(result.ok, false);
    assertEquals(mutations(calls), []);
    assertEquals(await exists(hb), false);
    const decisions = __getRecoveryDecisions();
    assertEquals(decisions.length, 1);
    assertEquals(decisions[0]!.decision, "skipped:issue_closed");
    assertEquals(decisions[0]!.source, "detectAndRecoverStuckHeartbeats");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - an issue a teammate already recovered (no assignee) is left alone", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const hb = heartbeatFilePath(workDir, "org/repo", 4204);
    await Deno.writeTextFile(hb, `${NOW - 36_000}`);
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      4204,
      "worker-bot",
      7200,
      fakeGh({ view: '{"state":"OPEN","assignees":[]}' }, calls),
      { machineId: "vibe-coder-1736-aaaa", nowFn: () => NOW },
    );
    assertEquals(result.ok, false);
    assertEquals(mutations(calls), []);
    assertEquals(await exists(hb), false);
    assertEquals(
      __getRecoveryDecisions()[0]!.decision,
      "skipped:not_assigned",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - an issue re-claimed by another account is left alone", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      7,
      "worker-bot",
      7200,
      fakeGh(
        { view: '{"state":"OPEN","assignees":[{"login":"sibling-bot"}]}' },
        calls,
      ),
      { machineId: "vibe-coder-1736-aaaa", nowFn: () => NOW },
    );
    assertEquals(result.ok, false);
    assertEquals(mutations(calls), []);
    assertStringIncludes(
      result.ok ? "" : result.error.message,
      "assigned to sibling-bot",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - a same-account sibling host's fresh heartbeat keeps the claim", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const hb = heartbeatFilePath(workDir, "org/repo", 7);
    await Deno.writeTextFile(hb, `${NOW - 36_000}`);
    const calls: string[][] = [];
    const comments = JSON.stringify([
      {
        body: `<!-- VIBE_CODER_HEARTBEAT:vibe-coder-26143-bbbb:${
          NOW - 120
        } -->`,
        author: "worker-bot",
      },
    ]);
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      7,
      "worker-bot",
      7200,
      fakeGh(
        {
          view: '{"state":"OPEN","assignees":[{"login":"worker-bot"}]}',
          comments,
        },
        calls,
      ),
      {
        machineId: "vibe-coder-1736-aaaa",
        fleetAuthors: ["worker-bot"],
        nowFn: () => NOW,
      },
    );
    assertEquals(result.ok, false);
    assertEquals(mutations(calls), []);
    assertEquals(await exists(hb), false);
    assertEquals(
      __getRecoveryDecisions()[0]!.decision,
      "skipped:live_marker",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - still ours with only a stale heartbeat: recovers and names the dead run", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const lastBeat = NOW - 35_000;
    const comments = JSON.stringify([
      {
        body: `<!-- VIBE_CODER_HEARTBEAT:vibe-coder-39949-aaaa:${lastBeat} -->`,
        author: "worker-bot",
      },
    ]);
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      7,
      "worker-bot",
      7200,
      fakeGh(
        {
          view: '{"state":"OPEN","assignees":[{"login":"worker-bot"}]}',
          comments,
        },
        calls,
      ),
      {
        machineId: "vibe-coder-1736-aaaa",
        fleetAuthors: ["worker-bot"],
        nowFn: () => NOW,
      },
    );
    assertEquals(result.ok, true);
    assertEquals(mutations(calls), ["edit", "comment"]);
    const body = calls.find((c) => c[1] === "comment")!.at(-1)!;
    assertStringIncludes(body, "on machine `vibe-coder-1736-aaaa`");
    assertStringIncludes(
      body,
      `last heartbeat ${new Date(lastBeat * 1000).toISOString()}`,
    );
    assertEquals(__getRecoveryDecisions()[0]!.decision, "recovered");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recoverStuckIssue - when GitHub cannot be read the recovery proceeds as before", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const result = await recoverStuckIssue(
      workDir,
      "org/repo",
      7,
      "worker-bot",
      7200,
      fakeGh({ view: "not json" }, calls),
    );
    assertEquals(result.ok, true);
    assertEquals(mutations(calls), ["edit", "comment"]);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("detectAndRecoverStuckHeartbeats - the container sweep passes machine id and fleet authors through", async () => {
  __resetRecoveryDecisions();
  const workDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${workDir}/.heartbeat_org_repo_42`,
      `${NOW - 30}`,
    );
    const calls: string[][] = [];
    const comments = JSON.stringify([
      {
        body: `<!-- VIBE_CODER_HEARTBEAT:vibe-coder-other-cccc:${NOW - 60} -->`,
        author: "forger", // not a fleet author — must be ignored (Issue #3164)
      },
    ]);
    const recovered = await detectAndRecoverStuckHeartbeats(
      {
        workDir,
        stuckIssueTimeout: 7200,
        assignedNoHeartbeatTimeout: 1800,
        staleAssignmentTimeout: 14400,
        repos: ["org/repo"],
        machineId: "vibe-coder-1736-aaaa",
        fleetAuthors: ["worker-bot"],
      },
      "worker-bot",
      () => NOW,
      {
        sweepAllHeartbeats: true,
        ghCommandFn: fakeGh(
          {
            view: '{"state":"OPEN","assignees":[{"login":"worker-bot"}]}',
            comments,
          },
          calls,
        ),
      },
    );
    // Forged marker ignored → nothing live → recovered.
    assertEquals(recovered, 1);
    assertEquals(mutations(calls), ["edit", "comment"]);
    assertEquals(
      __getRecoveryDecisions()[0]!.markerState,
      "none",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
