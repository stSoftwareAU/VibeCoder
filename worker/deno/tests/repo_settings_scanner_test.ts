/**
 * Tests for the repository-settings pre-filer (Issues #4397, #4398, #4401).
 *
 * Workflow YAML can be perfect while the repository settings underneath it
 * are wide open: a read-write default token that may approve PRs, no
 * allow-list, SHA-pinning not enforced, a CODEOWNERS file the ruleset never
 * consults, secret scanning off. Only an admin can flip those, so the audit
 * detects and reports drift; the findings say plainly that a human must act —
 * except the missing-SECURITY.md finding (Issue #3269), whose fix is an
 * ordinary commit a worker PR can make.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  PRIVATE_VULNERABILITY_REPORTING_SKIP_REASON,
  scanRepoSettings,
  SECRET_PROTECTION_SKIP_CHECK,
  SECURITY_POLICY_CHECK,
  SECURITY_POLICY_SKIP_REASON,
} from "../lib/repo_settings_scanner.ts";
import { fileWorkflowFinding } from "../lib/workflow_scan_common.ts";
import { isAdminOnlyRepoSettingsIssue } from "../lib/admin_only_finding.ts";

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
  "/private-vulnerability-reporting": { enabled: true },
  "/contents/SECURITY.md": {
    name: "SECURITY.md",
    path: "SECURITY.md",
    type: "file",
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
  "/private-vulnerability-reporting": { enabled: false },
  "/contents/SECURITY.md": {
    name: "SECURITY.md",
    path: "SECURITY.md",
    type: "file",
  },
};

Deno.test("scanRepoSettings - a hardened repository yields no findings (Issues #4397 #4398 #4401)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(HARDENED), {
    defaultBranch: "Develop",
  });
  assertEquals(findings, []);
});

Deno.test("scanRepoSettings - every open setting becomes one stable, admin-actionable finding (Issues #4397 #4398 #4401)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(OPEN), {
    defaultBranch: "Develop",
  });
  const ids = findings.map((f) => f.findingId).sort();
  assertEquals(ids, [
    "BP-REPO-ACTIONS-ALLOW-ALL",
    "BP-REPO-ACTIONS-MAY-APPROVE-PRS",
    "BP-REPO-DEFAULT-TOKEN-WRITE",
    "BP-REPO-PUSH-PROTECTION-OFF",
    "BP-REPO-PVR-OFF",
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

Deno.test("scanRepoSettings - code-owner review being off is never a finding: the fleet reviewer's approval is the gate", async () => {
  // Filing it would oscillate with repo-settings-harden, which turns
  // code-owner review off because the reviewer App cannot be a code owner.
  const findings = await scanRepoSettings("org/repo", ghFor(OPEN), {
    defaultBranch: "Develop",
  });
  const ids = findings.map((f) => f.findingId);
  assert(!ids.some((id) => id.includes("CODEOWNER")), ids.join(", "));
  assert(ids.includes("BP-REPO-RULESET-NO-REVIEW"));
});

Deno.test("scanRepoSettings - a failed lookup is reported and skipped, never read as hardened; known-open ids are not re-filed (Issues #4397 #4398)", async () => {
  const failures: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor({ ...OPEN, "/actions/permissions": new Error("HTTP 403") }),
    {
      defaultBranch: "Develop",
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
// Issue #2225 — secret scanning / push protection cost money on a private
// repository, so neither finding is filed there
// =============================================================================

/** `OPEN` with both secret settings off and the given visibility fields. */
function openWithVisibility(
  repoFields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...OPEN,
    "repos/org/repo": {
      ...OPEN["repos/org/repo"],
      ...repoFields,
    },
  };
}

