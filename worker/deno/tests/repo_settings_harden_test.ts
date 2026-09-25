/**
 * Tests for `repo-settings-harden` (Issues #4397, #4398, #4401): the
 * write-side twin of the settings pre-filer. It reads the same four
 * surfaces, plans the changes that close each open setting, and applies
 * them only under `--apply` — the ruleset review requirement is a separate
 * opt-in because it stops the fleet's autonomous merges.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseAllowActionArg } from "../commands/repo_settings_harden.ts";
import {
  allowListCovers,
  applyRepoSettingsPlan,
  buildAllowedActionPatterns,
  findCodeownersOnDefaultBranch,
  hardenRepo,
  isSecretScanningSkipped,
  MILESTONE_REF_PATTERN,
  needsPaidSecretProtection,
  planRepoSettingsHardening,
  type RepoSettingsSnapshot,
  resolveTransitiveActionCoordinates,
  SECRET_PROTECTION_SKIP_NOTE,
} from "../lib/repo_settings_harden.ts";

const OPEN = {
  workflow: {
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: true,
  },
  actions: {
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: false,
  },
  security: {
    secret_scanning: { status: "disabled" },
    secret_scanning_push_protection: { status: "disabled" },
  },
  rules: [{
    type: "pull_request",
    parameters: {
      require_code_owner_review: false,
      required_approving_review_count: 0,
    },
  }],
};

const HARDENED = {
  workflow: {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  },
  actions: {
    enabled: true,
    allowed_actions: "selected",
    sha_pinning_required: true,
  },
  security: {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  },
  rules: [{
    type: "pull_request",
    parameters: {
      require_code_owner_review: true,
      required_approving_review_count: 1,
    },
  }],
};

Deno.test("buildAllowedActionPatterns - GitHub-owned stay implicit; each third-party owner/repo becomes a pattern (Issue #4398)", () => {
  const patterns = buildAllowedActionPatterns([
    "actions/checkout",
    "actions/cache",
    "github/codeql-action/analyze",
    "denoland/setup-deno",
    "gitleaks/gitleaks-action",
    "aquasecurity/trivy-action",
    "denoland/setup-deno",
  ]);
  assertEquals(patterns, [
    "aquasecurity/trivy-action@*",
    "denoland/setup-deno@*",
    "gitleaks/gitleaks-action@*",
  ]);
});

Deno.test("planRepoSettingsHardening - an open repository plans every safe change; the review rule only under requireReviews (Issues #4397 #4398 #4401)", () => {
  const plan = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: ["denoland/setup-deno@*"],
    requireReviews: false,
    defaultBranch: "Develop",
  });
  const kinds = plan.map((s) => s.kind).sort();
  assertEquals(kinds, [
    "actions-allow-list",
    "secret-scanning",
    "sha-pinning-required",
    "workflow-token",
  ]);
  const token = plan.find((s) => s.kind === "workflow-token")!;
  assertEquals(token.method, "PUT");
  assertEquals(token.endpoint, "actions/permissions/workflow");
  assertEquals(JSON.parse(token.body!), {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  });
  const allow = plan.find((s) => s.kind === "actions-allow-list")!;
  assertEquals(JSON.parse(allow.body!), {
    github_owned_allowed: true,
    verified_allowed: false,
    patterns_allowed: ["denoland/setup-deno@*"],
  });
  assert(!plan.some((s) => s.kind === "ruleset-reviews"), "reviews are opt-in");

  const withReviews = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: [],
    requireReviews: true,
    defaultBranch: "Develop",
  });
  const rule = withReviews.find((s) => s.kind === "ruleset-reviews");
  assert(rule, "opt-in adds the ruleset step");
  assert(rule.warning?.includes("auto-merge"), rule.warning);
});

Deno.test("planRepoSettingsHardening - a hardened repository plans nothing (Issues #4397 #4398 #4401)", () => {
  assertEquals(
    planRepoSettingsHardening(HARDENED, {
      thirdPartyPatterns: ["x/y@*"],
      requireReviews: true,
      defaultBranch: "Develop",
    }),
    [],
  );
});

// =============================================================================
// Issue #2225 — secret scanning / push protection need paid GitHub Secret
// Protection on a private repository, so the step is not planned there
// =============================================================================

Deno.test("planRepoSettingsHardening - a private repository plans no secret-scanning step and reports the skip (Issue #2225)", () => {
  for (const visibility of ["private", "internal"]) {
    const snapshot: RepoSettingsSnapshot = {
      ...OPEN,
      visibility,
      private: true,
    };
    const plan = planRepoSettingsHardening(snapshot, {
      thirdPartyPatterns: [],
      requireReviews: false,
      defaultBranch: "Develop",
    });
    assert(
      !plan.some((s) => s.kind === "secret-scanning"),
      `${visibility}: no secret-scanning step`,
    );
    // The rest of the plan is unaffected.
    assert(plan.some((s) => s.kind === "workflow-token"), visibility);
    assert(isSecretScanningSkipped(snapshot), visibility);
  }
});

Deno.test("planRepoSettingsHardening - a public repository keeps the secret-scanning step and its warning (Issue #2225)", () => {
  const snapshot: RepoSettingsSnapshot = {
    ...OPEN,
    visibility: "public",
    private: false,
  };
  const plan = planRepoSettingsHardening(snapshot, {
    thirdPartyPatterns: [],
    requireReviews: false,
    defaultBranch: "Develop",
  });
  const step = plan.find((s) => s.kind === "secret-scanning");
  assert(step, "public repositories still plan the step");
  assert(step.warning?.includes("Secret Protection"), step.warning);
  assertEquals(isSecretScanningSkipped(snapshot), false);
});

Deno.test("needsPaidSecretProtection - private and internal cost money, public does not, and an unknown visibility falls back to the private flag (Issue #2225)", () => {
  assertEquals(needsPaidSecretProtection("private"), true);
  assertEquals(needsPaidSecretProtection("internal"), true);
  assertEquals(needsPaidSecretProtection("public"), false);
  // GitHub returns lowercase, but the value is normalised rather than trusted.
  assertEquals(needsPaidSecretProtection("Private"), true);
  // An explicit visibility wins over a contradictory boolean flag.
  assertEquals(needsPaidSecretProtection("public", true), false);
  assertEquals(needsPaidSecretProtection(undefined, true), true);
  assertEquals(needsPaidSecretProtection(undefined, false), false);
  // Neither field readable: evaluated as today, never exempt.
  assertEquals(needsPaidSecretProtection(), false);
  assertEquals(needsPaidSecretProtection("something-new"), false);
});

Deno.test("isSecretScanningSkipped - no skip when the settings already hold, or when visibility is unknown (Issue #2225)", () => {
  assertEquals(
    isSecretScanningSkipped({ ...HARDENED, visibility: "private" }),
    false,
  );
  // Unknown visibility is evaluated exactly as today — never silently skipped.
  assertEquals(isSecretScanningSkipped(OPEN), false);
  // No security surface read at all: nothing was planned, nothing skipped.
  assertEquals(isSecretScanningSkipped({ visibility: "private" }), false);
  // The boolean `private` flag alone is enough when `visibility` is absent.
  assertEquals(isSecretScanningSkipped({ ...OPEN, private: true }), true);
});

Deno.test("applyRepoSettingsPlan - dry run touches nothing; apply issues each write once and reports per step; a failed write is reported, not thrown (Issue #4398)", async () => {
  const plan = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: [],
    requireReviews: false,
    defaultBranch: "Develop",
  });
  const calls: string[][] = [];
  const dry = await applyRepoSettingsPlan("org/repo", plan, {
    apply: false,
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve("{}");
    },
  });
  assertEquals(calls, []);
  assert(dry.every((r) => r.status === "planned"));

  calls.length = 0;
  const applied = await applyRepoSettingsPlan("org/repo", plan, {
    apply: true,
    ghCommandFn: (args) => {
      calls.push(args);
      // The secret-scanning step is the only PATCH (bodies travel by file).
      if (args.includes("PATCH")) {
        return Promise.reject(
          new Error("HTTP 422: Advanced Security must be enabled"),
        );
      }
      return Promise.resolve("{}");
    },
  });
  // One write per step, plus the allow-list's flip to allowed_actions=selected.
  assertEquals(calls.length, plan.length + 1);
  const flip = calls.find((c) =>
    c.join(" ").includes("actions/permissions") &&
    !c.join(" ").includes("selected-actions") &&
    !c.join(" ").includes("workflow")
  );
  assert(flip, "the allow-list step flips allowed_actions first");
  assert(calls.every((c) => c[0] === "api" && c.includes("--method")));
  assert(
    calls.filter((c) => c.includes("--input")).length === plan.length + 1,
    "every body travels via --input <file>",
  );
  const secret = applied.find((r) => r.step.kind === "secret-scanning")!;
  assertEquals(secret.status, "failed");
  assert(secret.detail?.includes("Advanced Security"), secret.detail);
  assert(
    applied.filter((r) => r.status === "applied").length === plan.length - 1,
  );
});

// =============================================================================
// Issue #4424 — transitive composite-action dependencies and an incomplete
// allow-list
// =============================================================================

const TRIVY_COMPOSITE = `name: Trivy
runs:
  using: composite
  steps:
    - name: Install Trivy
      uses: aquasecurity/setup-trivy@3fb12ec12f41e471780db15c232d5dd185dcb514
    - uses: ./internal/step
    - uses: docker://alpine:3
    - run: echo hi
      shell: bash
`;

const SETUP_TRIVY_COMPOSITE = `name: setup-trivy
runs:
  using: composite
  steps:
    - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830
`;

/** A gh stub serving action.yml at pinned refs; JS actions have none. */
function actionYamlGh(): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const endpoint = args[1] ?? "";
    if (
      endpoint.startsWith("repos/aquasecurity/trivy-action/contents/action.yml")
    ) {
      return Promise.resolve(TRIVY_COMPOSITE);
    }
    if (
      endpoint.startsWith("repos/aquasecurity/setup-trivy/contents/action.yml")
    ) {
      return Promise.resolve(SETUP_TRIVY_COMPOSITE);
    }
    // A JavaScript action, or a repo with action.yaml only: 404 on .yml.
    return Promise.reject(new Error("HTTP 404: Not Found"));
  };
  return { gh, calls };
}

