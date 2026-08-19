/**
 * Tests for security_remediation_grouping.ts (Issue #2402).
 *
 * Covers finding parsing from filed `security` issues, the three safe
 * grouping strategies (file / class / dependency), the PR-size cap, the
 * singleton fallback for un-groupable findings, and the traceability
 * helpers that reference each closed finding in the batched PR.
 *
 * Pure-function tests — no GitHub I/O.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildClosesReferences,
  buildFindingIdList,
  DEFAULT_MAX_GROUP_SIZE,
  type GroupingStrategy,
  groupSecurityFindings,
  parseSecurityFinding,
  type RawFindingIssue,
  type SecurityFinding,
  selectGroupingKey,
} from "../lib/security_remediation_grouping.ts";

// ---------------------------------------------------------------------------
// parseSecurityFinding
// ---------------------------------------------------------------------------

Deno.test("parseSecurityFinding - extracts finding id, severity, file, class", () => {
  const issue: RawFindingIssue = {
    number: 42,
    title: "🟠 SQL injection in src/api/orders.ts:47",
    body:
      "<!-- finding-id: SEC-abc123def456 -->\nThe file src/api/orders.ts ...",
    labels: ["security", "severity:high", "confidence:medium"],
  };
  const finding = parseSecurityFinding(issue);
  assertEquals(finding.issueNumber, 42);
  assertEquals(finding.findingId, "SEC-abc123def456");
  assertEquals(finding.severity, "high");
  assertEquals(finding.file, "src/api/orders.ts");
  assertEquals(finding.vulnClass, "SQL injection");
});

Deno.test("parseSecurityFinding - severity defaults to unknown when no label", () => {
  const issue: RawFindingIssue = {
    number: 5,
    title: "Some finding in a.ts",
    body: "no marker here",
    labels: ["security"],
  };
  const finding = parseSecurityFinding(issue);
  assertEquals(finding.severity, "unknown");
  assertEquals(finding.findingId, undefined);
});

Deno.test("parseSecurityFinding - strips trailing line range from file", () => {
  const issue: RawFindingIssue = {
    number: 7,
    title: "🔴 Hardcoded secret in config/app.yaml:12-18",
    body: "<!-- finding-id: SEC-000000000001 -->",
    labels: ["security", "severity:critical"],
  };
  const finding = parseSecurityFinding(issue);
  assertEquals(finding.file, "config/app.yaml");
  assertEquals(finding.severity, "critical");
});

Deno.test("parseSecurityFinding - extracts dependency from a bump-style title", () => {
  const issue: RawFindingIssue = {
    number: 9,
    title: "Bump lodash from 4.17.20 to 4.17.21",
    body: "<!-- finding-id: SEC-deadbeef0001 -->",
    labels: ["security", "severity:medium", "supply-chain:quarantine-missing"],
  };
  const finding = parseSecurityFinding(issue);
  assertEquals(finding.dependency, "lodash");
});

Deno.test("parseSecurityFinding - file is undefined when title has no path", () => {
  const issue: RawFindingIssue = {
    number: 11,
    title: "Insecure default configuration",
    body: "",
    labels: ["security", "severity:low"],
  };
  const finding = parseSecurityFinding(issue);
  assertEquals(finding.file, undefined);
});

// ---------------------------------------------------------------------------
// groupSecurityFindings — by file
// ---------------------------------------------------------------------------

function f(
  partial: Partial<SecurityFinding> & { issueNumber: number },
): SecurityFinding {
  return {
    severity: "medium",
    ...partial,
  };
}

Deno.test("groupSecurityFindings - groups findings sharing a file", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 1, file: "src/a.ts" }),
    f({ issueNumber: 2, file: "src/a.ts" }),
    f({ issueNumber: 3, file: "src/b.ts" }),
  ];
  const groups = groupSecurityFindings(findings, {
    strategy: "file",
    maxGroupSize: 5,
  });
  // One group for a.ts (2 findings) and one for b.ts (1 finding).
  assertEquals(groups.length, 2);
  const aGroup = groups.find((g) => g.key === "src/a.ts");
  assertEquals(aGroup?.findings.map((x) => x.issueNumber), [1, 2]);
});

Deno.test("groupSecurityFindings - respects the max group size cap", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 1, file: "src/a.ts" }),
    f({ issueNumber: 2, file: "src/a.ts" }),
    f({ issueNumber: 3, file: "src/a.ts" }),
    f({ issueNumber: 4, file: "src/a.ts" }),
    f({ issueNumber: 5, file: "src/a.ts" }),
  ];
  const groups = groupSecurityFindings(findings, {
    strategy: "file",
    maxGroupSize: 2,
  });
  // 5 findings for one file, cap 2 → 3 chunks (2, 2, 1).
  assertEquals(groups.length, 3);
  assertEquals(groups.map((g) => g.findings.length).sort(), [1, 2, 2]);
  // Every group must respect the cap.
  for (const g of groups) {
    assertEquals(g.findings.length <= 2, true);
  }
});

Deno.test("groupSecurityFindings - ungroupable findings become singletons", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 1, file: undefined }),
    f({ issueNumber: 2, file: undefined }),
  ];
  const groups = groupSecurityFindings(findings, {
    strategy: "file",
    maxGroupSize: 5,
  });
  // No shared file → each finding is its own group (never batched unsafely).
  assertEquals(groups.length, 2);
  for (const g of groups) {
    assertEquals(g.findings.length, 1);
  }
});

// ---------------------------------------------------------------------------
// groupSecurityFindings — by class and dependency
// ---------------------------------------------------------------------------

Deno.test("groupSecurityFindings - groups by vulnerability class case-insensitively", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 1, vulnClass: "SQL injection" }),
    f({ issueNumber: 2, vulnClass: "sql injection" }),
    f({ issueNumber: 3, vulnClass: "XSS" }),
  ];
  const groups = groupSecurityFindings(findings, {
    strategy: "class",
    maxGroupSize: 5,
  });
  assertEquals(groups.length, 2);
  const sqlGroup = groups.find((g) => g.findings.length === 2);
  assertEquals(sqlGroup?.findings.map((x) => x.issueNumber), [1, 2]);
});

Deno.test("groupSecurityFindings - groups by dependency", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 1, dependency: "lodash" }),
    f({ issueNumber: 2, dependency: "lodash" }),
    f({ issueNumber: 3, dependency: "axios" }),
  ];
  const groups = groupSecurityFindings(findings, {
    strategy: "dependency",
    maxGroupSize: 5,
  });
  assertEquals(groups.length, 2);
  const lodashGroup = groups.find((g) => g.key === "lodash");
  assertEquals(lodashGroup?.findings.length, 2);
});

Deno.test("groupSecurityFindings - returns empty array for no findings", () => {
  const groups = groupSecurityFindings([], {
    strategy: "file",
    maxGroupSize: 5,
  });
  assertEquals(groups, []);
});

Deno.test("groupSecurityFindings - throws on non-positive max group size", () => {
  assertThrows(
    () => groupSecurityFindings([], { strategy: "file", maxGroupSize: 0 }),
    RangeError,
  );
});

Deno.test("groupSecurityFindings - output is deterministic for a given input", () => {
  const findings: SecurityFinding[] = [
    f({ issueNumber: 3, file: "src/b.ts" }),
    f({ issueNumber: 1, file: "src/a.ts" }),
    f({ issueNumber: 2, file: "src/a.ts" }),
  ];
  const opts = { strategy: "file" as const, maxGroupSize: 5 };
  const first = groupSecurityFindings(findings, opts);
  const second = groupSecurityFindings(findings, opts);
  assertEquals(first, second);
  // Groups sorted by key; findings sorted by issue number within a group.
  assertEquals(first[0]?.key, "src/a.ts");
  assertEquals(first[0]?.findings.map((x) => x.issueNumber), [1, 2]);
});

// ---------------------------------------------------------------------------
// Traceability helpers
// ---------------------------------------------------------------------------

Deno.test("buildClosesReferences - emits one Closes line per finding", () => {
  const group = {
    strategy: "file" as const,
    key: "src/a.ts",
    findings: [
      f({ issueNumber: 1, file: "src/a.ts" }),
      f({ issueNumber: 2, file: "src/a.ts" }),
    ],
  };
  const refs = buildClosesReferences(group);
  assertStringIncludes(refs, "Closes #1");
  assertStringIncludes(refs, "Closes #2");
});

Deno.test("buildFindingIdList - lists finding ids, falling back to issue number", () => {
  const group = {
    strategy: "file" as const,
    key: "src/a.ts",
    findings: [
      f({ issueNumber: 1, file: "src/a.ts", findingId: "SEC-aaa111bbb222" }),
      f({ issueNumber: 2, file: "src/a.ts" }),
    ],
  };
  const list = buildFindingIdList(group);
  assertStringIncludes(list, "SEC-aaa111bbb222");
  assertStringIncludes(list, "#2");
});

Deno.test("DEFAULT_MAX_GROUP_SIZE - is a sane positive cap", () => {
  assertEquals(DEFAULT_MAX_GROUP_SIZE > 0, true);
});

// ---------------------------------------------------------------------------
// selectGroupingKey — exhaustiveness guard (Issue #2794)
// ---------------------------------------------------------------------------

Deno.test("selectGroupingKey - returns the file path for the file strategy", () => {
  const finding = f({ issueNumber: 1, file: "src/a.ts" });
  assertEquals(selectGroupingKey(finding, "file"), "src/a.ts");
});

Deno.test("selectGroupingKey - lower-cases the vulnerability class for the class strategy", () => {
  const finding = f({ issueNumber: 1, vulnClass: "SQL Injection" });
  assertEquals(selectGroupingKey(finding, "class"), "sql injection");
});

Deno.test("selectGroupingKey - returns the dependency name for the dependency strategy", () => {
  const finding = f({ issueNumber: 1, dependency: "lodash" });
  assertEquals(selectGroupingKey(finding, "dependency"), "lodash");
});

Deno.test("selectGroupingKey - returns undefined when the finding lacks the strategy's key", () => {
  const finding = f({ issueNumber: 1 });
  assertEquals(selectGroupingKey(finding, "file"), undefined);
});

Deno.test("selectGroupingKey - throws via assertNever on an out-of-union strategy", () => {
  const finding = f({ issueNumber: 1, file: "src/a.ts" });
  // Simulate a future-variant gap reaching the switch at runtime.
  assertThrows(
    () => selectGroupingKey(finding, "branch" as GroupingStrategy),
    Error,
    "Unreachable",
  );
});
