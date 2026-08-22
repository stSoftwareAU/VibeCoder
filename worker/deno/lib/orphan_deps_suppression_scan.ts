/**
 * Filesystem scan that gathers in-source orphan-deps suppression ids from a
 * cloned repository's dependency manifests (Issue #2908, parent #2902).
 *
 * The pure parsing lives in `orphan_deps_finding_id.ts`
 * ({@link collectOrphanDepsSuppressions}); this module is the thin I/O
 * wrapper that reads a bounded allow-list of manifests at the repo root
 * and feeds their text to the parser under the comment grammar each file
 * format actually has. Splitting the I/O out keeps the parsing
 * unit-testable without touching disk and keeps this module's only side
 * effect a guarded `Deno.readTextFile`.
 *
 * Every read is best-effort: a missing file or a read error is swallowed so
 * a suppression scan never blocks the orphan-deps run. Each manifest is also
 * bounded before parsing ({@link capManifestText}, Issue #3942) — the files
 * come from a cloned repository, so a fork PR controls their size.
 * Australian English spelling used throughout (behaviour, organisation,
 * authorised).
 */

import {
  collectOrphanDepsSuppressions,
  type ManifestCommentGrammar,
  type OrphanDepsManifestText,
  type OrphanDepsSuppression,
} from "./orphan_deps_finding_id.ts";
import { blameFileLineLogins } from "./suppression_identity.ts";

/** One entry of the manifest inventory surface. */
export interface OrphanDepsManifest {
  /** Filename relative to the repo root. */
  name: string;
  /** The comment grammar that file format actually has. */
  grammar: ManifestCommentGrammar;
}

/**
 * The dependency manifests at the repo root, each paired with the comment
 * grammar its format actually has. Bounded on purpose — these are the
 * files an operator declares dependencies in, so a `best-practice-ignore`
 * / `orphan-deps-ignore` marker above an offending line lives here. The
 * list mirrors the prompt's Phase-1 inventory surface.
 *
 * Only the commentable manifests are ever read for markers. Strict JSON
 * (`package.json`, `package-lock.json`) and generated lockfiles
 * (`deno.lock`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`) carry
 * `grammar: "none"`: they are part of the inventory surface, but nothing a
 * PR can put in them is an operator waiver, so they are never scanned
 * (Issue #3947). `deno.json` is listed as `slash` because Deno parses it
 * as JSONC.
 */
export const ORPHAN_DEPS_MANIFESTS: readonly OrphanDepsManifest[] = [
  { name: "deno.json", grammar: "slash" },
  { name: "deno.jsonc", grammar: "slash" },
  { name: "deno.lock", grammar: "none" },
  { name: "package.json", grammar: "none" },
  { name: "package-lock.json", grammar: "none" },
  { name: "pnpm-lock.yaml", grammar: "none" },
  { name: "yarn.lock", grammar: "none" },
  { name: "Cargo.toml", grammar: "hash" },
  { name: "Cargo.lock", grammar: "none" },
];

/** The manifest inventory surface as bare filenames. */
export const ORPHAN_DEPS_MANIFEST_FILES: readonly string[] =
  ORPHAN_DEPS_MANIFESTS
    .map((m) => m.name);

/**
 * Cap on the manifest text handed to the suppression parser (Issue #3942).
 *
 * Mirrors the `MAX_SCAN_CHARS` bound `security_fix_gate.ts` already applies to
 * untrusted text. A manifest arrives from a cloned repository — a fork PR
 * controls its size — and every byte is fed to the marker regexes, so the read
 * is bounded here rather than trusting the file.
 */
export const MAX_MANIFEST_SCAN_CHARS = 200_000;

/**
 * Cap on a single manifest line (Issue #3942). A suppression marker is a
 * short comment; a line orders of magnitude longer than that is minified or
 * generated content, never a waiver. Over-long lines are blanked rather than
 * dropped so a record's `line` still points at the real source line.
 */
export const MAX_MANIFEST_SCAN_LINE_CHARS = 4_000;

/**
 * Bound one manifest's text before it reaches the marker regexes.
 *
 * Truncates the whole text to {@link MAX_MANIFEST_SCAN_CHARS} and blanks any
 * line longer than {@link MAX_MANIFEST_SCAN_LINE_CHARS}, preserving line
 * numbering. Capping only ever removes candidate markers, so it fails safe:
 * the worst outcome is a finding that stays visible instead of being waived.
 *
 * Every drop is announced through `logFn` — a cap that silently discards
 * text would look like a clean scan (Issue #3234).
 *
 * @param text - Raw manifest text
 * @param file - Manifest name, used in the cap notices
 * @param logFn - Notice sink; defaults to `console.warn`
 * @returns The bounded text
 */