Deno.test("resolveTransitiveActionCoordinates - a composite action's own uses: are collected recursively; local, docker and GitHub-owned steps are not patterns (Issue #4424)", async () => {
  const { gh, calls } = actionYamlGh();
  const resolved = await resolveTransitiveActionCoordinates(
    [
      "aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
      "denoland/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282",
    ],
    gh,
  );
  assertEquals(resolved.coordinates, [
    "actions/cache",
    "aquasecurity/setup-trivy",
    "aquasecurity/trivy-action",
    "denoland/setup-deno",
  ]);
  assertEquals(buildAllowedActionPatterns(resolved.coordinates), [
    "aquasecurity/setup-trivy@*",
    "aquasecurity/trivy-action@*",
    "denoland/setup-deno@*",
  ]);
  // The action manifest is read at the pinned ref, raw, once per action.
  const trivyCall = calls.find((c) =>
    (c[1] ?? "").startsWith("repos/aquasecurity/trivy-action/contents/")
  );
  assert(trivyCall, "action.yml never fetched");
  assert(
    trivyCall.join(" ").includes(
      "ref=ed142fd0673e97e23eac54620cfb913e5ce36c25",
    ),
    trivyCall.join(" "),
  );
  assert(trivyCall.join(" ").includes("application/vnd.github.raw"));
  // The JS action (setup-deno) is looked up once, its 404 is not an error.
  assertEquals(resolved.unreadable, []);
});

