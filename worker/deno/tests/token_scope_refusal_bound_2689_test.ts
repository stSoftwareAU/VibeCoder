/**
 * A workflow-scope refusal is remembered by the host that was refused, and
 * the fleet stops retrying once no host has pushed it (Issue #2689, the
 * owner's review of PR #2696).
 *
 * Making `token-scope` transient removed the ladder cap that used to end the
 * loop. Without these two bounds the refusing host re-claimed the issue every
 * 600 s and repeated a ~7-minute agent run, and with no capable host online
 * the issue cycled for ever:
 *
 * - **Per-host memory.** The refusal is written to the persisted cooldown
 *   state in the install's work directory, keyed on the install uuid — never
 *   the per-launch container hostname — with the scope verdict it was
 *   refused under. The claim scan skips it while that verdict stands, on
 *   both the `work-on` route and the custom-label route.
 * - **Fleet-wide bound.** Consecutive `token-scope` releases are counted
 *   from the attempt tally on the issue's own release comment. At the bound
 *   the fleet posts one comment naming the scope and the fix, and every host
 *   whose token is not known to have the scope stops claiming it. A host
 *   whose token has it still claims it.
 *
 * Fixtures use the `vibe-coder-<n>-<uuid>` host shape on purpose: a stable
 * name like `GRQ-23` hides the per-launch hostname trap.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isIssueInCooldown,
  isWorkflowScopeRefused,
  loadState,
  recordIssueCooldown,
  recordWorkflowScopeRefusal,
  WORKFLOW_SCOPE_REFUSAL_RETENTION_SECONDS,
} from "../lib/cooldown_state.ts";
import {
  countConsecutiveTokenScopeReleases,
  enforceTokenScopeFleetBound,
  isParkedForMissingWorkflowScope,
  TOKEN_SCOPE_FLEET_BOUND,
  TOKEN_SCOPE_PARKED_MARKER,
} from "../lib/token_scope_fleet_bound.ts";
import {
  appendAttempt,
  describeAttemptOutcome,
  type ReleaseAttemptTally,
  renderHeartbeatBody,
} from "../lib/heartbeat_storage.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";
import { WORKFLOW_SCOPE_REMEDIATION } from "../lib/workflow_scope.ts";
import {
  buildNewWorkGateContext,
  filterNewWorkEligible,
} from "../lib/new_work_eligibility.ts";
import { collectWorkOnCandidates } from "../lib/collect_work_on_candidates.ts";
import { createIssueFetcher } from "../lib/issue_finder_common.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "stSoftwareAU/GRQ";
const ISSUE = 4939;
const INSTALL = "27d69915-f749-4e3b-9eeb-fda5310a8543";
const OTHER_INSTALL = "5b1f0c2e-3a44-4d6b-9c1e-0f2a7d9e8b10";
const FLEET = ["VibeCoderST", "stservice"];

function cooldownConfig() {
  return {
    workDir: Deno.makeTempDirSync({ prefix: "token-scope-2689-" }),
    issueRetryCooldown: 600,
  };
}

// ---------------------------------------------------------------------------
// Per-host memory
// ---------------------------------------------------------------------------

Deno.test("recordWorkflowScopeRefusal - the refusing install remembers the issue past its 600 s cooldown (Issue #2689)", async () => {
  const config = cooldownConfig();
  // The base cooldown the transient release records, already expired.
  await Deno.writeTextFile(
    `${config.workDir}/.cooldown_state.json`,
    JSON.stringify({
      entries: [{
        repo: REPO,
        issueNumber: ISSUE,
        timestamp: Math.floor(Date.now() / 1000) - 700,
      }],
    }),
  );
  const recorded = await recordWorkflowScopeRefusal(config, {
    repo: REPO,
    issueNumber: ISSUE,
    installUuid: INSTALL,
    verdict: "absent",
  });
  assert(recorded.ok);

  assertEquals(await isIssueInCooldown(config, REPO, ISSUE), false);
  // Reloaded from disk — what the next hourly launch sees.
  const state = await loadState(config.workDir, config.issueRetryCooldown);
  assert(isWorkflowScopeRefused(state, {
    repo: REPO,
    issueNumber: ISSUE,
    installUuid: INSTALL,
    verdict: "absent",
  }));
});

Deno.test("recordWorkflowScopeRefusal - keyed on the install uuid and the verdict, so a capable host still claims (Issue #2689)", async () => {
  const config = cooldownConfig();
  await recordWorkflowScopeRefusal(config, {
    repo: REPO,
    issueNumber: ISSUE,
    installUuid: INSTALL,
    verdict: "absent",
  });
  const state = await loadState(config.workDir, config.issueRetryCooldown);
  const query = { repo: REPO, issueNumber: ISSUE };
  // Another install (a host whose token may have the scope).
  assertEquals(
    isWorkflowScopeRefused(state, {
      ...query,
      installUuid: OTHER_INSTALL,
      verdict: "absent",
    }),
    false,
  );
  // The same install after the operator granted the scope.
  assertEquals(
    isWorkflowScopeRefused(state, {
      ...query,
      installUuid: INSTALL,
      verdict: "granted",
    }),
    false,
  );
  // Another issue.
  assertEquals(
    isWorkflowScopeRefused(state, {
      repo: REPO,
      issueNumber: ISSUE + 1,
      installUuid: INSTALL,
      verdict: "absent",
    }),
    false,
  );
});

Deno.test("recordWorkflowScopeRefusal - an ordinary cooldown write keeps the refusal, and it expires after its retention (Issue #2689)", async () => {
  const config = cooldownConfig();
  await recordWorkflowScopeRefusal(config, {
    repo: REPO,
    issueNumber: ISSUE,
    installUuid: INSTALL,
    verdict: "absent",
  });
  await recordIssueCooldown(config, REPO, 12);
  const kept = await loadState(config.workDir, config.issueRetryCooldown);
  const query = {
    repo: REPO,
    issueNumber: ISSUE,
    installUuid: INSTALL,
    verdict: "absent" as const,
  };
  assert(isWorkflowScopeRefused(kept, query));

  kept.workflowScopeRefusals = kept.workflowScopeRefusals!.map((r) => ({
    ...r,
    timestamp: r.timestamp - WORKFLOW_SCOPE_REFUSAL_RETENTION_SECONDS - 1,
  }));
  await Deno.writeTextFile(
    `${config.workDir}/.cooldown_state.json`,
    JSON.stringify(kept),
  );
  const expired = await loadState(config.workDir, config.issueRetryCooldown);
  assertEquals(isWorkflowScopeRefused(expired, query), false);
});

// ---------------------------------------------------------------------------
// Claim scan: the refusing host never re-claims; a capable host still does
// ---------------------------------------------------------------------------

const LABEL = "deploy-review";

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [REPO],
    allowedAuthors: ["alice"],
    fleetPrAuthors: ["bot"],
    workOnLabel: "work-on",
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "token-scope-2689-work-" }),
  };
}

/** GRQ#4939's shape: nothing in the title or body names a workflow. */
function makeIssue(number: number, labels: string[]): FilterableIssue {
  return {
    number,
    title: "Tighten the quality gate",
    url: `https://github.com/${REPO}/issues/${number}`,
    assignees: [],
    labels,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    author: "alice",
    milestone: "",
    body: "Run the stricter checks on every push.",
  };
}

