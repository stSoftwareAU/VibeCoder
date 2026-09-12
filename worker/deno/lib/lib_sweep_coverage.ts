/**
 * Coverage ledger for the security sweeps of `worker/deno/lib/`,
 * `worker/deno/commands/` and `worker/deno/setup/` (Issue #1609, parents
 * #1219 / #1209).
 *
 * The lib/ sweep was cut into sink-organised slices and later top-ups.
 * `commands/` and `setup/` were read under #1218 and #1220 but were never
 * partitioned, so a later scan could not tell a swept module from an
 * unread one. Each slice now records `sweptAt` — the commit its written
 * record landed at — so `driftSince` and the `sweep-drift` command can
 * list the modules added or rewritten since that read.
 *
 * `diffCoverage` still fails loud on any module that is missing, stale,
 * or claimed twice. The enforcing test is
 * `worker/deno/tests/lib_sweep_coverage_test.ts`.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Repo-relative path of the ledger this module reads. */
export const LIB_SWEEP_LEDGER_PATH = "docs/audits/lib-sweep-coverage.json";

/** Repo-relative directory the original ledger covered. */
export const LIB_SWEEP_ROOT = "worker/deno/lib";

/** The three trees the ledger now partitions (Issue #1609). */
export const SWEEP_COVERAGE_ROOTS = [
  "worker/deno/lib",
  "worker/deno/commands",
  "worker/deno/setup",
] as const;

/** A 40-character lowercase git commit. */
const SWEPT_AT_RE = /^[0-9a-f]{40}$/;

/** Whether a slice has actually been read, or is only claimed by an open issue. */
export type SweepSliceStatus = "swept" | "claimed";

/** One slice of the sweep — an issue, and the paths it owns. */
export interface SweepSlice {
  /** GitHub issue number that owns the slice. */
  readonly issue: number;
  /**
   * Chunk id from the parent scan's plan, e.g. `12a`.
   *
   * A **top-up** slice uses {@link topUpChunkId} — `top-up-<issue>` — rather
   * than the next letter after the ledger's tail: two branches cut from the
   * same base always read the same tail and so always choose the same next
   * letter, which is how #1940 and #1943 both picked `12aa` and one of them
   * was lost in the resolution (Issue #1968).
   */
  readonly chunk: string;
  /** Human-readable subject of the slice. */
  readonly title: string;
  /** Where the slice's written record lives. */
  readonly ledger: string;
  /** How the slice's file list was derived, so it can be regenerated. */
  readonly definition: string;
  /** `swept` once the slice has been read; `claimed` while its issue is open. */
  readonly status: SweepSliceStatus;
  /**
   * Full commit the slice's written record landed at (Issue #1609).
   * Drift is measured from this SHA to HEAD.
   */
  readonly sweptAt: string;
  /** Repo-relative paths owned by this slice. */
  readonly paths: readonly string[];
}

/** The whole ledger. */
export interface SweepCoverageLedger {
  /** Repo-relative directories the ledger partitions. */
  readonly roots: readonly string[];
  /** Parent issue that ordered the sweep. */
  readonly parent: number;
  /** Prose describing what the ledger is for. */
  readonly description: string;
  /** Every slice; together they must partition `roots`. */
  readonly slices: readonly SweepSlice[];
}

/** One slice's added/modified/unowned modules since `sweptAt`. */
export interface SliceDrift {
  /** Modules the slice owns that git reports as added since `sweptAt`. */
  readonly added: string[];
  /** Modules the slice owns that git reports as modified since `sweptAt`. */
  readonly modified: string[];
  /** Modules on disk under the slice's roots that no slice claims. */
  readonly unowned: string[];
}

/** Injected git runner for {@link driftSince}. */
export type SweepGitRunner = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What `diffCoverage` found wrong. Every list empty means the sweep is closed. */
export interface CoverageDiff {
  /** Modules on disk that no slice claims — unswept files. */
  readonly unswept: string[];
  /** Ledger entries with no module on disk — stale after a delete or rename. */
  readonly stale: string[];
  /** Modules claimed by more than one slice, as `path (12a, 12b)`. */
  readonly duplicated: string[];
}