Deno.test("scanRepoSettings - a private repository files neither secret-scanning finding and records one skip (Issue #2225)", async () => {
  const skips: string[] = [];
  const actionableFlags: boolean[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ visibility: "private", private: true })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what, reason, actionable) => {
        if (what === SECRET_PROTECTION_SKIP_CHECK) {
          skips.push(`${what}: ${reason}`);
          actionableFlags.push(actionable);
        }
      },
      onLookupFailure: () => {
        throw new Error("a skip must not be reported as a lookup failure");
      },
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assert(!ids.includes("BP-REPO-PUSH-PROTECTION-OFF"), ids.join(", "));
  // Every other open setting is still reported.
  assert(ids.includes("BP-REPO-DEFAULT-TOKEN-WRITE"), ids.join(", "));
  assertEquals(skips.length, 1, JSON.stringify(skips));
  assertEquals(
    skips[0],
    "secret scanning / push protection: private repository — needs paid " +
      "GitHub Secret Protection",
  );
  // A licence would lift this one, so it is actionable (Issue #3268).
  assertEquals(actionableFlags, [true]);
});

Deno.test("scanRepoSettings - an internal repository is exempt like a private one (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ visibility: "internal", private: true })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what) => {
        if (what === SECRET_PROTECTION_SKIP_CHECK) skips.push(what);
      },
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assert(!ids.includes("BP-REPO-PUSH-PROTECTION-OFF"), ids.join(", "));
  assertEquals(skips.length, 1);
});

Deno.test("scanRepoSettings - a private repository with both settings already on records no secret-protection skip (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor({
      ...HARDENED,
      "repos/org/repo": {
        ...HARDENED["repos/org/repo"],
        visibility: "private",
        private: true,
      },
    }),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what) => {
        if (what === SECRET_PROTECTION_SKIP_CHECK) skips.push(what);
      },
    },
  );
  assertEquals(findings, []);
  assertEquals(skips, []);
});

Deno.test("scanRepoSettings - a public repository still files both findings (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ visibility: "public", private: false })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assert(ids.includes("BP-REPO-PUSH-PROTECTION-OFF"), ids.join(", "));
  assertEquals(skips, []);
});

Deno.test("scanRepoSettings - an unreadable visibility is evaluated exactly as today (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings("org/repo", ghFor(OPEN), {
    defaultBranch: "Develop",
    onCheckSkipped: (what) => skips.push(what),
  });
  const ids = findings.map((f) => f.findingId);
  assert(ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assert(ids.includes("BP-REPO-PUSH-PROTECTION-OFF"), ids.join(", "));
  assertEquals(skips, []);
});

Deno.test("scanRepoSettings - the boolean private flag alone exempts the repository (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ private: true })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what) => {
        if (what === SECRET_PROTECTION_SKIP_CHECK) skips.push(what);
      },
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assertEquals(skips.length, 1);
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
    requiredActionPatterns: ["aquasecurity/trivy-action@*"],
  });
  assertEquals(complete, []);

  // Without the required set the check is not made (nothing to compare).
  const unknown = await scanRepoSettings("org/repo", ghFor(withList), {
    defaultBranch: "Develop",
  });
  assertEquals(unknown, []);
});

// =============================================================================
// Issue #4397 — code-owner review is a human gate
// =============================================================================

Deno.test("scanRepoSettings - code-owner review with zero approvals is still a NO-REVIEW finding, with or without it (Issues #4397 #2680)", async () => {
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
  });
  assertEquals(findings.map((f) => f.findingId), [
    "BP-REPO-RULESET-NO-REVIEW",
  ]);

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
  });
  assertEquals(open.map((f) => f.findingId), ["BP-REPO-RULESET-NO-REVIEW"]);
});

// =============================================================================
// Issue #3268 — private vulnerability reporting off on a public repository
// =============================================================================

/** `HARDENED` with the given visibility fields and PVR state. */
function hardenedWithVisibilityAndPvr(
  repoFields: Record<string, unknown>,
  pvrEnabled: boolean,
): Record<string, unknown> {
  return {
    ...HARDENED,
    "repos/org/repo": {
      ...HARDENED["repos/org/repo"],
      ...repoFields,
    },
    "/private-vulnerability-reporting": { enabled: pvrEnabled },
  };
}