function ghFixture(
  labelled: { number: number; label: string }[],
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "api" && args[1] === "graphql") {
      return Promise.reject(new Error("GraphQL unavailable in this fake"));
    }
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(labelled.map((i) => ({
        number: i.number,
        title: "Tighten the quality gate",
        url: `https://github.com/${REPO}/issues/${i.number}`,
        assignees: [],
        labels: [{ name: i.label }],
        createdAt: "2024-03-01T00:00:00Z",
        author: { login: "alice" },
        milestone: null,
      }))));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({ title: "", body: "" }));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(
        [...new Set(labelled.map((i) => i.label))].map((name) => ({
          event: "labeled",
          label: { name },
          actor: { login: "alice" },
          created_at: "2024-03-01T00:00:00Z",
        })),
      ));
    }
    return Promise.resolve("[]");
  };
}

function cache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "token-scope-2689-cache-" }),
    600,
  );
}

const refusedHere = (repo: string, n: number) => repo === REPO && n === ISSUE;

Deno.test("filterNewWorkEligible - the refusing host skips an issue it was refused, though nothing names a workflow (Issue #2689)", async () => {
  const gh = ghFixture([]);
  const ctx = await buildNewWorkGateContext(REPO, makeConfig(), {
    githubUser: "bot",
    ghCommandFn: gh,
    cache: cache(),
    hasWorkflowScope: false,
    isWorkflowScopeRefused: refusedHere,
  }, gh);
  const verdict = await filterNewWorkEligible(
    [makeIssue(ISSUE, [LABEL]), makeIssue(ISSUE + 1, [LABEL])],
    LABEL,
    ctx,
  );
  assertEquals(verdict.eligible.map((i) => i.number), [ISSUE + 1]);
  assertEquals(
    verdict.blocked.filter((b) => b.reason === "workflow-scope-missing")
      .map((b) => b.issueNumber),
    [ISSUE],
  );
});

