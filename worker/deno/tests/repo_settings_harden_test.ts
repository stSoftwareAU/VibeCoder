/**
 * Tests for `repo-settings-harden` (Issues #4397, #4398, #4401): the
 * write-side twin of the settings pre-filer. It reads the same four
 * surfaces, plans the changes that close each open setting, and applies
 * them only under `--apply`. One approving review on the default branch is
 * part of the default plan (Issue #2680); code-owner review stays opt-in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseAllowActionArg } from "../commands/repo_settings_harden.ts";
import { buildMilestoneRulesetBody } from "../lib/repo_rulesets.ts";
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

Deno.test("planRepoSettingsHardening - an open repository plans every safe change; code-owner review only when asked for (Issues #4397 #4398 #4401)", () => {
  const plan = planRepoSettingsHardening(OPEN, {
    thirdPartyPatterns: ["denoland/setup-deno@*"],
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
  assert(
    !plan.some((s) => s.kind === "ruleset-reviews"),
    "code-owner review is opt-in",
  );
});

Deno.test("planRepoSettingsHardening - a hardened repository plans nothing (Issues #4397 #4398 #4401)", () => {
  assertEquals(
    planRepoSettingsHardening(HARDENED, {
      thirdPartyPatterns: ["x/y@*"],
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

Deno.test("planRepoSettingsHardening - requireCodeOwnerReview plans nothing when the rule already enforces it (Issue #4397)", () => {
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
      requireCodeOwnerReview: true,
      defaultBranch: "Develop",
    }),
    [],
  );
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
    // A string is a raw file body (`Accept: application/vnd.github.raw+json`).
    return typeof value === "string" ? value : JSON.stringify(value);
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
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 1,
      },
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

/**
 * Routes for a repo whose default branch lacks code-owner review. Like
 * GitHub, each pull_request rule on the branch names the ruleset it comes
 * from (`ruleset_id`), one per ruleset that holds one.
 */
function codeOwnerRoutes(
  repo: string,
  rulesets: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const routes = hardenedRoutes(repo);
  // One approval already holds, so only the code-owner step is in play.
  routes[`repos/${repo}/rules/branches/main`] = rulesets
    .filter((r) =>
      (r["rules"] as Array<{ type: string }>).some((rule) =>
        rule.type === "pull_request"
      )
    )
    .map((r) => ({
      type: "pull_request",
      ruleset_id: r["id"],
      parameters: {
        require_code_owner_review: false,
        required_approving_review_count: 1,
      },
    }));
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
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes.map((w) => w.endpoint), [`repos/${repo}/rulesets/7`]);
});

Deno.test("hardenRepo - code-owner review goes to the ruleset the branch's pull_request rule names, whatever it is called (Issue #2685)", async () => {
  const repo = uniqueRepo();
  // GRQ: the pull_request rule sits in a ruleset named neither after the
  // branch nor "Vibe Coder default branch".
  const grq = { ...VIBE_RULESET, id: 42, name: "Protect Develop" };
  const unrelated = {
    ...VIBE_RULESET,
    id: 9,
    name: "tags",
    rules: [{ type: "deletion" }],
  };
  const { gh, writes } = makeGh(codeOwnerRoutes(repo, [unrelated, grq]));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes.map((w) => w.endpoint), [`repos/${repo}/rulesets/42`]);
  assertEquals(report.results.map((r) => r.status), ["applied"]);
});

Deno.test("hardenRepo - no pull_request rule on the branch at apply time fails naming the branch, with no write (Issue #2685)", async () => {
  const repo = uniqueRepo();
  let branchReads = 0;
  const { gh: base, writes } = makeGh(codeOwnerRoutes(repo, [VIBE_RULESET]));
  // The plan sees the rule; by the write it has gone (a concurrent edit).
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === `repos/${repo}/rules/branches/main` && ++branchReads > 1) {
      return Promise.resolve("[]");
    }
    return base(args);
  };
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes, []);
  const reviews = report.results.find((r) => r.step.kind === "ruleset-reviews");
  assertEquals(reviews?.status, "failed");
  assert(reviews?.detail?.includes("main"), reviews?.detail);
  assert(reviews?.detail?.includes("pull_request"), reviews?.detail);
});