Deno.test("scanRepoSettings - a public repository with PVR off files BP-REPO-PVR-OFF (Issue #3268)", async () => {
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndPvr(
        { visibility: "public", private: false },
        false,
      ),
    ),
    { defaultBranch: "Develop" },
  );
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, "BP-REPO-PVR-OFF");
  assert(
    f.suggestedFix.includes(
      "Repository admin action — the worker cannot change repository settings.",
    ),
    f.suggestedFix,
  );
  assertEquals(f.file, "repository settings");
});

Deno.test("scanRepoSettings - a public repository with PVR on files nothing but still reads the endpoint (Issue #3268)", async () => {
  const seen: string[] = [];
  const failures: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndPvr(
        { visibility: "public", private: false },
        true,
      ),
      (args) => seen.push(args[1] ?? ""),
    ),
    {
      defaultBranch: "Develop",
      onLookupFailure: (what, reason) => failures.push(`${what}: ${reason}`),
    },
  );
  assertEquals(findings, []);
  assertEquals(failures, []);
  assert(
    seen.includes("repos/org/repo/private-vulnerability-reporting"),
    seen.join(", "),
  );
});

Deno.test("scanRepoSettings - a known-open BP-REPO-PVR-OFF is not re-filed (Issue #3268)", async () => {
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndPvr(
        { visibility: "public", private: false },
        false,
      ),
    ),
    {
      defaultBranch: "Develop",
      knownOpenFindingIds: ["BP-REPO-PVR-OFF"],
    },
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
    findings.map((f) => f.findingId).join(", "),
  );
});

Deno.test("scanRepoSettings - a private or internal repository is not read for PVR and the skip is recorded (Issue #3268)", async () => {
  for (
    const repoFields of [
      { visibility: "private", private: true },
      { visibility: "internal", private: true },
    ]
  ) {
    const seen: string[] = [];
    const skips: Array<[string, string]> = [];
    const actionableFlags: boolean[] = [];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor(
        hardenedWithVisibilityAndPvr(repoFields, false),
        (args) => seen.push(args[1] ?? ""),
      ),
      {
        defaultBranch: "Develop",
        onCheckSkipped: (what, reason, actionable) => {
          skips.push([what, reason]);
          if (what === "private vulnerability reporting") {
            actionableFlags.push(actionable);
          }
        },
        onLookupFailure: () => {
          throw new Error("PVR must not be read on a private repository");
        },
      },
    );
    assert(
      !seen.some((e) => e.includes("private-vulnerability-reporting")),
      JSON.stringify(seen),
    );
    assert(
      !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
      findings.map((f) => f.findingId).join(", "),
    );
    const pvrSkips = skips.filter(([what]) =>
      what === "private vulnerability reporting"
    );
    assertEquals(pvrSkips.length, 1, JSON.stringify(skips));
    assertEquals(pvrSkips[0]![1], PRIVATE_VULNERABILITY_REPORTING_SKIP_REASON);
    // Nobody can act: GitHub does not offer PVR on a private/internal repo
    // (Issue #3268).
    assertEquals(actionableFlags, [false]);
  }
});

Deno.test("scanRepoSettings - a PVR read failure is a lookup failure, not a finding or a skip (Issue #3268)", async () => {
  for (
    const err of [
      new Error("HTTP 403: Must have admin rights to Repository."),
      new Error("HTTP 404: Not Found"),
      new Error("HTTP 500: Server Error"),
    ]
  ) {
    const failures: Array<[string, string]> = [];
    const skips: string[] = [];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor({
        ...HARDENED,
        "repos/org/repo": {
          ...HARDENED["repos/org/repo"],
          visibility: "public",
          private: false,
        },
        "/private-vulnerability-reporting": err,
      }),
      {
        defaultBranch: "Develop",
        onLookupFailure: (what, reason) => failures.push([what, reason]),
        onCheckSkipped: (what) => skips.push(what),
      },
    );
    assert(
      !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
      findings.map((f) => f.findingId).join(", "),
    );
    assertEquals(failures.length, 1, JSON.stringify(failures));
    assertEquals(failures[0]![0], "private-vulnerability-reporting");
    assert(failures[0]![1].includes(err.message), failures[0]![1]);
    assertEquals(skips, []);
  }
});

