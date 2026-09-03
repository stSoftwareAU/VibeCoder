/**
 * Issue #792: a prompt's H1 must not declare a version other than its own.
 *
 * Committed `vN.md` files are immutable, so a new version starts as a copy of
 * its predecessor — and the `(vN)` suffix in the H1 title comes along with it.
 * Nine of the latest templates ended up announcing the version *before* the
 * one in their filename, so anything reading the title — a human, or a model
 * being told which revision it is running — got the wrong number.
 *
 * The rule is deliberately narrow: a *mismatching* suffix fails, a matching
 * one is legal, and no suffix at all is legal. That lets the templates that
 * already carry a correct suffix stay as they are until they are next bumped,
 * without forcing a churn-only pass over the whole tree.
 *
 * Scans the latest version of every prompt directory, so a future bump that
 * inherits a stale suffix fails here rather than shipping.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The highest `vN.md` in a prompt directory, or null when unversioned. */
async function latestVersion(dir: string): Promise<number | null> {
  let best = -1;
  for await (const entry of Deno.readDir(dir)) {
    const match = entry.name.match(/^v(\d+)\.md$/);
    if (match) best = Math.max(best, Number(match[1]));
  }
  return best < 0 ? null : best;
}

Deno.test("prompt H1 - no template declares a version other than its own (Issue #792)", async () => {
  const stale: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    const dir = `${PROMPTS_DIR}/${entry.name}`;
    const version = await latestVersion(dir);
    if (version === null) continue;

    const file = `v${version}.md`;
    const text = await Deno.readTextFile(`${dir}/${file}`);
    const h1 = text.split("\n")[0] ?? "";
    const declared = h1.match(/\(v(\d+)\)\s*$/);
    // No suffix is legal; a matching suffix is legal.
    if (declared && Number(declared[1]) !== version) {
      stale.push(
        `${entry.name}/${file} declares (v${declared[1]}): ${h1.trim()}`,
      );
    }
  }
  stale.sort();
  assertEquals(
    stale,
    [],
    "a new version copied its predecessor's H1 suffix, so the title " +
      "announces the wrong revision:\n" + stale.join("\n"),
  );
});

Deno.test("prompt H1 - the four templates fixed here dropped their suffix (Issue #792)", async () => {
  const fixed = [
    "doc_coverage",
    "format_drift",
    "supply_chain_detection",
    "supply_chain_readiness",
  ];
  const offenders: string[] = [];
  for (const name of fixed) {
    const dir = `${PROMPTS_DIR}/${name}`;
    const version = await latestVersion(dir);
    if (version === null) {
      offenders.push(`${name}: no versioned prompt`);
      continue;
    }
    const text = await Deno.readTextFile(`${dir}/v${version}.md`);
    const h1 = text.split("\n")[0] ?? "";
    if (/\(v\d+\)\s*$/.test(h1)) {
      offenders.push(`${name}/v${version}.md still carries a suffix: ${h1}`);
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});
