/**
 * Why NEAT-AI-Ockham#116 went quiet, pinned as tests (Issue #1108).
 *
 * On 4 Sep 2026 PR #116 was labelled `merge-conflict` at 23:00:34Z and then
 * nothing happened for over three hours. Three causes were in contention:
 * the launcher was down, the repository was gated out by
 * `claimable=0 reason=pr_blocked`, or the shared agent-backed lane never gave
 * the pass its slot. The retained GRQ-25 logs rule all three out — see
 * `docs/workflows/merge-conflicts.md`, "Why #116 went silent" — and the two
 * behaviours the verdict rests on are asserted here so neither can regress
 * unnoticed:
 *
 * 1. **Reachability.** A repository the idle-detect audit reports as
 *    `claimable=0 reason=pr_blocked` is still scanned, and still drained, by
 *    the conflict pass. That gate is per-issue and belongs to the Priority 2
 *    claim path; resolving a repo's conflicting PRs is how its PR block
 *    clears, so a repo whose PRs block it must never be gated out of the pass
 *    that unblocks them.
 * 2. **The seam that rejected #116.** `findConflictingPr` decides on the
 *    *live* `mergeable` state, never on the `merge-conflict` label. A PR that
 *    still carries the label after its conflict has cleared is not due, and
 *    the drain reports an empty queue rather than an attempt.
 *
 * The reachability tests use the production repo filter itself — the same
 * `isRepoAllowed(repos, repo)` the wiring passes in at
 * `run_core_production_deps.ts` — rather than an unconditional allow, so a
 * claimability gate added at that seam would turn them red.
 *
 * Australian English spelling throughout (behaviour, labelled).
 */

import { assert, assertEquals } from "@std/assert";
import { isRepoAllowed } from "../lib/config_validator.ts";
import {
  classifyIssues,
  pickDominantReason,
} from "../lib/idle_detect_diagnostics.ts";
import { drainConflictingPrs } from "../lib/merge_conflict_drain.ts";
import {
  findConflictingPr,
  MERGE_CONFLICT_LABEL,
} from "../lib/pr_merge_conflict_scan.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-Ockham";
const PR_NUMBER = 116;
const HEAD_REF = "issue-104-add-progressive-adaptive-screening";
const BASE_REF = "Develop";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/**
 * The window's real repository shape: issue #104 is open and unassigned, and
 * PR #116 — open against the default-branch stream — is what holds it back.
 */
function classifyOckham() {
  return classifyIssues(
    [{ number: 104, labels: ["work-on"], assignees: [], milestone: "" }],
    {
      workerUser: "stservice",
      repo: REPO,
      openPRs: [{
        number: PR_NUMBER,
        title: "Add progressive adaptive screening (Issue #104)",
        baseRefName: BASE_REF,
        headRefName: HEAD_REF,
        author: "stservice",
      }],
    },
  );
}

/** A `gh` stub answering exactly the calls `findConflictingPr` issues. */
function makeGh(mergeable: string, labels: string[]) {
  return (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "list") {
      // Only NEAT-AI-Ockham has an open PR; the other monitored repos are
      // quiet, so the scan has to reach this one to find anything.
      if (!args.includes(REPO)) return Promise.resolve("[]");
      return Promise.resolve(JSON.stringify([{
        number: PR_NUMBER,
        headRefName: HEAD_REF,
        baseRefName: BASE_REF,
      }]));
    }
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            p0: {
              number: PR_NUMBER,
              mergeable,
              headRef: { compare: { aheadBy: 1, behindBy: 2 } },
            },
          },
        },
      }));
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("labels")) {
      return Promise.resolve(labels.join("\n"));
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    // Fail loud rather than answering an unmodelled call with a silent empty
    // success — a scan that grows a new `gh` call must not stay green here.
    return Promise.reject(
      new Error(`unmodelled gh call: ${args.join(" ")}`),
    );
  };
}

/** The monitored-repo list the production wiring resolves `repos` from. */
const MONITORED = ["stSoftwareAU/VibeCoder", REPO, "stSoftwareAU/GRQ"];

