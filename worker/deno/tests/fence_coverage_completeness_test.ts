/** Every exported prompt builder needs canary coverage (Issue #4208). */
import {
  assert,
  assertEquals,
  AssertionError,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { sourceProseLines } from "../lib/removed_assertion_gate.ts";

const ROW_FILES = [
  "fence_coverage_verifier_test.ts",
  "fence_coverage_prompt_builder_test.ts",
  "fence_coverage_processors_test.ts",
  "fence_coverage_repair_test.ts",
] as const;

interface NoUntrustedInput {
  name: string;
  reason: string;
}

// All current exported builders accept untrusted text, including the security
// scanner (open issue titles) and summariser (conversation text). Add an entry
// only when its reason explains why no caller-controlled text enters a prompt.
const NO_UNTRUSTED_INPUT: readonly NoUntrustedInput[] = [];

function codeOnly(source: string, path: string): string {
  const lexed = sourceProseLines(source, path);
  assertEquals(
    lexed.unterminatedFrom,
    -1,
    `${path}: source could not be scanned completely; fix the parse before checking coverage`,
  );
  const originalLines = source.split("\n");
  return lexed.lines.map((line, index) =>
    line.code.padEnd(originalLines[index]!.length)
  ).join("\n");
}

function exportedBuilders(source: string, path = "fixture.ts"): string[] {
  const pattern =
    /\bexport\s+(?:(?:async\s+)?function\s+(build\w*Prompt)\b|const\s+(build\w*Prompt)\s*=)/g;
  return [...codeOnly(source, path).matchAll(pattern)].map((match) =>
    match[1] ?? match[2]!
  );
}

function rowNames(source: string, path = "rows_test.ts"): string[] {
  // Locate the property in executable code, then read its literal value from
  // the same offset in the original text. Comments and strings cannot pose as
  // rows, while knownLeakRow({ name: "buildXPrompt", ... }) counts normally.
  const names: string[] = [];
  for (const match of codeOnly(source, path).matchAll(/\bname\s*:/g)) {
    const literal = source.slice(match.index + match[0].length).match(
      /^\s*["'](build\w*Prompt)["']/,
    );
    if (literal) names.push(literal[1]!);
  }
  return names;
}

function assertCoverage(
  builders: readonly string[],
  rows: readonly string[],
  allowlist: readonly NoUntrustedInput[],
): void {
  const problems: string[] = [];
  const builderNames = new Set(builders);
  const covered = new Set(rows);
  const allowed = new Set(allowlist.map((entry) => entry.name));
  if (builders.length === 0) problems.push("Builder scan found nothing");
  if (rows.length === 0) problems.push("Row scan found nothing");
  for (const name of builderNames) {
    if (!covered.has(name) && !allowed.has(name)) {
      problems.push(`Missing fence coverage: ${name}`);
    }
  }
  for (const name of new Set([...rows, ...allowed])) {
    if (!builderNames.has(name)) problems.push(`Stale entry: ${name}`);
    if (covered.has(name) && allowed.has(name)) {
      problems.push(`Both a row and NO_UNTRUSTED_INPUT: ${name}`);
    }
  }
  for (const entry of allowlist) {
    if (!entry.reason.trim()) {
      problems.push(`Missing allowlist reason: ${entry.name}`);
    }
  }
  assertEquals(
    problems,
    [],
    problems.join("\n") +
      "\nAdd a row in the matching fence_coverage_*_test.ts file, or add a " +
      "NO_UNTRUSTED_INPUT entry with a reason. Remove stale or overlapping entries.",
  );
}

async function scanBuilders(dir: URL): Promise<string[]> {
  const builders: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = new URL(entry.name, dir);
    if (entry.isDirectory) {
      builders.push(...await scanBuilders(new URL(`${entry.name}/`, dir)));
    } else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      builders.push(
        ...exportedBuilders(await Deno.readTextFile(path), path.pathname),
      );
    }
  }
  return builders;
}

Deno.test("fence coverage completeness - every exported builder has a current row or reason", async () => {
  const builders = await scanBuilders(new URL("../lib/", import.meta.url));
  const rows = (await Promise.all(
    ROW_FILES.map(async (file) =>
      rowNames(await Deno.readTextFile(new URL(file, import.meta.url)), file)
    ),
  )).flat();
  assertCoverage(builders, rows, NO_UNTRUSTED_INPUT);
});

