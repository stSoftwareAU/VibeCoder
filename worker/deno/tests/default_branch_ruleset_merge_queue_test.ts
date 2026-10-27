/**
 * Tests for the merge-queue decision in the default-branch ruleset configurator
 * (Issue #4424).
 *
 * Every test drives the real `planDefaultBranchRuleset` /
 * `ensureDefaultBranchRuleset` (and once `syncBranchProtectionForRepo`) through
 * an injected `gh` executor. The fake's repository metadata, organisation plan,
 * workflow files, live rulesets, topics and probe behaviour are set per test.
 *
 * A refusal test asserts the specific verdict and then runs the same input with
 * only the probed value made legal, which must enable the queue (a positive
 * control). Without the control a refusal could be a fake that never answers.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ensureDefaultBranchRuleset,
  planDefaultBranchRuleset,
  VIBE_RULESET_NAME,
} from "../lib/default_branch_ruleset.ts";
import {
  buildMergeQueueParameters,
  MERGE_QUEUE_OPT_OUT_TOPIC,
  MERGE_QUEUE_PROBE_NAME,
} from "../lib/merge_queue.ts";
import {
  buildDefaultBranchRulesetBody,
  type GhExec,
  type MergeQueueParameters,
} from "../lib/repo_rulesets.ts";
import {
  formatMergeQueueLine,
  planBranchProtectionForRepo,
  syncBranchProtectionForRepo,
} from "../setup/branch_protection_sync.ts";
import type { CommandOutput } from "../setup/branch_protection_sync.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "acme/widgets";
const BRANCH = "main";
const OURS_ID = 7;
const FOREIGN_ID = 2;
const PROBE_ID = 900;

/** GitHub allows no merge queue on a user-owned repository. */
const USER_REPO = { owner: { type: "User" }, private: true };
const PUBLIC_ORG = {
  owner: { type: "Organization" },
  private: false,
  allow_squash_merge: true,
};
const PRIVATE_ORG = {
  owner: { type: "Organization" },
  private: true,
  allow_squash_merge: true,
};

/** A workflow whose `gitleaks` job runs on pull requests and on the queue. */
const CI_WITH_MERGE_GROUP = [
  "on:",
  "  pull_request:",
  "  merge_group:",
  "jobs:",
  "  gitleaks:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo ok",
  "",
].join("\n");

/** The same workflow without the `merge_group` trigger. */
const CI_PR_ONLY = [
  "on:",
  "  pull_request:",
  "jobs:",
  "  gitleaks:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo ok",
  "",
].join("\n");

const WITH_MERGE_GROUP = { "ci.yml": CI_WITH_MERGE_GROUP };
const PR_ONLY = { "ci.yml": CI_PR_ONLY };

/** Queue parameters a human tuned on the live ruleset. */
const HUMAN_QUEUE: MergeQueueParameters = {
  check_response_timeout_minutes: 30,
  grouping_strategy: "HEADGREEN",
  max_entries_to_build: 3,
  max_entries_to_merge: 2,
  merge_method: "MERGE",
  min_entries_to_merge: 2,
  min_entries_to_merge_wait_minutes: 5,
};

/** A required-status-checks rule as the live ruleset carries it. */
function statusRule(
  contexts: string[],
  strict?: boolean,
): Record<string, unknown> {
  return {
    type: "required_status_checks",
    parameters: {
      ...(strict === undefined
        ? {}
        : { strict_required_status_checks_policy: strict }),
      required_status_checks: contexts.map((context) => ({ context })),
    },
  };
}

/** A `merge_queue` rule the worker itself would have written. */
function queueRule(
  parameters: MergeQueueParameters = buildMergeQueueParameters("SQUASH"),
): Record<string, unknown> {
  return { type: "merge_queue", parameters };
}

