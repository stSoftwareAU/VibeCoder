/**
 * Core registers nothing vendor-specific (Issue #986).
 *
 * This is a backstop, not the fix. The fix is that core no longer depends on
 * any vendor's module: the fetch seam the extension point uses lives in
 * `ci_fetch_types.ts`, and the only CI client core ships is the one for the
 * CI this project itself runs on. A test cannot enforce that; it can only
 * notice when it stops being true.
 *
 * Noticing has turned out to be worth a lot. One deployment's CI integration
 * arrived in the initial public export and was then invested in three
 * separate times *after* it had been scheduled for removal — each time by
 * someone reading the code correctly and the intent, which lived only in an
 * issue, not at all.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * The assertion is **not** "the registry contains no vendor we have thought
 * of". A denylist of names catches the vendor you remembered and waves the
 * next one through, and — worse — writing the list would itself be the
 * defect: this repository must not record which tools an operator might use.
 *
 * The assertion is total instead. Core ships **exactly one** built-in
 * provider, and it is the one this project's own CI uses. That is a property
 * of the whole registry, so *any* addition fails it, named or not, whether or
 * not anyone here has heard of it.
 *
 * GitHub Actions is not on an approved list. It is the default every repo
 * gets with no configuration, and it is here because this repository runs on
 * it. Anything else is a private extension — see `docs/PRIVATE-EXTENSIONS.md`
 * — and registers itself at runtime, where core never sees it.
 *
 * Two halves make the totality sound:
 *
 *   1. **Runtime.** After importing `mod.ts` — the whole worker, so every
 *      module that could register anything has run — the registry holds one
 *      provider, and it is the built-in default.
 *   2. **Source.** `registerCiLogProvider` is called from exactly one file in
 *      the shipped tree. Without this, a registration in a module the first
 *      test happens not to reach would pass unnoticed.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import { assertEquals } from "@std/assert";
import { listCiLogProviders } from "../lib/ci_log_provider.ts";
import { GITHUB_ACTIONS_PROVIDER_ID } from "../lib/github_actions_log_fetcher.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

// Importing the whole worker is the point: a provider registered by any
// module reachable from the CLI entry point is registered by the time the
// assertions below run. The side effect is the test fixture.
import "../mod.ts";

/** `worker/deno`, resolved from this file rather than the process cwd. */
const DENO_DIR = `${REPO_ROOT}worker/deno`;

/** Shipped source the registry claims to cover, relative to `worker/deno`. */
const SCANNED_DIRS = ["lib", "commands", "setup"] as const;

/** Single shipped files scanned as well. */
const SCANNED_FILES = ["mod.ts"] as const;

/**
 * The one file allowed to register a provider.
 *
 * Not an allowlist of vendors — an allowlist of *call sites*. It says where
 * core's built-in registration lives, so the runtime assertion above is total
 * rather than a sample.
 */
const REGISTRATION_SITE = "lib/ci_log_provider.ts";

/** A call to the registry's register function, in source text. */
const REGISTER_CALL = /(?<![\w.])registerCiLogProvider\s*\(/;

/** Every shipped `.ts` file, as `path relative to worker/deno` → source. */
async function shippedSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const add = async (path: string): Promise<void> => {
    sources.set(path.slice(DENO_DIR.length + 1), await Deno.readTextFile(path));
  };

  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".ts")) await add(path);
    }
  };

  for (const dir of SCANNED_DIRS) await walk(`${DENO_DIR}/${dir}`);
  for (const file of SCANNED_FILES) await add(`${DENO_DIR}/${file}`);
  return sources;
}

Deno.test("ci log providers - core ships exactly one, and it is this repo's own CI", () => {
  const registered = listCiLogProviders().map((p) => p.id).sort();

  assertEquals(
    registered,
    [GITHUB_ACTIONS_PROVIDER_ID],
    "core has registered a CI log provider beyond the built-in default.\n\n" +
      "The built-in is GitHub Actions and only because it is the CI this " +
      "project itself runs on — it is not the first entry on a list of the " +
      "CI systems we support, and there is no such list. A CI system " +
      "specific to one deployment belongs in that operator's own private " +
      "extension, which registers its provider at runtime and leaves no " +
      "trace in this repository: see docs/PRIVATE-EXTENSIONS.md.\n\n" +
      `registered: ${registered.join(", ")}`,
  );
});

Deno.test("ci log providers - the shipped tree registers from exactly one place", async () => {
  const sites = [...await shippedSources()]
    .filter(([, source]) => REGISTER_CALL.test(source))
    .map(([path]) => path)
    .sort();

  assertEquals(
    sites,
    [REGISTRATION_SITE],
    "registerCiLogProvider is called outside the one place core registers " +
      "its built-in default. That is how a vendor gets into core without " +
      "the assertion above noticing: a module the entry point does not " +
      "reach registers it later, or a command registers one on the side.\n\n" +
      "A provider that is not the built-in default is registered by the " +
      "operator's private extension at runtime, not from this tree " +
      "(docs/PRIVATE-EXTENSIONS.md).\n\n" +
      `call sites: ${sites.join(", ")}`,
  );
});
