/**
 * One rule about bypassing the pre-commit gate (Issue #783).
 *
 * `coding_guidelines` forbids it categorically — "Bypassing either safeguard
 * (e.g. `git commit --no-verify`, `git add -f`) is **forbidden**", restated in
 * its worked example and in `CODING-STANDARDS.md`. But `issue` and
 * `pr_feedback`, which render that block in the same prompt, listed
 * `git commit --no-verify` among the justify-then-run actions: "if one of them
 * genuinely is the only way forward, **do it** and state the justification".
 *
 * The reversibility bullet is sound; `--no-verify` was the wrong member of it.
 * Unlike `push --force`, `rm -rf` or branch deletion, it has a documented
 * non-bypass remedy — fix the allowlist by PR — and it is the gate that stops
 * a staged secret, so an escape clause reopens exactly the hole the ban exists
 * to close.
 *
 * The guard is deliberately literal: no latest-version template outside
 * `coding_guidelines` may contain the string `--no-verify` at all. A template
 * that needs to talk about the ban cites the guidelines instead — which is
 * what the two new versions do. Classifying "permissive wording" would be
 * neither exact nor enforceable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The bypass flag no phase template may name. */
const NO_VERIFY = "--no-verify";

/**
 * The one family that states the ban, and so must name the flag.
 *
 * Every other family cites it rather than repeating it.
 */
const BAN_OWNER = "coding_guidelines";

/** Every prompt family under `prompts/`. */
async function promptFamilies(): Promise<string[]> {
  const families: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isDirectory) families.push(entry.name);
  }
  return families.sort();
}

/** The latest text of one family, and the version it came from. */
async function latestText(
  family: string,
): Promise<{ version: string; text: string } | null> {
  const latest = await getLatestVersion(family, PROMPTS_DIR);
  if (!latest.ok) return null;
  const loaded = await loadPrompt(family, latest.value, PROMPTS_DIR);
  if (!loaded.ok) return null;
  return { version: latest.value, text: loaded.value };
}

Deno.test("no-verify - no latest template outside the guidelines names the flag (Issue #783)", async () => {
  const families = await promptFamilies();
  assert(families.length > 0, "expected prompt families under prompts/");

  const offenders: string[] = [];
  for (const family of families) {
    if (family === BAN_OWNER) continue;
    const latest = await latestText(family);
    if (!latest) continue;
    if (latest.text.includes(NO_VERIFY)) {
      offenders.push(`${family} ${latest.version}`);
    }
  }

  assertEquals(
    offenders,
    [],
    `these templates name \`${NO_VERIFY}\` — cite the guidelines' ban instead ` +
      `of restating the flag, so no phase can appear to license it: ` +
      offenders.join(", "),
  );
});

Deno.test("no-verify - the guidelines still forbid it, categorically (Issue #783)", async () => {
  // The guard above is only meaningful while the ban it defers to exists.
  const latest = await latestText(BAN_OWNER);
  assert(latest, "coding_guidelines must resolve");
  assertStringIncludes(latest.text, NO_VERIFY);
  // The wording wraps, so the ban is matched as one collapsed line.
  const collapsed = latest.text.replace(/\s+/g, " ");
  assertStringIncludes(
    collapsed,
    "Bypassing either safeguard (e.g. `git commit --no-verify`, `git add -f`) " +
      "is forbidden",
  );
  assertStringIncludes(collapsed, "fix the allowlist via PR — do not bypass");
});

Deno.test("no-verify - the two templates keep the rest of the reversibility bullet (Issue #783)", async () => {
  // Only `--no-verify` leaves the list: `push --force`, `rm -rf` and branch
  // deletion genuinely can be the only way forward, and keep their clause.
  for (const family of ["issue", "pr_feedback"]) {
    const latest = await latestText(family);
    assert(latest, `${family} must resolve`);
    assertStringIncludes(latest.text, "Bound irreversible actions");
    assertStringIncludes(latest.text, "git push --force");
    assertStringIncludes(latest.text, "only way forward");
    // …and each now says why the bypass is not among them.
    assertStringIncludes(latest.text, "Bypassing the pre-commit gate is");
  }
});

Deno.test("no-verify - the retired versions stay immutable (Issue #783)", async () => {
  for (const [family, version] of [["issue", "v41"], ["pr_feedback", "v15"]]) {
    const result = await loadPrompt(family!, version!, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (!result.ok) continue;
    assertStringIncludes(
      result.value,
      NO_VERIFY,
      `${family} ${version} carried the flag and must keep reading as it did`,
    );
  }
});