interface Fixture {
  /** Live rules of the worker's own ruleset; absent = no ruleset of ours. */
  ours?: Array<Record<string, unknown>>;
  /** True when a human-managed ruleset also covers the branch. */
  foreign?: boolean;
  /** True when the branch's only recent commit is a direct push. */
  direct?: boolean;
  /** Repository metadata (`GET repos/<slug>`); default user-owned. */
  repoMeta?: Record<string, unknown>;
  /** The repository metadata read fails. */
  metaError?: boolean;
  /** Organisation plan name; absent = the plan read fails. */
  orgPlan?: string;
  /** Workflow files under `.github/workflows`, by file name. */
  workflows?: Record<string, string>;
  /** Repository topics. */
  topics?: string[];
  /** Check-run names reported on the branch; default `gitleaks`. */
  checkRuns?: string[];
  /** What the probe create does; default accepted. */
  probe?: "accepted" | "rejected" | "failed";
}

interface Recorded {
  method: string;
  endpoint: string;
  body?: string;
}

function notFound(): Promise<string> {
  return Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
}

/** Answer one call of the fake GitHub. */
function route(
  method: string,
  endpoint: string,
  stdin: string | undefined,
  f: Fixture,
): Promise<string> {
  if (method === "POST" && stdin?.includes(MERGE_QUEUE_PROBE_NAME)) {
    if (f.probe === "rejected") {
      return Promise.reject(
        new Error(
          'gh failed: HTTP 422: Unprocessable Entity\n{"message":"Invalid rule \'merge_queue\': not available"}',
        ),
      );
    }
    if (f.probe === "failed") {
      return Promise.reject(new Error("gh failed: HTTP 500: Server Error"));
    }
    return Promise.resolve(JSON.stringify({ id: PROBE_ID }));
  }
  if (method !== "GET") return Promise.resolve("");

  if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
    if (f.metaError) {
      return Promise.reject(new Error("gh failed: HTTP 503: unavailable"));
    }
    return Promise.resolve(JSON.stringify(f.repoMeta ?? USER_REPO));
  }
  if (/^orgs\/[^/]+$/.test(endpoint)) {
    return f.orgPlan === undefined
      ? notFound()
      : Promise.resolve(JSON.stringify({ plan: { name: f.orgPlan } }));
  }
  if (/\/topics$/.test(endpoint)) {
    return Promise.resolve(JSON.stringify({ names: f.topics ?? [] }));
  }
  if (/\/contents\/\.github\/workflows$/.test(endpoint)) {
    return Promise.resolve(
      JSON.stringify(
        Object.keys(f.workflows ?? {}).map((name) => ({ type: "file", name })),
      ),
    );
  }
  const workflow = endpoint.match(/\/contents\/\.github\/workflows\/([^/]+)$/);
  if (workflow) {
    const text = f.workflows?.[workflow[1]!];
    return text === undefined ? notFound() : Promise.resolve(text);
  }
  if (endpoint.includes("/contents/")) return notFound();

  if (/\/commits\?sha=/.test(endpoint)) {
    const message = f.direct ? "Refresh of history" : "feat: change (#1)";
    return Promise.resolve(
      JSON.stringify([{ sha: "abc1234", commit: { message } }]),
    );
  }
  if (/\/commits\/[^/]+\/pulls$/.test(endpoint)) return Promise.resolve("[]");
  if (/\/pulls\?/.test(endpoint)) return Promise.resolve("[]");
  if (/\/protection$/.test(endpoint)) return notFound();
  if (/\/status$/.test(endpoint)) {
    return Promise.resolve(JSON.stringify({ statuses: [] }));
  }
  if (/check-runs/.test(endpoint)) {
    const names = f.checkRuns ?? ["gitleaks"];
    return Promise.resolve(
      JSON.stringify({ check_runs: names.map((name) => ({ name })) }),
    );
  }
  if (/\/rules\/branches\//.test(endpoint)) {
    const rules: Array<Record<string, unknown>> = [];
    for (const rule of f.ours ?? []) {
      rules.push({ ...rule, ruleset_id: OURS_ID });
    }
    if (f.foreign) {
      rules.push({
        type: "required_status_checks",
        ruleset_id: FOREIGN_ID,
        parameters: { required_status_checks: [{ context: "quality" }] },
      });
    }
    return Promise.resolve(JSON.stringify(rules));
  }
  if (/\/rulesets$/.test(endpoint)) {
    const list: Array<{ id: number; name: string }> = [];
    if (f.ours) list.push({ id: OURS_ID, name: VIBE_RULESET_NAME });
    if (f.foreign) list.push({ id: FOREIGN_ID, name: "Develop" });
    return Promise.resolve(JSON.stringify(list));
  }
  const detail = endpoint.match(/\/rulesets\/(\d+)$/);
  if (detail) {
    const id = Number(detail[1]);
    if (id === OURS_ID && f.ours) {
      return Promise.resolve(
        JSON.stringify({
          id,
          name: VIBE_RULESET_NAME,
          target: "branch",
          enforcement: "active",
          rules: f.ours,
        }),
      );
    }
    return notFound();
  }
  return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
}

