/**
 * Tests for the one reconciliation that covers every committed ruleset
 * (Issue #1073).
 *
 * `main` had a check (Issue #858) and the release tags had a check (Issue
 * #1049); `Milestone` had neither, and drifted to two required contexts
 * without anything noticing. One registry, one comparison, all three payloads
 * — a ruleset nobody reconciles is the failure this closes.
 *
 * Each drift direction is asserted against a stubbed API response, because a
 * reconciliation that reports "no drift" for a ruleset it could not read, or
 * skips over a ruleset that has been deleted, is worse than none at all.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  COMMITTED_RULESETS,
  loadCommittedRuleset,
  MILESTONE_BRANCH_RULESET_PATH,
  reconcileCommittedRuleset,
  reconcileCommittedRulesets,
} from "../lib/committed_rulesets.ts";

const REPO = "stSoftwareAU/VibeCoder";

/** Repository root, resolved from this test's location. */
function repoRoot(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname)
    .replace(/\/$/, "");
}

/** The milestone entry, which every drift-direction test works against. */
function milestoneEntry() {
  const entry = COMMITTED_RULESETS.find((r) =>
    r.path === MILESTONE_BRANCH_RULESET_PATH
  );
  assert(entry, "the milestone payload must be registered");
  return entry;
}

/** The committed payload rendered as the API returns it, with an id. */
async function liveFromCommitted(
  path: string,
  id: number,
): Promise<Record<string, unknown>> {
  const entry = COMMITTED_RULESETS.find((r) => r.path === path);
  assert(entry, `${path} must be registered`);
  const committed = await loadCommittedRuleset(entry, repoRoot());
  return {
    id,
    ...JSON.parse(JSON.stringify(committed)) as Record<string, unknown>,
  };
}

/**
 * A `gh` stub answering the list call from `details`, then each detail call
 * with the payload registered under that id.
 */
function ghStub(details: Record<number, Record<string, unknown>>) {
  const summaries = Object.entries(details).map(([id, detail]) => ({
    id: Number(id),
    name: detail["name"],
    target: detail["target"],
  }));
  return (args: string[]): Promise<string> => {
    const path = args[args.length - 1] ?? "";
    const match = path.match(/rulesets\/(\d+)$/);
    if (!match) return Promise.resolve(JSON.stringify(summaries));
    return Promise.resolve(JSON.stringify(details[Number(match[1])]));
  };
}

/** Reconcile the milestone ruleset against a mutated live payload. */
async function reconcileMilestone(
  mutate: (live: Record<string, unknown>) => void,
) {
  const live = await liveFromCommitted(MILESTONE_BRANCH_RULESET_PATH, 21835173);
  mutate(live);
  return await reconcileCommittedRuleset(milestoneEntry(), {
    repo: REPO,
    root: repoRoot(),
    ghExec: ghStub({ 21835173: live }),
  });
}

/** The required-status-check contexts of a live payload, for mutation. */
function liveContexts(live: Record<string, unknown>): Array<{
  context: string;
}> {
  const rules = live["rules"] as Array<
    { type: string; parameters?: Record<string, unknown> }
  >;
  const rule = rules.find((r) => r.type === "required_status_checks");
  assert(rule?.parameters, "expected a required_status_checks rule");
  return rule.parameters["required_status_checks"] as Array<
    { context: string }
  >;
}

Deno.test("COMMITTED_RULESETS - every payload in infra/rulesets is reconciled", async () => {
  const registered = new Set(COMMITTED_RULESETS.map((r) => r.path));
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(`${repoRoot()}/infra/rulesets`)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      onDisk.push(`infra/rulesets/${entry.name}`);
    }
  }
  assert(onDisk.length >= 3, `expected three payloads, found ${onDisk}`);
  const unreconciled = onDisk.filter((path) => !registered.has(path));
  assertEquals(
    unreconciled,
    [],
    `these payloads are committed but nothing compares them to GitHub: ${unreconciled}`,
  );
});

Deno.test("COMMITTED_RULESETS - each payload parses and names its target", async () => {
  for (const entry of COMMITTED_RULESETS) {
    const payload = await loadCommittedRuleset(entry, repoRoot());
    assertEquals(payload.target, entry.target);
    assert(entry.protects.length > 0, `${entry.path} needs a description`);
  }
});

