/**
 * Fresh-branch redo after an abandoned PR (Issue #3033).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  freshRedoBranchName,
  loadAbandonedBranches,
  restartMarkerBranches,
} from "../lib/conflict_redo_branch.ts";

/** A raw REST comment object, in the shape `fetchIssueCommentPages` returns. */
function comment(body: string, login: string): unknown {
  return { body, user: { login } };
}

const FLEET = "vibe-worker";

Deno.test("#3033 - a restart marker's branch attribute is parsed", () => {
  const branches = restartMarkerBranches([
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#34" branch="issue-12-foo" -->',
      FLEET,
    ),
  ]);
  assertEquals(branches, ["issue-12-foo"]);
});

Deno.test("#3033 - a marker with no branch attribute yields no branch", () => {
  const branches = restartMarkerBranches([
    comment('<!-- vibe-merge-conflict-restart pr="o/r#34" -->', FLEET),
  ]);
  assertEquals(branches, []);
});

Deno.test("#3033 - an unsafe branch attribute value is ignored", () => {
  const branches = restartMarkerBranches([
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#34" branch="../etc/passwd" -->',
      FLEET,
    ),
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#35" branch="$(rm -rf /)" -->',
      FLEET,
    ),
  ]);
  assertEquals(branches, []);
});

Deno.test("#3033 - a comment with no restart marker is ignored", () => {
  const branches = restartMarkerBranches([
    comment("just a normal comment, branch=\"issue-12-foo\"", FLEET),
  ]);
  assertEquals(branches, []);
});

Deno.test("#3033 - the same branch named twice is deduplicated, order kept", () => {
  const branches = restartMarkerBranches([
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#34" branch="issue-12-foo" -->',
      FLEET,
    ),
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#36" branch="issue-12-bar" -->',
      FLEET,
    ),
    comment(
      '<!-- vibe-merge-conflict-restart pr="o/r#38" branch="issue-12-foo" -->',
      FLEET,
    ),
  ]);
  assertEquals(branches, ["issue-12-foo", "issue-12-bar"]);
});

Deno.test("#3033 - freshRedoBranchName returns the derived name when it is not abandoned", () => {
  assertEquals(freshRedoBranchName("issue-12-foo", []), "issue-12-foo");
  assertEquals(
    freshRedoBranchName("issue-12-foo", ["issue-12-bar"]),
    "issue-12-foo",
  );
});

Deno.test("#3033 - freshRedoBranchName appends -redo-1 on collision", () => {
  assertEquals(
    freshRedoBranchName("issue-12-foo", ["issue-12-foo"]),
    "issue-12-foo-redo-1",
  );
});

Deno.test("#3033 - freshRedoBranchName steps to -redo-2 when -redo-1 is also abandoned", () => {
  assertEquals(
    freshRedoBranchName("issue-12-foo", [
      "issue-12-foo",
      "issue-12-foo-redo-1",
    ]),
    "issue-12-foo-redo-2",
  );
});

/** A fake `gh` answering one page of REST comments, then an empty page. */
function fakeGh(comments: unknown[]): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const url = args[args.length - 1] ?? "";
    const pageMatch = /[?&]page=(\d+)/.exec(url);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    return Promise.resolve(page === 1 ? JSON.stringify(comments) : "[]");
  };
}

Deno.test("#3033 - loadAbandonedBranches counts a trusted marker", async () => {
  const result = await loadAbandonedBranches(
    "o/r",
    12,
    fakeGh([
      comment(
        '<!-- vibe-merge-conflict-restart pr="o/r#34" branch="issue-12-foo" -->',
        FLEET,
      ),
    ]),
    [FLEET],
  );
  if (!result.ok) throw new Error("expected ok");
  assertEquals(result.value, ["issue-12-foo"]);
});

Deno.test("#3033 - loadAbandonedBranches ignores an outsider's marker", async () => {
  const result = await loadAbandonedBranches(
    "o/r",
    12,
    fakeGh([
      comment(
        '<!-- vibe-merge-conflict-restart pr="o/r#34" branch="issue-12-foo" -->',
        "an-outsider",
      ),
    ]),
    [FLEET],
  );
  if (!result.ok) throw new Error("expected ok");
  assertEquals(result.value, []);
});

Deno.test("#3033 - loadAbandonedBranches fails loud on a gh failure", async () => {
  const result = await loadAbandonedBranches(
    "o/r",
    12,
    () => Promise.reject(new Error("gh exited 1")),
    [FLEET],
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "gh exited 1");
  }
});