Deno.test("scanRepoSettings - a PVR response without a boolean enabled field is a lookup failure, not a finding (Issue #3268)", async () => {
  const failures: Array<[string, string]> = [];
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor({
      ...HARDENED,
      "repos/org/repo": {
        ...HARDENED["repos/org/repo"],
        visibility: "public",
        private: false,
      },
      "/private-vulnerability-reporting": {},
    }),
    {
      defaultBranch: "Develop",
      onLookupFailure: (what, reason) => failures.push([what, reason]),
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
    findings.map((f) => f.findingId).join(", "),
  );
  assertEquals(failures.length, 1, JSON.stringify(failures));
  assertEquals(failures[0]![0], "private-vulnerability-reporting");
  assert(failures[0]![1].includes("enabled"), failures[0]![1]);
  assertEquals(skips, []);
});

Deno.test("scanRepoSettings - a PVR response body of null is a lookup failure, not a throw (Issue #3268)", async () => {
  const failures: Array<[string, string]> = [];
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor({
      ...HARDENED,
      "repos/org/repo": {
        ...HARDENED["repos/org/repo"],
        visibility: "public",
        private: false,
      },
      "/private-vulnerability-reporting": null,
    }),
    {
      defaultBranch: "Develop",
      onLookupFailure: (what, reason) => failures.push([what, reason]),
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
    findings.map((f) => f.findingId).join(", "),
  );
  assertEquals(failures.length, 1, JSON.stringify(failures));
  assertEquals(failures[0]![0], "private-vulnerability-reporting");
  assert(failures[0]![1].includes("enabled"), failures[0]![1]);
  assertEquals(skips, []);
});

Deno.test("scanRepoSettings - an unreadable repos/{owner}/{repo} is not followed by a PVR read (Issue #3268)", async () => {
  const seen: string[] = [];
  const failures: Array<[string, string]> = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      {
        ...HARDENED,
        "repos/org/repo": new Error("HTTP 500: Server Error"),
      },
      (args) => seen.push(args[1] ?? ""),
    ),
    {
      defaultBranch: "Develop",
      onLookupFailure: (what, reason) => failures.push([what, reason]),
    },
  );
  assert(
    !seen.some((e) => e.includes("private-vulnerability-reporting")),
    JSON.stringify(seen),
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"),
    findings.map((f) => f.findingId).join(", "),
  );
  assertEquals(failures.length, 1, JSON.stringify(failures));
  assertEquals(failures[0]![0], "repos (security_and_analysis)");
});

// =============================================================================
// Issue #3269 — a public repository without a SECURITY.md
// =============================================================================

const SECURITY_POLICY_ENDPOINTS = [
  "/contents/SECURITY.md",
  "/contents/.github/SECURITY.md",
  "/contents/docs/SECURITY.md",
];

/** `HARDENED` with the given visibility fields and content endpoints. */
function hardenedWithVisibilityAndSecurityPolicy(
  repoFields: Record<string, unknown>,
  contentsAnswers: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...HARDENED };
  delete base["/contents/SECURITY.md"];
  return {
    ...base,
    "repos/org/repo": {
      ...HARDENED["repos/org/repo"],
      ...repoFields,
    },
    ...contentsAnswers,
  };
}