/** Thrown when the ledger cannot be parsed. Never returns a partial ledger. */
export class SweepLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepLedgerError";
  }
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: "${field}" must be a non-empty string`,
    );
  }
  return value;
}

function parseSlice(raw: unknown, index: number): SweepSlice {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: slices[${index}] must be an object`,
    );
  }
  const slice = raw as Record<string, unknown>;
  const issue = slice.issue;
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: slices[${index}].issue must be a positive integer`,
    );
  }
  const status = slice.status;
  if (status !== "swept" && status !== "claimed") {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: slices[${index}].status must be "swept" or "claimed"`,
    );
  }
  const sweptAt = requireString(slice.sweptAt, `slices[${index}].sweptAt`);
  if (!SWEPT_AT_RE.test(sweptAt)) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: slices[${index}].sweptAt must be a 40-hex commit`,
    );
  }
  const paths = slice.paths;
  if (!Array.isArray(paths)) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: slices[${index}].paths must be an array`,
    );
  }
  return {
    issue,
    chunk: requireString(slice.chunk, `slices[${index}].chunk`),
    title: requireString(slice.title, `slices[${index}].title`),
    ledger: requireString(slice.ledger, `slices[${index}].ledger`),
    definition: requireString(slice.definition, `slices[${index}].definition`),
    status,
    sweptAt,
    paths: paths.map((p, i) =>
      requireString(p, `slices[${index}].paths[${i}]`)
    ),
  };
}

function parseRoots(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: "roots" must be a non-empty array`,
    );
  }
  return raw.map((value, i) => requireString(value, `roots[${i}]`));
}

/**
 * Chunk id for a top-up slice, collision-free by construction (Issue #1968).
 *
 * The original sweep's ids came from the parent scan's chunk plan, which a
 * single agent allocated in one pass. A top-up is allocated by whichever run
 * added a module, and concurrent runs each read the same ledger tail: deriving
 * the id from the issue number instead means two runs cannot choose the same
 * one, because two runs are never working the same issue.
 *
 * @param issue - GitHub issue number that owns the slice.
 */
export function topUpChunkId(issue: number): string {
  return `top-up-${issue}`;
}

/** A chunk id written in the top-up form, capturing the issue it names. */
const TOP_UP_CHUNK_RE = /^top-up-(\d+)$/;

/**
 * Slices whose `top-up-<issue>` chunk id names a different issue.
 *
 * The convention is only collision-free while the number in the id is the
 * slice's own issue: `top-up-1940` on `issue: 1943` is back to an id two runs
 * could both pick. A mismatch is a typo or a copied entry, and it is caught
 * here rather than by the next merge (Issue #1968).
 *
 * @param slices - The ledger's slices, in file order.
 * @returns Sorted `chunk (issue N)` entries; empty when every top-up id
 *   matches its own issue.
 */
export function mismatchedTopUpIds(
  slices: readonly { chunk: string; issue: number }[],
): string[] {
  return slices
    .filter((slice) => {
      const named = TOP_UP_CHUNK_RE.exec(slice.chunk)?.[1];
      return named !== undefined && Number(named) !== slice.issue;
    })
    .map((slice) => `${slice.chunk} (issue ${slice.issue})`)
    .sort();
}

/**
 * Chunk ids and issue numbers that more than one slice claims.
 *
 * Both are identities: a chunk id names a slice in its written record and in
 * every failure message, and an issue owns exactly one slice. A duplicate of
 * either means two slices were merged that were written against the same
 * ledger tail, which is the collision that has to fail on the PR that
 * introduces it rather than after the merge.
 *
 * @param slices - The ledger's slices, in file order.
 * @returns Sorted duplicate chunk ids and issue numbers; both empty when every
 *   slice is uniquely identified.
 */
export function duplicateSliceIds(
  slices: readonly { chunk: string; issue: number }[],
): { chunks: string[]; issues: number[] } {
  const seenChunks = new Set<string>();
  const seenIssues = new Set<number>();
  const chunks = new Set<string>();
  const issues = new Set<number>();
  for (const slice of slices) {
    if (seenChunks.has(slice.chunk)) chunks.add(slice.chunk);
    else seenChunks.add(slice.chunk);
    if (seenIssues.has(slice.issue)) issues.add(slice.issue);
    else seenIssues.add(slice.issue);
  }
  return {
    chunks: [...chunks].sort(),
    issues: [...issues].sort((a, b) => a - b),
  };
}

/**
 * Parse the ledger's JSON text.
 *
 * Fails loud: a malformed ledger throws rather than yielding a partial one,
 * because an empty or truncated slice list would silently read as "everything
 * is swept". A slice id claimed twice throws for the same reason — the second
 * claimant is a slice some merge resolved by hand, and the record it points at
 * no longer names it unambiguously (Issue #1968).
 *
 * @param json - Raw file text.
 * @returns The parsed ledger.
 * @throws {SweepLedgerError} When the text is not a well-formed ledger.
 */
export function parseCoverageLedger(json: string): SweepCoverageLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: not valid JSON — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: top level must be an object`,
    );
  }
  const ledger = raw as Record<string, unknown>;
  const parent = ledger.parent;
  if (typeof parent !== "number" || !Number.isInteger(parent)) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: "parent" must be an integer issue number`,
    );
  }
  const slices = ledger.slices;
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: "slices" must be a non-empty array`,
    );
  }
  const parsed = slices.map(parseSlice);
  const duplicates = duplicateSliceIds(parsed);
  if (duplicates.chunks.length > 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: chunk id(s) claimed by more than one slice — ` +
        `${
          duplicates.chunks.join(", ")
        }. Two runs allocated the same id from ` +
        `the same ledger tail; give a top-up slice the collision-free id ` +
        `"top-up-<issue>" instead.`,
    );
  }
  const mismatched = mismatchedTopUpIds(parsed);
  if (mismatched.length > 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: top-up chunk id(s) naming another slice's ` +
        `issue — ${
          mismatched.join(", ")
        }. A top-up id must be "top-up-" followed by its own issue number.`,
    );
  }
  if (duplicates.issues.length > 0) {
    throw new SweepLedgerError(
      `${LIB_SWEEP_LEDGER_PATH}: issue number(s) owning more than one slice — ` +
        `${
          duplicates.issues.join(", ")
        }. One issue owns one slice; merge the ` +
        `paths into a single entry.`,
    );
  }
  return {
    roots: parseRoots(ledger.roots),
    parent,
    description: requireString(ledger.description, "description"),
    slices: parsed,
  };
}