export function capManifestText(
  text: string,
  file: string = "manifest",
  logFn: (message: string) => void = (message) => console.warn(message),
): string {
  const bounded = text.length > MAX_MANIFEST_SCAN_CHARS
    ? text.slice(0, MAX_MANIFEST_SCAN_CHARS)
    : text;
  if (bounded.length !== text.length) {
    logFn(
      `Suppression scan: ${file} truncated at ${MAX_MANIFEST_SCAN_CHARS} ` +
        `characters (was ${text.length}) — markers past the cap are ignored.`,
    );
  }
  let dropped = 0;
  const lines = bounded.split("\n").map((line) => {
    if (line.length <= MAX_MANIFEST_SCAN_LINE_CHARS) return line;
    dropped++;
    return "";
  });
  if (dropped > 0) {
    logFn(
      `Suppression scan: ${file} had ${dropped} line(s) over ` +
        `${MAX_MANIFEST_SCAN_LINE_CHARS} characters — skipped unparsed.`,
    );
  }
  return lines.join("\n");
}

/** Injectable side-effects for {@link collectInSourceSuppressedIds}. */
export interface SuppressionScanDeps {
  /** File reader. Defaults to `Deno.readTextFile`. */
  readTextFileFn?: (path: string) => Promise<string>;
  /**
   * Sink for cap notices (Issue #3942). Every byte the caps drop is reported
   * so a bounded scan is never silent. Defaults to `console.warn`.
   */
  logFn?: (message: string) => void;
  /**
   * Blame `file` under `workDir` and return a line → login map
   * (Issue #269). Defaults to {@link blameFileLineLogins}. Tests inject
   * a stub so they do not need a real git checkout.
   */
  blameFileFn?: (
    workDir: string,
    file: string,
  ) => Promise<Readonly<Record<number, string>>>;
}

/**
 * Read the commentable manifests under `workDir` and return every
 * suppression marker declared in them, each scoped to its file and line.
 *
 * A manifest with no comment grammar is never opened — a marker in a
 * lockfile or a strict-JSON value is not a waiver (Issue #3947).
 *
 * Best-effort: a manifest that does not exist or cannot be read contributes
 * nothing — the scan never throws.
 */
export async function collectInSourceSuppressions(
  workDir: string,
  deps: SuppressionScanDeps = {},
): Promise<OrphanDepsSuppression[]> {
  const readTextFileFn = deps.readTextFileFn ??
    ((path) => Deno.readTextFile(path));
  // Loud by default (Issue #3234): a cap that drops text must never be silent.
  const logFn = deps.logFn ?? ((message: string) => console.warn(message));
  const blameFileFn = deps.blameFileFn ??
    ((dir, file) => blameFileLineLogins(dir, file));

  const manifests: OrphanDepsManifestText[] = [];
  // Issue #269: bind each manifest's markers to the blamed author of
  // that line. Per-file blame is cheap — the inventory is a handful of
  // commentable manifests — and closes the `author=<allowlisted>`
  // forgery a fork can plant in comment text.
  const lineAuthorsByFile = new Map<string, Readonly<Record<number, string>>>();
  for (const manifest of ORPHAN_DEPS_MANIFESTS) {
    if (manifest.grammar === "none") continue;
    try {
      manifests.push({
        file: manifest.name,
        // Bounded before parsing (Issue #3942) — the file comes from a cloned
        // repository, so its size is attacker-influenced.
        text: capManifestText(
          await readTextFileFn(`${workDir}/${manifest.name}`),
          manifest.name,
          logFn,
        ),
        grammar: manifest.grammar,
      });
      const blamed = await blameFileFn(workDir, manifest.name);
      if (Object.keys(blamed).length > 0) {
        lineAuthorsByFile.set(manifest.name, blamed);
      }
    } catch {
      // Missing or unreadable manifest — skip it.
    }
  }
  // When blame yielded nothing (tests with a stubbed reader, or a
  // checkout git cannot see) the process-wide commit-author list still
  // applies; an empty bind fails closed in the parser.
  const collected: OrphanDepsSuppression[] = [];
  for (const manifest of manifests) {
    const lineAuthors = lineAuthorsByFile.get(manifest.file);
    collected.push(
      ...collectOrphanDepsSuppressions(
        [manifest],
        lineAuthors ? { lineAuthors } : {},
      ),
    );
  }
  return collected;
}

/**
 * The de-duplicated `BP-` suppression ids declared under `workDir` — the
 * flat list the prompt's `{{SUPPRESSED_IDS}}` placeholder takes. Returns an
 * empty array when no marker is present (the common case).
 *
 * Use {@link collectInSourceSuppressions} when the declaring file and line
 * matter; the run's suppression report renders them either way, because
 * every marker is parsed with its source file attached.
 *
 * Delegates to {@link collectInSourceSuppressions} so both #3947 rules hold
 * on this path too — a non-commentable manifest is never opened, and only a
 * real comment can carry a marker — and then keeps only the markers that
 * passed governance (Issue #3941), because an unattributed, expired or
 * unauthorised waiver must never reach the prompt.
 */
export async function collectInSourceSuppressedIds(
  workDir: string,
  deps: SuppressionScanDeps = {},
): Promise<string[]> {
  const suppressions = await collectInSourceSuppressions(workDir, deps);
  return [
    ...new Set(suppressions.filter((s) => s.valid).map((s) => s.id)),
  ];
}