Deno.test("scanRepoSettings - a public repository with SECURITY.md at any recognised location files nothing (Issue #3269)", async () => {
  for (const presentAt of SECURITY_POLICY_ENDPOINTS) {
    const contentsAnswers: Record<string, unknown> = {};
    for (const endpoint of SECURITY_POLICY_ENDPOINTS) {
      contentsAnswers[endpoint] = endpoint === presentAt
        ? { name: "SECURITY.md", path: presentAt, type: "file" }
        : new Error("HTTP 404: Not Found");
    }
    const failures: Array<[string, string]> = [];
    const skips: string[] = [];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor(
        hardenedWithVisibilityAndSecurityPolicy(
          { visibility: "public", private: false },
          contentsAnswers,
        ),
      ),
      {
        defaultBranch: "Develop",
        onLookupFailure: (what, reason) => failures.push([what, reason]),
        onCheckSkipped: (what) => skips.push(what),
      },
    );
    assertEquals(
      findings,
      [],
      `${presentAt}: ${findings.map((f) => f.findingId).join(", ")}`,
    );
    assertEquals(failures, [], presentAt);
    assertEquals(skips, [], presentAt);
  }
});

Deno.test("scanRepoSettings - a public repository with no SECURITY.md anywhere files BP-REPO-SECURITY-POLICY-MISSING, and the issue it becomes is not admin-only (Issue #3269)", async () => {
  const seen: string[] = [];
  const contentsAnswers: Record<string, unknown> = {};
  for (const endpoint of SECURITY_POLICY_ENDPOINTS) {
    contentsAnswers[endpoint] = new Error("HTTP 404: Not Found");
  }
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndSecurityPolicy(
        { visibility: "public", private: false },
        contentsAnswers,
      ),
      (args) => seen.push(args[1] ?? ""),
    ),
    { defaultBranch: "Develop" },
  );
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, "BP-REPO-SECURITY-POLICY-MISSING");
  assertEquals(f.severity, "low");
  for (const endpoint of SECURITY_POLICY_ENDPOINTS) {
    assert(
      seen.some((e) => e.endsWith(endpoint)),
      `${endpoint} not read: ${seen.join(", ")}`,
    );
  }

  const captured: string[][] = [];
  const gh = (args: string[]) => {
    captured.push(args);
    return Promise.resolve("https://github.com/org/repo/issues/7\n");
  };
  await fileWorkflowFinding({
    repo: "org/repo",
    findingId: f.findingId,
    severity: f.severity,
    title: f.title,
    file: f.file,
    lines: f.lines,
    whyItMatters: f.whyItMatters,
    suggestedFix: f.suggestedFix,
    evidence: f.evidence,
    template: "github-actions-audit",
    runId: "vibe-test",
    ghCommandFn: gh,
  });
  const args = captured[0] as string[];
  const bodyIdx = args.indexOf("--body");
  const body = args[bodyIdx + 1] as string;
  assertEquals(isAdminOnlyRepoSettingsIssue(body), false, body);
  assert(
    !/the worker cannot change repository settings/i.test(body),
    body,
  );
  assert(body.includes("<!-- finding-id: BP-REPO-SECURITY-POLICY-MISSING -->"));
  assert(f.suggestedFix.includes("SECURITY.md"), f.suggestedFix);
  assert(f.suggestedFix.includes("pull request"), f.suggestedFix);
});

Deno.test("scanRepoSettings - an already-open BP-REPO-SECURITY-POLICY-MISSING is not re-filed (Issue #3269)", async () => {
  const contentsAnswers: Record<string, unknown> = {};
  for (const endpoint of SECURITY_POLICY_ENDPOINTS) {
    contentsAnswers[endpoint] = new Error("HTTP 404: Not Found");
  }
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndSecurityPolicy(
        { visibility: "public", private: false },
        contentsAnswers,
      ),
    ),
    {
      defaultBranch: "Develop",
      knownOpenFindingIds: ["BP-REPO-SECURITY-POLICY-MISSING"],
    },
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-SECURITY-POLICY-MISSING"),
    findings.map((f) => f.findingId).join(", "),
  );
});

