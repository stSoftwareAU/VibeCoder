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
  planRepoSettingsHardening,
  resolveTransitiveActionCoordinates,
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