function splitGitNames(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0 && !line.endsWith("_test.ts")
  );
}

function rootsForSlice(
  slice: SweepSlice,
  roots: readonly string[],
): string[] {
  return roots.filter((root) =>
    slice.paths.some((path) => path === root || path.startsWith(`${root}/`))
  );
}

/**
 * Modules a slice owns that changed since `sweptAt`, plus unowned modules
 * on disk under that slice's roots (Issue #1609).
 *
 * Git is an injected runner so unit tests never spawn. A non-zero exit
 * throws with the stderr; an empty diff is an empty report.
 *
 * @param ledger - Parsed ledger (roots + every claimed path).
 * @param slice - The slice whose drift to measure.
 * @param onDisk - Non-test modules currently on disk (repo-relative).
 * @param runGit - Git runner. Receives `diff --name-only` argument lists.
 */
export async function driftSince(
  ledger: SweepCoverageLedger,
  slice: SweepSlice,
  onDisk: readonly string[],
  runGit: SweepGitRunner,
): Promise<SliceDrift> {
  const claimed = new Set(ledger.slices.flatMap((s) => s.paths));
  const owned = new Set(slice.paths);
  const sliceRoots = rootsForSlice(slice, ledger.roots);
  const added: string[] = [];
  const modified: string[] = [];
  for (const root of sliceRoots) {
    for (const filter of ["A", "M"] as const) {
      const result = await runGit([
        "diff",
        "--name-only",
        `--diff-filter=${filter}`,
        slice.sweptAt,
        "HEAD",
        "--",
        root,
      ]);
      if (result.code !== 0) {
        throw new SweepLedgerError(
          result.stderr.length > 0
            ? result.stderr
            : `git diff --diff-filter=${filter} exited ${result.code}`,
        );
      }
      const target = filter === "A" ? added : modified;
      for (const path of splitGitNames(result.stdout)) {
        if (owned.has(path)) target.push(path);
      }
    }
  }
  const unowned = onDisk.filter((path) =>
    sliceRoots.some((root) => path === root || path.startsWith(`${root}/`)) &&
    !claimed.has(path)
  ).sort();
  return {
    added: [...new Set(added)].sort(),
    modified: [...new Set(modified)].sort(),
    unowned,
  };
}

/**
 * Walk every ledger root and return the sorted non-test module list.
 *
 * @param repoRoot - Absolute path of the repository root.
 * @param roots - Repo-relative directories to walk.
 */
export async function listSweptModulesForRoots(
  repoRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const root of roots) {
    paths.push(...await listSweptModules(repoRoot, root));
  }
  return [...new Set(paths)].sort();
}

/**
 * List the non-test TypeScript modules under a directory, repo-relative.
 *
 * This is the `find lib -name '*.ts' ! -name '*_test.ts'` of the issue, done
 * without a subprocess so the check runs under the unit-test permission set.
 *
 * @param repoRoot - Absolute path of the repository root.
 * @param root - Repo-relative directory to walk (defaults to `worker/deno/lib`).
 * @returns Sorted repo-relative paths, using forward slashes.
 */
export async function listSweptModules(
  repoRoot: string,
  root: string = LIB_SWEEP_ROOT,
): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (relDir: string): Promise<void> => {
    for await (const entry of Deno.readDir(`${repoRoot}/${relDir}`)) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(relPath);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        paths.push(relPath);
      }
    }
  };
  await visit(root);
  return paths.sort();
}