Deno.test("fence coverage completeness - finds function, async and const builders across lines", () => {
  assertEquals(
    exportedBuilders(`
    export function buildFirstPrompt() {}
    export async function buildSecondPrompt() {}
    export const buildThirdPrompt = () => "";
    export\nasync\nfunction\nbuildWrappedPrompt() {}
    export const buildPromptPreviewBody = () => "";
    export function buildPromptTooLongReason() {}
    function buildPrivatePrompt() {}
  `),
    [
      "buildFirstPrompt",
      "buildSecondPrompt",
      "buildThirdPrompt",
      "buildWrappedPrompt",
    ],
  );
});

Deno.test("fence coverage completeness - comments and literal examples cannot invent builders or rows", () => {
  assertEquals(
    exportedBuilders(`
    // export function buildCommentPrompt() {}
    /* export async function buildBlockPrompt() {} */
    const example = "export function buildQuotedPrompt() {}";
    const template = \`export const buildTemplatePrompt = () => ""\`;
    const pattern = /export function buildRegexPrompt/;
    export function buildActualPrompt() {}
  `),
    ["buildActualPrompt"],
  );
  assertEquals(
    rowNames(`
    // name: "buildCommentPrompt"
    /* name: "buildBlockPrompt" */
    const example = 'name: "buildQuotedPrompt"';
    const template = \`name: "buildTemplatePrompt"\`;
    const rows = [{ name: "buildActualPrompt", render() { return ""; } },
      knownLeakRow({ name:\n"buildLeakingPrompt", knownLeak: "#4208" })];
  `),
    ["buildActualPrompt", "buildLeakingPrompt"],
  );
});

Deno.test("fence coverage completeness - rejects empty scans, missing, stale and overlapping entries", () => {
  const cases: Array<{
    builders: string[];
    rows: string[];
    allowlist: NoUntrustedInput[];
    reason: string;
  }> = [
    {
      builders: [],
      rows: ["buildRealPrompt"],
      allowlist: [],
      reason: "Builder scan found nothing",
    },
    {
      builders: ["buildRealPrompt"],
      rows: [],
      allowlist: [],
      reason: "Row scan found nothing",
    },
    {
      builders: ["buildRealPrompt", "buildDummyPrompt"],
      rows: ["buildRealPrompt"],
      allowlist: [],
      reason: "Missing fence coverage: buildDummyPrompt",
    },
    {
      builders: ["buildRealPrompt"],
      rows: ["buildRenamedPrompt"],
      allowlist: [],
      reason: "Stale entry: buildRenamedPrompt",
    },
    {
      builders: ["buildRealPrompt"],
      rows: ["buildRealPrompt"],
      allowlist: [{
        name: "buildRemovedPrompt",
        reason: "Only fixed instructions",
      }],
      reason: "Stale entry: buildRemovedPrompt",
    },
    {
      builders: ["buildRealPrompt"],
      rows: ["buildRealPrompt"],
      allowlist: [{
        name: "buildRealPrompt",
        reason: "Only fixed instructions",
      }],
      reason: "Both a row and NO_UNTRUSTED_INPUT: buildRealPrompt",
    },
    {
      builders: ["buildRealPrompt", "buildFixedPrompt"],
      rows: ["buildRealPrompt"],
      allowlist: [{ name: "buildFixedPrompt", reason: " " }],
      reason: "Missing allowlist reason: buildFixedPrompt",
    },
  ];
  for (const { builders, rows, allowlist, reason } of cases) {
    const error = assertThrows(
      () => assertCoverage(builders, rows, allowlist),
      AssertionError,
      reason,
    );
    assertStringIncludes(error.message, "fence_coverage_*_test.ts");
    assertStringIncludes(error.message, "NO_UNTRUSTED_INPUT");
  }
});

Deno.test("fence coverage completeness - accepts an explicit no-input reason and rejects unreadable source", () => {
  assertCoverage(["buildRealPrompt", "buildFixedPrompt"], ["buildRealPrompt"], [
    {
      name: "buildFixedPrompt",
      reason: "Returns only fixed worker-authored instructions",
    },
  ]);
  for (
    const source of [
      "/* unclosed comment",
      "const example = `unclosed template",
    ]
  ) {
    assertThrows(
      () => exportedBuilders(source),
      AssertionError,
      "could not be scanned completely",
    );
  }
  assert(
    rowNames('const row = { name: "buildRealPrompt" };').includes(
      "buildRealPrompt",
    ),
  );
});
