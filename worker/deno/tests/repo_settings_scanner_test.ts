/**
 * Tests for the repository-settings pre-filer (Issues #4397, #4398, #4401).
 *
 * Workflow YAML can be perfect while the repository settings underneath it
 * are wide open: a read-write default token that may approve PRs, no
 * allow-list, SHA-pinning not enforced, a CODEOWNERS file the ruleset never
 * consults, secret scanning off. Only an admin can flip those, so the audit
 * detects and reports drift; the findings say plainly that a human must act.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { scanRepoSettings } from "../lib/repo_settings_scanner.ts";

/** A gh stub answering the four settings endpoints from a table. */
function ghFor(
  answers: Record<string, unknown>,
  onArgs?: (args: string[]) => void,
): (args: string[]) => Promise<string> {
  return (args) => {
    onArgs?.(args);
    const endpoint = args[1] ?? "";
    for (const [suffix, value] of Object.entries(answers)) {
      if (endpoint.endsWith(suffix)) {
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(JSON.stringify(value));
      }
    }
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  };
}

const HARDENED = {
  "/actions/permissions/workflow": {
    default_workflow_permissions: "read",
    can_approve_pull_request_reviews: false,
  },
  "/actions/permissions": {
    enabled: true,
    allowed_actions: "selected",
    sha_pinning_required: true,
  },
  "/rules/branches/Develop": [
    {
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
        required_approving_review_count: 1,
      },
    },
  ],
  "repos/org/repo": {
    security_and_analysis: {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    },
  },
};

const OPEN = {
  "/actions/permissions/workflow": {
    default_workflow_permissions: "write",
    can_approve_pull_request_reviews: true,
  },
  "/actions/permissions": {
    enabled: true,
    allowed_actions: "all",
    sha_pinning_required: false,
  },
  "/rules/branches/Develop": [
    {
      type: "pull_request",
      parameters: {
        require_code_owner_review: false,
        required_approving_review_count: 0,
      },
    },
  ],
  "repos/org/repo": {
    security_and_analysis: {
      secret_scanning: { status: "disabled" },
      secret_scanning_push_protection: { status: "disabled" },
    },
  },
};

Deno.test("scanRepoSettings - a hardened repository yields no findings (Issues #4397 #4398 #4401)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(HARDENED), {
    defaultBranch: "Develop",
    hasCodeowners: true,
  });
  assertEquals(findings, []);
});

Deno.test("scanRepoSettings - every open setting becomes one stable, admin-actionable finding (Issues #4397 #4398 #4401)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(OPEN), {
    defaultBranch: "Develop",
    hasCodeowners: true,
  });
  const ids = findings.map((f) => f.findingId).sort();
  assertEquals(ids, [
    "BP-REPO-ACTIONS-ALLOW-ALL",
    "BP-REPO-ACTIONS-MAY-APPROVE-PRS",
    "BP-REPO-CODEOWNERS-NOT-ENFORCED",
    "BP-REPO-DEFAULT-TOKEN-WRITE",
    "BP-REPO-PUSH-PROTECTION-OFF",
    "BP-REPO-RULESET-NO-REVIEW",
    "BP-REPO-SECRET-SCANNING-OFF",
    "BP-REPO-SHA-PIN-NOT-ENFORCED",
  ]);
  for (const f of findings) {
    assert(f.file === "repository settings", f.file);
    assert(
      /admin/i.test(f.suggestedFix),
      `${f.findingId}: must say an admin acts: ${f.suggestedFix}`,
    );
    // The outbound secret masker rewrites `secret_scanning*` key/value pairs
    // and `id-token: write`; the bodies must not carry those literals.
    assert(
      !/secret_scanning\w*\s*[:=]/.test(
        f.whyItMatters + f.suggestedFix + f.evidence,
      ),
      f.findingId,
    );
    assert(
      !/id-token:\s*write/.test(f.whyItMatters + f.suggestedFix),
      f.findingId,
    );
  }
  const token = findings.find((f) =>
    f.findingId === "BP-REPO-DEFAULT-TOKEN-WRITE"
  )!;
  assertEquals(token.severity, "high");
  const allowAll = findings.find((f) =>
    f.findingId === "BP-REPO-ACTIONS-ALLOW-ALL"
  )!;
  assertEquals(allowAll.severity, "medium");
});

