/**
 * Tests for action_pin_scanner.ts — native SHA-pin pre-filer for the
 * github-actions-audit template (Issue #2501, part of #2497).
 *
 * Every test exercises the real `scanActionPins` against in-memory
 * `WorkflowFile` fixtures — no filesystem, no network.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyUses,
  extractUsesValue,
  scanActionLockfile,
  scanActionPins,
} from "../lib/action_pin_scanner.ts";
import {
  type ActionsLockfileEvidence,
  parseActionsLockfile,
} from "../lib/actions_lockfile.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678"; // 40 hex

function wf(path: string, rawText: string): WorkflowFile {
  return { path, rawText, parsed: null, kind: "workflow" };
}

// ---------------------------------------------------------------------------
// extractUsesValue / classifyUses unit cases
// ---------------------------------------------------------------------------

Deno.test("extractUsesValue - handles list dash, quotes, and inline comments", () => {
  assertEquals(
    extractUsesValue("      - uses: actions/checkout@v4"),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue("    uses: 'actions/checkout@v4'"),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue('    uses: "actions/checkout@v4"'),
    "actions/checkout@v4",
  );
  assertEquals(
    extractUsesValue("      - uses: actions/checkout@v4 # pinned later"),
    "actions/checkout@v4",
  );
  assertEquals(extractUsesValue("      - run: echo hi"), null);
});

Deno.test("classifyUses - SHA pin, first-party, and local refs are exempt", () => {
  assertEquals(classifyUses(`actions/checkout@${SHA}`), null);
  assertEquals(classifyUses("stSoftwareAU/some-action@v1"), null);
  assertEquals(classifyUses("./.github/actions/setup"), null);
  assertEquals(classifyUses("docker://alpine:3.19"), null);
  // Tag pin on a third-party action is flagged.
  const parsed = classifyUses("actions/checkout@v4");
  assert(parsed !== null);
  assertEquals(parsed!.coordinate, "actions/checkout");
  assertEquals(parsed!.owner, "actions");
  assertEquals(parsed!.ref, "v4");
});

// ---------------------------------------------------------------------------
// scanActionPins — acceptance-criteria coverage
// ---------------------------------------------------------------------------

Deno.test("scanActionPins - SHA-pinned uses is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
    ),
  ];
  assertEquals(scanActionPins(files, { lockfile: { kind: "absent" } }), []);
});

Deno.test("scanActionPins - tag/branch pinned third-party action IS flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "actions/checkout");
  assertEquals(f.findingId, "BP-SHA-PIN-actions-checkout");
  assertEquals(f.severity, "high");
  assertEquals(f.file, ".github/workflows/ci.yml");
  assertEquals(f.lines, 4);
  assert(f.findingId.startsWith("BP-"));
});

Deno.test("scanActionPins - branch ref is flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: foo/bar@main\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.callSites[0]!.ref, "main");
});

Deno.test("scanActionPins - stSoftwareAU/* carve-out is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: stSoftwareAU/deploy-action@v2\n",
    ),
  ];
  assertEquals(scanActionPins(files, { lockfile: { kind: "absent" } }), []);
});

Deno.test("scanActionPins - local ./ reference carve-out is NOT flagged", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: ./.github/actions/setup\n",
    ),
  ];
  assertEquals(scanActionPins(files, { lockfile: { kind: "absent" } }), []);
});

Deno.test("scanActionPins - cross-repo reusable workflow is in scope", () => {
  const files = [
    wf(
      ".github/workflows/release.yml",
      "jobs:\n  call:\n    uses: org/repo/.github/workflows/build.yml@v1\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "org/repo/.github/workflows/build.yml");
  assertEquals(f.findingId, "BP-SHA-PIN-org-repo-github-workflows-build-yml");
});

Deno.test("scanActionPins - consolidates multiple call-sites into one finding", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n  b:\n    steps:\n      - uses: actions/checkout@v3\n",
    ),
    wf(
      ".github/workflows/release.yml",
      "jobs:\n  c:\n    steps:\n      - uses: actions/checkout@v4\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.coordinate, "actions/checkout");
  assertEquals(f.callSites.length, 3);
  // Evidence lists every call-site.
  assert(f.evidence.includes(".github/workflows/ci.yml`:4"));
  assert(f.evidence.includes(".github/workflows/ci.yml`:7"));
  assert(f.evidence.includes(".github/workflows/release.yml`:4"));
  assert(f.evidence.includes("3 call-sites"));
});

Deno.test("scanActionPins - in-source best-practice-ignore suppresses the finding", () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const findingId = "BP-SHA-PIN-actions-checkout";
    const files = [
      wf(
        ".github/workflows/ci.yml",
        `jobs:\n  b:\n    steps:\n      # best-practice-ignore: ${findingId} — author=nigel expires=2099-12-31 pinned by trusted mirror\n      - uses: actions/checkout@v4\n`,
      ),
    ];
    assertEquals(scanActionPins(files, { lockfile: { kind: "absent" } }), []);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("scanActionPins - knownOpenFindingIds and suppressedIds are skipped", () => {
  const body = "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n";
  const known = scanActionPins([wf(".github/workflows/ci.yml", body)], {
    knownOpenFindingIds: ["BP-SHA-PIN-actions-checkout"],
    lockfile: { kind: "absent" },
  });
  assertEquals(known, []);

  const suppressed = scanActionPins([wf(".github/workflows/ci.yml", body)], {
    suppressedIds: ["BP-SHA-PIN-actions-checkout"],
    lockfile: { kind: "absent" },
  });
  assertEquals(suppressed, []);
});

Deno.test("scanActionPins - distinct coordinates yield distinct findings sorted by id", () => {
  const files = [
    wf(
      ".github/workflows/ci.yml",
      "jobs:\n  b:\n    steps:\n      - uses: zzz/last@v1\n      - uses: aaa/first@v1\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
  assertEquals(findings.length, 2);
  assertEquals(findings[0]!.findingId, "BP-SHA-PIN-aaa-first");
  assertEquals(findings[1]!.findingId, "BP-SHA-PIN-zzz-last");
});

// ---------------------------------------------------------------------------
// Workflow lockfile coverage (Issue #5051)
// ---------------------------------------------------------------------------

const HEX = "1234567890abcdef1234567890abcdef12345678"; // 40 hex
const CI = ".github/workflows/ci.yml";
const CHECKOUT_V4_BODY =
  "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v4\n";

/** A valid lockfile: ci.yml locks actions/checkout@v4. */
const LOCK_CI_CHECKOUT = [
  "version: 'v0.0.3'",
  "workflows:",
  "    '.github/workflows/ci.yml':",
  "        - 'actions/checkout@v4'",
  "dependencies:",
  "    'actions/checkout@v4':",
  "        ref: 'v4'",
  `        commit: 'sha1-${HEX}'`,
  "        owner_id: 44036562",
  "        repo_id: 197814629",
  "",
].join("\n");

