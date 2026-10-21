/**
 * A `reused` outcome needs an owned, open lookup, in both directions.
 *
 * **Why this test reads source text.** The invariant is a property of the call
 * sites in the tree: every module that reports a reused artefact asks an owned
 * lookup for it first. There is no runtime seam that sees every module, and the
 * failure it prevents is silent. A module that reports `reused` without a lookup
 * takes an artefact that may be closed or not the fleet's, and nothing else in
 * the tree notices. This follows `marker_dedup_author_cap_test.ts`, the same
 * shape: a classifier over the tree, a shrink-only manifest of what has not
 * been fixed, and a cap in both directions.
 *
 * The scanner and the manifests live in `lib/owned_reuse_manifest.ts`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  findUnownedReuseSites,
  OWNED_REUSE_NOT_ARTEFACT_FILES,
  OWNED_REUSE_UNVERIFIED_FILES,
} from "../lib/owned_reuse_manifest.ts";

const DENO_DIR = new URL("..", import.meta.url).pathname;

/** The trees that can report a reused artefact, relative to `worker/deno`. */
const SCANNED_ROOTS = ["lib", "commands"];

/** The scanner module names the pattern in its own prose and constants. */
const SELF = "lib/owned_reuse_manifest.ts";

const EXEMPT_FILES = Object.keys(OWNED_REUSE_NOT_ARTEFACT_FILES);

async function* walk(dir: string, prefix: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(`${dir}/${prefix}`)) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory) yield* walk(dir, path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Every source file the cap covers, path relative to `worker/deno`. */
async function scannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) {
    for await (const file of walk(DENO_DIR, root)) {
      if (file !== SELF) files.push(file);
    }
  }
  return files.sort();
}

/** Files that currently hold at least one reuse site with no owned lookup. */
async function currentlyUnverified(
  override?: Map<string, string>,
): Promise<string[]> {
  const files = new Set([...await scannedFiles(), ...(override?.keys() ?? [])]);
  const offenders: string[] = [];
  for (const file of files) {
    const source = override?.get(file) ??
      await Deno.readTextFile(`${DENO_DIR}${file}`);
    if (findUnownedReuseSites(source).length > 0) offenders.push(file);
  }
  return offenders.sort();
}

// ---------------------------------------------------------------------------
// The cap, both directions
// ---------------------------------------------------------------------------

Deno.test("owned reuse - no new module reports a reuse without an owned lookup", async () => {
  const listed = new Set([...OWNED_REUSE_UNVERIFIED_FILES, ...EXEMPT_FILES]);
  const added = (await currentlyUnverified()).filter((f) => !listed.has(f));
  assertEquals(
    added,
    [],
    "these files report a `reused` outcome without an owned, open lookup, so " +
      "a dedup hit could suppress a filing with no owned match behind it. " +
      "Find the artefact through `findOwnedOpenArtefact` in " +
      "`lib/owned_open_artefact.ts`:\n" + added.join("\n"),
  );
});

Deno.test("owned reuse - the unverified list holds no file that was fixed", async () => {
  // An exemption that outlives its fix is how a manifest rots into a permission
  // slip, so a stale entry must fail until its line is deleted.
  const current = new Set(await currentlyUnverified());
  const stale = OWNED_REUSE_UNVERIFIED_FILES.filter((f) => !current.has(f))
    .sort();
  assertEquals(
    stale,
    [],
    "these files no longer report an unverified reuse, so remove them from " +
      "OWNED_REUSE_UNVERIFIED_FILES:\n" + stale.join("\n"),
  );
});

Deno.test("owned reuse - the exempt list holds no file that no longer reports a reuse", async () => {
  const current = new Set(await currentlyUnverified());
  const stale = EXEMPT_FILES.filter((f) => !current.has(f)).sort();
  assertEquals(
    stale,
    [],
    "these exempt files no longer hold a `reused` producer, so remove them " +
      "from OWNED_REUSE_NOT_ARTEFACT_FILES:\n" + stale.join("\n"),
  );
});

Deno.test("owned reuse - every exempt entry gives a reason", () => {
  const blank = Object.entries(OWNED_REUSE_NOT_ARTEFACT_FILES)
    .filter(([, reason]) => reason.trim() === "")
    .map(([file]) => file);
  assertEquals(blank, [], "these exempt entries have no reason");
});

