/**
 * One rule about timing assertions in unit tests (Issue #786).
 *
 * Three surfaces stated three different rules about the same concrete
 * pattern:
 *
 *   - `coding_guidelines` — "**Do not measure performance inside unit
 *     tests**", a flat ban;
 *   - `CODING-STANDARDS.md` — "a few tests **must** measure", mandating
 *     `assertLinearGrowth`;
 *   - `test_audit` check 3 — "flag **any** wall-clock comparison inside a unit
 *     test as a finding", with no carve-out.
 *
 * `assertLinearGrowth` times the same work at N and 4N and compares the two
 * readings, so a `test-audit` run over this repository would have filed
 * `timing-assertion` findings against the exact pattern its own standards
 * require — and the implementing run would read a guidelines block telling it
 * not to measure at all.
 *
 * The narrow rule that reconciles all three: what the elapsed time is compared
 * *against*. Another reading of the same work is fine; a constant is the
 * defect. These cases pin that rule on all three surfaces, and pin the callers
 * that depend on it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/** The ratio helper the policy exists to permit. */
const HELPER = "assertLinearGrowth";

/** The one-line rule each surface now states. */
const RULE =
  /compare two readings of the same work|another reading\s+of the same work/i;

/** The latest text of one prompt family, collapsed for matching. */
async function latestCollapsed(
  family: string,
): Promise<{ version: string; text: string; collapsed: string }> {
  const latest = await getLatestVersion(family, PROMPTS_DIR);
  assertEquals(latest.ok, true, `no latest version for ${family}`);
  if (!latest.ok) throw new Error(latest.error.message);
  const loaded = await loadPrompt(family, latest.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return {
    version: latest.value,
    text: loaded.value,
    collapsed: loaded.value.replace(/\s+/g, " "),
  };
}

/** `CODING-STANDARDS.md`, collapsed. */
async function standardsCollapsed(): Promise<string> {
  const text = await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);
  return text.replace(/\s+/g, " ");
}

Deno.test("timing policy - all three surfaces state the same rule (Issue #786)", async () => {
  const guidelines = await latestCollapsed("coding_guidelines");
  const audit = await latestCollapsed("test_audit");
  const standards = await standardsCollapsed();

  for (
    const [name, text] of [
      [`coding_guidelines ${guidelines.version}`, guidelines.collapsed],
      [`test_audit ${audit.version}`, audit.collapsed],
      ["CODING-STANDARDS.md", standards],
    ] as const
  ) {
    assert(
      RULE.test(text),
      `${name} does not state what an elapsed time may be compared against — ` +
        `that distinction is the whole policy`,
    );
  }
});

Deno.test("timing policy - the guidelines no longer ban measuring outright (Issue #786)", async () => {
  const { version, collapsed } = await latestCollapsed("coding_guidelines");
  assertEquals(
    collapsed.includes("Do not measure performance inside unit tests"),
    false,
    `coding_guidelines ${version} still carries the flat ban, which forbids ` +
      `the ratio assertions CODING-STANDARDS.md requires`,
  );
  // …and it names the helper, so a reader knows what is permitted.
  assertStringIncludes(collapsed, HELPER);
});

Deno.test("timing policy - the auditor exempts ratio assertions (Issue #786)", async () => {
  const { version, collapsed } = await latestCollapsed("test_audit");
  // It still flags the real defect …
  assertStringIncludes(collapsed, "Absolute");
  assertStringIncludes(collapsed, "against a constant as a finding");
  // … and now says the growth pattern is not one.
  assertStringIncludes(collapsed, "Ratio assertions are not a finding");
  assertStringIncludes(collapsed, HELPER);
  assertEquals(
    collapsed.includes("Flag any wall-clock comparison inside a unit test"),
    false,
    `test_audit ${version} still flags every comparison without exception`,
  );
});

Deno.test("timing policy - the helper the carve-out names still exists and is used (Issue #786)", async () => {
  // The carve-out is only worth having while the pattern it protects is real.
  const growth = await Deno.readTextFile(
    `${REPO_ROOT}worker/deno/tests/support/growth.ts`,
  );
  assertStringIncludes(growth, `export function ${HELPER}`);

  const callers: string[] = [];
  for await (const entry of Deno.readDir(`${REPO_ROOT}worker/deno/tests`)) {
    if (!entry.isFile || !entry.name.endsWith("_test.ts")) continue;
    const text = await Deno.readTextFile(
      `${REPO_ROOT}worker/deno/tests/${entry.name}`,
    );
    if (text.includes(`${HELPER}(`)) callers.push(entry.name);
  }
  assert(
    callers.length > 0,
    "no unit test calls the helper the carve-out was written for",
  );
});

Deno.test("timing policy - the new audit version declares its own number (Issue #786)", async () => {
  // `test_audit` carries its version in its H1, so a copied file inherits the
  // predecessor's number — the defect class #792 sweeps. This is the one file
  // this change adds, so it is checked here.
  const { version, text } = await latestCollapsed("test_audit");
  assertStringIncludes(text, `Coverage-Gap Audit (${version})`);
});

Deno.test("timing policy - the retired versions stay immutable (Issue #786)", async () => {
  const guidelines = await loadPrompt(
    "coding_guidelines",
    "v45",
    PROMPTS_DIR,
  );
  assertEquals(guidelines.ok, true);
  if (guidelines.ok) {
    assertStringIncludes(
      guidelines.value,
      "Do not measure performance inside unit tests",
    );
  }

  const audit = await loadPrompt("test_audit", "v12", PROMPTS_DIR);
  assertEquals(audit.ok, true);
  if (audit.ok) {
    assertStringIncludes(
      audit.value.replace(/\s+/g, " "),
      "Flag any wall-clock comparison inside a unit test",
    );
  }
});