Deno.test("resolveTransitiveActionCoordinates - a lookup that fails for a reason other than 'no manifest' is reported, never silently dropped (Issue #4424)", async () => {
  const gh = (args: string[]) =>
    (args[1] ?? "").includes("trivy-action")
      ? Promise.reject(new Error("HTTP 403: rate limited"))
      : Promise.reject(new Error("HTTP 404: Not Found"));
  const resolved = await resolveTransitiveActionCoordinates(
    ["aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25"],
    gh,
  );
  assertEquals(resolved.coordinates, ["aquasecurity/trivy-action"]);
  assertEquals(resolved.unreadable.length, 1);
  assert(resolved.unreadable[0]?.includes("403"));
});

// =============================================================================
// Issue #1235 — a hostile third-party manifest must not widen the allow-list
// nor steer the contents endpoint
// =============================================================================

/** A composite manifest whose steps carry hostile `uses:` coordinates. */
const HOSTILE_COMPOSITE = `name: Hostile
runs:
  using: composite
  steps:
    - uses: '*/*@v1'
    - uses: 'owner/../../victim@x'
    - uses: 'owner/repo with space@v1'
    - uses: 'good/action@0057852bfaa89a56745cba8c7296529d2fc39830'
`;

/** A gh stub serving the hostile manifest for the entry action only. */
function hostileManifestGh(): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const endpoint = args[1] ?? "";
    if (endpoint.startsWith("repos/vendor/composite/contents/action.yml")) {
      return Promise.resolve(HOSTILE_COMPOSITE);
    }
    return Promise.reject(new Error("HTTP 404: Not Found"));
  };
  return { gh, calls };
}