Deno.test("scanRepoSettings - CODEOWNERS finding only when the file exists; review-count finding regardless (Issue #4397)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(OPEN), {
    defaultBranch: "Develop",
    hasCodeowners: false,
  });
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-CODEOWNERS-NOT-ENFORCED"));
  assert(ids.includes("BP-REPO-RULESET-NO-REVIEW"));
});

Deno.test("scanRepoSettings - a failed lookup is reported and skipped, never read as hardened; known-open ids are not re-filed (Issues #4397 #4398)", async () => {
  const failures: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor({ ...OPEN, "/actions/permissions": new Error("HTTP 403") }),
    {
      defaultBranch: "Develop",
      hasCodeowners: true,
      knownOpenFindingIds: ["BP-REPO-DEFAULT-TOKEN-WRITE"],
      onLookupFailure: (what, reason) => {
        failures.push(`${what}: ${reason}`);
      },
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-DEFAULT-TOKEN-WRITE"), "known-open skipped");
  assert(
    !ids.includes("BP-REPO-ACTIONS-ALLOW-ALL"),
    "unreadable endpoint yields nothing",
  );
  assert(ids.includes("BP-REPO-ACTIONS-MAY-APPROVE-PRS"));
  assertEquals(failures.length, 1);
  assert(failures[0]!.includes("HTTP 403"));
});

// =============================================================================
// Issue #4424 — a "selected" allow-list that omits an action the workflows
// (or their composite steps) need
// =============================================================================

Deno.test("scanRepoSettings - a selected allow-list missing a required pattern is one finding naming the gap; a complete list is silent (Issue #4424)", async () => {
  const withList = {
    ...HARDENED,
    "/actions/permissions/selected-actions": {
      github_owned_allowed: true,
      verified_allowed: false,
      patterns_allowed: [
        "aquasecurity/trivy-action@*",
        "denoland/setup-deno@*",
      ],
    },
  };
  const incomplete = await scanRepoSettings("org/repo", ghFor(withList), {
    defaultBranch: "Develop",
    hasCodeowners: true,
    requiredActionPatterns: [
      "aquasecurity/setup-trivy@*",
      "aquasecurity/trivy-action@*",
      "denoland/setup-deno@*",
    ],
  });
  assertEquals(incomplete.length, 1);
  const f = incomplete[0]!;
  assertEquals(f.findingId, "BP-REPO-ACTIONS-ALLOW-LIST-INCOMPLETE");
  assert(f.evidence.includes("aquasecurity/setup-trivy@*"), f.evidence);
  assert(!f.evidence.includes("trivy-action@*"), f.evidence);
  assert(f.suggestedFix.includes("repo-settings-harden"), f.suggestedFix);

  const complete = await scanRepoSettings("org/repo", ghFor(withList), {
    defaultBranch: "Develop",
    hasCodeowners: true,
    requiredActionPatterns: ["aquasecurity/trivy-action@*"],
  });
  assertEquals(complete, []);

  // Without the required set the check is not made (nothing to compare).
  const unknown = await scanRepoSettings("org/repo", ghFor(withList), {
    defaultBranch: "Develop",
    hasCodeowners: true,
  });
  assertEquals(unknown, []);
});

// =============================================================================
// Issue #4397 — code-owner review is a human gate
// =============================================================================

Deno.test("scanRepoSettings - a rule that requires code-owner review with zero approvals is the chosen policy, not a NO-REVIEW finding; neither gate is a finding (Issue #4397)", async () => {
  const ownerOnly = {
    ...HARDENED,
    "/rules/branches/Develop": [
      {
        type: "pull_request",
        parameters: {
          require_code_owner_review: true,
          required_approving_review_count: 0,
        },
      },
    ],
  };
  const findings = await scanRepoSettings("org/repo", ghFor(ownerOnly), {
    defaultBranch: "Develop",
    hasCodeowners: true,
  });
  assertEquals(findings.map((f) => f.findingId), []);

  const neither = {
    ...HARDENED,
    "/rules/branches/Develop": [
      {
        type: "pull_request",
        parameters: {
          require_code_owner_review: false,
          required_approving_review_count: 0,
        },
      },
    ],
  };
  const open = await scanRepoSettings("org/repo", ghFor(neither), {
    defaultBranch: "Develop",
    hasCodeowners: true,
  });
  assertEquals(open.map((f) => f.findingId).sort(), [
    "BP-REPO-CODEOWNERS-NOT-ENFORCED",
    "BP-REPO-RULESET-NO-REVIEW",
  ]);
});
