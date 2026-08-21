/**
 * Tests for issue_finder_logger.ts (Issue #1062).
 *
 * Verifies the diagnostic logging module for the issue finder pipeline.
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDiagnostics,
  formatScanSummary,
  type IssueFinderDiagnostics,
  sanitiseLogField,
} from "../lib/issue_finder_logger.ts";
import {
  compareFleetAuthorSets,
  type FleetAuthorSetInput,
  resolveFleetMaintenanceAuthorSet,
  resolveFleetPrAuthorSet,
} from "../lib/fleet_authors.ts";

/**
 * Create a diagnostics instance with message capture for testing.
 */
function createTestDiagnostics(enabled = true): {
  diag: IssueFinderDiagnostics;
  output: string[];
} {
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled,
    write: (msg: string) => output.push(msg),
  });
  return { diag, output };
}

// =============================================================================
// Diagnostic logger unit tests
// =============================================================================

Deno.test("issue_finder_logger - logRepoClassification emits structured message", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logRepoClassification("owner/repo", "free");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[issue-finder]");
  assertStringIncludes(output[0]!, "repo=owner/repo");
  assertStringIncludes(output[0]!, "classification=free");
});

Deno.test("issue_finder_logger - logRepoClassification logs deprioritised repos", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logRepoClassification("owner/repo", "deprioritised");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "classification=deprioritised");
});

Deno.test("issue_finder_logger - logIssueConsidered tracks total and emits message", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logIssueConsidered("owner/repo", 42, "Fix bug");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "repo=owner/repo");
  assertStringIncludes(output[0]!, "issue=#42");
  assertStringIncludes(output[0]!, "status=considered");

  const summary = diag.getSummary();
  assertEquals(summary.totalConsidered, 1);
});

Deno.test("issue_finder_logger - logIssueSkipped tracks reason counts", () => {
  const { diag } = createTestDiagnostics();

  diag.logIssueSkipped("owner/repo", 1, "assigned");
  diag.logIssueSkipped("owner/repo", 2, "assigned");
  diag.logIssueSkipped("owner/repo", 3, "milestone-occupied", "v2.0");

  const summary = diag.getSummary();
  assertEquals(summary.skippedByReason["assigned"], 2);
  assertEquals(summary.skippedByReason["milestone-occupied"], 1);
});

Deno.test("issue_finder_logger - logIssueSkipped emits structured skip message", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logIssueSkipped("owner/repo", 10, "pr-blocked", "PR #55");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "repo=owner/repo");
  assertStringIncludes(output[0]!, "issue=#10");
  assertStringIncludes(output[0]!, "skipped=pr-blocked");
  assertStringIncludes(output[0]!, 'detail="PR #55"');
});

Deno.test("issue_finder_logger - logIssueEligible tracks eligible count", () => {
  const { diag } = createTestDiagnostics();

  diag.logIssueEligible("owner/repo", 10);
  diag.logIssueEligible("owner/repo", 20);

  const summary = diag.getSummary();
  assertEquals(summary.totalEligible, 2);
});

Deno.test("issue_finder_logger - logFinalSelection emits selection message", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logFinalSelection("owner/repo", 42, "work-on");

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "selected");
  assertStringIncludes(output[0]!, "repo=owner/repo");
  assertStringIncludes(output[0]!, "issue=#42");
  assertStringIncludes(output[0]!, "source=work-on");
});

Deno.test("issue_finder_logger - logFleetPrGuard emits fleet authors and per-author counts (Issue #3138)", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logFleetPrGuard(
    "owner/repo",
    ["bot", "alice", "stsvcbot"],
    { bot: 0, alice: 1, stsvcbot: 2 },
    3,
  );

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "fleet-pr-guard");
  assertStringIncludes(output[0]!, "authors=3");
  assertStringIncludes(output[0]!, "bot=0");
  assertStringIncludes(output[0]!, "alice=1");
  assertStringIncludes(output[0]!, "stsvcbot=2");
  assertStringIncludes(output[0]!, "total-open-prs=3");
});

Deno.test("issue_finder_logger - logFleetPrGuard renders (none) for an empty fleet", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logFleetPrGuard("owner/repo", [], {}, 0);

  assertStringIncludes(output[0]!, "per-author=(none)");
  assertStringIncludes(output[0]!, "total-open-prs=0");
});