/** Routes serving `files` from the default branch through the contents API. */
function workflowRoutes(
  repo: string,
  files: Record<string, string>,
): Record<string, unknown> {
  const routes: Record<string, unknown> = {};
  const listings: Record<string, Array<Record<string, string>>> = {};
  for (const [path, body] of Object.entries(files)) {
    routes[`repos/${repo}/contents/${path}?ref=main`] = body;
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = parts.slice(0, i).join("/");
      const child = parts.slice(0, i + 1).join("/");
      const entries = listings[dir] ??= [];
      if (entries.some((e) => e["path"] === child)) continue;
      entries.push({
        name: parts[i]!,
        path: child,
        type: i === parts.length - 1 ? "file" : "dir",
      });
    }
  }
  for (const [dir, entries] of Object.entries(listings)) {
    routes[`repos/${repo}/contents/${dir}?ref=main`] = entries;
  }
  return routes;
}

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";

Deno.test("hardenRepo - the allow-list is built from the default branch's workflows and local composite actions read through the API, with no checkout (Issue #2685)", async () => {
  const repo = uniqueRepo();
  const routes = {
    ...hardenedRoutes(repo),
    ...workflowRoutes(repo, {
      ".github/workflows/ci.yml":
        `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA_A}\n      - uses: acme/deploy-action@${SHA_A}\n      - uses: ./.github/actions/setup\n`,
      ".github/workflows/notes.md": "uses: ignored/not-a-workflow@v1\n",
      ".github/actions/setup/action.yml":
        `runs:\n  using: composite\n  steps:\n    - uses: other/tool@${SHA_B}\n`,
    }),
  };
  routes[`repos/${repo}/actions/permissions`] = {
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: true,
  };
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
  });
  const allowList = writes.find((w) =>
    w.endpoint === `repos/${repo}/actions/permissions/selected-actions`
  );
  assertEquals(allowList?.body, {
    github_owned_allowed: true,
    verified_allowed: false,
    patterns_allowed: ["acme/deploy-action@*", "other/tool@*"],
  });
  assertEquals(report.referenceCount, 3);
  assertEquals(
    report.results.filter((r) => r.step.kind === "actions-allow-list")
      .map((r) => r.status),
    ["applied"],
  );
});

Deno.test("hardenRepo - an unreadable workflow directory fails the allow-list alone, never writing an empty list (Issue #2685)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/actions/permissions`] = {
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: true,
  };
  routes[`repos/${repo}/contents/.github/workflows?ref=main`] = SERVER_ERROR();
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  const allowList = report.results.filter((r) =>
    r.step.kind === "actions-allow-list"
  );
  assertEquals(allowList.map((r) => r.status), ["failed"]);
  assert(allowList[0]?.detail?.includes("HTTP 500"), allowList[0]?.detail);
});

Deno.test("hardenRepo - a failed workflow-permissions read is a failure naming the endpoint, with no write (Issue #2626)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/actions/permissions/workflow`] = SERVER_ERROR();
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
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
    defaultBranchCachePath: BRANCH_CACHE,
    requireCodeOwnerReview: true,
  });
  assertEquals(writes, []);
  const reviews = report.results.find((r) => r.step.kind === "ruleset-reviews");
  assertEquals(reviews?.status, "failed");
  assert(reviews?.detail?.includes("no pull_request rule"), reviews?.detail);
});

// ---------------------------------------------------------------------------
// One approving review on the default branch by default (Issue #2680)
// ---------------------------------------------------------------------------

/** GRQ's shape: a human ruleset carrying the pull_request rule at zero. */
const REQUIRE_PULL_RULESET = {
  id: 20,
  name: "Develop Require pull",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  bypass_actors: [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    { actor_id: 22807563, actor_type: "User", bypass_mode: "pull_request" },
  ],
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [{
    type: "pull_request",
    parameters: {
      allowed_merge_methods: ["squash"],
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
    } as Record<string, unknown>,
  }],
};

/** A human ruleset with required checks and no pull_request rule. */
const CHECKS_ONLY_RULESET = {
  id: 21,
  name: "Main",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  bypass_actors: [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "quality" }],
      } as Record<string, unknown>,
    },
  ],
};

type TestRuleset = {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  source_type: string;
  bypass_actors: unknown[];
  conditions: unknown;
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
};