function scanOckham(mergeable: string, labels: string[]) {
  return findConflictingPr({
    githubUser: "stservice",
    repos: MONITORED,
    logger: makeSilentLogger(),
    // Exactly what `run_core_production_deps.ts` passes: the monitored-repo
    // allowlist, and nothing about claimability.
    isRepoAllowed: (repo: string) => isRepoAllowed(MONITORED, repo),
    ghCommandFn: makeGh(mergeable, labels),
    nowMs: () => Date.parse("2026-09-05T00:08:36Z"),
  });
}

// ---------------------------------------------------------------------------
// 1. Reachability — `pr_blocked` must not suppress priority 1.61
// ---------------------------------------------------------------------------

Deno.test(
  "conflict scan - a repo the audit reports as pr_blocked is still scanned",
  async () => {
    // The audit's verdict for the repo, from the audit's own classifier.
    const verdicts = classifyOckham();
    assertEquals(verdicts[0]?.claimable, false);
    assertEquals(verdicts[0]?.excludedBy, "pr_blocked");
    assertEquals(pickDominantReason(verdicts), "pr_blocked");

    // The conflict scan over that same repo, in that same state. It takes no
    // claimability input at all, so the audit's verdict cannot reach it.
    const scan = await scanOckham("CONFLICTING", []);

    assert(scan.ok, "the scan must not fail for a pr_blocked repository");
    assertEquals(
      scan.value.selected?.prNumber,
      PR_NUMBER,
      "a pr_blocked repo's conflicting PR must still be selected — resolving " +
        "it is how the PR block clears",
    );
  },
);

Deno.test(
  "conflict drain - a pr_blocked repo's conflicting PR is taken, not skipped",
  async () => {
    assertEquals(pickDominantReason(classifyOckham()), "pr_blocked");

    const resolved: number[] = [];
    const drain = await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: async (exclude) => {
        const scan = await scanOckham("CONFLICTING", []);
        if (!scan.ok || scan.value.selected === null) return null;
        return exclude.has(`${REPO}#${scan.value.selected.prNumber}`)
          ? null
          : scan.value.selected;
      },
      acquireLease: () => ({ release: () => {} }),
      resolve: (pr) => {
        resolved.push(pr.prNumber);
        return Promise.resolve({ processed: true, merged: true });
      },
    });

    assertEquals(resolved, [PR_NUMBER]);
    assertEquals(drain.taken, 1);
    assertEquals(drain.merged, 1);
    assertEquals(drain.deferred, 0);
    assertEquals(drain.processed, true);
  },
);

// ---------------------------------------------------------------------------
// 2. The seam that rejected #116 — the live state decides, not the label
// ---------------------------------------------------------------------------

Deno.test(
  "conflict scan - a stale merge-conflict label does not make a PR due",
  async () => {
    // #116's state from 23:00:34Z onwards: labelled, but the live mergeable
    // state had gone back to "behind its base", not CONFLICTING.
    const scan = await scanOckham("BEHIND", [MERGE_CONFLICT_LABEL]);

    assert(scan.ok);
    assertEquals(
      scan.value.selected,
      null,
      "the label is queue visibility, not the queue — only the live " +
        "mergeable state makes a PR due",
    );
  },
);

Deno.test(
  "conflict drain - a queue of stale-labelled PRs stops as queue-empty",
  async () => {
    const drain = await drainConflictingPrs({
      logger: makeSilentLogger(),
      findNext: async () => {
        const scan = await scanOckham("BEHIND", [MERGE_CONFLICT_LABEL]);
        return scan.ok ? scan.value.selected : null;
      },
      acquireLease: () => ({ release: () => {} }),
      resolve: () => {
        throw new Error("no PR was due — resolve must not run");
      },
    });

    // The 00:08:36Z cycle in full: the pass ran, took nothing, and had
    // nothing to say. That silence is a correct empty queue, not a stall.
    assertEquals(drain.taken, 0);
    assertEquals(drain.merged, 0);
    assertEquals(drain.deferred, 0);
    assertEquals(drain.processed, false);
    assertEquals(drain.stopReason, "queue-empty");
  },
);