/** A `gh` executor over `f`, recording every call it receives. */
function fakeGh(f: Fixture): { gh: GhExec; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const gh: GhExec = (args, stdin) => {
    const isVerb = args[1] === "-X";
    const method = isVerb ? String(args[2]) : "GET";
    const endpoint = String(isVerb ? args[3] : args[1]);
    calls.push({ method, endpoint, body: stdin });
    return route(method, endpoint, stdin, f);
  };
  return { gh, calls };
}

// ---------------------------------------------------------------------------
// Call selectors
// ---------------------------------------------------------------------------

function isProbeWrite(call: Recorded): boolean {
  return call.method === "POST" &&
    call.body?.includes(MERGE_QUEUE_PROBE_NAME) === true;
}

/** The worker's ruleset creates and updates; never the probe or a delete. */
function rulesetWrites(calls: Recorded[]): Recorded[] {
  return calls.filter((c) =>
    (c.method === "POST" || c.method === "PUT") && !isProbeWrite(c) &&
    /\/rulesets/.test(c.endpoint)
  );
}

function probeWrites(calls: Recorded[]): Recorded[] {
  return calls.filter(isProbeWrite);
}

function deletes(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.method === "DELETE");
}

/**
 * Calls made only to decide the merge queue: the repository metadata, the
 * organisation plan, the workflow files and the probe. The direct-push guard
 * and the check-name reads are not among them.
 */
function queueReads(calls: Recorded[]): Recorded[] {
  return calls.filter((c) =>
    isProbeWrite(c) ||
    (c.method === "GET" &&
      (c.endpoint === `repos/${REPO}` ||
        c.endpoint.startsWith("orgs/") ||
        c.endpoint.includes("/contents/.github/workflows")))
  );
}

/** A parsed ruleset body as written. */
interface WrittenBody {
  name: string;
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

function bodyOf(call: Recorded): WrittenBody {
  return JSON.parse(call.body!) as WrittenBody;
}

function queueOf(body: WrittenBody): MergeQueueParameters | undefined {
  const parameters = body.rules.find((r) => r.type === "merge_queue")
    ?.parameters;
  return parameters as MergeQueueParameters | undefined;
}

function strictOf(body: WrittenBody): unknown {
  const rule = body.rules.find((r) => r.type === "required_status_checks");
  return rule?.parameters?.["strict_required_status_checks_policy"];
}

function contextsOf(body: WrittenBody): unknown {
  const rule = body.rules.find((r) => r.type === "required_status_checks");
  return rule?.parameters?.["required_status_checks"];
}

/** Unwrap a result that the test expects to be a success. */
function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const error = (result as unknown as { error?: Error }).error;
    throw new Error(`expected success, got: ${error?.message ?? "unknown"}`);
  }
  return result as Extract<T, { ok: true }>;
}

const ensure = (gh: GhExec, visibility: "public" | "private" = "public") =>
  ensureDefaultBranchRuleset(REPO, { branch: BRANCH, visibility }, gh);

// ---------------------------------------------------------------------------
// Enabling: create
// ---------------------------------------------------------------------------

Deno.test("merge queue - a public organisation with a merge_group workflow creates the queue and drops strict (Issue #4424)", async () => {
  const { gh, calls } = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });

  const result = must(await ensure(gh));

  assertEquals(result.changed, true);
  assertEquals(result.mergeQueue?.verdict, "enabled");
  assertEquals(result.mergeQueue?.enabled, true);
  const writes = rulesetWrites(calls);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.method, "POST");
  const body = bodyOf(writes[0]!);
  assertEquals(strictOf(body), false);
  assertEquals(contextsOf(body), [{ context: "gitleaks" }]);
  assertEquals(queueOf(body)?.merge_method, "SQUASH");
  assertEquals(queueOf(body), buildMergeQueueParameters("SQUASH"));
});

