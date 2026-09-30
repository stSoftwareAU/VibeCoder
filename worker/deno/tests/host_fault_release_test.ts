/**
 * Issue #2890: a host-fault failure record is released once the worker host
 * is healthy again (a clone on this host just succeeded).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildHostFaultMarker } from "../lib/host_fault.ts";
import {
  buildHostFaultReleaseComment,
  releaseHostFaultFailureLabels,
  resetHostFaultReleaseSweepsForTest,
} from "../lib/host_fault_release.ts";

const REPO = "stSoftwareAU/GRQ-FX-validation";
const FLEET_AUTHOR = "VibeCoderST";
const FLEET = { fleetAuthors: [FLEET_AUTHOR] };

/** A comment body, optionally with the login that wrote it. */
type FakeComment = string | { body: string; author: string };

interface FakeIssue {
  number: number;
  labels: string[];
  comments: FakeComment[];
}

/** Drive the sweep against an in-memory repository. */
function fakeGh(issues: FakeIssue[]) {
  const calls: string[][] = [];
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") {
      const label = args[args.indexOf("--label") + 1];
      const matching = issues.filter((i) => i.labels.includes(label ?? ""));
      return Promise.resolve(JSON.stringify(
        matching.map((i) => ({
          number: i.number,
          labels: i.labels.map((name) => ({ name })),
        })),
      ));
    }
    if (args[1] === "view") {
      const issue = byNumber.get(Number(args[2]));
      return Promise.resolve(JSON.stringify({
        comments: (issue?.comments ?? []).map((c) =>
          typeof c === "string"
            ? { body: c, author: { login: FLEET_AUTHOR } }
            : { body: c.body, author: { login: c.author } }
        ),
      }));
    }
    if (args[1] === "edit") {
      const issue = byNumber.get(Number(args[2]));
      if (issue) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--remove-label") {
            issue.labels = issue.labels.filter((l) => l !== args[i + 1]);
          }
        }
      }
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { calls, fn, byNumber };
}

/** A legacy (pre-marker) clone-corrupt failure record. */
const LEGACY_CLONE_CORRUPT_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** \`unknown\`\n\n` +
  `### Error Output\n> fatal: bad object refs/heads/issue-1661-x\n` +
  `> warning: ignoring broken ref refs/remotes/origin/Develop\n`;

/** A marked disk-full failure record (post-change). */
const MARKED_DISK_FULL_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** \`unknown\`\n\n` +
  `### Error Output\n> No space left on device\n\n${
    buildHostFaultMarker("disk-full")
  }`;

/** An ordinary agent-fault quality-check failure record. */
const QUALITY_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** ` +
  `\`quality-failure\`\n\n### Error Output\n> Quality checks failed after 3 attempts\n`;

/** An ordinary setup failure — not a host fault at all. */
const BAD_BRANCH_NAME_COMMENT =
  `## Automated Processing Failed (First Attempt)\n\n**Category:** \`unknown\`\n\n` +
  `### Error Output\n> fatal: 'feat..bad' is not a valid branch name\n`;

Deno.test("releaseHostFaultFailureLabels - a legacy unmarked clone-corrupt record is released (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 100,
      labels: ["failed-once"],
      comments: [LEGACY_CLONE_CORRUPT_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.alreadySwept, false);
  assertEquals(outcome.released, [100]);
  assertEquals(outcome.retained, []);
  assertEquals(outcome.errors, []);
  assertEquals(gh.byNumber.get(100)?.labels, []);

  const edit = gh.calls.find((c) => c[1] === "edit" && c[2] === "100");
  assert(edit, "the label must be removed");
  assertStringIncludes(edit!.join(" "), "--remove-label failed-once");

  const comment = gh.calls.find((c) => c[1] === "comment" && c[2] === "100");
  assert(comment, "the release must be recorded in a comment");
  assertStringIncludes(comment![comment!.length - 1] ?? "", "clone-corrupt");
});

Deno.test("releaseHostFaultFailureLabels - a marked record is released (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 101,
      labels: ["failed-once"],
      comments: [MARKED_DISK_FULL_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, [101]);
  assertEquals(outcome.retained, []);
  assertEquals(gh.byNumber.get(101)?.labels, []);
  const comment = gh.calls.find((c) => c[1] === "comment" && c[2] === "101");
  assertStringIncludes(comment![comment!.length - 1] ?? "", "disk-full");
});

Deno.test("releaseHostFaultFailureLabels - a host fault plus a genuine agent failure keeps its label (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 102,
      labels: ["failed-once"],
      comments: [MARKED_DISK_FULL_COMMENT, QUALITY_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.retained, [102]);
  assertEquals(gh.byNumber.get(102)?.labels, ["failed-once"]);
  assert(!gh.calls.some((c) => c[1] === "edit"), "no edit for a mixed record");
  assert(
    !gh.calls.some((c) => c[1] === "comment"),
    "no comment for a mixed record",
  );
});