/** Parse a lockfile fixture and insist it is valid. */
function validLock(text: string): ActionsLockfileEvidence {
  const evidence = parseActionsLockfile(text);
  assertEquals(evidence.kind, "valid", "fixture must be a valid lockfile");
  return evidence;
}

Deno.test("scanActionPins - a tag ref the lockfile covers is not flagged and raises no lockfile finding", () => {
  const files = [wf(CI, CHECKOUT_V4_BODY)];
  const lockfile = validLock(LOCK_CI_CHECKOUT);
  assertEquals(scanActionPins(files, { lockfile }), []);
  assertEquals(scanActionLockfile(files, lockfile), []);
});

Deno.test("scanActionPins - partial adoption: the listed workflow is covered, the unlisted one keeps BP-SHA-PIN", () => {
  const files = [
    wf(CI, CHECKOUT_V4_BODY),
    wf(".github/workflows/release.yml", CHECKOUT_V4_BODY),
  ];
  const findings = scanActionPins(files, {
    lockfile: validLock(LOCK_CI_CHECKOUT),
  });
  assertEquals(findings.map((f) => f.findingId), [
    "BP-SHA-PIN-actions-checkout",
  ]);
  assertEquals(findings[0]!.callSites, [
    { file: ".github/workflows/release.yml", line: 4, ref: "v4" },
  ]);
  assertStringIncludes(
    findings[0]!.suggestedFix,
    "gh actions-lock --verify",
  );
});

Deno.test("scanActionLockfile - a newly added unlocked action in an onboarded workflow is stale, not BP-SHA-PIN", () => {
  const body = CHECKOUT_V4_BODY +
    "      - uses: actions/setup-node@v4\n";
  const files = [wf(CI, body)];
  const lockfile = validLock(LOCK_CI_CHECKOUT);
  assertEquals(scanActionPins(files, { lockfile }), []);

  const findings = scanActionLockfile(files, lockfile);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-ACTIONS-LOCK-STALE-ci-yml",
  ]);
  const f = findings[0]!;
  assertEquals(f.severity, "high");
  assertEquals(f.coordinate, CI);
  assertEquals(
    f.title,
    "🔴 Workflow lockfile is stale for `.github/workflows/ci.yml`: run `gh actions-lock`",
  );
  assertEquals(f.callSites, [{ file: CI, line: 5, ref: "v4" }]);
  assertStringIncludes(f.evidence, "uses: actions/setup-node@v4");
  assertStringIncludes(f.suggestedFix, "gh actions-lock --verify");
});