Deno.test("resolveTransitiveActionCoordinates - a hostile manifest's wildcard and traversal uses: are rejected, never collected and never fetched (Issue #1235)", async () => {
  const { gh, calls } = hostileManifestGh();
  const resolved = await resolveTransitiveActionCoordinates(
    ["vendor/composite@0057852bfaa89a56745cba8c7296529d2fc39830"],
    gh,
  );
  // Only the entry action and the legitimate step survive.
  assertEquals(resolved.coordinates, ["good/action", "vendor/composite"]);
  // `*/*@v1` must never reach the allow-list as `*/*@*`.
  assertEquals(buildAllowedActionPatterns(resolved.coordinates), [
    "good/action@*",
    "vendor/composite@*",
  ]);
  // No traversal or wildcard coordinate is turned into an API path.
  for (const call of calls) {
    const endpoint = call[1] ?? "";
    assert(!endpoint.includes(".."), endpoint);
    assert(!endpoint.includes("*"), endpoint);
  }
  // Rejections are reported, never silently dropped.
  assertEquals(resolved.unreadable.length, 3);
  assert(
    resolved.unreadable.every((u) => /not a valid owner\/repo/.test(u)),
    resolved.unreadable.join("; "),
  );
});

Deno.test("parseAllowActionArg - an operator coordinate the pattern builder would drop is rejected loudly, not silently (Issue #1235)", () => {
  assertEquals(parseAllowActionArg("denoland/setup-deno,good/action"), [
    "denoland/setup-deno",
    "good/action",
  ]);
  for (const bad of ["../..", "*/*", "owner/./repo", "owner/repo/sub"]) {
    assertThrows(
      () => parseAllowActionArg(bad),
      Error,
      "--allow-action expects owner/repo",
    );
  }
});

Deno.test("buildAllowedActionPatterns - a wildcard or traversal coordinate never becomes an allow-list pattern (Issue #1235)", () => {
  assertEquals(
    buildAllowedActionPatterns([
      "*/*",
      "owner/*",
      "../../victim",
      "./local",
      "owner/repo with space",
      "denoland/setup-deno",
    ]),
    ["denoland/setup-deno@*"],
  );
});

Deno.test("planRepoSettingsHardening - a selected allow-list missing a required pattern plans an extension that keeps the existing patterns (Issue #4424)", () => {
  const plan = planRepoSettingsHardening(
    {
      ...HARDENED,
      selectedActions: {
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: [
          "aquasecurity/trivy-action@*",
          "denoland/setup-deno@*",
        ],
      },
    },
    {
      thirdPartyPatterns: [
        "aquasecurity/setup-trivy@*",
        "aquasecurity/trivy-action@*",
        "denoland/setup-deno@*",
      ],
      requireReviews: false,
      defaultBranch: "Develop",
    },
  );
  assertEquals(plan.length, 1);
  const step = plan[0]!;
  assertEquals(step.kind, "actions-allow-list");
  assertEquals(step.endpoint, "actions/permissions/selected-actions");
  const body = JSON.parse(step.body ?? "{}") as {
    patterns_allowed: string[];
    github_owned_allowed: boolean;
  };
  assertEquals(body.patterns_allowed, [
    "aquasecurity/setup-trivy@*",
    "aquasecurity/trivy-action@*",
    "denoland/setup-deno@*",
  ]);
  assertEquals(body.github_owned_allowed, true);
  assert(step.title.includes("aquasecurity/setup-trivy@*"), step.title);
});

Deno.test("planRepoSettingsHardening - a selected allow-list that already covers every pattern plans nothing (Issue #4424)", () => {
  const plan = planRepoSettingsHardening(
    {
      ...HARDENED,
      selectedActions: {
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: ["aquasecurity/trivy-action@*", "extra/allowed@*"],
      },
    },
    {
      thirdPartyPatterns: ["aquasecurity/trivy-action@*"],
      requireReviews: false,
      defaultBranch: "Develop",
    },
  );
  assertEquals(plan, []);
});

Deno.test("allowListCovers - GitHub allow-list globs: owner/repo@*, owner/* and a whole-owner wildcard cover; a version-prefixed pattern does not cover every ref (Issue #4424)", () => {
  assert(
    allowListCovers(
      ["aquasecurity/setup-trivy@*"],
      "aquasecurity/setup-trivy@*",
    ),
  );
  assert(allowListCovers(["aquasecurity/*"], "aquasecurity/setup-trivy@*"));
  assert(
    !allowListCovers(
      ["aquasecurity/trivy-action@*"],
      "aquasecurity/setup-trivy@*",
    ),
  );
  assert(
    !allowListCovers(
      ["aquasecurity/setup-trivy@v1*"],
      "aquasecurity/setup-trivy@*",
    ),
  );
  assert(!allowListCovers([], "aquasecurity/setup-trivy@*"));
  // Multi-wildcard and exact patterns, after the matcher stopped building a
  // regular expression from the allow-list (Issue #1235).
  assert(allowListCovers(["*/setup-*"], "aquasecurity/setup-trivy@*"));
  assert(!allowListCovers(["*/setup-*x"], "aquasecurity/setup-trivy@*"));
  assert(
    !allowListCovers(
      ["aquasecurity/setup-trivy"],
      "aquasecurity/setup-trivy@*",
    ),
  );
});

