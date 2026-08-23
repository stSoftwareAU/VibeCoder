/**
 * The coding guidelines must forbid unbounded spin-waits (Issue #324).
 *
 * Pins the rule by phrase, not by wording, following the approach the
 * best-practices bucket tests use: a reword is free, a silent deletion is not.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The highest `vN.md` — the version the worker actually sends. */
async function readLatestGuidelines(): Promise<string> {
  const dir = `${PROMPTS_DIR}/coding_guidelines`;
  const versions: number[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const m = /^v(\d+)\.md$/.exec(entry.name);
    if (m) versions.push(Number(m[1]));
  }
  versions.sort((a, b) => a - b);
  const latest = versions[versions.length - 1];
  assert(latest !== undefined, "there must be at least one guidelines version");
  return await Deno.readTextFile(`${dir}/v${latest}.md`);
}

Deno.test("#324 - the latest guidelines forbid spin-waiting on a background job", async () => {
  const body = (await readLatestGuidelines()).toLowerCase();
  assertStringIncludes(body, "spin-wait");
});

Deno.test("#324 - the rule names the bounded alternative, not just the ban", async () => {
  // A ban with no alternative gets worked around. The guidance has to say
  // what to do instead: foreground, or a bounded poll that gives up loudly.
  const body = (await readLatestGuidelines()).toLowerCase();
  assertStringIncludes(body, "foreground");
  assert(
    body.includes("bound it") || body.includes("bounded"),
    "the rule must state the bounded-poll alternative",
  );
});

Deno.test("#324 - the rule shows the real shapes that caused the outage", async () => {
  // Both are copied from the 2026-08-22 log. Naming them makes the rule
  // recognisable rather than abstract.
  const body = await readLatestGuidelines();
  assertStringIncludes(body, "pgrep");
  assertStringIncludes(body, "sleep 30");
});
