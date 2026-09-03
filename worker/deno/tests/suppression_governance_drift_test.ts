/**
 * Every reader of the suppression grammar applies the same three-field
 * governance check (Issue #789).
 *
 * `retro/v1` triage rule 6 honoured a **bare** marker: an id match alone
 * dropped the candidate. Twelve sibling scans and the deterministic check
 * (`worker/deno/lib/suppression_comments.ts`) refuse that — a marker
 * suppresses only when it records who waived the finding (`author=`), until
 * when (`expires=`, today or later) and why (non-empty reason), and an
 * ungoverned marker is reported as a `Rejected suppression:` line rather than
 * silently obeyed.
 *
 * So a one-line `// best-practice-ignore: BP-abc123def456` with no author, no
 * expiry and no reason was an ungoverned, never-expiring waiver on the retro
 * path and refused everywhere else — the exact failure the three-field rule
 * exists to prevent.
 *
 * `bash_syntax_audit` compounded it by asserting the deterministic check was
 * "the only path that reads these markers — there is no second triage path
 * for it to drift from". Retro *was* that second path.
 *
 * This test makes the invariant enforceable: every latest prompt that reads
 * the grammar must carry all three fields and the reporting line, so a scan
 * added later cannot honour a bare marker.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** A prompt reads the grammar when it names a marker of the `…-ignore:` form. */
const READS_GRAMMAR = "-ignore:";

/** What a reader must state before honouring one. */
const GOVERNANCE = [
  "author=",
  "expires=",
  "Rejected suppression",
] as const;

/** Every prompt family under `prompts/`. */
async function families(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isDirectory) found.push(entry.name);
  }
  return found.sort();
}

/** The latest text of one family, or null when it has no versions. */
async function latestText(
  family: string,
): Promise<{ version: string; text: string } | null> {
  const latest = await getLatestVersion(family, PROMPTS_DIR);
  if (!latest.ok) return null;
  const loaded = await loadPrompt(family, latest.value, PROMPTS_DIR);
  if (!loaded.ok) return null;
  return { version: latest.value, text: loaded.value };
}

Deno.test("suppression governance - every marker reader states all three fields (Issue #789)", async () => {
  const offenders: string[] = [];
  let readers = 0;

  for (const family of await families()) {
    const latest = await latestText(family);
    if (!latest || !latest.text.includes(READS_GRAMMAR)) continue;
    readers += 1;
    const collapsed = latest.text.replace(/\s+/g, " ");
    for (const field of GOVERNANCE) {
      if (!collapsed.includes(field)) {
        offenders.push(`${family} ${latest.version}: no \`${field}\``);
      }
    }
  }

  assert(readers > 1, "expected several prompts to read the marker grammar");
  assertEquals(
    offenders,
    [],
    "a prompt that reads the suppression grammar must apply the same " +
      "three-field governance check as the deterministic one, or it honours " +
      "an ungoverned, never-expiring waiver:\n" + offenders.join("\n"),
  );
});

Deno.test("suppression governance - retro no longer drops on an id match alone (Issue #789)", async () => {
  const latest = await latestText("retro");
  assert(latest, "retro must resolve");
  const collapsed = latest.text.replace(/\s+/g, " ");

  assertEquals(
    collapsed.includes("whose id matches, drop the candidate"),
    false,
    `retro ${latest.version} still drops a candidate on an id match alone`,
  );
  assertStringIncludes(collapsed, "check all three governance fields");
  assertStringIncludes(collapsed, "Never silently honour an ungoverned marker");
});

Deno.test("suppression governance - no prompt claims to be the only marker reader (Issue #789)", async () => {
  // `bash_syntax_audit` justified its rule by claiming nothing else read the
  // markers. Retro did, which is how the two drifted.
  for (const family of await families()) {
    const latest = await latestText(family);
    if (!latest) continue;
    assertEquals(
      latest.text.replace(/\s+/g, " ").includes(
        "the only path that reads these markers",
      ),
      false,
      `${family} ${latest.version} claims to be the only reader of the ` +
        `suppression grammar, which is what let the paths drift apart`,
    );
  }
});

Deno.test("suppression governance - the deterministic check requires the same fields (Issue #789)", async () => {
  // The prompts say they mirror the code. Read the code, so the claim is
  // checked rather than repeated.
  const source = await Deno.readTextFile(
    new URL("../lib/suppression_comments.ts", import.meta.url).pathname,
  );
  for (const field of ["author", "expires"]) {
    assertStringIncludes(source, field);
  }
});

Deno.test("suppression governance - the retired versions stay immutable (Issue #789)", async () => {
  const retro = await loadPrompt("retro", "v1", PROMPTS_DIR);
  assertEquals(retro.ok, true);
  if (retro.ok) {
    assertStringIncludes(
      retro.value.replace(/\s+/g, " "),
      "whose id matches, drop the candidate",
    );
  }

  const bash = await loadPrompt("bash_syntax_audit", "v4", PROMPTS_DIR);
  assertEquals(bash.ok, true);
  if (bash.ok) {
    assertStringIncludes(
      bash.value.replace(/\s+/g, " "),
      "the only path that reads these markers",
    );
  }
});