Deno.test("scanActionLockfile - a ref mismatch (@v5 against the locked @v4) is stale", () => {
  const files = [
    wf(CI, "jobs:\n  b:\n    steps:\n      - uses: actions/checkout@v5\n"),
  ];
  const lockfile = validLock(LOCK_CI_CHECKOUT);
  assertEquals(scanActionPins(files, { lockfile }), []);
  assertEquals(
    scanActionLockfile(files, lockfile).map((f) => f.findingId),
    ["BP-ACTIONS-LOCK-STALE-ci-yml"],
  );
});

Deno.test("scanActionLockfile - a workflow pin with no dependency entry is stale", () => {
  const lockfile = validLock(
    [
      "version: 'v0.0.3'",
      "workflows:",
      "    '.github/workflows/ci.yml':",
      "        - 'actions/checkout@v4'",
      "",
    ].join("\n"),
  );
  const files = [wf(CI, CHECKOUT_V4_BODY)];
  assertEquals(scanActionPins(files, { lockfile }), []);
  assertEquals(
    scanActionLockfile(files, lockfile).map((f) => f.findingId),
    ["BP-ACTIONS-LOCK-STALE-ci-yml"],
  );
});

Deno.test("scanActionPins - an invalid lockfile yields BP-ACTIONS-LOCK-INVALID and SHA fallback findings", () => {
  const lockfile = parseActionsLockfile("version: 'v0.0.1'\n");
  assertEquals(lockfile.kind, "invalid");
  const files = [wf(CI, CHECKOUT_V4_BODY)];

  assertEquals(
    scanActionPins(files, { lockfile }).map((f) => f.findingId),
    ["BP-SHA-PIN-actions-checkout"],
  );

  const findings = scanActionLockfile(files, lockfile);
  assertEquals(findings.map((f) => f.findingId), [
    "BP-ACTIONS-LOCK-INVALID",
  ]);
  const f = findings[0]!;
  assertEquals(f.severity, "high");
  assertEquals(f.file, ".github/workflows/actions.lock");
  assertEquals(f.lines, 1);
  assertEquals(f.callSites, []);
  assertEquals(
    f.title,
    "🔴 Workflow lockfile `.github/workflows/actions.lock` is not a valid, supported lockfile",
  );
  assertStringIncludes(f.evidence, "v0.0.1");
});

Deno.test("scanActionPins - a reusable-workflow call at a tag is BP-SHA-PIN even when the lockfile lists the pin", () => {
  const lockfile = validLock(
    [
      "version: 'v0.0.3'",
      "workflows:",
      "    '.github/workflows/release.yml':",
      "        - 'org/repo@v1'",
      "dependencies:",
      "    'org/repo@v1':",
      "        ref: 'v1'",
      `        commit: 'sha1-${HEX}'`,
      "        owner_id: 1",
      "        repo_id: 2",
      "",
    ].join("\n"),
  );
  const files = [
    wf(
      ".github/workflows/release.yml",
      "jobs:\n  call:\n    uses: org/repo/.github/workflows/build.yml@v1\n",
    ),
  ];
  const findings = scanActionPins(files, { lockfile });
  assertEquals(findings.map((f) => f.findingId), [
    "BP-SHA-PIN-org-repo-github-workflows-build-yml",
  ]);
  assertStringIncludes(
    findings[0]!.whyItMatters,
    "does not cover a reusable-workflow call",
  );
  assertStringIncludes(
    findings[0]!.suggestedFix,
    "does not cover a reusable-workflow call",
  );
  assertEquals(scanActionLockfile(files, lockfile), []);
});

Deno.test("scanActionPins - a composite-action file with a tag ref is BP-SHA-PIN even with a valid lockfile", () => {
  const files = [{
    path: ".github/actions/setup/action.yml",
    rawText:
      "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n",
    parsed: null,
    kind: "composite-action" as const,
  }];
  const findings = scanActionPins(files, {
    lockfile: validLock(LOCK_CI_CHECKOUT),
  });
  assertEquals(findings.map((f) => f.findingId), [
    "BP-SHA-PIN-actions-checkout",
  ]);
});

