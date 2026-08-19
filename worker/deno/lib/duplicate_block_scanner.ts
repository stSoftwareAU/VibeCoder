/**
 * Duplicate-block pre-pass for the duplicated-knowledge idle-task scan
 * (stSoftwareAU/VibeCoder#3609).
 *
 * A cheap, deterministic, language-agnostic clone detector: it normalises
 * each source line (whitespace collapsed, blank / comment-only /
 * punctuation-only lines dropped), hashes a sliding window of five
 * normalised lines, and reports every window that occurs in two or more
 * places — greedily extended to the full length of the clone so a
 * twenty-line copy is one finding, not sixteen overlapping ones.
 *
 * The pre-pass only *narrows the search*. It reports duplicated **text**;
 * whether that text is duplicated **knowledge** — the same rule, needing
 * the same edit in every copy — is a judgement the scan prompt makes, and
 * the prompt is explicitly biased towards silence. Nothing here files
 * anything.
 *
 * Modelled on `coverage_gap_scanner.ts`, which seeds the test-audit scan
 * the same way: pure core, injectable I/O, best-effort by design.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { isTestPath } from "./coverage_gap_scanner.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One occurrence of a duplicated block, in original 1-based line numbers. */
export interface DuplicateSite {
  /** Repo-relative path of the file holding this copy. */
  file: string;
  /** 1-based line number of the block's first significant line. */
  startLine: number;
  /** 1-based line number of the block's last significant line. */
  endLine: number;
}

/** A block of significant lines occurring in two or more places. */
export interface DuplicateBlock {
  /** Number of significant (normalised) lines in the block. */
  lineCount: number;
  /** Every place the block occurs, in discovery order. */
  sites: DuplicateSite[];
}

/** A source file handed to the pure core. */
export interface SourceFile {
  /** Repo-relative path. */
  file: string;
  /** Full file contents. */
  content: string;
}

/** A single normalised source line and where it came from. */
export interface SignificantLine {
  /** Trimmed text with internal whitespace runs collapsed to one space. */
  text: string;
  /** 1-based line number in the original file. */
  line: number;
}

/** Tuning knobs for {@link findDuplicateBlocksIn}. */
export interface DuplicateBlockOptions {
  /**
   * Minimum clone size in significant lines. Defaults to 5 — the
   * threshold the scan prompt documents.
   */
  windowLines?: number;
  /** Maximum number of blocks returned, largest clone first. Defaults to 25. */
  maxBlocks?: number;
}

/** Options for {@link findDuplicateBlocks}. */
export interface FindDuplicateBlocksOptions extends DuplicateBlockOptions {
  /** Absolute path of the cloned repository. */
  workDir: string;
  /**
   * Returns every scannable source file in the repo. Defaults to walking
   * `workDir`. Injected in tests so no filesystem walk runs.
   */
  collectSourcesFn?: (workDir: string) => Promise<SourceFile[]>;
}

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

/** Extensions the pre-pass reads. Prose and data files are not code. */
const CODE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".php",
  ".swift",
  ".scala",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
];

/** Directories that hold code nobody in this repo maintains. */
const EXCLUDED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  ".venv",
  "third_party",
];

/** Generated / bundled artefacts — duplication there is not a defect. */
const GENERATED_MARKERS: readonly RegExp[] = [
  /\.min\.[cm]?js$/,
  /\.bundle\.[cm]?js$/,
  /\.generated\.[a-z]+$/,
  /_pb2?\.[a-z]+$/,
];

/**
 * True when `relPath` is a source file the pre-pass should read.
 *
 * Test sources are deliberately excluded: test scaffolding is repetitive
 * by nature, and the scan prompt is told to stay silent on it, so
 * surfacing it would only manufacture candidates that must be dropped.
 */