// =============================================================================
// Issue #4397 — code-owner review without stopping the fleet
// =============================================================================

Deno.test("planRepoSettingsHardening - requireCodeOwnerReview plans code-owner review only, leaving the approval count alone (Issue #4397)", () => {
  const plan = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: [],
    requireReviews: false,
    requireCodeOwnerReview: true,
    defaultBranch: "Develop",
  });
  const rule = plan.find((s) => s.kind === "ruleset-reviews");
  assert(rule, "the code-owner step is planned");
  const body = JSON.parse(rule.body ?? "{}") as Record<string, unknown>;
  assertEquals(body, { require_code_owner_review: true });
  assert(rule.title.includes("code-owner"), rule.title);
  // The warning describes the actual blast radius: owned paths only.
  assert(rule.warning?.includes("CODEOWNERS"), rule.warning);
  assert(!rule.warning?.includes("Stops the fleet"), rule.warning);
});

Deno.test("planRepoSettingsHardening - requireCodeOwnerReview plans nothing when the rule already enforces it, and requireReviews takes precedence when both are set (Issue #4397)", () => {
  const ownerOnly = {
    ...HARDENED,
    rules: [{
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 0,
      },
    }],
  };
  assertEquals(
    planRepoSettingsHardening(ownerOnly, {
      thirdPartyPatterns: ["x/y@*"],
      requireReviews: false,
      requireCodeOwnerReview: true,
      defaultBranch: "Develop",
    }),
    [],
  );
  const both = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: [],
    requireReviews: true,
    requireCodeOwnerReview: true,
    defaultBranch: "Develop",
  });
  const rule = both.find((s) => s.kind === "ruleset-reviews")!;
  const body = JSON.parse(rule.body ?? "{}") as Record<string, unknown>;
  assertEquals(body.required_approving_review_count, 1);
});

// ---------------------------------------------------------------------------
// Milestone branches must be creatable (Issue #3912 follow-up)
// ---------------------------------------------------------------------------

/** A milestone ruleset that enforces its checks on branch creation. */
function milestoneRuleset(
  doNotEnforceOnCreate: boolean,
): NonNullable<RepoSettingsSnapshot["rulesets"]>[number] {
  return {
    id: 22357806,
    name: "Vibe Coder milestone branches",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }],
    conditions: { ref_name: { include: [MILESTONE_REF_PATTERN], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: doNotEnforceOnCreate,
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "Quality Checks" }],
        },
      },
    ],
  };
}

const PLAN_OPTS = {
  thirdPartyPatterns: [],
  requireReviews: false,
  defaultBranch: "main",
};

Deno.test("planRepoSettingsHardening - a milestone ruleset enforced on create is planned open (Issue #3912)", () => {
  // Observed 2026-09-06 on NEAT-AI-Ockham: the self-heal that recreates a
  // missing milestone branch could not push it —
  //   "5 of 6 required status checks are expected … push declined"
  // A branch that does not exist yet has no check runs, so the checks can
  // never be satisfied and only an admin bypass gets through.
  const plan = planRepoSettingsHardening(
    { rulesets: [milestoneRuleset(false)] },
    PLAN_OPTS,
  );
  const step = plan.find((s) => s.kind === "milestone-branch-create");
  assert(
    step,
    `a create-blocking milestone ruleset is planned: ${
      JSON.stringify(plan.map((s) => s.kind))
    }`,
  );
  assertEquals(step.method, "PUT");
  assertEquals(step.endpoint, "rulesets/22357806");

  const body = JSON.parse(step.body ?? "{}");
  const checks = body.rules.find((r: { type: string }) =>
    r.type === "required_status_checks"
  );
  // The flag is flipped...
  assertEquals(checks.parameters.do_not_enforce_on_create, true);
  // ...and nothing else about the rule is disturbed. The contexts still gate
  // the MERGE, and `required_status_checks` stays present — which is what
  // `isBaseProtected` reads when deciding whether to arm auto-merge at PR
  // creation. Dropping the rule would silently disable that.
  assertEquals(checks.parameters.strict_required_status_checks_policy, true);
  assertEquals(checks.parameters.required_status_checks.length, 1);
  assertEquals(body.rules.map((r: { type: string }) => r.type), [
    "deletion",
    "non_fast_forward",
    "required_status_checks",
  ]);
  // The rulesets API takes a whole ruleset, so everything untouched is echoed.
  assertEquals(body.name, "Vibe Coder milestone branches");
  assertEquals(body.enforcement, "active");
  assertEquals(body.bypass_actors.length, 1);
});