/**
 * Largest slice whose record must name every module the slice claims.
 *
 * The five original slices each cover dozens to hundreds of modules and
 * describe them collectively, so naming each one is neither possible nor
 * useful. A **top-up** slice — the recurring shape, one or two modules added
 * to `lib/` after the sweeps recorded their coverage — is small precisely
 * because it exists to name them. Twenty is the line between the two.
 */
export const ENUMERATED_SLICE_MAX_PATHS = 20;

/**
 * Modules a small slice claims that its written record never names.
 *
 * This is the honesty half of the coverage gate. `diffCoverage` only asks
 * whether *some* slice owns each module, so the cheapest way to turn it green
 * is to append a new module's path to a slice whose sweep ran before that
 * module existed — a false record in a security-audit ledger, and exactly what
 * happened to `gh_body_file_io.ts` and `gh_timeout.ts` (Issue #1325). A
 * top-up slice cannot take that shortcut: its record has to name what it
 * claims to have read.
 *
 * Fails loud on a record it was not given: a local record whose text is
 * missing reports every path the slice claims, rather than passing for want
 * of evidence.
 *
 * @param ledger - The parsed ledger.
 * @param recordTexts - Repo-relative record path to that record's text.
 * @returns Sorted `path (chunk — record)` entries; empty when every small
 *   slice's record names each module it claims.
 */
export function unnamedSmallSliceModules(
  ledger: SweepCoverageLedger,
  recordTexts: ReadonlyMap<string, string>,
): string[] {
  const gaps: string[] = [];
  for (const slice of ledger.slices) {
    if (slice.paths.length > ENUMERATED_SLICE_MAX_PATHS) continue;
    // A slice still in progress points at its issue, which is not in the tree.
    if (/^https?:\/\//.test(slice.ledger)) continue;
    const text = recordTexts.get(slice.ledger);
    for (const path of slice.paths) {
      if (text?.includes(path)) continue;
      gaps.push(`${path} (${slice.chunk} — ${slice.ledger})`);
    }
  }
  return gaps.sort();
}

/**
 * Repo-relative written records named by the ledger's slices.
 *
 * A slice may point at a file in this repository (`docs/audits/….md`) or, for
 * a slice still in progress, at its GitHub issue. Only the former can be
 * checked against the tree, so the URLs are filtered out rather than reported
 * as missing.
 *
 * @param ledger - The parsed ledger.
 * @returns Sorted, de-duplicated repo-relative record paths.
 */
export function localLedgerRecords(ledger: SweepCoverageLedger): string[] {
  const records = ledger.slices
    .map((slice) => slice.ledger)
    .filter((ledgerPath) => !/^https?:\/\//.test(ledgerPath));
  return [...new Set(records)].sort();
}

/**
 * Compare the ledger against the modules actually on disk.
 *
 * @param ledger - The parsed ledger.
 * @param actualPaths - Repo-relative module paths found on disk.
 * @returns The three ways the ledger and the tree can disagree. All empty
 *   means every module is accounted for exactly once.
 */
export function diffCoverage(
  ledger: SweepCoverageLedger,
  actualPaths: readonly string[],
): CoverageDiff {
  const owners = new Map<string, string[]>();
  for (const slice of ledger.slices) {
    for (const path of slice.paths) {
      const existing = owners.get(path);
      if (existing) existing.push(slice.chunk);
      else owners.set(path, [slice.chunk]);
    }
  }
  const actual = new Set(actualPaths);
  return {
    unswept: [...actual].filter((p) => !owners.has(p)).sort(),
    stale: [...owners.keys()].filter((p) => !actual.has(p)).sort(),
    duplicated: [...owners.entries()]
      .filter(([, chunks]) => chunks.length > 1)
      .map(([path, chunks]) => `${path} (${chunks.join(", ")})`)
      .sort(),
  };
}

/**
 * Render a diff as a failure message, or `null` when the sweep is closed.
 *
 * @param diff - The result of `diffCoverage`.
 * @returns A human-readable description of every disagreement, or `null`.
 */
export function describeCoverageDiff(diff: CoverageDiff): string | null {
  const parts: string[] = [];
  if (diff.unswept.length > 0) {
    parts.push(
      `${diff.unswept.length} module(s) under the ledger roots are claimed by no sweep slice — ` +
        `read them for the shapes in ${LIB_SWEEP_LEDGER_PATH}, then add them to a slice:\n` +
        diff.unswept.map((p) => `  - ${p}`).join("\n"),
    );
  }
  if (diff.stale.length > 0) {
    parts.push(
      `${diff.stale.length} ledger entr(ies) name a module that no longer exists — remove them:\n` +
        diff.stale.map((p) => `  - ${p}`).join("\n"),
    );
  }
  if (diff.duplicated.length > 0) {
    parts.push(
      `${diff.duplicated.length} module(s) are claimed by more than one slice — the slices must be disjoint:\n` +
        diff.duplicated.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}