Deno.test("issue_finder_logger - getSummary emits summary line when enabled", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logIssueConsidered("owner/repo", 1, "A");
  diag.logIssueConsidered("owner/repo", 2, "B");
  diag.logIssueConsidered("owner/repo", 3, "C");
  diag.logIssueSkipped("owner/repo", 1, "assigned");
  diag.logIssueSkipped("owner/repo", 2, "cooldown");
  diag.logIssueEligible("owner/repo", 3);

  const summary = diag.getSummary();

  assertEquals(summary.totalConsidered, 3);
  assertEquals(summary.totalEligible, 1);
  assertEquals(summary.skippedByReason["assigned"], 1);
  assertEquals(summary.skippedByReason["cooldown"], 1);

  // Summary line should be emitted
  const summaryLine = output.find((m) => m.includes("summary"));
  assertEquals(summaryLine !== undefined, true);
  assertStringIncludes(summaryLine!, "total_considered=3");
  assertStringIncludes(summaryLine!, "total_eligible=1");
  assertStringIncludes(summaryLine!, "total_skipped=2");
});

Deno.test("issue_finder_logger - disabled diagnostics do not write to output", () => {
  const { diag, output } = createTestDiagnostics(false);

  diag.logRepoClassification("owner/repo", "free");
  diag.logIssueConsidered("owner/repo", 1, "A");
  diag.logIssueSkipped("owner/repo", 1, "assigned");
  diag.logIssueEligible("owner/repo", 2);
  diag.logFinalSelection("owner/repo", 2, "work-on");

  // Nothing written to output when disabled
  assertEquals(output.length, 0);
});

Deno.test("issue_finder_logger - disabled diagnostics still track counts via getMessages", () => {
  const { diag } = createTestDiagnostics(false);

  diag.logIssueConsidered("owner/repo", 1, "A");
  diag.logIssueSkipped("owner/repo", 1, "assigned");
  diag.logIssueEligible("owner/repo", 2);

  // Messages are still captured internally
  const messages = diag.getMessages();
  assertEquals(messages.length, 3);

  // Summary counts still work
  const summary = diag.getSummary();
  assertEquals(summary.totalConsidered, 1);
  assertEquals(summary.totalEligible, 1);
});

// =============================================================================
// Claim race diagnostic tracking (Issue #1090)
// =============================================================================

Deno.test("issue_finder_logger - logClaimRaceOutcome tracks wins", () => {
  const { diag } = createTestDiagnostics();

  diag.logClaimRaceOutcome("owner/repo", 42, "won", 2);

  const summary = diag.getSummary();
  assertEquals(summary.claimRaceWins, 1);
  assertEquals(summary.claimRaceLosses, 0);
});

Deno.test("issue_finder_logger - logClaimRaceOutcome tracks losses", () => {
  const { diag } = createTestDiagnostics();

  diag.logClaimRaceOutcome("owner/repo", 42, "lost", 3);

  const summary = diag.getSummary();
  assertEquals(summary.claimRaceWins, 0);
  assertEquals(summary.claimRaceLosses, 1);
});

Deno.test("issue_finder_logger - logClaimRaceOutcome emits structured message", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logClaimRaceOutcome("owner/repo", 42, "lost", 2);

  assertEquals(output.length, 1);
  assertStringIncludes(output[0]!, "[issue-finder]");
  assertStringIncludes(output[0]!, "repo=owner/repo");
  assertStringIncludes(output[0]!, "issue=#42");
  assertStringIncludes(output[0]!, "claim_race=lost");
  assertStringIncludes(output[0]!, "competing_workers=2");
});

Deno.test("issue_finder_logger - getSummary includes claim race statistics", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logClaimRaceOutcome("owner/repo", 10, "won", 1);
  diag.logClaimRaceOutcome("owner/repo", 20, "lost", 2);
  diag.logClaimRaceOutcome("owner/repo", 30, "lost", 3);

  const summary = diag.getSummary();
  assertEquals(summary.claimRaceWins, 1);
  assertEquals(summary.claimRaceLosses, 2);

  // Summary line should include claim race stats
  const summaryLine = output.find((m) => m.includes("summary"));
  assertStringIncludes(summaryLine!, "claim_race_wins=1");
  assertStringIncludes(summaryLine!, "claim_race_losses=2");
});

Deno.test("issue_finder_logger - cross-worker cooldown skip reason is distinct from local cooldown", () => {
  const { diag } = createTestDiagnostics();

  diag.logIssueSkipped("owner/repo", 1, "cooldown");
  diag.logIssueSkipped("owner/repo", 2, "cross-worker-cooldown");

  const summary = diag.getSummary();
  assertEquals(summary.skippedByReason["cooldown"], 1);
  assertEquals(summary.skippedByReason["cross-worker-cooldown"], 1);
});

Deno.test("issue_finder_logger - enabled property reflects configuration", () => {
  const { diag: enabled } = createTestDiagnostics(true);
  const { diag: disabled } = createTestDiagnostics(false);

  assertEquals(enabled.enabled, true);
  assertEquals(disabled.enabled, false);
});