Deno.test("planRepoSettingsHardening - a milestone ruleset already open plans nothing (Issue #3912)", () => {
  const plan = planRepoSettingsHardening(
    { rulesets: [milestoneRuleset(true)] },
    PLAN_OPTS,
  );
  assertEquals(plan.filter((s) => s.kind === "milestone-branch-create"), []);
});

Deno.test("planRepoSettingsHardening - rulesets that do not govern milestone branches are left alone (Issue #3912)", () => {
  // The default-branch ruleset SHOULD enforce on create: nobody recreates the
  // default branch, and relaxing it there would weaken the real gate.
  const defaultBranchRuleset = {
    ...milestoneRuleset(false),
    id: 21019403,
    name: "main",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  };
  const plan = planRepoSettingsHardening(
    { rulesets: [defaultBranchRuleset] },
    PLAN_OPTS,
  );
  assertEquals(plan.filter((s) => s.kind === "milestone-branch-create"), []);
});

Deno.test("planRepoSettingsHardening - a milestone ruleset with no status checks plans nothing (Issue #3912)", () => {
  // Nothing to relax: without `required_status_checks` there is no
  // create-time enforcement to lift — and no protected base either, which is
  // a separate problem this step does not pretend to solve.
  const noChecks = {
    ...milestoneRuleset(false),
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  };
  const plan = planRepoSettingsHardening({ rulesets: [noChecks] }, PLAN_OPTS);
  assertEquals(plan.filter((s) => s.kind === "milestone-branch-create"), []);
});

// ---------------------------------------------------------------------------
// hardenRepo + findCodeownersOnDefaultBranch (Issue #2626)
// ---------------------------------------------------------------------------

interface RecordedWrite {
  method: string;
  endpoint: string;
  body?: unknown;
}

const NOT_FOUND = () => new Error("gh: Not Found (HTTP 404)");
const SERVER_ERROR = () => new Error("HTTP 500: server error");

/**
 * A routing `gh` stub: answers each read endpoint from `routes` (a value is
 * returned as JSON, an Error is thrown, an unknown endpoint is a 404) and
 * records every write, reading the `--input` body while the call is live.
 */
function makeGh(routes: Record<string, unknown>) {
  const writes: RecordedWrite[] = [];
  const reads: string[] = [];
  const gh = async (args: string[]): Promise<string> => {
    const m = args.indexOf("--method");
    if (m >= 0) {
      const i = args.indexOf("--input");
      writes.push({
        method: args[m + 1] ?? "",
        endpoint: args[m + 2] ?? "",
        body: i >= 0
          ? JSON.parse(await Deno.readTextFile(args[i + 1] ?? ""))
          : undefined,
      });
      return "{}";
    }
    if (args.includes("--jq") && args.includes(".default_branch")) {
      return "main";
    }
    const endpoint = args[1] ?? "";
    reads.push(endpoint);
    const value = routes[endpoint];
    if (value instanceof Error) throw value;
    if (value === undefined) throw NOT_FOUND();
    return JSON.stringify(value);
  };
  return { gh, writes, reads };
}

// Every temp path the #2626 tests create, removed when the module unloads.
const TEMP_PATHS: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const path of TEMP_PATHS) {
    Deno.removeSync(path, { recursive: true });
  }
});

/** A temp directory; with `checkout`, a `.git` and one pinned workflow. */
async function makeWorkDir(checkout: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-harden-" });
  TEMP_PATHS.push(dir);
  if (checkout) {
    await Deno.mkdir(`${dir}/.git`);
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000\n",
    );
  }
  return dir;
}

// Keeps the default-branch lookup off the worker's real disk cache.
const BRANCH_CACHE = await Deno.makeTempFile({ prefix: "vibe-harden-cache-" });
TEMP_PATHS.push(BRANCH_CACHE);

let repoCounter = 0;
/** Unique per test: the default-branch lookup is memory-cached by repo. */
function uniqueRepo(): string {
  repoCounter += 1;
  return `harden-test/repo-${Date.now()}-${repoCounter}`;
}