Deno.test("scanRepoSettings - a non-404 security-policy read error is a lookup failure, never a finding (Issue #3269)", async () => {
  for (
    const err of [
      new Error("HTTP 500: Server Error"),
      new Error("HTTP 403: Resource not accessible by integration"),
    ]
  ) {
    const failures: Array<[string, string]> = [];
    const skips: string[] = [];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor(
        hardenedWithVisibilityAndSecurityPolicy(
          { visibility: "public", private: false },
          { "/contents/SECURITY.md": err },
        ),
      ),
      {
        defaultBranch: "Develop",
        onLookupFailure: (what, reason) => failures.push([what, reason]),
        onCheckSkipped: (what) => skips.push(what),
      },
    );
    assert(
      !findings.some((f) => f.findingId === "BP-REPO-SECURITY-POLICY-MISSING"),
      findings.map((f) => f.findingId).join(", "),
    );
    assertEquals(failures.length, 1, JSON.stringify(failures));
    assertEquals(failures[0]![0], SECURITY_POLICY_CHECK);
    assert(failures[0]![1].includes(err.message), failures[0]![1]);
    assertEquals(skips, []);
  }
});

Deno.test("scanRepoSettings - a 404 at the root then a non-404 at .github/SECURITY.md is a lookup failure, no finding (Issue #3269)", async () => {
  const failures: Array<[string, string]> = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      hardenedWithVisibilityAndSecurityPolicy(
        { visibility: "public", private: false },
        {
          "/contents/SECURITY.md": new Error("HTTP 404: Not Found"),
          "/contents/.github/SECURITY.md": new Error(
            "HTTP 500: Server Error",
          ),
        },
      ),
    ),
    {
      defaultBranch: "Develop",
      onLookupFailure: (what, reason) => failures.push([what, reason]),
    },
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-SECURITY-POLICY-MISSING"),
    findings.map((f) => f.findingId).join(", "),
  );
  assertEquals(failures.length, 1, JSON.stringify(failures));
  assertEquals(failures[0]![0], SECURITY_POLICY_CHECK);
});

Deno.test("scanRepoSettings - a private or internal repository is not read for a security policy and the skip is recorded (Issue #3269)", async () => {
  for (
    const repoFields of [
      { visibility: "private", private: true },
      { visibility: "internal", private: true },
    ]
  ) {
    const seen: string[] = [];
    const skips: Array<[string, string, boolean]> = [];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor(
        hardenedWithVisibilityAndSecurityPolicy(repoFields, {}),
        (args) => seen.push(args[1] ?? ""),
      ),
      {
        defaultBranch: "Develop",
        onCheckSkipped: (what, reason, actionable) => {
          if (what === SECURITY_POLICY_CHECK) {
            skips.push([what, reason, actionable]);
          }
        },
        onLookupFailure: (what) => {
          if (what === SECURITY_POLICY_CHECK) {
            throw new Error(
              "security policy must not be read on a private repository",
            );
          }
        },
      },
    );
    assert(
      !seen.some((e) => e.includes("/contents/")),
      JSON.stringify(seen),
    );
    assert(
      !findings.some((f) => f.findingId === "BP-REPO-SECURITY-POLICY-MISSING"),
      findings.map((f) => f.findingId).join(", "),
    );
    assertEquals(skips.length, 1, JSON.stringify(skips));
    assertEquals(skips[0]![1], SECURITY_POLICY_SKIP_REASON);
    assertEquals(skips[0]![2], false);
  }
});

Deno.test("scanRepoSettings - an unreadable repos/{owner}/{repo} is not followed by a security-policy read (Issue #3269)", async () => {
  const seen: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(
      {
        ...HARDENED,
        "repos/org/repo": new Error("HTTP 500: Server Error"),
      },
      (args) => seen.push(args[1] ?? ""),
    ),
    { defaultBranch: "Develop" },
  );
  assert(
    !seen.some((e) => e.includes("/contents/")),
    JSON.stringify(seen),
  );
  assert(
    !findings.some((f) => f.findingId === "BP-REPO-SECURITY-POLICY-MISSING"),
    findings.map((f) => f.findingId).join(", "),
  );
});