// =============================================================================
// Selection reasoning diagnostic (Issue #1718)
// =============================================================================

Deno.test(
  "issue_finder_logger - logSelectionReasoning emits unconditionally when disabled",
  () => {
    // The reasoning line answers a user question right now (#1717) and
    // must surface even when ISSUE_FINDER_DEBUG is unset.
    const { diag, output } = createTestDiagnostics(false);

    diag.logSelectionReasoning(
      { repo: "owner/repo", number: 1711, source: "work-on" },
      2,
      [
        {
          repo: "owner/repo",
          issueNumber: 1691,
          milestone: "v2.0",
          reason: "milestone-occupied",
        },
        {
          repo: "owner/other",
          issueNumber: 42,
          milestone: "",
          reason: "pr-blocked",
        },
      ],
    );

    assertEquals(output.length, 1);
    const line = output[0]!;
    assertStringIncludes(line, "[issue-finder] selection-reasoning");
    assertStringIncludes(line, "selected=owner/repo#1711");
    assertStringIncludes(line, "source=work-on");
    assertStringIncludes(line, "configured-label-considered=2");
    assertStringIncludes(line, "configured-label-blocked=2");
    assertStringIncludes(
      line,
      "blocked=owner/repo#1691(milestone-occupied),owner/other#42(pr-blocked)",
    );
  },
);

Deno.test(
  "issue_finder_logger - logSelectionReasoning omits blocked field when no entries",
  () => {
    const { diag, output } = createTestDiagnostics();

    diag.logSelectionReasoning(
      { repo: "owner/repo", number: 1711, source: "work-on" },
      0,
      [],
    );

    assertEquals(output.length, 1);
    const line = output[0]!;
    assertStringIncludes(line, "configured-label-blocked=0");
    // No `blocked=` field when there are no blocked entries
    assertEquals(line.includes("blocked=owner"), false);
    assertEquals(line.endsWith("configured-label-blocked=0"), true);
  },
);

Deno.test(
  "issue_finder_logger - logSelectionReasoning quotes each documented skip reason",
  () => {
    // Acceptance criterion: the reasoning line must be able to surface
    // each per-issue skip reason that collect_label_candidates emits.
    const { diag, output } = createTestDiagnostics();
    const reasons = [
      "milestone-occupied",
      "pr-blocked",
      "dependency-blocked",
      "closed-pr-cooldown",
    ] as const;

    diag.logSelectionReasoning(
      { repo: "owner/repo", number: 1711, source: "work-on" },
      reasons.length,
      reasons.map((reason, i) => ({
        repo: "owner/repo",
        issueNumber: 100 + i,
        milestone: "",
        reason,
      })),
    );

    assertEquals(output.length, 1);
    for (const reason of reasons) {
      assertStringIncludes(output[0]!, `(${reason})`);
    }
  },
);

// =============================================================================
// Log-injection sanitisation tests (Issue #2797)
// =============================================================================