/** Every surface already hardened, as the read endpoints return them. */
function hardenedRoutes(repo: string): Record<string, unknown> {
  return {
    [`repos/${repo}`]: {
      visibility: "public",
      private: false,
      security_and_analysis: {
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
      },
    },
    [`repos/${repo}/actions/permissions/workflow`]: {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    },
    [`repos/${repo}/actions/permissions`]: {
      enabled: true,
      allowed_actions: "selected",
      sha_pinning_required: true,
    },
    [`repos/${repo}/actions/permissions/selected-actions`]: {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: [],
    },
    [`repos/${repo}/rules/branches/main`]: [{
      type: "pull_request",
      parameters: { require_code_owner_review: true },
    }],
    [`repos/${repo}/rulesets`]: [],
  };
}

const VIBE_RULESET = {
  id: 7,
  name: "Vibe Coder default branch",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    {
      type: "pull_request",
      parameters: {
        require_code_owner_review: false,
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
      },
    },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "quality" }] },
    },
  ],
};

/** Routes for a repo whose default branch lacks code-owner review. */
function codeOwnerRoutes(
  repo: string,
  rulesets: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/rules/branches/main`] = [{
    type: "pull_request",
    parameters: { require_code_owner_review: false },
  }];
  routes[`repos/${repo}/rulesets`] = rulesets.map((r) => ({
    id: r["id"],
    name: r["name"],
    target: r["target"],
    enforcement: r["enforcement"],
  }));
  for (const r of rulesets) routes[`repos/${repo}/rulesets/${r["id"]}`] = r;
  return routes;
}

Deno.test("hardenRepo - a Vibe-only ruleset gets exactly one write turning on code-owner review (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [VIBE_RULESET]));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.method, "PUT");
  assertEquals(writes[0]?.endpoint, `repos/${repo}/rulesets/7`);
  const expected = structuredClone(VIBE_RULESET.rules);
  expected[0]!.parameters = {
    ...expected[0]!.parameters,
    require_code_owner_review: true,
  } as typeof expected[0]["parameters"];
  assertEquals(writes[0]?.body, { rules: expected });
  assertEquals(report.results.map((r) => r.status), ["applied"]);
});

Deno.test("hardenRepo - the Vibe ruleset is preferred over the branch-named one (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const legacy = { ...VIBE_RULESET, id: 3, name: "main" };
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [legacy, VIBE_RULESET]));
  await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes.map((w) => w.endpoint), [`repos/${repo}/rulesets/7`]);
});

Deno.test("hardenRepo - the branch-named ruleset is still used when no Vibe ruleset exists (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const legacy = { ...VIBE_RULESET, id: 3, name: "main" };
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [legacy]));
  await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes.map((w) => w.endpoint), [`repos/${repo}/rulesets/3`]);
});

Deno.test("hardenRepo - no matching ruleset fails naming both the branch and the Vibe ruleset (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const other = { ...VIBE_RULESET, id: 9, name: "legacy" };
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [other]));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes, []);
  const reviews = report.results.find((r) => r.step.kind === "ruleset-reviews");
  assertEquals(reviews?.status, "failed");
  assert(reviews?.detail?.includes("main"), reviews?.detail);
  assert(
    reviews?.detail?.includes("Vibe Coder default branch"),
    reviews?.detail,
  );
});

Deno.test("hardenRepo - review requirement stays off without requireReviews (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [VIBE_RULESET]));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  const body = writes[0]?.body as {
    rules: Array<{ parameters?: Record<string, unknown> }>;
  };
  assertEquals(body.rules[0]?.parameters?.required_approving_review_count, 0);
  assertEquals(report.results.length, 1);
});

Deno.test("hardenRepo - without a local checkout the allow-list is skipped, never written (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/actions/permissions`] = {
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: true,
  };
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(false),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  const allowList = report.results.filter((r) =>
    r.step.kind === "actions-allow-list"
  );
  assertEquals(allowList.length, 1);
  assertEquals(allowList[0]?.status, "skipped");
  assertEquals(allowList[0]?.detail, "no local checkout");
});

Deno.test("hardenRepo - a missing checkout records the skip even when nothing else is planned (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh(hardenedRoutes(repo));
  const report = await hardenRepo(repo, {
    apply: false,
    ghCommandFn: gh,
    workDir: await makeWorkDir(false),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assertEquals(
    report.results.map((r) => [r.step.kind, r.status, r.detail]),
    [["actions-allow-list", "skipped", "no local checkout"]],
  );
});

Deno.test("hardenRepo - a failed workflow-permissions read is a failure naming the endpoint, with no write (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/actions/permissions/workflow`] = SERVER_ERROR();
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  const failed = report.results.filter((r) => r.status === "failed");
  assertEquals(failed.length, 1);
  assertEquals(failed[0]?.step.kind, "workflow-token");
  assert(
    failed[0]?.detail?.includes(`repos/${repo}/actions/permissions/workflow`),
    failed[0]?.detail,
  );
});

