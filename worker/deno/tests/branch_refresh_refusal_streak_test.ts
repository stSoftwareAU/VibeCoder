/**
 * Unit tests for the branch-refresh refusal comment and its repair lane
 * (Issue #4831, Issue #4943): lib/branch_refresh_refusal_streak.ts and the
 * repair tracker in lib/repair_base_merge_4943.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type BranchRefreshRefusalEntry,
  notifyBranchRefreshRefusal,
} from "../lib/branch_refresh_refusal_streak.ts";
import {
  createRepairMergeabilityTracker,
  trackRepairMergeability,
} from "../lib/repair_base_merge_4943.ts";

const MARKER = '<!-- vibe-branch-refresh-refusal-v1 repo="org/repo" pr="7" -->';
const TRUSTED = "VibeCoderST";
const WAITING_ENTRY: BranchRefreshRefusalEntry = {
  reason: "mergeability-unknown",
  streak: 2,
  lastSeenAtMs: 1,
  notified: true,
};

/** Post into a PR with no marker comment yet, and return the body it posts. */
async function postedBody(
  event: { active: boolean; lane?: "refresh" | "repair" },
): Promise<string> {
  const bodies: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("/comments?")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "pr" && args[1] === "comment") {
      bodies.push(args[args.indexOf("--body") + 1]!);
      return Promise.resolve(
        "https://github.com/org/repo/pull/7#issuecomment-1",
      );
    }
    return Promise.reject(new Error(`unexpected gh args: ${args.join(" ")}`));
  };
  await notifyBranchRefreshRefusal(
    { repo: "org/repo", prNumber: 7, entry: WAITING_ENTRY, ...event },
    gh,
    (login) => login === TRUSTED,
  );
  assertEquals(bodies.length, 1, "one comment is posted");
  return bodies[0]!;
}

Deno.test("notifyBranchRefreshRefusal keeps the sweep's refresh wording for the default lane (Issue #4831)", async () => {
  const waiting =
    `${MARKER}\n### Branch refresh is still waiting\n\nThe strict-base branch refresh has been refused on 2 consecutive passes because GitHub has not finished calculating mergeability. The worker will keep retrying it.\n`;
  const recovered =
    `${MARKER}\n### Branch refresh recovered\n\nThe strict-base branch refresh is no longer refused for GitHub has not finished calculating mergeability; automatic recovery continues.\n`;
  assertEquals(await postedBody({ active: true }), waiting);
  assertEquals(await postedBody({ active: false }), recovered);
  assertEquals(await postedBody({ active: true, lane: "refresh" }), waiting);
  assertEquals(await postedBody({ active: false, lane: "refresh" }), recovered);
});

Deno.test("notifyBranchRefreshRefusal words a repair lane as a repair waiting on mergeability, not a refused refresh (Issue #4943)", async () => {
  const waiting = await postedBody({ active: true, lane: "repair" });
  assertEquals(
    waiting,
    `${MARKER}\n### Repair is waiting on mergeability\n\nA repair of this PR could not decide whether to merge its base on 2 consecutive passes because GitHub has not finished calculating mergeability. The worker will keep retrying.\n`,
  );
  assert(!waiting.includes("refused"), waiting);

  const recovered = await postedBody({ active: false, lane: "repair" });
  assertEquals(
    recovered,
    `${MARKER}\n### Repair mergeability recovered\n\nA repair of this PR is no longer waiting on mergeability; automatic recovery continues.\n`,
  );
  assert(!recovered.includes("strict-base"), recovered);
});

Deno.test("the repair tracker posts one repair-lane comment and edits it to recovered, through createRepairMergeabilityTracker (Issue #4943)", async () => {
  const dir = await Deno.makeTempDir();
  const comments: Array<{ id: number; body: string; author: string }> = [];
  const posted: string[] = [];
  const patched: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("/comments?")) {
      return Promise.resolve(JSON.stringify(comments));
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1]!;
      posted.push(body);
      comments.push({ id: 1, body, author: TRUSTED });
      return Promise.resolve(
        "https://github.com/org/repo/pull/7#issuecomment-1",
      );
    }
    if (args[0] === "api" && args[1] === "-X") {
      const body = args.find((arg) => arg.startsWith("body="))!.slice(5);
      patched.push(body);
      comments[0]!.body = body;
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh args: ${args.join(" ")}`));
  };
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  try {
    const tracker = createRepairMergeabilityTracker({
      workDir: dir,
      gh,
      fleetAuthors: [TRUSTED],
    })!;

    await trackRepairMergeability(tracker, "org/repo", 7, "UNKNOWN", log);
    await trackRepairMergeability(tracker, "org/repo", 7, "UNKNOWN", log);
    assertEquals(posted.length, 1, "the waiting comment is posted once");
    assert(
      posted[0]!.includes("### Repair is waiting on mergeability"),
      posted[0],
    );
    assert(!posted[0]!.includes("Branch refresh"), posted[0]);

    await trackRepairMergeability(tracker, "org/repo", 7, "MERGEABLE", log);
    assertEquals(patched.length, 1, "the same comment is edited, not reposted");
    assertEquals(posted.length, 1);
    assert(
      patched[0]!.includes("### Repair mergeability recovered"),
      patched[0],
    );
    assertEquals(comments.length, 1, "one comment per PR");
    assertEquals(
      lines.filter((line) => line.includes("could not")),
      [],
      "no notification failure is logged",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