/**
 * Detect any C0 (0x00-0x1F) or C1 (0x7F-0x9F) control character by code
 * point. Done by char-code scan rather than a control-character regex to
 * keep the test file free of the literal control bytes the
 * `no-control-regex` lint rule forbids.
 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

Deno.test("sanitiseLogField - strips C0 control characters including newlines", () => {
  const malicious =
    'x"\n[issue-finder] repo=acme/app issue=#1 status=eligible title="benign';
  const cleaned = sanitiseLogField(malicious);

  // No control characters (C0/C1) survive.
  assertEquals(hasControlChar(cleaned), false);
  // Single line — no embedded newline.
  assertEquals(cleaned.includes("\n"), false);
  // Embedded double quotes are neutralised so field framing holds.
  assertEquals(cleaned.includes('"'), false);
});

Deno.test("sanitiseLogField - strips ANSI/terminal escape bytes", () => {
  // ESC (0x1B) is a C0 control byte used to start ANSI sequences.
  const ansi = `title${String.fromCharCode(0x1b)}[31mRED${
    String.fromCharCode(0x1b)
  }[0m`;
  const cleaned = sanitiseLogField(ansi);

  assertEquals(hasControlChar(cleaned), false);
});

Deno.test("sanitiseLogField - clamps length to 200 characters", () => {
  const long = "a".repeat(500);
  const cleaned = sanitiseLogField(long);

  assertEquals(cleaned.length, 200);
});

Deno.test("sanitiseLogField - leaves benign titles unchanged", () => {
  const benign = "Fix the date parser bug";
  assertEquals(sanitiseLogField(benign), benign);
});

Deno.test("issue_finder_logger - logIssueConsidered sanitises injected title", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logIssueConsidered(
    "owner/repo",
    7,
    'evil"\n[issue-finder] forged status=eligible',
  );

  // Exactly one emitted line — the forged newline did not split it.
  assertEquals(output.length, 1);
  assertEquals(output[0]!.includes("\n"), false);
  assertEquals(hasControlChar(output[0]!), false);
  assertStringIncludes(output[0]!, "status=considered");
});

Deno.test("issue_finder_logger - logIssueSkipped sanitises injected detail", () => {
  const { diag, output } = createTestDiagnostics();

  diag.logIssueSkipped(
    "owner/repo",
    9,
    "filtered-out",
    'reason"\n[issue-finder] forged line',
  );

  assertEquals(output.length, 1);
  assertEquals(output[0]!.includes("\n"), false);
  assertEquals(hasControlChar(output[0]!), false);
  assertStringIncludes(output[0]!, "skipped=filtered-out");
});

// =============================================================================
// Fleet-author-set divergence warning path (Issues #4024, #4079)
// =============================================================================

const DIVERGENCE_INPUT: FleetAuthorSetInput = {
  githubUser: "Vibecoderbot",
  allowedAuthors: ["human1"],
  fleetPrAuthors: ["stsvcbot"],
};

/** The divergence lines emitted for a given pair of author sets. */
function divergenceLines(
  blocking: readonly string[],
  maintenance: readonly string[],
): string[] {
  // Diagnostics disabled: the warning is written unconditionally, so this
  // also pins that it does not need ISSUE_FINDER_DEBUG to be visible.
  const { diag, output } = createTestDiagnostics(false);
  diag.logFleetAuthorSetDivergence(
    compareFleetAuthorSets(blocking, maintenance, {
      expectedMaintenanceExclusions: DIVERGENCE_INPUT.allowedAuthors,
    }),
  );
  return output.filter((m) => m.includes("fleet-author-set-divergence"));
}

Deno.test("issue_finder_logger - expected trusted-human delta logs no divergence warning (Issue #4079)", () => {
  const lines = divergenceLines(
    resolveFleetPrAuthorSet(DIVERGENCE_INPUT),
    resolveFleetMaintenanceAuthorSet(DIVERGENCE_INPUT),
  );
  assertEquals(lines, []);
});

Deno.test("issue_finder_logger - a fleet sibling missing from maintenance still warns (Issue #4079)", () => {
  const lines = divergenceLines(
    resolveFleetPrAuthorSet(DIVERGENCE_INPUT),
    ["Vibecoderbot"],
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "missing-from-maintenance=stsvcbot");
  assertStringIncludes(lines[0]!, "missing-from-blocking=(none)");
});

Deno.test("issue_finder_logger - a maintained login invisible to the guard still warns (Issue #4079)", () => {
  const lines = divergenceLines(
    ["Vibecoderbot"],
    ["Vibecoderbot", "stsvcbot"],
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "missing-from-blocking=stsvcbot");
  assertStringIncludes(lines[0]!, "missing-from-maintenance=(none)");
});

// =============================================================================
// Scan-summary formatting (Issue #219)
// =============================================================================

Deno.test("formatScanSummary - names the counts and the busiest skip reasons (Issue #219)", () => {
  const line = formatScanSummary({
    totalConsidered: 12,
    totalEligible: 0,
    skippedByReason: { cooldown: 8, "repo-busy": 3, assigned: 1 },
    claimRaceWins: 0,
    claimRaceLosses: 0,
  });

  assertEquals(
    line,
    "considered=12 eligible=0 skipped=12 top-skips=cooldown=8,repo-busy=3,assigned=1",
  );
});

Deno.test("formatScanSummary - reports only the top reasons, busiest first (Issue #219)", () => {
  const line = formatScanSummary({
    totalConsidered: 9,
    totalEligible: 1,
    skippedByReason: {
      assigned: 1,
      cooldown: 5,
      "pr-blocked": 2,
      "needs-human": 4,
    },
    claimRaceWins: 0,
    claimRaceLosses: 0,
  }, 2);

  assertEquals(
    line,
    "considered=9 eligible=1 skipped=12 top-skips=cooldown=5,needs-human=4",
  );
});

Deno.test("formatScanSummary - a scan with no skips still renders (Issue #219)", () => {
  const line = formatScanSummary({
    totalConsidered: 0,
    totalEligible: 0,
    skippedByReason: {},
    claimRaceWins: 0,
    claimRaceLosses: 0,
  });

  assertEquals(line, "considered=0 eligible=0 skipped=0 top-skips=(none)");
});