export function isScannablePath(relPath: string): boolean {
  const path = relPath.replaceAll("\\", "/");
  if (path.length === 0) return false;
  const segments = path.split("/");
  if (segments.some((s) => EXCLUDED_DIRECTORIES.includes(s))) return false;
  if (GENERATED_MARKERS.some((re) => re.test(path))) return false;
  if (isTestPath(path)) return false;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return CODE_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// Line normalisation
// ---------------------------------------------------------------------------

/** Comment openers across the languages the pre-pass reads. */
const COMMENT_PREFIXES: readonly string[] = [
  "//",
  "#",
  "*",
  "/*",
  "*/",
  "--",
  "<!--",
  ";",
];

/** True when the trimmed line carries no letters or digits (`});`, `],`, …). */
function isPunctuationOnly(trimmed: string): boolean {
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

/**
 * Reduce `content` to its significant lines: blank, comment-only, and
 * punctuation-only lines are dropped, and internal whitespace runs are
 * collapsed so re-indentation never hides a clone. Original 1-based line
 * numbers are preserved so findings can cite `file:start-end`.
 */
export function significantLines(content: string): SignificantLine[] {
  const out: SignificantLine[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length === 0) continue;
    if (COMMENT_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    if (isPunctuationOnly(trimmed)) continue;
    out.push({ text: trimmed.replace(/\s+/g, " "), line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Window hashing
// ---------------------------------------------------------------------------

/**
 * 64-bit window key built from two independent 32-bit hashes (FNV-1a and
 * djb2). Two hashes rather than one keeps accidental collisions
 * negligible without holding every window's text in memory.
 */
function windowKey(
  lines: readonly SignificantLine[],
  start: number,
  len: number,
): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = start; i < start + len; i++) {
    const text = lines[i]?.text ?? "";
    for (let c = 0; c < text.length; c++) {
      const code = text.charCodeAt(c);
      fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
      djb = (Math.imul(djb, 33) + code) >>> 0;
    }
    // Separator so ["ab","c"] and ["a","bc"] cannot collide.
    fnv = Math.imul(fnv ^ 10, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) + 10) >>> 0;
  }
  return `${fnv.toString(16)}:${djb.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** A candidate occurrence: document index + start offset in significant lines. */
interface Occurrence {
  doc: number;
  start: number;
}

/**
 * Find every block of at least `windowLines` significant lines that occurs
 * in two or more places across `files`.
 *
 * Pure — no I/O. Blocks are returned largest first (line count, then site
 * count), capped at `maxBlocks`. Overlapping windows of the same clone
 * collapse into a single block, and two copies inside one file are
 * reported as two sites of one block.
 */
export function findDuplicateBlocksIn(
  files: readonly SourceFile[],
  opts: DuplicateBlockOptions = {},
): DuplicateBlock[] {
  const windowLines = opts.windowLines ?? 5;
  const maxBlocks = opts.maxBlocks ?? 25;
  if (windowLines < 1) return [];

  const docs = files.map((f) => ({
    file: f.file,
    lines: significantLines(f.content),
  }));

  // Index every window position by its key.
  const index = new Map<string, Occurrence[]>();
  for (let d = 0; d < docs.length; d++) {
    const lines = docs[d]?.lines ?? [];
    for (let start = 0; start + windowLines <= lines.length; start++) {
      const key = windowKey(lines, start, windowLines);
      const bucket = index.get(key);
      if (bucket === undefined) index.set(key, [{ doc: d, start }]);
      else bucket.push({ doc: d, start });
    }
  }

  // Walk the positions in document order so the output is deterministic,
  // emitting each clone once and marking its lines as reported.
  const covered = docs.map(() => new Set<number>());
  const blocks: DuplicateBlock[] = [];

  for (let d = 0; d < docs.length; d++) {
    const lines = docs[d]?.lines ?? [];
    for (let start = 0; start + windowLines <= lines.length; start++) {
      if (covered[d]?.has(start)) continue;
      const occurrences = index.get(windowKey(lines, start, windowLines)) ?? [];
      const fresh = occurrences.filter((o) => !covered[o.doc]?.has(o.start));
      if (fresh.length < 2) continue;

      const length = extendedLength(docs, fresh, windowLines);
      for (const site of fresh) {
        for (let i = site.start; i < site.start + length; i++) {
          covered[site.doc]?.add(i);
        }
      }
      blocks.push({
        lineCount: length,
        sites: fresh.map((site) => {
          const siteLines = docs[site.doc]?.lines ?? [];
          return {
            file: docs[site.doc]?.file ?? "",
            startLine: siteLines[site.start]?.line ?? 0,
            endLine: siteLines[site.start + length - 1]?.line ?? 0,
          };
        }),
      });
    }
  }

  blocks.sort((a, b) =>
    b.lineCount - a.lineCount ||
    b.sites.length - a.sites.length ||
    (a.sites[0]?.file ?? "").localeCompare(b.sites[0]?.file ?? "") ||
    (a.sites[0]?.startLine ?? 0) - (b.sites[0]?.startLine ?? 0)
  );
  return blocks.slice(0, maxBlocks);
}

/**
 * Greedily extend a matched window while every site still agrees, so a long
 * clone is reported once at its true length. Sites inside the same document
 * are never allowed to overlap each other.
 */
function extendedLength(
  docs: readonly { file: string; lines: SignificantLine[] }[],
  sites: readonly Occurrence[],
  windowLines: number,
): number {
  // Cap at the smallest gap between two sites in the same document.
  let limit = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i]!;
      const b = sites[j]!;
      if (a.doc !== b.doc) continue;
      limit = Math.min(limit, Math.abs(a.start - b.start));
    }
  }

  let length = windowLines;
  while (length < limit) {
    const first = sites[0]!;
    const firstLines = docs[first.doc]?.lines ?? [];
    const next = firstLines[first.start + length];
    if (next === undefined) break;
    const allMatch = sites.every((s) => {
      const siteLines = docs[s.doc]?.lines ?? [];
      return siteLines[s.start + length]?.text === next.text;
    });
    if (!allMatch) break;
    length += 1;
  }
  return length;
}

// ---------------------------------------------------------------------------
// Filesystem collection
// ---------------------------------------------------------------------------

/** Skip anything larger than this — a huge file is data, not hand-written logic. */
const MAX_FILE_BYTES = 512 * 1024;

/** Default collector: walk `workDir` for scannable source files. */
async function defaultCollectSources(workDir: string): Promise<SourceFile[]> {
  const base = workDir.endsWith("/") ? workDir : `${workDir}/`;
  const files: SourceFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile) continue;
      const rel = abs.startsWith(base) ? abs.slice(base.length) : abs;
      if (!isScannablePath(rel)) continue;
      try {
        const stat = await Deno.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        files.push({ file: rel, content: await Deno.readTextFile(abs) });
      } catch {
        // unreadable — skip this file, keep scanning the rest
      }
    }
  };

  await walk(workDir.replace(/\/$/, ""));
  return files;
}

/**
 * Collect the repo's source files and return its duplicate blocks.
 *
 * Best-effort by design, exactly like `findCoverageGaps`: if the walk
 * fails the result is an empty list, the prompt renders the `(none)`
 * sentinel, and the scan still self-drives on its own search. The
 * pre-pass is a hint, never the finding — so an empty hint list can never
 * be mistaken for "this repo is clean".
 */
export async function findDuplicateBlocks(
  opts: FindDuplicateBlocksOptions,
): Promise<DuplicateBlock[]> {
  const collectSourcesFn = opts.collectSourcesFn ?? defaultCollectSources;
  let files: SourceFile[];
  try {
    files = await collectSourcesFn(opts.workDir);
  } catch {
    return [];
  }
  return findDuplicateBlocksIn(files, {
    windowLines: opts.windowLines,
    maxBlocks: opts.maxBlocks,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the block list for the scan prompt's `{{DUPLICATE_BLOCKS}}`
 * placeholder — one `<candidate>` element per block, every site cited as
 * `file:start-end`. The 1-based `index` gives the scan a stable handle so
 * it can carry a verdict for candidate 3 across phases and across a
 * context compaction (prompt v3, Issue #3781). An empty list renders the
 * `(none)` sentinel so the prompt reads naturally and the scan knows to
 * search unaided.
 */
export function renderDuplicateBlocks(
  blocks: readonly DuplicateBlock[],
): string {
  if (blocks.length === 0) return "(none)";
  return blocks
    .map((block, i) => {
      const sites = block.sites
        .map((s) => `${s.file}:${s.startLine}-${s.endLine}`)
        .join(", ");
      return [
        `<candidate index="${i + 1}" lines="${block.lineCount}" ` +
        `site_count="${block.sites.length}">`,
        `<sites>${sites}</sites>`,
        `</candidate>`,
      ].join("\n");
    })
    .join("\n");
}
