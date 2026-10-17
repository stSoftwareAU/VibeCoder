import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { validateRemovedAssertions } from "../lib/removed_assertion_gate.ts";

const FILE = "tests/store_test.ts";
const MOVED_FILE = "tests/moved_test.ts";
const OLD = "assertEquals(stored, written);";
const NEW = "assertEquals(stored.id, written.id);";
const REQUIREMENT = "Store the new marker alongside every record";
const ISSUE = { issueTitle: "Record markers", issueBody: REQUIREMENT + "." };

function patch(file: string, before: string[], after: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,4 +1,4 @@",
    ' Deno.test("record", () => {',
    ...before.map((line) => "-  " + line),
    ...after.map((line) => "+  " + line),
    " });",
  ].join("\n");
}

function check(entry: string, diff = patch(FILE, [OLD], []), issue = ISSUE) {
  return validateRemovedAssertions({
    ...issue,
    changedFiles: [FILE, MOVED_FILE],
    testDiff: diff,
    prSummaryContent:
      `## Test Plan\n\n- Removed from \`${FILE}\`: \`${OLD}\`\n  ${entry}\n`,
  });
}

Deno.test("removed assertion reasons: explicitly dropping a still-true assertion fails", () => {
  const result = check(
    "Dropped, not moved; no issue requirement makes it untrue.",
  );
  assertFalse(result.valid);
  assertStringIncludes(result.problems.join("\n"), "Required by:");
});

Deno.test("removed assertion reasons: a fabricated requirement fails", () => {
  assertFalse(
    check('Required by: "Remove the stored record equality check"').valid,
  );
});

Deno.test("removed assertion reasons: a short quote fails even when present", () => {
  assertFalse(check('Required by: "the new marker"').valid);
});

Deno.test("removed assertion reasons: an exact issue-body quote passes", () => {
  const result = check(`Required by: "${REQUIREMENT}"`);
  assert(result.valid);
  assertEquals(result.problems, []);
});

Deno.test("removed assertion reasons: issue-title quotes and wrapped whitespace pass", () => {
  const result = check(
    'Required by: "Store the new marker\n  alongside every record"',
    undefined,
    {
      issueTitle: REQUIREMENT,
      issueBody: "An unrelated issue body.",
    },
  );
  assert(result.valid);
});

Deno.test("removed assertion reasons: a requirement in another entry cannot justify a removal", () => {
  assertFalse(
    check(
      `Dropped without a requirement.\n- Unrelated change\n  Required by: "${REQUIREMENT}"`,
    ).valid,
  );
});

Deno.test("removed assertion reasons: a quote cannot bridge the issue title and body", () => {
  assertFalse(
    check('Required by: "Store the new marker alongside"', undefined, {
      issueTitle: "Store the new marker",
      issueBody: "alongside every record",
    }).valid,
  );
});

Deno.test("removed assertion reasons: Moved to requires a matching added assertion", () => {
  assertFalse(check(`Moved to: \`${MOVED_FILE}\``).valid);
  assertFalse(
    check(
      `Moved to: \`${MOVED_FILE}\``,
      patch(FILE, [OLD], []) + "\n" + patch(MOVED_FILE, [], [NEW]),
    ).valid,
  );
});

Deno.test("removed assertion reasons: a genuine move to the named file passes", () => {
  const diff = patch(FILE, [OLD], []) + "\n" + patch(MOVED_FILE, [], [OLD]);
  assert(check(`Moved to: \`${MOVED_FILE}\``, diff).valid);
  assertFalse(check("Moved to: `tests/absent_test.ts`", diff).valid);
});

Deno.test("removed assertion reasons: a matching assertion under a new guard is not a move", () => {
  const diff = patch(FILE, [OLD], []) + "\n" +
    patch(MOVED_FILE, [], ["if (false) {", "  " + OLD, "}"]);
  assertFalse(check(`Moved to: \`${MOVED_FILE}\``, diff).valid);
});

Deno.test("removed assertion reasons: one moved copy cannot account for two removed copies", () => {
  const diff = patch(FILE, [OLD, OLD], []) + "\n" +
    patch(MOVED_FILE, [], [OLD]);
  assertFalse(check(`Moved to: \`${MOVED_FILE}\``, diff).valid);
});

Deno.test("removed assertion reasons: replacement must actually be added in the original file", () => {
  const entry = `Required by: "${REQUIREMENT}"\n  Replaced by: \`${NEW}\``;
  assertFalse(check(entry).valid);
  assertFalse(
    check(entry, patch(FILE, [OLD], []) + "\n" + patch(MOVED_FILE, [], [NEW]))
      .valid,
  );
  assert(check(entry, patch(FILE, [OLD], [NEW])).valid);
});

Deno.test("removed assertion reasons: every named replacement must be added", () => {
  const entry =
    `Required by: "${REQUIREMENT}"\n  Replaced by: \`${NEW}\`, \`assertEquals(stored.name, written.name);\``;
  assertFalse(check(entry, patch(FILE, [OLD], [NEW])).valid);
  assert(
    check(
      entry,
      patch(FILE, [OLD], [NEW, "assertEquals(stored.name, written.name);"]),
    ).valid,
  );
});

Deno.test("removed assertion reasons: replacement evidence alone is not a reason", () => {
  assertFalse(
    check(`Replaced by: \`${NEW}\``, patch(FILE, [OLD], [NEW])).valid,
  );
});

Deno.test("removed assertion reasons: unchanged or commented replacement text is not added evidence", () => {
  const entry = `Required by: "${REQUIREMENT}"\n  Replaced by: \`${NEW}\``;
  const unchanged = patch(FILE, [OLD], []).replace(" });", `   ${NEW}\n });`);
  assertFalse(check(entry, unchanged).valid);
  assertFalse(check(entry, patch(FILE, [OLD], ["// " + NEW])).valid);
});

Deno.test("removed assertion reasons: an unrelated added test does not require a false replacement claim", () => {
  const requirement = "Remove the stored record equality assertion";
  const diff = patch(FILE, [OLD], []) +
    '\n+Deno.test("independent cache behaviour", () => {\n' +
    "+  assertEquals(cache.size, 0);\n+});\n";
  const result = check(`Required by: "${requirement}"`, diff, {
    ...ISSUE,
    issueBody: requirement,
  });
  assert(result.valid, result.problems.join("; "));
});

Deno.test("removed assertion reasons: naming the old check only as a replacement is insufficient", () => {
  const result = validateRemovedAssertions({
    ...ISSUE,
    changedFiles: [FILE],
    testDiff: patch(FILE, [OLD], [NEW]),
    prSummaryContent:
      `## Test Plan\n\n- Changed the store check\n  Required by: "${REQUIREMENT}"\n  Replaced by: \`${OLD}\``,
  });
  assertFalse(result.valid);
  assertEquals(result.unaccounted.length, 1);
});

Deno.test("removed assertion reasons: Markdown code spans can contain template literals", () => {
  const replacement = "assertEquals(stored.label, `marker-${written.id}`);";
  const entry = `Required by: "${REQUIREMENT}"\n  Replaced by: ` +
    "``" + replacement + "``";
  const valid = check(entry, patch(FILE, [OLD], [replacement]));
  assert(valid.valid, valid.problems.join("; "));
  const invalid = check(entry, patch(FILE, [OLD], [NEW]));
  assertFalse(invalid.valid);
  assertStringIncludes(
    invalid.problems.join("; "),
    "must name assertions added",
  );
});