Deno.test("merge queue - a user-owned repository is byte-identical to today, with the reason recorded (Issue #4424)", async () => {
  // Negative: the user-owned repository gets today's body and no queue.
  const user = fakeGh({ workflows: WITH_MERGE_GROUP });
  const userResult = must(await ensure(user.gh));
  const userWrites = rulesetWrites(user.calls);
  assertEquals(userWrites.length, 1);
  assertEquals(
    userWrites[0]!.body,
    JSON.stringify(
      buildDefaultBranchRulesetBody(VIBE_RULESET_NAME, ["gitleaks"]),
    ),
  );
  assertEquals(userResult.mergeQueue?.verdict, "unavailable");
  assertEquals(userResult.mergeQueue?.enabled, false);
  assertStringIncludes(userResult.mergeQueue?.reason ?? "", "user account");

  // Positive control: only the owner type changed, and the queue appears.
  const org = fakeGh({ repoMeta: PUBLIC_ORG, workflows: WITH_MERGE_GROUP });
  must(await ensure(org.gh));
  assertEquals(
    queueOf(bodyOf(rulesetWrites(org.calls)[0]!))?.merge_method,
    "SQUASH",
  );
});

// ---------------------------------------------------------------------------
// Refusals: unavailable, unverified, missing merge_group, opt-out
// ---------------------------------------------------------------------------

Deno.test("merge queue - a private Team organisation is unavailable; an Enterprise one enables it (Issue #4424)", async () => {
  const team = fakeGh({
    repoMeta: PRIVATE_ORG,
    orgPlan: "team",
    workflows: WITH_MERGE_GROUP,
  });
  const teamPlan = await planDefaultBranchRuleset(
    REPO,
    { branch: BRANCH, visibility: "private" },
    team.gh,
  );
  const teamDecision = must(teamPlan).plan.mergeQueue;
  assertEquals(teamDecision?.verdict, "unavailable");
  assertEquals(teamDecision?.enabled, false);
  assertStringIncludes(teamDecision?.reason ?? "", "team");
  assertEquals(probeWrites(team.calls).length, 0);

  // Positive control: the plan made legal is the only change.
  const enterprise = fakeGh({
    repoMeta: PRIVATE_ORG,
    orgPlan: "enterprise",
    workflows: WITH_MERGE_GROUP,
  });
  const enterprisePlan = await planDefaultBranchRuleset(
    REPO,
    { branch: BRANCH, visibility: "private" },
    enterprise.gh,
  );
  assertEquals(must(enterprisePlan).plan.mergeQueue?.verdict, "enabled");
});

Deno.test("merge queue - a private organisation the probe refuses gets no queue; an accepted probe enables it and is deleted (Issue #4424)", async () => {
  // Refused: the probe create fails with 422, so nothing was created and
  // nothing needs deleting. The ruleset is written without a queue.
  const refused = fakeGh({
    repoMeta: PRIVATE_ORG,
    probe: "rejected",
    workflows: WITH_MERGE_GROUP,
  });
  const refusedResult = must(await ensure(refused.gh, "private"));
  assertEquals(refusedResult.mergeQueue?.verdict, "unavailable");
  assertEquals(refusedResult.mergeQueue?.enabled, false);
  assertStringIncludes(
    refusedResult.mergeQueue?.reason ?? "",
    "GitHub rejected a merge_queue rule",
  );
  assertEquals(probeWrites(refused.calls).length, 1);
  assertEquals(deletes(refused.calls).length, 0);
  assertEquals(queueOf(bodyOf(rulesetWrites(refused.calls)[0]!)), undefined);

  // Positive control: the probe accepted, so the queue is enabled and the
  // probe ruleset is removed again.
  const accepted = fakeGh({
    repoMeta: PRIVATE_ORG,
    probe: "accepted",
    workflows: WITH_MERGE_GROUP,
  });
  const acceptedResult = must(await ensure(accepted.gh, "private"));
  assertEquals(acceptedResult.mergeQueue?.verdict, "enabled");
  assertEquals(
    deletes(accepted.calls).map((c) => c.endpoint),
    [`repos/${REPO}/rulesets/${PROBE_ID}`],
  );
  assertEquals(
    queueOf(bodyOf(rulesetWrites(accepted.calls)[0]!))?.merge_method,
    "SQUASH",
  );
});

