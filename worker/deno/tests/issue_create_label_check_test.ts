/**
 * Tests for the issue-create label guard quality-gate check (Issue #1276).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, and real temporary directories for the directory walk
 * (including an allowlisted file). No source-text grepping of the repo —
 * every assertion runs the real scanner over inputs the test supplies.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  CREATE_LABEL_ALLOWLIST,
  resolveOwningVerb,
  scanContentForUnguardedCreateLabels,
  scanDirectoriesForUnguardedCreateLabels,
} from "../lib/issue_create_label_check.ts";

/** The pre-fix shape of a template finding filer (Issue #1276's report). */
const UNGUARDED_TEMPLATE_FILER = [
  "async function fileFinding(repo: string, finding: Finding) {",
  "  const args: string[] = [",
  '    "issue",',
  '    "create",',
  '    "--repo",',
  "    repo,",
  '    "--title",',
  "    finding.title,",
  '    "--body",',
  "    body,",
  '    "--label",',
  "    BASH_SYNTAX_AUDIT_LABEL,",
  '    "--label",',
  "    `severity:${finding.severity}`,",
  "  ];",
  "  return await ghCommandFn(args);",
  "}",
].join("\n");

/** The same filer after routing its labels through the guard. */
const GUARDED_TEMPLATE_FILER = [
  "async function fileFinding(repo: string, finding: Finding) {",
  "  const args: string[] = [",
  '    "issue",',
  '    "create",',
  '    "--repo",',
  "    repo,",
  '    "--title",',
  "    finding.title,",
  '    "--body",',
  "    body,",
  "    ...guardedLabelArgs(",
  "      [BASH_SYNTAX_AUDIT_LABEL, `severity:${finding.severity}`],",
  '      "worker/deno/lib/idle_task_templates/example.ts",',
  "    ),",
  "  ];",
  "  return await ghCommandFn(args);",
  "}",
].join("\n");

Deno.test("issue_create_label_check - flags unguarded create labels", () => {
  const violations = scanContentForUnguardedCreateLabels(
    UNGUARDED_TEMPLATE_FILER,
    "worker/deno/lib/idle_task_templates/example.ts",
  );
  assertEquals(violations.length, 2);
  assertEquals(violations[0]?.line, 11);
  assertEquals(violations[0]?.rule, "create-argv");
  assertEquals(violations[1]?.line, 13);
  assertEquals(
    violations[0]?.file,
    "worker/deno/lib/idle_task_templates/example.ts",
  );
});

Deno.test("issue_create_label_check - accepts the guarded filer", () => {
  assertEquals(
    scanContentForUnguardedCreateLabels(
      GUARDED_TEMPLATE_FILER,
      "worker/deno/lib/idle_task_templates/example.ts",
    ),
    [],
  );
});

Deno.test("issue_create_label_check - ignores --label used as a read filter", () => {
  const listing = [
    "const raw = await ghCommandFn([",
    '  "issue",',
    '  "list",',
    '  "--repo",',
    "  repo,",
    '  "--label",',
    "  IDLE_TASK_LABEL,",
    '  "--state",',
    '  "open",',
    "]);",
  ].join("\n");
  assertEquals(
    scanContentForUnguardedCreateLabels(listing, "worker/deno/lib/list.ts"),
    [],
  );
});

Deno.test("issue_create_label_check - flags an inline create argv", () => {
  const inline = [
    "const out = await gh(",
    '  ["issue", "create", "--repo", repo, "--label", scanLabel],',
    ");",
  ].join("\n");
  const violations = scanContentForUnguardedCreateLabels(
    inline,
    "worker/deno/lib/inline.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(violations[0]?.rule, "create-argv");
});

Deno.test("issue_create_label_check - flags a pushed label argument", () => {
  const pushed = [
    "for (const extra of extraLabels) {",
    '  args.push("--label", extra);',
    "}",
  ].join("\n");
  const violations = scanContentForUnguardedCreateLabels(
    pushed,
    "worker/deno/lib/filer.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.rule, "label-push");
});

Deno.test("issue_create_label_check - flags a flatMap label pair", () => {
  const flatMapped = '  ...safeLabels.flatMap((l) => ["--label", l]),';
  const violations = scanContentForUnguardedCreateLabels(
    flatMapped,
    "worker/deno/commands/filer.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.rule, "label-array");
});

Deno.test("issue_create_label_check - ignores the pattern inside comments", () => {
  const commented = [
    "/**",
    ' * Historically this filer passed "--label" straight to `gh issue`',
    " * `create`, skipping the guard.",
    " */",
    'const args = ["issue", "create", "--repo", repo];',
    '// args.push("--label", extra);',
  ].join("\n");
  assertEquals(
    scanContentForUnguardedCreateLabels(commented, "worker/deno/lib/doc.ts"),
    [],
  );
});

Deno.test("issue_create_label_check - resolveOwningVerb reads the argv verb", () => {
  const lines = [
    "const args = [",
    '  "issue",',
    '  "create",',
    '  "--label",',
  ];
  assertEquals(resolveOwningVerb(lines, 3), "create");
  assertEquals(resolveOwningVerb(['  "--label",'], 0), null);
});

Deno.test("issue_create_label_check - directory scan honours the allowlist", async () => {
  const root = await Deno.makeTempDir();
  try {
    const libDir = `${root}/worker/deno/lib`;
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.writeTextFile(
      `${libDir}/offender.ts`,
      UNGUARDED_TEMPLATE_FILER,
    );
    await Deno.writeTextFile(`${libDir}/clean.ts`, GUARDED_TEMPLATE_FILER);
    // The chokepoint itself is allowlisted — it is where `--label` lives.
    await Deno.writeTextFile(
      `${libDir}/guarded_issue_labels.ts`,
      UNGUARDED_TEMPLATE_FILER,
    );

    const result = await scanDirectoriesForUnguardedCreateLabels(root, [
      "worker/deno/lib",
    ]);

    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 2);
    assert(
      result.violations.every(
        (v) => v.file === "worker/deno/lib/offender.ts",
      ),
      "only the non-allowlisted offender should be reported",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_label_check - allowlist entries are documented paths", () => {
  assert(
    CREATE_LABEL_ALLOWLIST.has("worker/deno/lib/guarded_issue_labels.ts"),
    "the chokepoint itself must be allowlisted",
  );
  for (const entry of CREATE_LABEL_ALLOWLIST) {
    assert(
      entry.startsWith("worker/deno/") && entry.endsWith(".ts"),
      `allowlist entry '${entry}' must be a repo-relative source path`,
    );
  }
});
