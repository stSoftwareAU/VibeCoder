/**
 * The preserved-branch line the claim-release comment carries (Issue #770).
 *
 * Two properties are load-bearing and neither is obvious from reading the
 * happy path:
 *
 *  - the handover path must be one the worker's own commit chokepoint will
 *    actually stage. The sketch in #769 used `.vibe/handover/…`, and `.vibe`
 *    is hidden: the enforced `.gitignore` (`.*`) never stages it and
 *    `classifyStagedPath` calls it a violation, so a handover written there
 *    could never reach the branch — and force-adding it would fail the
 *    pre-commit gate and take the WIP commit down with it;
 *  - the line must never be truncated mid-link. Half a URL is a broken link,
 *    which is exactly the dead-ref failure this issue exists to remove.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeHandoverFile,
  describePreservedBranch,
  handoverFilePath,
  handoverFileUrl,
} from "../lib/preserved_wip_branch.ts";
import { classifyStagedPath } from "../lib/pre_commit_safety.ts";
import {
  OUTCOME_WIP_MAX_LENGTH,
  renderHeartbeatBody,
  renderRunOutcomeClause,
} from "../lib/heartbeat_storage.ts";
import { isHeartbeatOnlyBody } from "../lib/heartbeat_sweep.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";

Deno.test("preserved wip #770 - the handover path is one the commit gate will stage", () => {
  for (const issueNumber of [1, 770, 12345]) {
    const path = handoverFilePath(issueNumber);
    assertEquals(
      classifyStagedPath(path),
      "safe",
      `${path} must be committable — a handover the worker cannot commit is ` +
        `a link to a file that never exists`,
    );
    assert(
      !path.split("/").some((segment) => segment.startsWith(".")),
      `${path} must not contain a hidden segment (the enforced .gitignore ` +
        `drops those)`,
    );
    // A handover carries free agent prose, so it must live where the docs
    // gates cannot read it: the markdownlint globs exclude `docs/archive`.
    assertStringIncludes(path, "docs/archive/");
  }
});

Deno.test("preserved wip #770 - the handover clause degrades to nothing when no file was written", () => {
  assertEquals(describeHandoverFile({ branch: "issue-770-x" }), "");
  const line = describePreservedBranch({ branch: "issue-770-x" });
  assertStringIncludes(line, "branch `issue-770-x` holds the work in progress");
  assertStringIncludes(line, "the next claim resumes from it");
  assert(!line.includes("Handover"), line);
});

Deno.test("preserved wip #770 - a committed handover file is linked, path and URL both", () => {
  const path = handoverFilePath(770);
  const line = describePreservedBranch({
    branch: "issue-770-x",
    handoverPath: path,
    handoverUrl: handoverFileUrl("stSoftwareAU/VibeCoder", "issue-770-x", path),
  });
  assertStringIncludes(
    line,
    `Handover: [${path}](https://github.com/stSoftwareAU/VibeCoder/blob/issue-770-x/${path})`,
  );
});

/** The rendered `**Work in progress:**` line for a preserved branch. */
function renderWipLine(branch: string, repo: string): string {
  const path = handoverFilePath(12345);
  const outcome: RunOutcome = {
    kind: "no_pr",
    category: "scheduled_release",
    phase: "execute",
    elapsedSeconds: 10_800,
    message: "Released on schedule: the cycle ended",
    preservedWip: {
      branch,
      handoverPath: path,
      handoverUrl: handoverFileUrl(repo, branch, path),
    },
  };
  const clause = renderRunOutcomeClause(outcome);
  const line = clause.split("\n").find((l) =>
    l.startsWith("**Work in progress:**")
  );
  assert(line, `the preserved-branch line must be rendered: ${clause}`);
  assert(
    line.length <= OUTCOME_WIP_MAX_LENGTH + "**Work in progress:** ".length,
    `line ${line.length} exceeds the bound`,
  );
  // The branch — the part a reader cannot do without — survives whole.
  assertStringIncludes(line, branch);
  return line;
}

Deno.test("preserved wip #770 - a long-but-fitting line keeps the whole link", () => {
  const branch = `issue-12345-${"a-very-long-slug".repeat(3)}`;
  const repo = "some-longer-organisation/an-even-longer-repository-name-here";
  const line = renderWipLine(branch, repo);
  assertStringIncludes(
    line,
    `(${handoverFileUrl(repo, branch, handoverFilePath(12345))})`,
  );
});

Deno.test("preserved wip #770 - an over-long line drops the handover clause rather than cutting the URL", () => {
  // A branch long enough that branch + link cannot fit: the link goes, the
  // branch stays. Half a URL would be the broken link this issue forbids.
  const branch = `issue-12345-${"a-very-long-slug-".repeat(12)}end`;
  const line = renderWipLine(branch, "stSoftwareAU/VibeCoder");
  assert(
    !line.includes("Handover:") && !line.includes("https://"),
    `the link must be dropped whole, not truncated: ${line}`,
  );
});

Deno.test("preserved wip #770 - a released comment naming the branch is still marker-only for the sweep", () => {
  const outcome: RunOutcome = {
    kind: "no_pr",
    category: "timeout",
    phase: "execute",
    elapsedSeconds: 3492,
    message: "Claude timed out with uncommitted changes (6 files)",
    preservedWip: { branch: "issue-770-x" },
  };
  const body = renderHeartbeatBody({
    machineId: "vibe-coder-27384-0f8e2a1b-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    host: "vibe-coder-27384",
    epoch: 0,
    released: true,
    outcome,
  }, () => 1_700_000_000);
  assertStringIncludes(body, "**Work in progress:**");
  assertEquals(
    isHeartbeatOnlyBody(body),
    true,
    "the preserved-branch line is the heartbeat layer's own text, so it must " +
      "not make the comment look like human prose to the sweep",
  );
});
