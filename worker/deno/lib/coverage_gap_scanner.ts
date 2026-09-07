/**
 * Coverage-gap scanner for the test-audit idle-task scan (Issue #2916,
 * parent #2903).
 *
 * Extends the WHAT-vs-HOW test-audit with **coverage-gap detection**: it
 * enumerates the exported (public) functions of a Deno/TypeScript
 * workspace and flags any whose symbol name is never referenced by a test
 * file. The flagged functions are surfaced to Claude as a deterministic
 * pre-pass so the test-audit run reports untested public functions
 * (file:line, symbol) alongside its existing quality findings, in the
 * same audit.
 *
 * Native tooling only — public-function enumeration uses `deno doc
 * --json` (a static documentation extractor; it does NOT execute repo
 * logic), never Node tooling (Issue #2222). The "has a test?" check is a
 * plain symbol-name grep across the repo's test sources.
 *
 * Both external interactions (the `deno doc` spawn and the test-source
 * collection) are injectable so the scanner is unit-tested against a
 * stubbed workspace with no real subprocess.
 *
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";

/** A public function with no referencing test. */
export interface CoverageGap {
  /** The exported function's symbol name. */
  symbol: string;
  /** Repo-relative path of the declaring file. */
  file: string;
  /** 1-based line number of the declaration. */
  line: number;
}

/** An exported function enumerated from `deno doc --json`. */
export interface ExportedFunction {
  symbol: string;
  file: string;
  line: number;
}

/** Options for {@link findCoverageGaps}. */
export interface FindCoverageGapsOptions {
  /** Absolute path of the cloned repository. */
  workDir: string;
  /**
   * Returns the `deno doc --json` output describing the repo's public
   * surface. Defaults to spawning `deno doc --json <workDir>`. Injected
   * in tests so no subprocess runs.
   */
  denoDocFn?: (workDir: string) => Promise<string>;
  /**
   * Returns the concatenated contents of every test file in the repo —
   * the corpus the "has a test?" check greps against. Defaults to
   * walking the workspace for test files. Injected in tests.
   */
  collectTestSourcesFn?: (workDir: string) => Promise<string>;
}

/**
 * Test-file detection markers, mirroring the test-audit prompt's Phase 1
 * inventory. A path is treated as a test source when its basename or
 * directory matches any of these.
 */
const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /_test\.[cm]?[jt]sx?$/, // foo_test.ts
  /\.test\.[cm]?[jt]sx?$/, // foo.test.ts
  /\.spec\.[cm]?[jt]sx?$/, // foo.spec.ts
  /(^|\/)__tests__\//, // __tests__/foo.ts
  /(^|\/)tests?\//, // tests/foo.ts or test/foo.ts
  /\.cy\.[jt]sx?$/, // cypress spec
];

/** True when `relPath` looks like a test file. */
export function isTestPath(relPath: string): boolean {
  const normalised = relPath.replaceAll("\\", "/");
  return TEST_PATH_PATTERNS.some((re) => re.test(normalised));
}

/**
 * Convert a `file://` URL (or already-relative path) to a path relative
 * to `workDir`. Falls back to the input when it cannot be relativised.
 */
function toRepoRelative(filename: string, workDir: string): string {
  let path = filename;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      // leave as-is
    }
  }
  const base = workDir.endsWith("/") ? workDir : `${workDir}/`;
  if (path.startsWith(base)) return path.slice(base.length);
  if (path === workDir) return "";
  return path;
}

/**
 * Parse `deno doc --json` output into the list of exported functions.
 *
 * Handles the Deno 2.x object-nodes shape
 * (`{ nodes: { "<file>": { symbols: [...] } } }`) and the older flat
 * array shape (`[{ kind, name, declarationKind, location }]`). Only
 * `kind === "function"` declarations with `declarationKind === "export"`
 * are returned. `deno doc` reports 0-based lines; the result is
 * normalised to 1-based.
 *
 * Malformed JSON yields an empty list rather than throwing — the caller
 * treats "could not enumerate" as "no gaps".
 */
