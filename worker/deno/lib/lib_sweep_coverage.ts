/**
 * Coverage ledger for the chunk-12 security sweep of `worker/deno/lib/`
 * (Issue #1219, parent #1209).
 *
 * The sweep was cut into five slices — four organised around taint sinks
 * (#1214 subprocess, #1215 filesystem, #1216 GitHub ingestion, #1217
 * environment/secrets) and one closing pass over everything they left behind
 * (#1219). `lib/` became a 750-file coverage gap in the first place because
 * nothing recorded which paths had been read, so a module added after a sweep
 * was indistinguishable from one the sweep skipped.
 *
 * This module makes that distinction checkable: the ledger names every
 * non-test module under `worker/deno/lib/` and the slice that swept it, and
 * `diffCoverage` fails loud on any module that is missing, stale, or claimed
 * twice. The enforcing test is
 * `worker/deno/tests/lib_sweep_coverage_test.ts`.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Repo-relative path of the ledger this module reads. */
export const LIB_SWEEP_LEDGER_PATH = "docs/audits/lib-sweep-coverage.json";

/** Repo-relative directory the ledger covers. */
export const LIB_SWEEP_ROOT = "worker/deno/lib";

/** Whether a slice has actually been read, or is only claimed by an open issue. */
export type SweepSliceStatus = "swept" | "claimed";

/** One slice of the sweep — an issue, and the paths it owns. */
export interface SweepSlice {
  /** GitHub issue number that owns the slice. */
  readonly issue: number;
  /** Chunk id from the parent scan's plan, e.g. `12a`. */
  readonly chunk: string;
  /** Human-readable subject of the slice. */
  readonly title: string;
  /** Where the slice's written record lives. */
  readonly ledger: string;
  /** How the slice's file list was derived, so it can be regenerated. */
  readonly definition: string;
  /** `swept` once the slice has been read; `claimed` while its issue is open. */
  readonly status: SweepSliceStatus;
  /** Repo-relative paths owned by this slice. */
  readonly paths: readonly string[];
}

/** The whole ledger. */
export interface SweepCoverageLedger {
  /** Repo-relative directory the ledger covers. */
  readonly root: string;
  /** Parent issue that ordered the sweep. */
  readonly parent: number;
  /** Prose describing what the ledger is for. */
  readonly description: string;
  /** Every slice; together they must partition `root`. */
  readonly slices: readonly SweepSlice[];
}

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
    paths: paths.map((p, i) =>
      requireString(p, `slices[${index}].paths[${i}]`)
    ),
  };
}

/**
 * Parse the ledger's JSON text.
 *
 * Fails loud: a malformed ledger throws rather than yielding a partial one,
 * because an empty or truncated slice list would silently read as "everything
 * is swept".
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
  return {
    root: requireString(ledger.root, "root"),
    parent,
    description: requireString(ledger.description, "description"),
    slices: slices.map(parseSlice),
  };
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
      `${diff.unswept.length} module(s) under ${LIB_SWEEP_ROOT} are claimed by no sweep slice — ` +
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
