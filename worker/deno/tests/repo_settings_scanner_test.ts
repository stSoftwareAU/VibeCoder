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
import {
  PVR_AND_SECURITY_MD_SKIP_CHECK,
  PVR_AND_SECURITY_MD_SKIP_REASON,
  scanRepoSettings,
} from "../lib/repo_settings_scanner.ts";
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
  "private-vulnerability-reporting": { enabled: true },
  "contents/.github/SECURITY.md": "# Security",
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
  // Kept hardened for these two (Issue #3227), so existing tests' exact
  // finding-id lists stay unaffected by this unrelated section.
  "private-vulnerability-reporting": { enabled: true },
  "contents/.github/SECURITY.md": "# Security",
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
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ visibility: "private", private: true })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what, reason) => skips.push(`${what}: ${reason}`),
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
  // A private repository is also exempt from the PVR/SECURITY.md check
  // (Issue #3227), recorded as its own skip alongside this one.
  assertEquals(skips.length, 2, JSON.stringify(skips));
  assert(
    skips.includes(
      "secret scanning / push protection: private repository — needs paid " +
        "GitHub Secret Protection",
    ),
    JSON.stringify(skips),
  );
});

Deno.test("scanRepoSettings - an internal repository is exempt like a private one (Issue #2225)", async () => {
  const skips: string[] = [];
  const findings = await scanRepoSettings(
    "org/repo",
    ghFor(openWithVisibility({ visibility: "internal", private: true })),
    {
      defaultBranch: "Develop",
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  assert(!ids.includes("BP-REPO-PUSH-PROTECTION-OFF"), ids.join(", "));
  // Also exempt from the PVR/SECURITY.md check (Issue #3227).
  assertEquals(skips.length, 2);
});

Deno.test("scanRepoSettings - a private repository with both settings already on records only the PVR/SECURITY.md skip (Issue #2225, #3227)", async () => {
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
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  assertEquals(findings, []);
  // The secret-scanning settings are already on, so that skip is not
  // recorded; the PVR/SECURITY.md check is exempt on any private
  // repository regardless (Issue #3227).
  assertEquals(skips, [PVR_AND_SECURITY_MD_SKIP_CHECK]);
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
      onCheckSkipped: (what) => skips.push(what),
    },
  );
  const ids = findings.map((f) => f.findingId);
  assert(!ids.includes("BP-REPO-SECRET-SCANNING-OFF"), ids.join(", "));
  // Also exempt from the PVR/SECURITY.md check (Issue #3227).
  assertEquals(skips.length, 2);
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
// Issue #3227 — private vulnerability reporting and SECURITY.md
// =============================================================================

Deno.test("scanRepoSettings - a public repository with PVR off files exactly one BP-REPO-PVR-OFF finding (Issue #3227)", async () => {
  const fixture = {
    ...HARDENED,
    "private-vulnerability-reporting": { enabled: false },
  };
  const findings = await scanRepoSettings("org/repo", ghFor(fixture), {
    defaultBranch: "Develop",
  });
  assertEquals(findings.map((f) => f.findingId), ["BP-REPO-PVR-OFF"]);
});

Deno.test("scanRepoSettings - a public repository with PVR on files no PVR finding (Issue #3227)", async () => {
  const findings = await scanRepoSettings("org/repo", ghFor(HARDENED), {
    defaultBranch: "Develop",
  });
  assert(!findings.some((f) => f.findingId === "BP-REPO-PVR-OFF"));
});

Deno.test("scanRepoSettings - a private or internal repository reads neither PVR nor SECURITY.md and records one skip (Issue #3227)", async () => {
  for (const visibility of ["private", "internal"]) {
    const skips: Array<[string, string]> = [];
    const endpointsRead: string[] = [];
    const fixture = {
      ...OPEN,
      "repos/org/repo": {
        ...OPEN["repos/org/repo"],
        visibility,
        private: true,
      },
      // PVR off and no SECURITY.md so the test can fail if either is read.
      "private-vulnerability-reporting": { enabled: false },
    };
    delete (fixture as Record<string, unknown>)["contents/.github/SECURITY.md"];
    const findings = await scanRepoSettings(
      "org/repo",
      ghFor(fixture, (args) => endpointsRead.push(args[1] ?? "")),
      {
        defaultBranch: "Develop",
        onCheckSkipped: (what, reason) => skips.push([what, reason]),
      },
    );
    assert(
      !endpointsRead.some((e) => e.includes("private-vulnerability-reporting")),
      `${visibility}: PVR must not be read: ${endpointsRead.join(", ")}`,
    );
    assert(
      !endpointsRead.some((e) => e.includes("/contents/")),
      `${visibility}: SECURITY.md must not be read: ${
        endpointsRead.join(", ")
      }`,
    );
    const ids = findings.map((f) => f.findingId);
    assert(!ids.includes("BP-REPO-PVR-OFF"), `${visibility}: ${ids}`);
    assert(
      !ids.includes("BP-SECURITY-POLICY-MISSING"),
      `${visibility}: ${ids}`,
    );
    assertEquals(
      skips.filter(([what]) => what === PVR_AND_SECURITY_MD_SKIP_CHECK),
      [[PVR_AND_SECURITY_MD_SKIP_CHECK, PVR_AND_SECURITY_MD_SKIP_REASON]],
      `${visibility}`,
    );
  }
});

Deno.test("scanRepoSettings - SECURITY.md absent at all three paths files BP-SECURITY-POLICY-MISSING; present at any one path is silent (Issue #3227)", async () => {
  const notFound = () => new Error("HTTP 404 Not Found");
  const absent = {
    ...HARDENED,
  };
  delete (absent as Record<string, unknown>)["contents/.github/SECURITY.md"];
  const missing = await scanRepoSettings(
    "org/repo",
    ghFor({
      ...absent,
      "contents/.github/SECURITY.md": notFound(),
      "contents/SECURITY.md": notFound(),
      "contents/docs/SECURITY.md": notFound(),
    }),
    { defaultBranch: "Develop" },
  );
  assertEquals(
    missing.map((f) => f.findingId),
    ["BP-SECURITY-POLICY-MISSING"],
  );

  for (
    const path of [
      "contents/.github/SECURITY.md",
      "contents/SECURITY.md",
      "contents/docs/SECURITY.md",
    ]
  ) {
    const fixture: Record<string, unknown> = {
      ...absent,
      "contents/.github/SECURITY.md": notFound(),
      "contents/SECURITY.md": notFound(),
      "contents/docs/SECURITY.md": notFound(),
    };
    fixture[path] = "# Security";
    const findings = await scanRepoSettings("org/repo", ghFor(fixture), {
      defaultBranch: "Develop",
    });
    assertEquals(
      findings.filter((f) => f.findingId === "BP-SECURITY-POLICY-MISSING"),
      [],
      path,
    );
  }
});

Deno.test("scanRepoSettings - a non-404 error reading SECURITY.md is reported, not a finding (Issue #3227)", async () => {
  const failures: Array<[string, string]> = [];
  const fixture: Record<string, unknown> = { ...HARDENED };
  fixture["contents/.github/SECURITY.md"] = new Error(
    "HTTP 500 Internal Server Error",
  );
  const findings = await scanRepoSettings("org/repo", ghFor(fixture), {
    defaultBranch: "Develop",
    onLookupFailure: (what, reason) => failures.push([what, reason]),
  });
  assert(!findings.some((f) => f.findingId === "BP-SECURITY-POLICY-MISSING"));
  assertEquals(failures.length, 1);
  assertEquals(failures[0]![0], "SECURITY.md");
});

Deno.test("scanRepoSettings - BP-SECURITY-POLICY-MISSING is not admin-only; BP-REPO-PVR-OFF is (Issue #3227)", async () => {
  const notFound = () => new Error("HTTP 404 Not Found");
  const fixture: Record<string, unknown> = {
    ...HARDENED,
    "private-vulnerability-reporting": { enabled: false },
    "contents/.github/SECURITY.md": notFound(),
    "contents/SECURITY.md": notFound(),
    "contents/docs/SECURITY.md": notFound(),
  };
  const findings = await scanRepoSettings("org/repo", ghFor(fixture), {
    defaultBranch: "Develop",
  });
  const bodyFor = (f: typeof findings[number]) =>
    `<!-- finding-id: ${f.findingId} -->\n\n${f.suggestedFix}\n\n${f.whyItMatters}`;

  const securityFinding = findings.find((f) =>
    f.findingId === "BP-SECURITY-POLICY-MISSING"
  )!;
  assert(securityFinding, "expected BP-SECURITY-POLICY-MISSING to be filed");
  assertEquals(isAdminOnlyRepoSettingsIssue(bodyFor(securityFinding)), false);

  const pvrFinding = findings.find((f) => f.findingId === "BP-REPO-PVR-OFF")!;
  assert(pvrFinding, "expected BP-REPO-PVR-OFF to be filed");
  assertEquals(isAdminOnlyRepoSettingsIssue(bodyFor(pvrFinding)), true);
});
