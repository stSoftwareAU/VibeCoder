/**
 * One severity scale across every filing scan (Issue #788).
 *
 * `orphan_deps` once mapped `🔴` high, `🟠` medium, `🟡` low — one band redder
 * than the twelve sibling scans, and its red collided with the `🔴`
 * `security_scan` reserves for `severity:critical`. A human triaging a mixed
 * idle-task queue read `🟠` as **high** on an orphan-deps issue and as
 * **medium** everywhere else, and `🔴` as **high** there and **critical** from
 * the security scan. `orphan_deps` attaches only `severity:high|medium|low`,
 * so its red was a mis-mapping rather than a fourth band.
 *
 * Three siblings already state the map as a cross-scan invariant — "the same
 * map the sibling scan templates use, so a human triaging every queue reads
 * one scale" — and `README.md` records the intended scale: critical red →
 * high orange → medium yellow → low green.
 *
 * This test makes the invariant enforceable rather than aspirational. It reads
 * every template, extracts each `` `<emoji>` <band> `` pairing it states, and
 * fails on any that disagrees with the one scale — so the wording may differ
 * per scan (and it does) while the mapping cannot.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The one scale, as `README.md` records it. */
const SCALE: Record<string, string> = {
  "🔴": "critical",
  "🟠": "high",
  "🟡": "medium",
  "🟢": "low",
};

/**
 * A stated pairing: `` `🟠` high ``, however the sentence wraps.
 *
 * The `u` flag is load-bearing: without it each emoji is a surrogate pair and
 * the alternation is not a valid pattern over code points.
 */
const PAIRING =
  /`(\u{1F534}|\u{1F7E0}|\u{1F7E1}|\u{1F7E2})`\s+(critical|high|medium|low)/gu;

/** Every prompt family under `prompts/`. */
async function families(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (entry.isDirectory) found.push(entry.name);
  }
  return found.sort();
}

/** The pairings one family's template states. */
async function pairingsOf(
  family: string,
): Promise<[string, string][] | null> {
  const loaded = await loadPrompt(family, PROMPTS_DIR);
  if (!loaded.ok) return null;
  // Collapsed, because the instruction wraps mid-pairing in several scans.
  const collapsed = loaded.value.replace(/\s+/g, " ");
  return [...collapsed.matchAll(PAIRING)].map(
    (match) => [match[1]!, match[2]!] as [string, string],
  );
}

Deno.test("severity scale - every scan's emoji map agrees with the one scale (Issue #788)", async () => {
  const offenders: string[] = [];
  let stated = 0;

  for (const family of await families()) {
    const pairs = await pairingsOf(family);
    if (!pairs || pairs.length === 0) continue;
    stated += 1;
    for (const [emoji, band] of pairs) {
      if (SCALE[emoji] !== band) {
        offenders.push(
          `${family}: ${emoji} = ${band} (the scale says ` +
            `${emoji} = ${SCALE[emoji]})`,
        );
      }
    }
  }

  assert(stated > 1, "expected several scans to state a severity map");
  assertEquals(
    offenders,
    [],
    "a triager reading a mixed queue must read one scale — critical red, " +
      "high orange, medium yellow, low green:\n" + offenders.join("\n"),
  );
});

Deno.test("severity scale - orphan_deps states the corrected map (Issue #788)", async () => {
  const pairs = await pairingsOf("orphan_deps");
  assert(pairs, "orphan_deps must resolve");
  assertEquals(
    pairs.sort(),
    [["🟠", "high"], ["🟡", "medium"], ["🟢", "low"]],
  );
});

Deno.test("severity scale - only the security scan claims the red band (Issue #788)", async () => {
  // `🔴` is `severity:critical`, and only one scan has that band. A second
  // claimant is what made orphan-deps' red ambiguous.
  const claimants: string[] = [];
  for (const family of await families()) {
    const pairs = await pairingsOf(family);
    if (!pairs) continue;
    if (pairs.some(([emoji]) => emoji === "🔴")) claimants.push(family);
  }
  assertEquals(claimants, ["security_scan"]);
});

Deno.test("severity scale - orphan_deps still has no critical band to justify a red (Issue #788)", async () => {
  // The mis-mapping was only unambiguous because this scan attaches
  // `severity:high|medium|low`. If it ever gained a critical band the fix
  // would need revisiting, so the premise is pinned.
  const loaded = await loadPrompt("orphan_deps", PROMPTS_DIR);
  assertEquals(loaded.ok, true);
  if (!loaded.ok) return;
  // The template says so itself, which is a stronger check than the absence
  // of the string — it mentions `severity:critical` deliberately, to say the
  // red belongs to the scan that does have that band.
  assertStringIncludes(
    loaded.value.replace(/\s+/g, " "),
    "There is **no `severity:critical`**",
  );
  assertEquals(
    loaded.value.includes("one `severity:critical`"),
    false,
    "orphan_deps must not attach a critical severity label",
  );
});