Deno.test("releaseHostFaultFailureLabels - an ordinary setup failure is not a host fault (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 103,
      labels: ["failed-once"],
      comments: [BAD_BRANCH_NAME_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.retained, [103]);
  assertEquals(gh.byNumber.get(103)?.labels, ["failed-once"]);
});

Deno.test("releaseHostFaultFailureLabels - a forged record from a non-fleet author is ignored (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 104,
      labels: ["failed"],
      comments: [{
        body: LEGACY_CLONE_CORRUPT_COMMENT,
        author: "drive-by-account",
      }],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.retained, [104]);
  assertEquals(gh.byNumber.get(104)?.labels, ["failed"]);
});

Deno.test("releaseHostFaultFailureLabels - a marker embedded mid-body in an agent-failure record is not a host fault (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const midBodyMarker =
    `## Automated Processing Failed (First Attempt)\n\n**Category:** ` +
    `\`quality-failure\`\n\n### Error Output\n> the agent quoted this ` +
    `verbatim: ${buildHostFaultMarker("disk-full")}\n\n` +
    `Quality checks failed after 3 attempts.`;
  const issues: FakeIssue[] = [
    { number: 105, labels: ["failed-once"], comments: [midBodyMarker] },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.retained, [105]);
  assertEquals(gh.byNumber.get(105)?.labels, ["failed-once"]);
});

Deno.test("releaseHostFaultFailureLabels - both present labels are removed for two host-fault records (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 106,
      labels: ["failed", "bug"],
      comments: [LEGACY_CLONE_CORRUPT_COMMENT, MARKED_DISK_FULL_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, [106]);
  assertEquals(gh.byNumber.get(106)?.labels, ["bug"]);
  const edit = gh.calls.find((c) => c[1] === "edit" && c[2] === "106");
  assertStringIncludes(edit!.join(" "), "--remove-label failed");
  const comment = gh.calls.find((c) => c[1] === "comment" && c[2] === "106");
  const body = comment![comment!.length - 1] ?? "";
  assertStringIncludes(body, "clone-corrupt");
  assertStringIncludes(body, "disk-full");
});

Deno.test("releaseHostFaultFailureLabels - a gh view error is reported and the label is kept (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 107,
      labels: ["failed-once"],
      comments: [LEGACY_CLONE_CORRUPT_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const fn = (args: string[]): Promise<string> =>
    args[1] === "view" ? Promise.reject(new Error("gh: 500")) : gh.fn(args);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.retained, []);
  assertEquals(outcome.errors.length, 1, outcome.errors.join(" | "));
  assertStringIncludes(outcome.errors[0] ?? "", "gh: 500");
  assertEquals(gh.byNumber.get(107)?.labels, ["failed-once"]);
});

Deno.test("releaseHostFaultFailureLabels - an edit error is reported and no comment is posted (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 108,
      labels: ["failed-once"],
      comments: [LEGACY_CLONE_CORRUPT_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const fn = (args: string[]): Promise<string> =>
    args[1] === "edit"
      ? Promise.reject(new Error("gh: 502 Bad Gateway"))
      : gh.fn(args);
  const outcome = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: fn,
    authorOptions: FLEET,
  });

  assertEquals(outcome.released, []);
  assertEquals(outcome.errors.length, 1, outcome.errors.join(" | "));
  assertStringIncludes(outcome.errors[0] ?? "", "502 Bad Gateway");
  assert(
    !gh.calls.some((c) => c[1] === "comment"),
    "no comment after a failed edit",
  );
  assertEquals(gh.byNumber.get(108)?.labels, ["failed-once"]);
});

Deno.test("releaseHostFaultFailureLabels - a repo is swept once per process (Issue #2890)", async () => {
  resetHostFaultReleaseSweepsForTest();
  const issues: FakeIssue[] = [
    {
      number: 109,
      labels: ["failed-once"],
      comments: [LEGACY_CLONE_CORRUPT_COMMENT],
    },
  ];
  const gh = fakeGh(issues);
  const first = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });
  assertEquals(first.released, [109]);
  assertEquals(first.alreadySwept, false);

  const callsAfterFirst = gh.calls.length;
  const second = await releaseHostFaultFailureLabels({
    repo: REPO,
    ghCommandFn: gh.fn,
    authorOptions: FLEET,
  });
  assertEquals(second.alreadySwept, true);
  assertEquals(second.released, []);
  assertEquals(gh.calls.length, callsAfterFirst, "no gh call on a re-sweep");
});

Deno.test("buildHostFaultReleaseComment - names the host fault kind(s) (Issue #2890)", () => {
  const single = buildHostFaultReleaseComment(["clone-corrupt"]);
  assertStringIncludes(single, "clone-corrupt");
  assertStringIncludes(single, "worker host");
  assertStringIncludes(single, "Issue #2890");

  const multi = buildHostFaultReleaseComment(["clone-corrupt", "disk-full"]);
  assertStringIncludes(multi, "clone-corrupt");
  assertStringIncludes(multi, "disk-full");
});