Deno.test("filterNewWorkEligible - a host with no refusal on record still claims it (Issue #2689)", async () => {
  const gh = ghFixture([]);
  const ctx = await buildNewWorkGateContext(REPO, makeConfig(), {
    githubUser: "bot",
    ghCommandFn: gh,
    cache: cache(),
    hasWorkflowScope: true,
    isWorkflowScopeRefused: () => false,
  }, gh);
  const verdict = await filterNewWorkEligible(
    [makeIssue(ISSUE, [LABEL])],
    LABEL,
    ctx,
  );
  assertEquals(verdict.eligible.map((i) => i.number), [ISSUE]);
});

Deno.test("collectWorkOnCandidates - the refusing host skips a work-on issue it was refused; a capable host claims it (Issue #2689)", async () => {
  const gh = ghFixture([
    { number: ISSUE, label: "work-on" },
    { number: ISSUE + 1, label: "work-on" },
  ]);
  const all = [
    makeIssue(ISSUE, ["work-on"]),
    makeIssue(ISSUE + 1, ["work-on"]),
  ];

  const refusing = await collectWorkOnCandidates(
    REPO,
    makeConfig(),
    {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: cache(),
      isWorkflowScopeRefused: refusedHere,
    },
    [],
    all,
    createIssueFetcher(gh),
    [],
  );
  assertEquals(refusing.candidates.map((c) => c.number), [ISSUE + 1]);
  assertEquals(
    refusing.blockedDetails.filter((b) => b.reason === "workflow-scope-missing")
      .map((b) => b.issueNumber),
    [ISSUE],
  );

  const capable = await collectWorkOnCandidates(
    REPO,
    makeConfig(),
    {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: cache(),
      isWorkflowScopeRefused: () => false,
    },
    [],
    all,
    createIssueFetcher(gh),
    [],
  );
  assertEquals(
    capable.candidates.map((c) => c.number).sort(),
    [ISSUE, ISSUE + 1],
  );
});

// ---------------------------------------------------------------------------
// Fleet-wide bound, counted from the release comment's attempt tally
// ---------------------------------------------------------------------------

const TOKEN_SCOPE: RunOutcome = {
  kind: "no_pr",
  category: "token_scope",
  phase: "completion",
  elapsedSeconds: 7 * 60,
  message: "Cannot push: the token lacks the 'workflow' scope",
};
const RAISED: RunOutcome = {
  kind: "pr",
  prNumber: 4950,
  prUrl: `https://github.com/${REPO}/pull/4950`,
};

/** The canonical release comment, rendered by the heartbeat layer itself. */
function releaseBody(outcomes: RunOutcome[]): string {
  let tally: ReleaseAttemptTally | null = null;
  outcomes.forEach((o, i) => {
    tally = appendAttempt(tally, {
      epoch: 3600 * (i + 1),
      host: `vibe-coder-${31555 + i}`,
      text: describeAttemptOutcome(o),
    });
  });
  return renderHeartbeatBody({
    machineId: `vibe-coder-31555-${INSTALL}`,
    epoch: 0,
    released: true,
    outcome: outcomes.at(-1)!,
    attempts: tally!,
  }, () => 3600 * outcomes.length);
}