/** The worker's own ruleset holding status checks only (NEAT-AI-Refinery). */
const VIBE_CHECKS_ONLY: TestRuleset = {
  ...CHECKS_ONLY_RULESET,
  id: 7,
  name: "Vibe Coder default branch",
  bypass_actors: [],
  rules: [CHECKS_ONLY_RULESET.rules[1]!],
};

/** The pull_request rule a create or an add writes: one approval, nothing more. */
const NEW_PULL_REQUEST_RULE = {
  type: "pull_request",
  parameters: {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  },
};

/** The effective branch rules GitHub reports for a set of rulesets. */
function branchRulesOf(rulesets: readonly TestRuleset[]) {
  return rulesets.flatMap((r) =>
    r.rules.map((rule) => ({
      ...rule,
      ruleset_id: r.id,
      ruleset_source_type: "Repository",
    }))
  );
}

interface ApprovalRepo {
  rulesets: readonly TestRuleset[];
  topics?: string[] | Error;
  /** Default-branch history, newest first; a missing `pr` is a direct push. */
  commits?: Array<{ sha: string; subject: string; pr?: boolean }>;
}

/** Routes for a hardened repo whose default-branch reviews are as given. */
function approvalRoutes(
  repo: string,
  state: ApprovalRepo,
): Record<string, unknown> {
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/rules/branches/main`] = branchRulesOf(state.rulesets);
  routes[`repos/${repo}/rulesets`] = state.rulesets.map((r) => ({
    id: r.id,
    name: r.name,
    target: r.target,
    enforcement: r.enforcement,
    source_type: r.source_type,
  }));
  for (const r of state.rulesets) routes[`repos/${repo}/rulesets/${r.id}`] = r;
  routes[`repos/${repo}/topics`] = state.topics instanceof Error
    ? state.topics
    : { names: state.topics ?? [] };
  const commits = state.commits ?? [
    { sha: "a".repeat(40), subject: "Fix a thing (#12)", pr: true },
  ];
  routes[`repos/${repo}/commits?sha=main&per_page=20`] = commits.map((c) => ({
    sha: c.sha,
    commit: { message: c.subject },
  }));
  for (const c of commits) {
    routes[`repos/${repo}/commits/${c.sha}/pulls`] = c.pr
      ? [{ number: 1, merged_at: "2026-09-26T00:00:00Z" }]
      : [];
  }
  return routes;
}

async function hardenApproval(repo: string, state: ApprovalRepo) {
  const recorded = makeGh(approvalRoutes(repo, state));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: recorded.gh,
    defaultBranchCachePath: BRANCH_CACHE,
  });
  const approval = report.results.filter((r) =>
    r.step.kind === "default-branch-approval"
  );
  return { ...recorded, report, approval };
}

Deno.test("hardenRepo - a pull_request rule at zero approvals is raised to one in the ruleset that carries it, keeping every other rule, parameter and bypass actor (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes, reads, approval } = await hardenApproval(repo, {
    rulesets: [CHECKS_ONLY_RULESET, REQUIRE_PULL_RULESET],
  });

  assertEquals(writes.length, 1, JSON.stringify(writes));
  assertEquals(writes[0]?.method, "PUT");
  assertEquals(writes[0]?.endpoint, `repos/${repo}/rulesets/20`);
  const raised = structuredClone(REQUIRE_PULL_RULESET.rules);
  raised[0]!.parameters.required_approving_review_count = 1;
  assertEquals(writes[0]?.body, {
    name: REQUIRE_PULL_RULESET.name,
    target: "branch",
    enforcement: "active",
    bypass_actors: REQUIRE_PULL_RULESET.bypass_actors,
    conditions: REQUIRE_PULL_RULESET.conditions,
    rules: raised,
  });
  assertEquals(approval.map((r) => r.status), ["applied"]);
  // A pull_request rule already refuses direct pushes, so raising its count
  // needs no push-policy read.
  assert(!reads.includes(`repos/${repo}/topics`), reads.join("\n"));
});

Deno.test("hardenRepo - the worker's own ruleset without a pull_request rule gains one on a PR-only branch (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes, approval } = await hardenApproval(repo, {
    rulesets: [VIBE_CHECKS_ONLY],
  });

  assertEquals(writes.map((w) => `${w.method} ${w.endpoint}`), [
    `PUT repos/${repo}/rulesets/7`,
  ]);
  const body = writes[0]?.body as { name: string; rules: unknown[] };
  assertEquals(body.name, "Vibe Coder default branch");
  assertEquals(body.rules, [...VIBE_CHECKS_ONLY.rules, NEW_PULL_REQUEST_RULE]);
  assertEquals(approval.map((r) => r.status), ["applied"]);
});

Deno.test("hardenRepo - no ruleset covering the default branch creates the worker's own with one required approval (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes, approval } = await hardenApproval(repo, { rulesets: [] });

  assertEquals(writes.map((w) => `${w.method} ${w.endpoint}`), [
    `POST repos/${repo}/rulesets`,
  ]);
  assertEquals(writes[0]?.body, {
    name: "Vibe Coder default branch",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [NEW_PULL_REQUEST_RULE],
  });
  assertEquals(approval.map((r) => r.status), ["applied"]);
});

Deno.test("hardenRepo - a human ruleset with no pull_request rule is left alone; the approval goes in the worker's own new ruleset (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes } = await hardenApproval(repo, {
    rulesets: [CHECKS_ONLY_RULESET],
  });

  assertEquals(writes.map((w) => `${w.method} ${w.endpoint}`), [
    `POST repos/${repo}/rulesets`,
  ]);
  const body = writes[0]?.body as { name: string; rules: unknown[] };
  assertEquals(body.name, "Vibe Coder default branch");
  assertEquals(body.rules, [NEW_PULL_REQUEST_RULE]);
});

Deno.test("hardenRepo - a default branch already requiring an approval gets no write and no push-policy read (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const compliant = structuredClone(REQUIRE_PULL_RULESET);
  compliant.rules[0]!.parameters.required_approving_review_count = 1;
  const { writes, reads, approval } = await hardenApproval(repo, {
    rulesets: [CHECKS_ONLY_RULESET, compliant],
  });

  assertEquals(writes, []);
  assertEquals(approval, []);
  assert(!reads.includes(`repos/${repo}/topics`), reads.join("\n"));
});

Deno.test("planRepoSettingsHardening - the strictest pull_request rule decides: one at zero beside one at two is compliant (Issue #2680)", () => {
  const two = structuredClone(REQUIRE_PULL_RULESET);
  two.id = 30;
  two.rules[0]!.parameters.required_approving_review_count = 2;
  const rulesets = [REQUIRE_PULL_RULESET, two];
  const plan = planRepoSettingsHardening(
    { rules: branchRulesOf(rulesets), rulesets },
    PLAN_OPTS,
  );
  assertEquals(plan, []);
});

Deno.test("planRepoSettingsHardening - the worker's own pull_request rule is raised, never duplicated, when the branch rules carry no ruleset id (Issue #2680)", () => {
  const plan = planRepoSettingsHardening({
    rules: [{
      type: "pull_request",
      parameters: { required_approving_review_count: 0 },
    }],
    rulesets: [VIBE_RULESET],
  }, PLAN_OPTS);
  assertEquals(plan.length, 1);
  assertEquals(plan[0]?.endpoint, "rulesets/7");
  assertEquals(plan[0]?.held, undefined);
  const body = JSON.parse(plan[0]?.body ?? "{}") as {
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  const pullRequests = body.rules.filter((r) => r.type === "pull_request");
  assertEquals(pullRequests.length, 1);
  assertEquals(pullRequests[0]?.parameters, {
    ...VIBE_RULESET.rules[0]!.parameters,
    required_approving_review_count: 1,
  });
});

Deno.test("hardenRepo - a direct-push default branch gets no pull_request rule, and the skip names the direct push for the owner (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const sha = "b".repeat(40);
  const { writes, approval } = await hardenApproval(repo, {
    rulesets: [CHECKS_ONLY_RULESET],
    commits: [
      { sha: "a".repeat(40), subject: "Fix a thing (#12)", pr: true },
      { sha, subject: "Auto commit models" },
    ],
  });

  assertEquals(writes, []);
  assertEquals(approval.length, 1);
  assertEquals(approval[0]?.status, "skipped");
  const detail = approval[0]?.detail ?? "";
  assert(detail.includes("direct-push"), detail);
  assert(detail.includes("Auto commit models"), detail);
  assert(detail.includes(sha.slice(0, 7)), detail);
});

Deno.test("hardenRepo - the direct-push topic opts a branch out of the approval rule, reported as a skip (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes, approval } = await hardenApproval(repo, {
    rulesets: [],
    topics: ["direct-push"],
  });

  assertEquals(writes, []);
  assertEquals(approval.map((r) => r.status), ["skipped"]);
  assert(
    approval[0]?.detail?.includes("direct-push"),
    approval[0]?.detail,
  );
});

Deno.test("hardenRepo - an unreadable push policy adds no pull_request rule and fails loud (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { writes, approval } = await hardenApproval(repo, {
    rulesets: [],
    topics: SERVER_ERROR(),
  });

  assertEquals(writes, []);
  assertEquals(approval.map((r) => r.status), ["failed"]);
  assert(approval[0]?.detail?.includes("HTTP 500"), approval[0]?.detail);
});

Deno.test("hardenRepo - a dry run plans the approval create without writing (Issue #2680)", async () => {
  const repo = uniqueRepo();
  const { gh, writes } = makeGh(approvalRoutes(repo, { rulesets: [] }));
  const report = await hardenRepo(repo, {
    apply: false,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
  });
  assertEquals(writes, []);
  assertEquals(
    report.results.map((r) => [r.step.kind, r.status]),
    [["default-branch-approval", "planned"]],
  );
});

// ---------------------------------------------------------------------------
// Milestone sync converges without admin; fleet accounts at write (Issue #2690)
// ---------------------------------------------------------------------------

/** A default-branch ruleset whose pull_request rule allows every method. */
const ALL_METHODS_RULESET: TestRuleset = {
  id: 40,
  name: "Develop",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  bypass_actors: [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    {
      type: "pull_request",
      parameters: {
        allowed_merge_methods: ["merge", "squash", "rebase"],
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 1,
        required_review_thread_resolution: false,
      },
    },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "quality" }] },
    },
  ],
};

/** The worker's milestone ruleset: no pull_request rule (Issue #2690). */
const MILESTONE_RULESET: TestRuleset = {
  id: 41,
  name: "Vibe Coder milestone branches",
  target: "branch",
  enforcement: "active",
  source_type: "Repository",
  bypass_actors: [],
  conditions: { ref_name: { include: [MILESTONE_REF_PATTERN], exclude: [] } },
  rules: [
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: true,
        required_status_checks: [{ context: "quality" }],
      },
    },
  ],
};

function mergeSnapshot(
  rulesets: readonly TestRuleset[],
  allowMergeCommit: boolean | undefined,
  extra: Partial<RepoSettingsSnapshot> = {},
): RepoSettingsSnapshot {
  return {
    rules: branchRulesOf(
      rulesets.filter((r) => r.id !== MILESTONE_RULESET.id),
    ),
    rulesets: structuredClone(rulesets) as RepoSettingsSnapshot["rulesets"],
    allowMergeCommit,
    pushPolicy: { kind: "pr-only", sampled: 20 },
    ...extra,
  };
}

function pullRequestParams(body: string | undefined) {
  const parsed = JSON.parse(body ?? "{}") as {
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  return parsed.rules.filter((r) => r.type === "pull_request").map((r) =>
    r.parameters
  );
}

Deno.test("planRepoSettingsHardening - a squash-only repo gets merge commits on and its default branch kept squash-only by its own ruleset, everything else echoed (Issue #2690)", () => {
  const plan = planRepoSettingsHardening(
    mergeSnapshot([ALL_METHODS_RULESET, MILESTONE_RULESET], false),
    PLAN_OPTS,
  );
  assertEquals(plan.map((s) => s.kind), [
    "default-branch-squash-only",
    "merge-commit-allowed",
  ]);
  const squash = plan[0]!;
  assertEquals(squash.method, "PUT");
  assertEquals(squash.endpoint, "rulesets/40");
  const expected = structuredClone(ALL_METHODS_RULESET.rules);
  expected[1]!.parameters!.allowed_merge_methods = ["squash"];
  assertEquals(JSON.parse(squash.body ?? "{}"), {
    name: ALL_METHODS_RULESET.name,
    target: "branch",
    enforcement: "active",
    bypass_actors: ALL_METHODS_RULESET.bypass_actors,
    conditions: ALL_METHODS_RULESET.conditions,
    rules: expected,
  });
  const merge = plan[1]!;
  assertEquals(merge.method, "PATCH");
  assertEquals(merge.endpoint, "");
  assertEquals(JSON.parse(merge.body ?? "{}"), { allow_merge_commit: true });
  assertEquals(merge.held, undefined);
  // The milestone ruleset is never given a pull_request rule.
  assert(!plan.some((s) => s.endpoint === "rulesets/41"));
});

Deno.test("planRepoSettingsHardening - a default branch already squash-only plans only the merge-commit switch (Issue #2690)", () => {
  const squashOnly = structuredClone(ALL_METHODS_RULESET);
  squashOnly.rules[1]!.parameters!.allowed_merge_methods = ["squash"];
  const plan = planRepoSettingsHardening(
    mergeSnapshot([squashOnly, MILESTONE_RULESET], false),
    PLAN_OPTS,
  );
  assertEquals(plan.map((s) => s.kind), ["merge-commit-allowed"]);
});

Deno.test("planRepoSettingsHardening - merge commits already on still keeps the default branch squash-only; converged plans nothing (Issue #2690)", () => {
  const plan = planRepoSettingsHardening(
    mergeSnapshot([ALL_METHODS_RULESET, MILESTONE_RULESET], true),
    PLAN_OPTS,
  );
  assertEquals(plan.map((s) => s.kind), ["default-branch-squash-only"]);

  const squashOnly = structuredClone(ALL_METHODS_RULESET);
  squashOnly.rules[1]!.parameters!.allowed_merge_methods = ["squash"];
  assertEquals(
    planRepoSettingsHardening(
      mergeSnapshot([squashOnly, MILESTONE_RULESET], true),
      PLAN_OPTS,
    ),
    [],
  );
});

Deno.test("planRepoSettingsHardening - an unread merge setting plans no merge-method change (Issue #2690)", () => {
  const plan = planRepoSettingsHardening(
    mergeSnapshot([ALL_METHODS_RULESET], undefined),
    PLAN_OPTS,
  );
  assertEquals(plan, []);
});

Deno.test("planRepoSettingsHardening - approval and squash-only on one ruleset are one write, never two that overwrite each other (Issue #2690)", () => {
  const zero = structuredClone(ALL_METHODS_RULESET);
  zero.rules[1]!.parameters!.required_approving_review_count = 0;
  const plan = planRepoSettingsHardening(
    mergeSnapshot([zero], false),
    PLAN_OPTS,
  );
  assertEquals(plan.map((s) => s.kind), [
    "default-branch-approval",
    "merge-commit-allowed",
  ]);
  assertEquals(pullRequestParams(plan[0]!.body), [{
    ...zero.rules[1]!.parameters,
    required_approving_review_count: 1,
    allowed_merge_methods: ["squash"],
  }]);
});

Deno.test("planRepoSettingsHardening - a pull_request rule that also covers other branches is not made squash-only; the worker's own default-branch ruleset carries it (Issue #2690)", () => {
  const broad = structuredClone(ALL_METHODS_RULESET);
  broad.conditions = { ref_name: { include: ["~ALL"], exclude: [] } };
  const plan = planRepoSettingsHardening(
    mergeSnapshot([broad], false),
    PLAN_OPTS,
  );
  assertEquals(plan.map((s) => [s.kind, s.method, s.endpoint]), [
    ["default-branch-squash-only", "POST", "rulesets"],
    ["merge-commit-allowed", "PATCH", ""],
  ]);
  const body = JSON.parse(plan[0]!.body ?? "{}");
  assertEquals(body.name, "Vibe Coder default branch");
  assertEquals(body.conditions, {
    ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
  });
  assertEquals(
    pullRequestParams(plan[0]!.body)[0]?.allowed_merge_methods,
    ["squash"],
  );
});

Deno.test("planRepoSettingsHardening - a direct-push default branch that cannot be kept squash-only keeps merge commits off, reported (Issue #2690)", () => {
  const plan = planRepoSettingsHardening(
    mergeSnapshot([CHECKS_ONLY_RULESET as TestRuleset], false, {
      pushPolicy: {
        kind: "direct-push",
        sha: "b".repeat(40),
        subject: "Auto commit models",
        detail: "Auto commit models",
      },
    }),
    PLAN_OPTS,
  );
  const merge = plan.find((s) => s.kind === "merge-commit-allowed");
  assertEquals(merge?.held?.status, "skipped");
  assert(
    merge?.held?.detail.includes("squash-only") ?? false,
    merge?.held?.detail,
  );
});

Deno.test("applyRepoSettingsPlan - merge commits are not switched on when keeping the default branch squash-only failed (Issue #2690)", async () => {
  const plan = planRepoSettingsHardening(
    mergeSnapshot([ALL_METHODS_RULESET], false),
    PLAN_OPTS,
  );
  const attempted: string[] = [];
  const results = await applyRepoSettingsPlan("o/r", plan, {
    apply: true,
    ghCommandFn: (args) => {
      attempted.push(`${args[2]} ${args[3]}`);
      return args[3]?.includes("rulesets")
        ? Promise.reject(new Error("HTTP 422: refused"))
        : Promise.resolve("");
    },
  });
  assertEquals(attempted, ["PUT repos/o/r/rulesets/40"]);
  assertEquals(results.map((r) => [r.step.kind, r.status]), [
    ["default-branch-squash-only", "failed"],
    ["merge-commit-allowed", "skipped"],
  ]);
});

Deno.test("planRepoSettingsHardening - a fleet account above write is set to write; write, org owners and the setup login itself are not written (Issue #2690)", () => {
  const plan = planRepoSettingsHardening({
    fleetPermissions: [
      { login: "VibeCoderST", role: "admin" },
      { login: "maintainer-bot", role: "maintain" },
      { login: "writer-bot", role: "write" },
      { login: "stservice", role: "admin" },
      { login: "operator", role: "admin" },
    ],
  }, {
    ...PLAN_OPTS,
    orgOwners: ["stservice"],
    setupLogin: "operator",
  });
  const fleet = plan.filter((s) => s.kind === "fleet-account-write");
  assertEquals(
    fleet.map((s) => [s.method, s.endpoint, s.body, s.held?.status]),
    [
      ["PUT", "collaborators/VibeCoderST", '{"permission":"push"}', undefined],
      [
        "PUT",
        "collaborators/maintainer-bot",
        '{"permission":"push"}',
        undefined,
      ],
      ["PUT", "collaborators/operator", '{"permission":"push"}', "skipped"],
    ],
  );
});

Deno.test("hardenRepo - a fleet account set to write is re-read; admin that survives the write fails naming where it comes from (Issue #2690)", async () => {
  const repo = uniqueRepo();
  const routes = hardenedRoutes(repo);
  routes[`repos/${repo}/collaborators/VibeCoderST/permission`] = {
    permission: "admin",
    role_name: "admin",
  };
  const { gh, writes } = makeGh(routes);
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
    fleetAccounts: ["VibeCoderST"],
  });
  assertEquals(writes.map((w) => [w.method, w.endpoint, w.body]), [
    ["PUT", `repos/${repo}/collaborators/VibeCoderST`, { permission: "push" }],
  ]);
  const fleet = report.results.filter((r) =>
    r.step.kind === "fleet-account-write"
  );
  assertEquals(fleet.map((r) => r.status), ["failed"]);
  assert(fleet[0]?.detail?.includes("team"), fleet[0]?.detail);
});

Deno.test("hardenRepo - an invalid fleet login is never put in an API path (Issue #2690)", async () => {
  const repo = uniqueRepo();
  const { gh, writes, reads } = makeGh(hardenedRoutes(repo));
  const report = await hardenRepo(repo, {
    apply: true,
    ghCommandFn: gh,
    defaultBranchCachePath: BRANCH_CACHE,
    fleetAccounts: ["../../evil"],
  });
  assertEquals(writes, []);
  assert(!reads.some((r) => r.includes("evil")), reads.join("\n"));
  assertEquals(
    report.results.filter((r) => r.step.kind === "fleet-account-write")
      .map((r) => r.status),
    ["failed"],
  );
});

Deno.test("buildMilestoneRulesetBody - a milestone ruleset carries no rule that refuses a merge commit, so a sync PR lands as one (Issue #2690)", () => {
  const body = buildMilestoneRulesetBody("m", [{ context: "quality" }]);
  const types = body.rules.map((r) => r.type);
  assert(!types.includes("pull_request"), types.join(","));
  assert(!types.includes("required_linear_history"), types.join(","));
});