Deno.test("owned reuse - the manifests are sorted and free of duplicates", () => {
  const unverified = [...OWNED_REUSE_UNVERIFIED_FILES];
  assertEquals(unverified, [...unverified].sort(), "the unverified list is not sorted");
  assertEquals(
    new Set(unverified).size,
    unverified.length,
    "the unverified list has duplicates",
  );
  assertEquals(EXEMPT_FILES, [...EXEMPT_FILES].sort(), "the exempt list is not sorted");
});

Deno.test("owned reuse - every manifest entry names a file that exists", async () => {
  const present = new Set(await scannedFiles());
  const missing = [...OWNED_REUSE_UNVERIFIED_FILES, ...EXEMPT_FILES].filter((f) =>
    !present.has(f)
  );
  assertEquals(missing, [], "the manifests name files that are not in the tree");
});

// ---------------------------------------------------------------------------
// The cap's own moving parts, proved on planted fixtures
// ---------------------------------------------------------------------------

Deno.test("owned reuse - an injected bypass fails the cap", async () => {
  // Forward direction, proved: a module that reports `reused` with no lookup and
  // is not on either manifest must be named. Without this, a scanner that stopped
  // matching would leave the real-tree tests green and useless.
  const planted = new Map<string, string>([[
    "lib/planted_bypass.ts",
    `export function settle(): { action: string } {
  return { action: "reused" };
}`,
  ]]);
  const listed = new Set([...OWNED_REUSE_UNVERIFIED_FILES, ...EXEMPT_FILES]);
  assert(
    !listed.has("lib/planted_bypass.ts"),
    "fixture precondition: the planted file must not be on a manifest",
  );
  assert(
    (await currentlyUnverified(planted)).includes("lib/planted_bypass.ts"),
    "the scanner did not flag a `reused` outcome with no owned lookup",
  );
});

Deno.test("owned reuse - a module that calls an owned lookup is not flagged", async () => {
  const planted = new Map<string, string>([[
    "lib/planted_checked.ts",
    `const hit = await findOwnedOpenArtefact({ repo, kind: "issue", marker, ghCommandFn: gh });
if (hit) return { action: "reused" };`,
  ]]);
  assertEquals(
    (await currentlyUnverified(planted)).includes("lib/planted_checked.ts"),
    false,
  );
});

Deno.test("owned reuse - importing the lookup without calling it does not exempt", async () => {
  // Only a call is a check. An import that is never called is not an owned
  // lookup, so the module that reports `reused` must still be flagged.
  const planted = new Map<string, string>([[
    "lib/planted_import_only.ts",
    `import { findOwnedOpenArtefact } from "./owned_open_artefact.ts";
export const settle = () => ({ action: "reused" });`,
  ]]);
  assert(
    (await currentlyUnverified(planted)).includes(
      "lib/planted_import_only.ts",
    ),
    "an imported but uncalled lookup exempted the module",
  );
});

Deno.test("owned reuse - declaring the lookup without calling it does not exempt", async () => {
  // The declaration of a helper is not a call, so it must not exempt a module.
  const source = `export async function findOwnedOpenArtefact(p: unknown) { return p; }
export const settle = () => ({ action: "reused" });`;
  assert(
    findUnownedReuseSites(source).length > 0,
    "a declaration of the lookup exempted a module that reports `reused`",
  );
});

Deno.test("owned reuse - a comparison against reused is not a producer", () => {
  const source = [
    `if (x.action === "reused") return 1;`,
    `if (x.action !== "reused") return 2;`,
    `if (x.action == "reused") return 3;`,
    `if (x.action != "reused") return 4;`,
    `if ("reused" === x.action) return 5;`,
  ].join("\n");
  assertEquals(findUnownedReuseSites(source), []);
});

Deno.test("owned reuse - a reused field set to true is a producer", async () => {
  const planted = new Map<string, string>([[
    "lib/planted_field.ts",
    `export const settle = () => ({ number: 3, reused: true });`,
  ]]);
  assert(
    (await currentlyUnverified(planted)).includes("lib/planted_field.ts"),
    "a `reused: true` outcome with no owned lookup was not flagged",
  );
});

Deno.test("owned reuse - a comment that mentions reused is not a producer", () => {
  const source = [
    `// the reused outcome needs an owned lookup first`,
    `/* reused: true is never set here */`,
    ` * a reused artefact is checked before it is returned`,
    `export const nothing = 1;`,
  ].join("\n");
  assertEquals(findUnownedReuseSites(source), []);
});

Deno.test("owned reuse - the scanner reports the 1-based line of each producer", () => {
  const source = [
    `export const a = 1;`,
    `export const b = 2;`,
    `export const settle = () => ({ action: "reused" });`,
  ].join("\n");
  assertEquals(findUnownedReuseSites(source), [3]);
});