Deno.test("merge queue - a required check whose workflow lacks merge_group keeps strict and names the workflow (Issue #4424)", async () => {
  const refused = fakeGh({ repoMeta: PUBLIC_ORG, workflows: PR_ONLY });
  const refusedResult = must(await ensure(refused.gh));
  assertEquals(refusedResult.mergeQueue?.verdict, "missing-merge-group");
  assertEquals(refusedResult.mergeQueue?.enabled, false);
  assertStringIncludes(
    refusedResult.mergeQueue?.reason ?? "",
    ".github/workflows/ci.yml",
  );
  const body = bodyOf(rulesetWrites(refused.calls)[0]!);
  assertEquals(strictOf(body), true);
  assertEquals(queueOf(body), undefined);

  // Positive control: add merge_group to that one workflow.
  const fixed = fakeGh({ repoMeta: PUBLIC_ORG, workflows: WITH_MERGE_GROUP });
  const fixedResult = must(await ensure(fixed.gh));
  assertEquals(fixedResult.mergeQueue?.verdict, "enabled");
});

Deno.test("merge queue - a refusal drops an existing queue and restores strict, and the control keeps it (Issue #4424)", async () => {
  const refused = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: PR_ONLY,
    ours: [statusRule(["gitleaks"], false), queueRule()],
  });
  const refusedResult = must(await ensure(refused.gh));
  assertEquals(refusedResult.changed, true);
  assertEquals(refusedResult.mergeQueue?.verdict, "missing-merge-group");
  const writes = rulesetWrites(refused.calls);
  assertEquals(writes.map((c) => c.method), ["PUT"]);
  const body = bodyOf(writes[0]!);
  assertEquals(queueOf(body), undefined);
  assertEquals(strictOf(body), true);

  // Positive control: the workflow reports on merge_group, so the queue is
  // kept as it is and nothing is written.
  const kept = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    ours: [statusRule(["gitleaks"], false), queueRule()],
  });
  const keptResult = must(await ensure(kept.gh));
  assertEquals(keptResult.changed, false);
  assertEquals(keptResult.mergeQueue?.enabled, true);
  assertEquals(rulesetWrites(kept.calls).length, 0);
});

Deno.test("merge queue - the opt-out topic gets no queue and drops an existing one (Issue #4424)", async () => {
  const opted = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    topics: [MERGE_QUEUE_OPT_OUT_TOPIC],
    ours: [statusRule(["gitleaks"], false), queueRule()],
  });
  const optedResult = must(await ensure(opted.gh));
  assertEquals(optedResult.mergeQueue?.verdict, "opted-out");
  assertEquals(optedResult.mergeQueue?.enabled, false);
  assertStringIncludes(
    optedResult.mergeQueue?.reason ?? "",
    MERGE_QUEUE_OPT_OUT_TOPIC,
  );
  const body = bodyOf(rulesetWrites(opted.calls)[0]!);
  assertEquals(queueOf(body), undefined);
  assertEquals(strictOf(body), true);

  // Positive control: without the topic the same repository keeps its queue.
  const open = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    topics: [],
    ours: [statusRule(["gitleaks"], false), queueRule()],
  });
  const openResult = must(await ensure(open.gh));
  assertEquals(openResult.mergeQueue?.verdict, "enabled");
  assertEquals(rulesetWrites(open.calls).length, 0);
});

// ---------------------------------------------------------------------------
// Existing rulesets: no-op, drift, human tuning
// ---------------------------------------------------------------------------