export function parseExportedFunctions(
  denoDocJson: string,
  workDir: string,
): ExportedFunction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(denoDocJson);
  } catch {
    return [];
  }

  const out: ExportedFunction[] = [];
  const seen = new Set<string>();

  const pushDecl = (
    name: unknown,
    kind: unknown,
    declarationKind: unknown,
    location: unknown,
  ): void => {
    if (kind !== "function") return;
    if (declarationKind !== "export") return;
    if (typeof name !== "string" || name.length === 0) return;
    const loc = location as { filename?: unknown; line?: unknown } | null;
    const filename = loc && typeof loc.filename === "string"
      ? loc.filename
      : "";
    const rawLine = loc && typeof loc.line === "number" ? loc.line : 0;
    const file = toRepoRelative(filename, workDir);
    const line = rawLine + 1; // deno doc lines are 0-based
    const key = `${file}::${name}::${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol: name, file, line });
  };

  // Flat array shape (older deno doc): each entry is a node.
  if (Array.isArray(parsed)) {
    for (const node of parsed) {
      if (node === null || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;
      pushDecl(n.name, n.kind, n.declarationKind, n.location);
    }
    return out;
  }

  // Object-nodes shape (Deno 2.x).
  const root = parsed as { nodes?: unknown } | null;
  const nodes = root && typeof root === "object" ? root.nodes : undefined;
  if (nodes && typeof nodes === "object") {
    for (const fileEntry of Object.values(nodes as Record<string, unknown>)) {
      const symbols = (fileEntry as { symbols?: unknown })?.symbols;
      if (!Array.isArray(symbols)) continue;
      for (const sym of symbols) {
        if (sym === null || typeof sym !== "object") continue;
        const name = (sym as { name?: unknown }).name;
        const decls = (sym as { declarations?: unknown }).declarations;
        if (!Array.isArray(decls)) continue;
        for (const decl of decls) {
          if (decl === null || typeof decl !== "object") continue;
          const d = decl as Record<string, unknown>;
          pushDecl(name, d.kind, d.declarationKind, d.location);
        }
      }
    }
  }
  return out;
}

/**
 * True when `symbol` is referenced as a whole word anywhere in
 * `testSources`. Word boundaries stop `parse` from matching `parseAll`.
 */
export function symbolHasTest(symbol: string, testSources: string): boolean {
  if (symbol.length === 0) return false;
  // Manual whole-word scan instead of a dynamically-built RegExp: the symbol
  // is attacker-uncontrolled, but a non-literal `new RegExp()` is a ReDoS
  // smell, so we match the `\b…\b` semantics with plain string scanning.
  // A word character is [A-Za-z0-9_], matching the regex `\w` boundary.
  const isWordChar = (c: string | undefined): boolean =>
    c !== undefined &&
    ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9") || c === "_");
  let from = 0;
  while (from <= testSources.length) {
    const idx = testSources.indexOf(symbol, from);
    if (idx === -1) return false;
    const before = idx > 0 ? testSources[idx - 1] : "";
    const afterIdx = idx + symbol.length;
    const after = afterIdx < testSources.length ? testSources[afterIdx] : "";
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * Bound on the `deno doc` spawn (Issue #1228).
 *
 * `deno doc --json` parses the TypeScript of a cloned, PR-merged repository —
 * content the author of that PR controls. An unbounded spawn over such
 * content is a hang, not a slowdown: it starves the worker's own watchdogs
 * and a human has to kill the host. Two minutes covers the largest workspace
 * the scanner has measured with room to spare.
 */
export const DENO_DOC_TIMEOUT_MS = 120_000;

/**
 * Build the default `deno doc --json <workDir>` runner, bounded by
 * {@link DENO_DOC_TIMEOUT_MS}.
 *
 * `runFn` is injectable so the bound is unit-tested without a subprocess.
 */
export function createDenoDocRunner(
  runFn: typeof runWithTimeout = runWithTimeout,
): (workDir: string) => Promise<string> {
  return async (workDir: string): Promise<string> => {
    const result = await runFn("deno", ["doc", "--json", workDir], {
      timeoutMs: DENO_DOC_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new Error(`deno doc failed: ${result.error.message}`);
    }
    if (result.value.timedOut) {
      // Loud: the caller degrades to an empty gap list, so the timeout would
      // otherwise be indistinguishable from a repo with full coverage.
      const message =
        `deno doc timed out after ${DENO_DOC_TIMEOUT_MS}ms over ${workDir}`;
      console.warn(`⚠️  ${message}`);
      throw new Error(message);
    }
    if (!result.value.success) return "";
    return result.value.stdout;
  };
}

/** Default `deno doc --json <workDir>` runner. */
const defaultDenoDoc = createDenoDocRunner();

/** Default test-source collector: walk `workDir` for test files. */
async function defaultCollectTestSources(workDir: string): Promise<string> {
  const chunks: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(abs);
        continue;
      }
      const rel = toRepoRelative(abs, workDir);
      if (isTestPath(rel)) {
        try {
          chunks.push(await Deno.readTextFile(abs));
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  await walk(workDir);
  return chunks.join("\n");
}

/**
 * Enumerate the workspace's exported functions and return those with no
 * referencing test (the coverage gaps). Best-effort: any failure in the
 * underlying tooling yields an empty list so the test-audit run still
 * proceeds on its prompt-driven, language-agnostic path.
 *
 * Functions declared inside test files are skipped — a test helper is
 * not a coverage gap.
 */
export async function findCoverageGaps(
  opts: FindCoverageGapsOptions,
): Promise<CoverageGap[]> {
  const denoDocFn = opts.denoDocFn ?? defaultDenoDoc;
  const collectTestSourcesFn = opts.collectTestSourcesFn ??
    defaultCollectTestSources;

  let docJson: string;
  try {
    docJson = await denoDocFn(opts.workDir);
  } catch {
    return [];
  }
  const exported = parseExportedFunctions(docJson, opts.workDir);
  if (exported.length === 0) return [];

  let testSources: string;
  try {
    testSources = await collectTestSourcesFn(opts.workDir);
  } catch {
    return [];
  }

  const gaps: CoverageGap[] = [];
  for (const fn of exported) {
    if (isTestPath(fn.file)) continue; // a test helper is not a gap
    if (symbolHasTest(fn.symbol, testSources)) continue;
    gaps.push({ symbol: fn.symbol, file: fn.file, line: fn.line });
  }
  return gaps;
}

/**
 * Maximum number of gaps rendered into the prompt (Issue #3809).
 *
 * A repo with a large untested public surface would otherwise inject an
 * arbitrarily long document into the prompt, and the run can only file
 * six issues per scan anyway. The surplus is re-detected next run.
 */
export const COVERAGE_GAP_RENDER_LIMIT = 50;

/**
 * Render the coverage-gap list for substitution into the test-audit
 * prompt's `{{COVERAGE_GAPS}}` placeholder. Each gap renders as
 * `- file:line — symbol`. An empty list renders the `(none)` sentinel so
 * the prompt reads naturally and Claude knows to enumerate the
 * non-Deno surface itself.
 *
 * At most {@link COVERAGE_GAP_RENDER_LIMIT} gaps are rendered. When the
 * list is longer the truncation is stated loudly on a trailing
 * `showing N of M` line — never silently dropped — so the run knows the
 * list it received is a prefix, not the whole answer.
 */
export function renderCoverageGaps(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) return "(none)";
  const shown = gaps.slice(0, COVERAGE_GAP_RENDER_LIMIT);
  const lines = shown.map((g) => `- ${g.file}:${g.line} — ${g.symbol}`);
  if (gaps.length > shown.length) {
    lines.push(
      `(showing ${shown.length} of ${gaps.length} statically detected gaps — ` +
        `the remainder are re-detected on the next run)`,
    );
  }
  return lines.join("\n");
}
