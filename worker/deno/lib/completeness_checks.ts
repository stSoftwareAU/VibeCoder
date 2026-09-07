/**
 * The completeness-check family, derived from the tree (Issue #1483).
 *
 * Roughly forty tests enumerate the source and assert that every new thing
 * is registered somewhere: every `lib/` module claimed by a sweep slice,
 * every `VIBE_*` name classified in the registry, every integration suite
 * in its manifest, every prompt in the house vocabulary. They need no
 * runtime, no container, no network and no fixtures, and the ten measured
 * ran in about six seconds — yet the only route to them was the full
 * `deno task test` (~30 minutes) or a CI shard, so two PRs in one hour
 * (#1481, #1482) each cost a full seven-job matrix to learn that one
 * registration line was missing, and a second matrix after the fix.
 *
 * `deno task check:manifests` runs exactly this family. Its membership is
 * **derived**, never hand-listed — a hand-list would be one more manifest
 * that drifts, which is the very failure this family exists to catch. A
 * test file belongs when:
 *
 *   1. it reads the repository tree itself — `Deno.readDir`, a `walk`, an
 *      `expandGlob` — or imports a ledger module (`*_manifest.ts`,
 *      `*_coverage.ts`, `*_registry.ts`) that does; and
 *   2. neither the file nor any test support/fixture module it imports
 *      spawns a process, writes, creates a temp dir, or mutates process
 *      state — so the family runs under `--allow-read --allow-env` alone
 *      and stays fast.
 *
 * `completeness_checks_test.ts` pins the two that actually fired, and
 * that the task's membership is this derivation and nothing else.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { stripComments } from "./parallel_unsafe_test_manifest.ts";

/** A test that reads the tree: the shape every completeness check has. */
export const ENUMERATES_TREE_RE =
  /Deno\.readDir(Sync)?\(|\bwalk(Sync)?\(|expandGlob(Sync)?\(/;

/** Modules whose whole purpose is a ledger the tree is checked against. */
export const LEDGER_MODULE_RE = /_(manifest|coverage|registry)\.ts$/;

/**
 * Anything that makes a test slow, order-dependent or permission-hungry.
 * A file matching this is not a completeness check whatever else it does.
 */
export const HEAVY_RE =
  /Deno\.Command|makeTempDir(Sync)?\(|Deno\.env\.(set|delete)\(|Deno\.chdir\(|\bspawn|\bfetch\(|Deno\.(writeTextFile|writeFile|mkdir|remove|create|symlink|open)(Sync)?\(|atomicWrite\(/;

/** The permissions the family runs under — and all it may need. */
export const COMPLETENESS_TEST_PERMISSIONS: readonly string[] = [
  "--allow-read",
  "--allow-env",
];

/** `from "./support/x.ts"` and `from "./fixtures/x.ts"` in a test file. */
const TEST_LOCAL_IMPORT_RE =
  /from\s+"\.\/(support|fixtures)\/([a-z0-9_]+\.ts)"/g;
/** `from "../lib/x.ts"` in a test file. */
const LIB_IMPORT_RE = /from\s+"\.\.\/lib\/([a-z0-9_]+\.ts)"/g;

/** Read a file, or return an empty string when it cannot be read. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

/**
 * Whether one test file is a completeness check.
 *
 * @param source - The test file's source
 * @param readTestLocal - Reads `support/` or `fixtures/` module source by
 *   its relative import path, empty when absent
 * @returns True when the file reads the tree (itself or via a ledger
 *   module) and nothing about it is heavy
 */
export async function isCompletenessCheck(
  source: string,
  readTestLocal: (dir: string, name: string) => Promise<string>,
): Promise<boolean> {
  const own = stripComments(source);
  if (HEAVY_RE.test(own)) return false;

  for (const match of own.matchAll(TEST_LOCAL_IMPORT_RE)) {
    const helper = stripComments(await readTestLocal(match[1]!, match[2]!));
    if (HEAVY_RE.test(helper)) return false;
  }

  if (ENUMERATES_TREE_RE.test(own)) return true;
  for (const match of own.matchAll(LIB_IMPORT_RE)) {
    if (LEDGER_MODULE_RE.test(match[1]!)) return true;
  }
  return false;
}

/**
 * Every completeness check under `<denoDir>/tests`, sorted, as paths
 * relative to `denoDir` (`tests/x_test.ts`).
 *
 * @param denoDir - The `worker/deno` directory
 * @returns The derived family
 */
export async function deriveCompletenessTestFiles(
  denoDir: string,
): Promise<string[]> {
  const testsDir = `${denoDir}/tests`;
  const names: string[] = [];
  for await (const entry of Deno.readDir(testsDir)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) names.push(entry.name);
  }
  names.sort();

  const out: string[] = [];
  for (const name of names) {
    const source = await Deno.readTextFile(`${testsDir}/${name}`);
    const belongs = await isCompletenessCheck(
      source,
      (dir, helper) => readOrEmpty(`${testsDir}/${dir}/${helper}`),
    );
    if (belongs) out.push(`tests/${name}`);
  }
  return out;
}

/**
 * The `deno test` argument list for the family: frozen lockfile, the two
 * permissions, then the files.
 *
 * @param files - Paths relative to `worker/deno`, from
 *   {@link deriveCompletenessTestFiles}
 * @returns Arguments after the `deno` executable
 */
export function completenessTestArgs(files: readonly string[]): string[] {
  return [
    "test",
    "--frozen",
    "--lock=deno.lock",
    ...COMPLETENESS_TEST_PERMISSIONS,
    ...files,
  ];
}