Deno.test("reconcileCommittedRulesets - all three matching is ok", async () => {
  const details: Record<number, Record<string, unknown>> = {};
  let id = 100;
  for (const entry of COMMITTED_RULESETS) {
    details[id] = await liveFromCommitted(entry.path, id);
    id += 1;
  }
  const results = await reconcileCommittedRulesets({
    repo: REPO,
    root: repoRoot(),
    ghExec: ghStub(details),
  });
  assertEquals(results.length, COMMITTED_RULESETS.length);
  for (const { ruleset, result } of results) {
    assertEquals(result.status, "ok", `${ruleset.path}: ${result.message}`);
  }
});

Deno.test("reconcileCommittedRuleset - a missing required context is drift", async () => {
  const result = await reconcileMilestone((live) => {
    const contexts = liveContexts(live);
    contexts.splice(
      contexts.findIndex((c) => c.context === "validate (tests 1/4)"),
      1,
    );
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.length, 1);
  assertEquals(result.findings[0]?.field, "required_status_checks");
  assertStringIncludes(result.message, "validate (tests 1/4)");
  assertStringIncludes(result.message, "a PR can merge with it red");
});

Deno.test("reconcileCommittedRuleset - an extra required context is drift", async () => {
  const result = await reconcileMilestone((live) => {
    liveContexts(live).push({ context: "ghost-check" });
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings[0]?.field, "required_status_checks");
  assertStringIncludes(result.message, "ghost-check");
});

Deno.test("reconcileCommittedRuleset - enforcement moved to evaluate is drift", async () => {
  const result = await reconcileMilestone((live) => {
    live["enforcement"] = "evaluate";
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.map((f) => f.field), ["enforcement"]);
  assertStringIncludes(result.message, "evaluate");
});

Deno.test("reconcileCommittedRuleset - a bypass actor is drift", async () => {
  const result = await reconcileMilestone((live) => {
    live["bypass_actors"] = [
      { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
    ];
  });
  assertEquals(result.status, "drift");
  assertEquals(result.findings.map((f) => f.field), ["bypass_actors"]);
  assertStringIncludes(result.message, "protect nothing");
});

Deno.test("reconcileCommittedRuleset - a deleted ruleset fails loud, it does not skip", async () => {
  const result = await reconcileCommittedRuleset(milestoneEntry(), {
    repo: REPO,
    root: repoRoot(),
    ghExec: () => Promise.resolve(JSON.stringify([{ id: 1, name: "main" }])),
  });
  assertEquals(result.status, "absent");
  assertStringIncludes(result.message, "Milestone");
  assertStringIncludes(result.message, "unprotected");
});

Deno.test("reconcileCommittedRulesets - no credential skips, and says so", async () => {
  for (
    const message of [
      "HTTP 401: Bad credentials",
      "gh: To get started with GitHub CLI, please run: gh auth login",
    ]
  ) {
    const results = await reconcileCommittedRulesets({
      repo: REPO,
      root: repoRoot(),
      ghExec: () => Promise.reject(new Error(message)),
    });
    assertEquals(results.length, COMMITTED_RULESETS.length);
    for (const { result } of results) {
      // Never "ok": nothing was compared, so nothing agreed.
      assertEquals(result.status, "skipped");
      assertStringIncludes(result.message, "SKIPPED");
      assertStringIncludes(result.message, "this is not a pass");
    }
  }
});

Deno.test("reconcileCommittedRulesets - an unexpected failure is never swallowed", async () => {
  await assertRejects(
    () =>
      reconcileCommittedRulesets({
        repo: REPO,
        root: repoRoot(),
        ghExec: () => Promise.reject(new Error("HTTP 422: unprocessable")),
      }),
    Error,
    "422",
  );
});

Deno.test("reconcileCommittedRulesets - rejects an unsafe repo slug", async () => {
  await assertRejects(
    () =>
      reconcileCommittedRulesets({
        repo: "stSoftwareAU/VibeCoder; rm -rf /",
        root: repoRoot(),
        ghExec: () => Promise.resolve("[]"),
      }),
    Error,
    "repo",
  );
});