Deno.test("merge queue - an already-queued, consistent ruleset makes no writes (Issue #4424)", async () => {
  const { gh, calls } = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    ours: [statusRule(["gitleaks"], false), queueRule()],
  });

  const planned = must(
    await planDefaultBranchRuleset(
      REPO,
      { branch: BRANCH, visibility: "public" },
      gh,
    ),
  );
  assertEquals(planned.plan.action, "none");
  assertEquals(planned.plan.skipped, "existing-ruleset");
  assertEquals(planned.plan.mergeQueue?.enabled, true);

  const result = must(await ensure(gh));
  assertEquals(result.changed, false);
  assertEquals(rulesetWrites(calls).length, 0);
  assertEquals(deletes(calls).length, 0);
});

Deno.test("merge queue - a human-tuned queue is preserved when the update writes (Issue #4424)", async () => {
  // The live ruleset requires nothing yet, so the update adds gitleaks; the
  // queue it carries was tuned by a human and must be written back unchanged.
  // (A live context no workflow reports would correctly refuse the queue, so
  // the live status rule must not name one.)
  const { gh, calls } = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    ours: [statusRule([], false), queueRule(HUMAN_QUEUE)],
  });

  const result = must(await ensure(gh));
  assertEquals(result.changed, true);
  const writes = rulesetWrites(calls);
  assertEquals(writes.map((c) => c.method), ["PUT"]);
  assertEquals(queueOf(bodyOf(writes[0]!)), HUMAN_QUEUE);
});

Deno.test("merge queue - drift (ours without a queue, nothing to add, queue available) updates and reports a change (Issue #4424)", async () => {
  const { gh, calls } = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    ours: [statusRule(["gitleaks"], true)],
  });

  const planned = must(
    await planDefaultBranchRuleset(
      REPO,
      { branch: BRANCH, visibility: "public" },
      gh,
    ),
  );
  assertEquals(planned.plan.action, "update");
  assertEquals(planned.plan.added, []);

  const result = must(await ensure(gh));
  assertEquals(result.changed, true);
  assertEquals(result.added, []);
  const writes = rulesetWrites(calls);
  assertEquals(writes.map((c) => c.method), ["PUT"]);
  const body = bodyOf(writes[0]!);
  assertEquals(queueOf(body)?.merge_method, "SQUASH");
  assertEquals(strictOf(body), false);
});

// ---------------------------------------------------------------------------
// Unverified: a transient failure never weakens or removes enforcement
// ---------------------------------------------------------------------------

Deno.test("merge queue - an unverified read keeps a live queue and writes nothing when nothing else needs doing (Issue #4424)", async () => {
  const unverified = fakeGh({
    metaError: true,
    probe: "failed",
    ours: [statusRule(["gitleaks"], false), queueRule(HUMAN_QUEUE)],
  });
  const unverifiedResult = must(await ensure(unverified.gh));
  assertEquals(unverifiedResult.changed, false);
  assertEquals(unverifiedResult.mergeQueue?.verdict, "unverified");
  assertEquals(unverifiedResult.mergeQueue?.enabled, true);
  assertEquals(rulesetWrites(unverified.calls).length, 0);
  assertEquals(deletes(unverified.calls).length, 0);

  // Positive control: the same live queue with the reads answering is
  // confirmed as enabled, with no write.
  const answered = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
    ours: [statusRule(["gitleaks"], false), queueRule(HUMAN_QUEUE)],
  });
  const answeredResult = must(await ensure(answered.gh));
  assertEquals(answeredResult.mergeQueue?.verdict, "enabled");
  assertEquals(rulesetWrites(answered.calls).length, 0);
});

Deno.test("merge queue - an unverified read adds no queue, to a new ruleset or to one without a queue (Issue #4424)", async () => {
  // Create: strict stays on, exactly as today.
  const created = fakeGh({ metaError: true, probe: "failed" });
  const createdResult = must(await ensure(created.gh));
  assertEquals(createdResult.mergeQueue?.verdict, "unverified");
  assertEquals(createdResult.mergeQueue?.enabled, false);
  const createBody = rulesetWrites(created.calls)[0]!.body;
  assertEquals(
    createBody,
    JSON.stringify(
      buildDefaultBranchRulesetBody(VIBE_RULESET_NAME, ["gitleaks"]),
    ),
  );

  // Ours without a queue and nothing to add: a genuine no-op, no queue.
  const ours = fakeGh({
    metaError: true,
    probe: "failed",
    ours: [statusRule(["gitleaks"], true)],
  });
  const oursResult = must(await ensure(ours.gh));
  assertEquals(oursResult.changed, false);
  assertEquals(oursResult.mergeQueue?.verdict, "unverified");
  assertEquals(oursResult.mergeQueue?.enabled, false);
  assertEquals(rulesetWrites(ours.calls).length, 0);
});