Deno.test("scanActionPins - a sub-action path is covered by its repo-scoped pin", () => {
  const lockfile = validLock(
    [
      "version: 'v0.0.3'",
      "workflows:",
      "    '.github/workflows/ci.yml':",
      "        - 'github/codeql-action@v3'",
      "dependencies:",
      "    'github/codeql-action@v3':",
      "        ref: 'v3'",
      `        commit: 'sha1-${HEX}'`,
      "        owner_id: 1",
      "        repo_id: 2",
      "",
    ].join("\n"),
  );
  const files = [
    wf(
      CI,
      "jobs:\n  b:\n    steps:\n      - uses: github/codeql-action/init@v3\n",
    ),
  ];
  assertEquals(scanActionPins(files, { lockfile }), []);
  assertEquals(scanActionLockfile(files, lockfile), []);
});

Deno.test("scanActionPins - SHA-pinned refs stay unflagged with a lockfile present", () => {
  const files = [
    wf(
      CI,
      `jobs:\n  b:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/setup-node@${SHA}\n`,
    ),
  ];
  const lockfile = validLock(LOCK_CI_CHECKOUT);
  assertEquals(scanActionPins(files, { lockfile }), []);
  assertEquals(scanActionLockfile(files, lockfile), []);
});

Deno.test("scanActionLockfile - a known-open or suppressed stale id is dropped", () => {
  const files = [
    wf(CI, CHECKOUT_V4_BODY + "      - uses: actions/setup-node@v4\n"),
  ];
  const lockfile = validLock(LOCK_CI_CHECKOUT);
  assertEquals(
    scanActionLockfile(files, lockfile, {
      knownOpenFindingIds: ["BP-ACTIONS-LOCK-STALE-ci-yml"],
    }),
    [],
  );
  assertEquals(
    scanActionLockfile(files, lockfile, {
      suppressedIds: ["BP-ACTIONS-LOCK-STALE-ci-yml"],
    }),
    [],
  );
});

Deno.test("scanActionLockfile - an absent lockfile raises nothing", () => {
  const files = [wf(CI, CHECKOUT_V4_BODY)];
  assertEquals(scanActionLockfile(files, { kind: "absent" }), []);
  const absent: ActionsLockfileEvidence = { kind: "absent" };
  assertEquals(scanActionPins(files, { lockfile: absent }).length, 1);
});

Deno.test("invalid lock metadata cannot suppress SHA findings", () => {
  for (
    const text of [
      LOCK_CI_CHECKOUT.replace("ref: 'v4'", "ref: 'v5'"),
      LOCK_CI_CHECKOUT + "        hostname: 'GITHUB.COM'\n",
      LOCK_CI_CHECKOUT + "        uses: ['actions/checkout@v4']\n",
    ]
  ) {
    const lockfile = parseActionsLockfile(text);
    assertEquals(
      scanActionLockfile([wf(CI, CHECKOUT_V4_BODY)], lockfile).map((f) =>
        f.findingId
      ),
      ["BP-ACTIONS-LOCK-INVALID"],
    );
    assertEquals(
      scanActionPins([wf(CI, CHECKOUT_V4_BODY)], { lockfile }).map((f) =>
        f.findingId
      ),
      ["BP-SHA-PIN-actions-checkout"],
    );
  }
});

Deno.test("onboarded workflows report unlocked first-party actions", () => {
  const files = [
    wf(CI, CHECKOUT_V4_BODY + "      - uses: stSoftwareAU/deploy-action@v2\n"),
  ];
  assertEquals(
    scanActionLockfile(files, validLock(LOCK_CI_CHECKOUT)).map((f) =>
      f.findingId
    ),
    ["BP-ACTIONS-LOCK-STALE-ci-yml"],
  );
});

Deno.test("composite call-sites never suggest ineffective lockfile adoption", () => {
  const composite = {
    path: ".github/actions/setup/action.yml",
    rawText:
      "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n",
    parsed: null,
    kind: "composite-action" as const,
  };
  for (const files of [[composite], [composite, wf(CI, CHECKOUT_V4_BODY)]]) {
    const findings = scanActionPins(files, { lockfile: { kind: "absent" } });
    assertEquals(findings.length, 1);
    assertEquals(findings[0]!.suggestedFix.includes("Alternatively"), false);
    assertStringIncludes(findings[0]!.suggestedFix, "SHA");
  }
});