Deno.test("countConsecutiveTokenScopeReleases - counts the trailing token-scope releases on the tally (Issue #2689)", () => {
  assertEquals(countConsecutiveTokenScopeReleases([]), 0);
  assertEquals(
    countConsecutiveTokenScopeReleases([releaseBody([TOKEN_SCOPE])]),
    1,
  );
  assertEquals(
    countConsecutiveTokenScopeReleases([
      releaseBody([TOKEN_SCOPE, TOKEN_SCOPE, TOKEN_SCOPE]),
    ]),
    3,
  );
  // A delivered PR in between resets the run of refusals.
  assertEquals(
    countConsecutiveTokenScopeReleases([
      releaseBody([TOKEN_SCOPE, RAISED, TOKEN_SCOPE]),
    ]),
    1,
  );
});

/** A fake issue: its comments, and every comment the bound posts. */
function fakeIssue(bodies: { author: string; body: string }[]) {
  const posted: string[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        title: "Tighten the quality gate",
        body: "",
        labels: [],
        state: "OPEN",
        comments: [
          ...bodies.map((c) => ({ author: { login: c.author }, body: c.body })),
          ...posted.map((body) => ({ author: { login: "stservice" }, body })),
        ],
      }));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      posted.push(args[args.indexOf("--body") + 1]!);
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { posted, ghFn };
}

Deno.test("enforceTokenScopeFleetBound - one transient refusal does not park the issue (Issue #2689)", async () => {
  const issue = fakeIssue([
    { author: "stservice", body: releaseBody([TOKEN_SCOPE]) },
  ]);
  const result = await enforceTokenScopeFleetBound(
    { repo: REPO, issueNumber: ISSUE, fleetAuthors: FLEET },
    { ghFn: issue.ghFn },
  );
  assertEquals(result.parked, false);
  assertEquals(result.posted, false);
  assertEquals(issue.posted, []);
});

Deno.test("enforceTokenScopeFleetBound - the bound ends the loop with one comment naming the scope and the fix (Issue #2689)", async () => {
  const refusals = Array(TOKEN_SCOPE_FLEET_BOUND).fill(TOKEN_SCOPE);
  const issue = fakeIssue([
    { author: "stservice", body: releaseBody(refusals) },
  ]);
  const first = await enforceTokenScopeFleetBound(
    { repo: REPO, issueNumber: ISSUE, fleetAuthors: FLEET },
    { ghFn: issue.ghFn },
  );
  assertEquals(first.consecutive, TOKEN_SCOPE_FLEET_BOUND);
  assertEquals(first.parked, true);
  assertEquals(first.posted, true);
  assertEquals(issue.posted.length, 1);
  assertStringIncludes(issue.posted[0]!, TOKEN_SCOPE_PARKED_MARKER);
  assertStringIncludes(issue.posted[0]!, "`workflow`");
  assertStringIncludes(issue.posted[0]!, WORKFLOW_SCOPE_REMEDIATION);
  // No hand-off to a human: nothing here names or applies a label.
  assertEquals(/needs-human|failed-once/.test(issue.posted[0]!), false);

  // A later refusal (a host that was already mid-run) posts nothing more.
  const again = await enforceTokenScopeFleetBound(
    { repo: REPO, issueNumber: ISSUE, fleetAuthors: FLEET },
    { ghFn: issue.ghFn },
  );
  assertEquals(again.parked, true);
  assertEquals(again.posted, false);
  assertEquals(issue.posted.length, 1);
});

Deno.test("isParkedForMissingWorkflowScope - parks a host without the scope, never one that has it, and trusts only the fleet (Issue #2689)", () => {
  const parked = [{
    author: "stservice",
    body: `${TOKEN_SCOPE_PARKED_MARKER}\nparked`,
  }];
  assertEquals(isParkedForMissingWorkflowScope(parked, FLEET, "absent"), true);
  assertEquals(isParkedForMissingWorkflowScope(parked, FLEET, "unknown"), true);
  assertEquals(
    isParkedForMissingWorkflowScope(parked, FLEET, "granted"),
    false,
  );
  // The marker from anyone outside the fleet parks nothing.
  assertEquals(
    isParkedForMissingWorkflowScope(
      [{ author: "mallory", body: TOKEN_SCOPE_PARKED_MARKER }],
      FLEET,
      "absent",
    ),
    false,
  );
  assertEquals(isParkedForMissingWorkflowScope([], FLEET, "absent"), false);
});
