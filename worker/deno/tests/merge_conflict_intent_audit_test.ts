/**
 * Tests for the intent audit surface (Issue #1114).
 *
 * The override is a judgement call, so the PR comment is what makes it
 * reviewable afterwards: which issues were consulted (including the paths for
 * which none was found), and which conflicts an issue's intent settled.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type {
  BasePathOrigin,
  ConflictIssueContext,
  OriginatingIssue,
} from "../lib/conflict_issue_context.ts";
import {
  buildConsultedIssuesSection,
  buildIntentOverrideSection,
  parseIntentOverrides,
} from "../lib/conflict_intent_audit.ts";

function issue(number: number, title: string): OriginatingIssue {
  return { number, title, state: "CLOSED", body: "", bodyTruncated: false };
}

function basePath(
  path: string,
  issues: OriginatingIssue[],
  unresolved: BasePathOrigin["unresolved"] = null,
): BasePathOrigin {
  return {
    path,
    commitsInspected: 1,
    prNumbers: [77],
    issues,
    unresolved,
    partial: false,
  };
}

function makeContext(
  overrides?: Partial<ConflictIssueContext>,
): ConflictIssueContext {
  return {
    repo: "org/repo",
    prNumber: 48,
    prSide: {
      resolved: true,
      signal: "branch",
      issue: issue(900, "Drop the interactive timeout to 10s"),
    },
    baseSide: [
      basePath("lib/timeouts.ts", [issue(812, "Raise it to 60s")]),
      basePath("docs/notes.md", [], "no-pr"),
    ],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false,
    },
    ghCallsUsed: 4,
    warnings: [],
    ...overrides,
  };
}

const section = (lines: string[]) => lines.join("\n");

// --- Issues consulted ---

Deno.test("buildConsultedIssuesSection - no context says so rather than staying silent", () => {
  const text = section(buildConsultedIssuesSection(null));
  assertStringIncludes(text, "Issues consulted");
  assertStringIncludes(text, "No originating issues were found");
  assertStringIncludes(text, "both-sides-survive contract applies unchanged");
});

Deno.test("buildConsultedIssuesSection - names both sides and the paths with none", () => {
  const text = section(buildConsultedIssuesSection(makeContext()));
  assertStringIncludes(text, "#900");
  assertStringIncludes(text, "via branch");
  assertStringIncludes(text, "`lib/timeouts.ts` — #812");
  assertStringIncludes(text, "`docs/notes.md` — none found");
  assertStringIncludes(text, "the base commits name no pull request");
  assertStringIncludes(text, "No originating issue was discoverable");
});

Deno.test("buildConsultedIssuesSection - states where an override may be considered", () => {
  const text = section(buildConsultedIssuesSection(makeContext()));
  assertStringIncludes(text, "Both sides' issues are known for");
  assertStringIncludes(text, "`lib/timeouts.ts`");
});

Deno.test("buildConsultedIssuesSection - one side only permits no override anywhere", () => {
  const text = section(buildConsultedIssuesSection(makeContext({
    prSide: { resolved: false, reason: "no-signal" },
  })));
  assertStringIncludes(text, "**PR side** — none found");
  assertStringIncludes(text, "no** conflicted path");
  assertStringIncludes(text, "no intent override is permitted");
});

Deno.test("buildConsultedIssuesSection - a gather failure is stated, not swallowed", () => {
  const text = section(buildConsultedIssuesSection(makeContext({
    warnings: ["gh pr view #77 failed: not found"],
  })));
  assertStringIncludes(text, "Gathering the context was incomplete");
  assertStringIncludes(text, "not found");
});

// --- Declared overrides ---

Deno.test("parseIntentOverrides - reads the documented shape", () => {
  const report = parseIntentOverrides(
    "Merged the base in.\n" +
      "Intent override: lib/timeouts.ts — kept #900, superseded #812 — " +
      "#900 retunes the 60s default #812 introduced\n" +
      "> The 60s default from #812 is too slow.",
  );
  assertEquals(report.malformed, []);
  assertEquals(report.overrides.length, 1);
  assertEquals(report.overrides[0]?.path, "lib/timeouts.ts");
  assertEquals(report.overrides[0]?.kept, 900);
  assertEquals(report.overrides[0]?.superseded, 812);
  assertStringIncludes(report.overrides[0]?.note ?? "", "retunes the 60s");
});

Deno.test("parseIntentOverrides - accepts a list item, backticks and a hyphen", () => {
  const report = parseIntentOverrides(
    "- Intent override: `lib/a.ts` - kept #5, superseded #4 - #5 reverts #4",
  );
  assertEquals(report.overrides.length, 1);
  assertEquals(report.overrides[0]?.path, "lib/a.ts");
  assertEquals(report.overrides[0]?.superseded, 4);
});

Deno.test("parseIntentOverrides - a claim missing an issue number is malformed", () => {
  const report = parseIntentOverrides(
    "Intent override: lib/a.ts — kept #5 because it is newer",
  );
  assertEquals(report.overrides, []);
  assertEquals(report.malformed.length, 1);
  assertStringIncludes(report.malformed[0] ?? "", "kept #5");
});

Deno.test("parseIntentOverrides - an ordinary reply declares nothing", () => {
  const report = parseIntentOverrides(
    "Merged main into the branch; both sides' bullets kept.",
  );
  assertEquals(report.overrides, []);
  assertEquals(report.malformed, []);
  assertEquals(parseIntentOverrides(undefined).overrides, []);
});

// --- The resolved-comment record ---

Deno.test("buildIntentOverrideSection - names both issues, the file and the outcome", () => {
  const report = parseIntentOverrides(
    "Intent override: lib/timeouts.ts — kept #900, superseded #812 — " +
      "kept the 10s interactive timeout, superseding the 60s default",
  );
  const text = section(buildIntentOverrideSection(report, makeContext()));
  assertStringIncludes(text, "Settled by issue intent");
  assertStringIncludes(text, "`lib/timeouts.ts`");
  assertStringIncludes(text, "kept #900, superseded #812");
  assertStringIncludes(text, "60s default");
  assert(
    !text.includes("uncorroborated"),
    "an override on a path where both issues were known is corroborated",
  );
});

Deno.test("buildIntentOverrideSection - an uncorroborated claim is flagged loudly", () => {
  const report = parseIntentOverrides(
    "Intent override: docs/notes.md — kept #900, superseded #812 — a guess",
  );
  const text = section(buildIntentOverrideSection(report, makeContext()));
  assertStringIncludes(text, "⚠️");
  assertStringIncludes(text, "were **not** known for this path");
});

Deno.test("buildIntentOverrideSection - a malformed claim is reported, not dropped", () => {
  const report = parseIntentOverrides("Intent override: lib/a.ts — kept #5");
  const text = section(buildIntentOverrideSection(report, makeContext()));
  assertStringIncludes(text, "could not be recorded");
  assertStringIncludes(text, "kept #5");
});

Deno.test("buildIntentOverrideSection - no claim renders no section", () => {
  assertEquals(
    buildIntentOverrideSection(parseIntentOverrides("all good"), makeContext()),
    [],
  );
});