Deno.test("hardenRepo - a 404 surface is absent, not a failure (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/actions/permissions/workflow`] = NOT_FOUND();
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assertEquals(report.results, []);
});

Deno.test("hardenRepo - an already-hardened repo makes zero writes under apply (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh(hardenedRoutes(repo));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes, []);
  assertEquals(report.results, []);
  assertEquals(report.skipNote, undefined);
});

Deno.test("hardenRepo - never throws when every read fails (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh({});
  const failing = async (args: string[]): Promise<string> => {
    if (args.includes(".default_branch")) return await gh(args);
    throw SERVER_ERROR();
  };
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: failing,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assert(report.results.length > 0);
  assert(report.results.every((r) => r.status === "failed"));
});

Deno.test("hardenRepo - an unknown default branch is one failed result, not a throw (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: () => Promise.reject(SERVER_ERROR()),
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(report.results.length, 1);
  assertEquals(report.results[0]?.status, "failed");
  assert(
    report.results[0]?.detail?.startsWith("default branch unknown"),
    report.results[0]?.detail,
  );
});

Deno.test("hardenRepo - a private repo with scanning off returns the paid-add-on skip note (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}`] = {
    visibility: "private",
    private: true,
    security_and_analysis: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
  };
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assertEquals(report.skipNote, SECRET_PROTECTION_SKIP_NOTE);
});

for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
  Deno.test(`findCodeownersOnDefaultBranch - present at ${path} (Issue #2626)`, async () => {
    const repo = "harden-test/codeowners";
    const { gh } = makeGh({
      [`repos/${repo}/contents/${path}`]: { path, type: "file" },
    });
    assertEquals(await findCodeownersOnDefaultBranch(repo, gh), {
      state: "present",
      path,
    });
  });
}

Deno.test("findCodeownersOnDefaultBranch - absent when every location is a 404 (Issue #2626)", async () => {
  const repo = "harden-test/codeowners";
  const { gh, reads } = makeGh({});
  assertEquals(await findCodeownersOnDefaultBranch(repo, gh), {
    state: "absent",
  });
  assertEquals(reads.length, 3);
});

Deno.test("findCodeownersOnDefaultBranch - a non-404 error is an error, never absent (Issue #2626)", async () => {
  const repo = "harden-test/codeowners";
  const { gh } = makeGh({
    [`repos/${repo}/contents/.github/CODEOWNERS`]: SERVER_ERROR(),
  });
  const result = await findCodeownersOnDefaultBranch(repo, gh);
  assertEquals(result.state, "error");
  assert(
    result.state === "error" && result.message.includes("HTTP 500"),
    JSON.stringify(result),
  );
});

Deno.test("findCodeownersOnDefaultBranch - an invalid repo is an error without a call (Issue #2626)", async () => {
  const { gh, reads } = makeGh({});
  const result = await findCodeownersOnDefaultBranch("not a repo", gh);
  assertEquals(result.state, "error");
  assertEquals(reads, []);
});

Deno.test("hardenRepo - an invalid repo is one failed result and no gh call (Issue #2626)", async () => {
  const { gh, writes, reads } = makeGh({});
  const report = await hardenRepo("bad repo;x", {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(report.results.map((r) => r.status), ["failed"]);
  assertEquals(reads, []);
  assertEquals(writes, []);
});

Deno.test("hardenRepo - a Vibe ruleset with no pull_request rule fails without a write (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const noPullRequest = {
    ...VIBE_RULESET,
    rules: VIBE_RULESET.rules.filter((r) => r.type !== "pull_request"),
  };
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [noPullRequest]));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: await makeWorkDir(true),
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes, []);
  const reviews = report.results.find((r) => r.step.kind === "ruleset-reviews");
  assertEquals(reviews?.status, "failed");
  assert(reviews?.detail?.includes("no pull_request rule"), reviews?.detail);
});

Deno.test("hardenRepo - a checkout probe fault other than NotFound fails loud, never skips (Issue #2626)", async () => {
  const repo = uniqueRepo();
  // A file as the work dir: stat of `<file>/.git` is ENOTDIR, not NotFound.
  const notADir = await Deno.makeTempFile({ prefix: "vibe-harden-file-" });
  TEMP_PATHS.push(notADir);
  const { gh, writes } = makeGh(hardenedRoutes(repo));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    workDir: notADir,
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assert(report.results.length > 0);
  assert(report.results.every((r) => r.status === "failed"));
  assert(!report.results.some((r) => r.status === "skipped"));
});