Deno.test("merge queue - an unverified read never removes a live queue, even with nothing else to change (Issue #4424)", async () => {
  // Strict is still on beside the queue, so the queue state has drifted; an
  // unverified read must not be allowed to strip the queue as a result.
  const { gh, calls } = fakeGh({
    metaError: true,
    probe: "failed",
    ours: [statusRule(["gitleaks"], true), queueRule(HUMAN_QUEUE)],
  });

  const result = must(await ensure(gh));
  assertEquals(result.mergeQueue?.verdict, "unverified");
  assertEquals(result.mergeQueue?.enabled, true);
  // Drift (strict still on beside the queue) makes the one update; that
  // update must keep the human's queue, not drop it.
  const writes = rulesetWrites(calls);
  assertEquals(writes.map((c) => c.method), ["PUT"]);
  assertEquals(queueOf(bodyOf(writes[0]!)), HUMAN_QUEUE);
  assertEquals(strictOf(bodyOf(writes[0]!)), false);
});

// ---------------------------------------------------------------------------
// No merge-queue reads on the early exits
// ---------------------------------------------------------------------------

Deno.test("merge queue - a foreign ruleset, a direct-push branch and no reported checks make no merge-queue reads (Issue #4424)", async () => {
  const foreign = fakeGh({
    foreign: true,
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  const foreignResult = must(await ensure(foreign.gh));
  assertEquals(foreignResult.skipped, "existing-ruleset");
  assertEquals(foreignResult.mergeQueue, undefined);
  assertEquals(queueReads(foreign.calls).length, 0);

  const direct = fakeGh({
    direct: true,
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  const directResult = must(await ensure(direct.gh));
  assertEquals(directResult.skipped, "direct-push-branch");
  assertEquals(queueReads(direct.calls).length, 0);

  const nothing = fakeGh({
    checkRuns: [],
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  const nothingResult = must(await ensure(nothing.gh));
  assertEquals(nothingResult.skipped, "no-reported-checks");
  assertEquals(queueReads(nothing.calls).length, 0);

  // Positive controls: the same repositories without the early exit do read
  // the merge queue state, so the zero counts above mean something.
  const openForeign = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  must(await ensure(openForeign.gh));
  assert(queueReads(openForeign.calls).length > 0);

  const openDirect = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  must(await ensure(openDirect.gh));
  assert(queueReads(openDirect.calls).length > 0);

  const reported = fakeGh({
    repoMeta: PUBLIC_ORG,
    workflows: WITH_MERGE_GROUP,
  });
  must(await ensure(reported.gh));
  assert(queueReads(reported.calls).length > 0);
});

// ---------------------------------------------------------------------------
// The setup-time sync result
// ---------------------------------------------------------------------------

/** Branch lookup for the sync; visibility is passed in, so it is not read. */
const DEFAULT_BRANCH_ONLY: (cmd: string[]) => Promise<CommandOutput> = (cmd) =>
  Promise.resolve({
    success: true,
    stdout: cmd[cmd.length - 1] === ".default_branch" ? BRANCH : "",
    stderr: "",
  });

Deno.test("merge queue - syncBranchProtectionForRepo carries the merge queue state of the write (Issue #4424)", async () => {
  const enabled = fakeGh({ repoMeta: PUBLIC_ORG, workflows: WITH_MERGE_GROUP });
  const result = await syncBranchProtectionForRepo(REPO, {
    visibility: "public",
    runCommand: DEFAULT_BRANCH_ONLY,
    ghFn: enabled.gh,
  });
  assertEquals(result.ok, true);
  assertEquals(result.changed, true);
  assertEquals(result.mergeQueue?.verdict, "enabled");
  assertEquals(result.mergeQueue?.enabled, true);
  assertStringIncludes(result.mergeQueue?.reason ?? "", "public repository");

  const refused = fakeGh({ workflows: WITH_MERGE_GROUP });
  const refusedResult = await syncBranchProtectionForRepo(REPO, {
    visibility: "public",
    runCommand: DEFAULT_BRANCH_ONLY,
    ghFn: refused.gh,
  });
  assertEquals(refusedResult.ok, true);
  assertEquals(refusedResult.mergeQueue?.verdict, "unavailable");
  assertEquals(refusedResult.mergeQueue?.enabled, false);
});

// ---------------------------------------------------------------------------
// The audit path never probes (Issue #4424)
// ---------------------------------------------------------------------------

Deno.test("merge queue - the audit path makes no non-GET call where the metadata is unreadable (Issue #4424)", async () => {
  // Read-only: the audit sweep plans with readOnly, so an inconclusive
  // answer is unverified and nothing is created, not even the probe.
  const audit = fakeGh({
    metaError: true,
    probe: "accepted",
    workflows: WITH_MERGE_GROUP,
  });
  const planned = await planBranchProtectionForRepo(REPO, {
    visibility: "public",
    runCommand: DEFAULT_BRANCH_ONLY,
    ghFn: audit.gh,
  });
  assertEquals(planned.ok, true);
  const plan = planned.plan!;
  assertEquals(plan.action, "create");
  assertEquals(plan.mergeQueue?.verdict, "unverified");
  assertEquals(plan.mergeQueue?.enabled, false);
  assertStringIncludes(plan.mergeQueue?.reason ?? "", "read-only");
  assertEquals(audit.calls.filter((c) => c.method !== "GET"), []);

  // The same read-only plan where the plan is unreadable on a private
  // organisation: still no write.
  const unreadablePlan = fakeGh({
    repoMeta: PRIVATE_ORG,
    probe: "accepted",
    workflows: WITH_MERGE_GROUP,
  });
  const planPrivate = await planDefaultBranchRuleset(
    REPO,
    { branch: BRANCH, visibility: "private", readOnly: true },
    unreadablePlan.gh,
  );
  assertEquals(must(planPrivate).plan.mergeQueue?.verdict, "unverified");
  assertEquals(unreadablePlan.calls.filter((c) => c.method !== "GET"), []);

  // Positive control: the same input planned without readOnly probes, and
  // the probe's acceptance enables the queue.
  const probing = fakeGh({
    metaError: true,
    probe: "accepted",
    workflows: WITH_MERGE_GROUP,
  });
  const planProbed = must(
    await planDefaultBranchRuleset(
      REPO,
      { branch: BRANCH, visibility: "public" },
      probing.gh,
    ),
  );
  assertEquals(planProbed.plan.mergeQueue?.verdict, "enabled");
  assertEquals(probeWrites(probing.calls).length, 1);
  assertEquals(deletes(probing.calls).length, 1);
});

// ---------------------------------------------------------------------------
// The setup-output wording (Issue #4424)
// ---------------------------------------------------------------------------

Deno.test("merge queue - the setup line says enabled, left in place, or not enabled with the reason (Issue #4424)", () => {
  const enabled = formatMergeQueueLine({
    verdict: "enabled",
    enabled: true,
    reason: "public repository of an organisation",
  });
  assertEquals(enabled, {
    level: "success",
    text: "merge queue enabled (public repository of an organisation)",
  });

  // An unverified read that kept a live queue: named as kept, not as a
  // fallback to strict (which would be false here).
  const kept = formatMergeQueueLine({
    verdict: "unverified",
    enabled: true,
    reason: "the probe failed: HTTP 500",
  });
  assertEquals(kept, {
    level: "info",
    text:
      "merge queue left in place: the probe failed: HTTP 500 — the existing queue is kept",
  });

  // A definitive refusal with no queue: the fallback names the reason and
  // the strict policy that was kept.
  const fallback = formatMergeQueueLine({
    verdict: "unavailable",
    enabled: false,
    reason: "owned by a user account",
  });
  assertEquals(fallback, {
    level: "info",
    text:
      "merge queue not enabled: owned by a user account — strict up-to-date policy kept",
  });
});
