/**
 * Export-time branding transform: the private product name → `VibeCoder`
 * (Issue #4197, Phase 3 of the #4160 proving-ground plan).
 *
 * The private proving ground keeps its name; the public repository is
 * `stSoftwareAU/VibeCoder`. Rather than churn ~940 occurrences across the
 * private tree, the rename is applied mechanically to the **staged export
 * tree** by `export-public.sh`, before the scrub gate (#4196) runs so the
 * gate sees the final published text.
 *
 * Rules:
 *
 *   - Five variants are rewritten, case- and separator-exactly:
 *     `VibeCoder`, `vibecoder`, `vibe-coder`, `vibe_coder`,
 *     `VIBECODER` → `VibeCoder`, `vibecoder`, `vibe-coder`, `vibe_coder`,
 *     `VIBECODER`. Code identifiers, prose, CLI strings and bare repository
 *     slugs (`stSoftwareAU/<old>` → `stSoftwareAU/VibeCoder`) are all in
 *     scope; nothing is exempt by path or package name.
 *   - A reference that **points at** the private repository — a
 *     `github.com` / `githubusercontent.com` URL, a `git@github.com:` clone
 *     path, a `.git` suffix, an `#NNN` issue shorthand or a `/issues/…`-style
 *     path — is never rewritten: renaming it would make the statement false
 *     (the issue lives in the private repo). It is left verbatim and
 *     surfaced as a **private-repo reference** in the report; the scrub gate
 *     is what blocks on it.
 *   - Binary files (NUL in the first 8 KiB) and non-UTF-8 files are left
 *     byte-for-byte untouched.
 *   - The report accounts for every replacement: a per-variant total and a
 *     per-file, per-variant count.
 *
 * The old-name literals below are assembled from parts on purpose: this
 * source file is itself exported and transformed, and it must still describe
 * the old name afterwards.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { decodeTextOrNull, listTreeFiles } from "./export_tree.ts";

export { isProbablyBinary } from "./export_tree.ts";

/** One rewrite rule. */
export interface BrandingVariant {
  /** The private-tree spelling. */
  readonly from: string;
  /** The published spelling. */
  readonly to: string;
}

const OLD_CAMEL = "Vibe" + "Coding";
const OLD_LOWER = "vibe" + "coding";
const OLD_KEBAB = "vibe-" + "coding";
const OLD_SNAKE = "vibe_" + "coding";
const OLD_UPPER = "VIBE" + "CODING";
const OLD_TITLE_SNAKE = "Vibe_" + "Coding";
const OLD_TITLE_KEBAB = "Vibe-" + "Coding";

/** The rewrite table, in the order the issue lists the variants. */
export const BRANDING_VARIANTS: readonly BrandingVariant[] = [
  { from: OLD_CAMEL, to: "VibeCoder" },
  { from: OLD_LOWER, to: "vibecoder" },
  { from: OLD_KEBAB, to: "vibe-coder" },
  { from: OLD_SNAKE, to: "vibe_coder" },
  { from: OLD_UPPER, to: "VIBECODER" },
  // Mixed-case separator forms seen in the tree (heartbeat file names).
  { from: OLD_TITLE_SNAKE, to: "Vibe_Coder" },
  { from: OLD_TITLE_KEBAB, to: "Vibe-Coder" },
];

/**
 * A reference that points at the private repository by URL, clone address,
 * `#N` shorthand or repository path. Group 1 is a host / clone prefix,
 * group 2 a repository-path suffix; a match with neither is a bare slug.
 *
 * Every form is rewritten to the public repository (Issue #4197 as
 * re-scoped: after the cut-over the public repository *is* the canonical
 * project, and its tracker numbers are the ones every bare `(Issue #N)` in
 * the tree already cites). URL/path forms are additionally **listed in the
 * report**, one line each, so the operator reviews what was renamed —
 * nothing is silent. References to *other* private repositories are the
 * historical ones that must not be renamed into false history; those are
 * for the redaction stage and the scrub gate, not for this transform.
 */
const PRIVATE_REFERENCE_RE = new RegExp(
  "((?:https?:\\/\\/)?(?:[a-z0-9.-]*github(?:usercontent)?\\.com[/:](?:repos\\/)?)|git@github\\.com:)?" +
    "stSoftwareAU\\/" + OLD_CAMEL + "(?![A-Za-z0-9_])" +
    "(\\.git\\b|#\\d+|\\/[^\\s\"'<>)\\]]*)?",
  "gi",
);

/** A URL/path-form reference to the private repository, rewritten and reported. */
export interface PrivateRepoReference {
  /** 1-based line. */
  line: number;
  /** The reference text as it was — it is a location, not a secret. */
  text: string;
  /** The reference as published. */
  rewritten: string;
}

/** Result of transforming one file's text. */
export interface FileBrandingResult {
  path: string;
  /** True when at least one replacement was made. */
  changed: boolean;
  /** The rewritten text (identical to the input when unchanged). */
  text: string;
  /** Replacements per variant (`from` → count); absent variants had none. */
  counts: Record<string, number>;
  privateReferences: PrivateRepoReference[];
}

/** Rewrite the branding variants in `text`; URL-form references are reported. */
export function transformBrandingText(
  text: string,
  path: string,
): FileBrandingResult {
  const counts: Record<string, number> = {};
  const privateReferences: PrivateRepoReference[] = [];
  const pieces: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(PRIVATE_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const hasPrefix = (match[1] ?? "") !== "";
    const hasSuffix = (match[2] ?? "") !== "";
    if (!hasPrefix && !hasSuffix) continue; // bare slug: rewritten below
    pieces.push(rewrite(text.slice(cursor, start), counts));
    const rewritten = rewrite(match[0], counts);
    pieces.push(rewritten);
    privateReferences.push({
      line: lineNumberAt(text, start),
      text: match[0],
      rewritten,
    });
    cursor = start + match[0].length;
  }
  pieces.push(rewrite(text.slice(cursor), counts));

  const out = pieces.join("");
  return {
    path,
    changed: out !== text,
    text: out,
    counts,
    privateReferences,
  };
}

function rewrite(segment: string, counts: Record<string, number>): string {
  let out = segment;
  for (const { from, to } of BRANDING_VARIANTS) {
    const hits = out.split(from).length - 1;
    if (hits === 0) continue;
    counts[from] = (counts[from] ?? 0) + hits;
    out = out.replaceAll(from, to);
  }
  return out;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Per-file entry in the tree report. */
export interface FileBrandingSummary {
  path: string;
  counts: Record<string, number>;
}

/** A private-repo reference located in the tree. */
export interface TreePrivateReference extends PrivateRepoReference {
  path: string;
}

/** The transform report for a whole tree. */
export interface BrandingReport {
  tree: string;
  /** Whether files were written (`false` in check mode). */
  applied: boolean;
  filesScanned: number;
  filesRewritten: number;
  filesSkippedBinary: number;
  /** Total replacements per variant — every variant present, zero or more. */
  totals: Record<string, number>;
  /** Only files with at least one replacement, in path order. */
  files: FileBrandingSummary[];
  privateReferences: TreePrivateReference[];
}

/** Options for {@link transformBrandingTree}. */
export interface TransformTreeOptions {
  /** Write rewritten files back (`false` = report only). */
  write: boolean;
}

/**
 * Apply the transform to every text file beneath `tree`, in place when
 * `write` is true. Binary and non-UTF-8 files are skipped and counted.
 */
export async function transformBrandingTree(
  tree: string,
  options: TransformTreeOptions,
): Promise<BrandingReport> {
  const totals: Record<string, number> = {};
  for (const { from } of BRANDING_VARIANTS) totals[from] = 0;
  const report: BrandingReport = {
    tree,
    applied: options.write,
    filesScanned: 0,
    filesRewritten: 0,
    filesSkippedBinary: 0,
    totals,
    files: [],
    privateReferences: [],
  };

  for (const rel of await listTreeFiles(tree)) {
    const abs = `${tree}/${rel}`;
    const text = decodeTextOrNull(await Deno.readFile(abs));
    if (text === null) {
      report.filesSkippedBinary++;
      continue;
    }
    report.filesScanned++;
    const result = transformBrandingText(text, rel);
    for (const ref of result.privateReferences) {
      report.privateReferences.push({ path: rel, ...ref });
    }
    if (!result.changed) continue;
    report.filesRewritten++;
    report.files.push({ path: rel, counts: result.counts });
    for (const [from, n] of Object.entries(result.counts)) {
      totals[from] = (totals[from] ?? 0) + n;
    }
    if (options.write) {
      // writeTextFile truncates in place, so the file's mode is preserved
      // (a staged setup.sh stays executable).
      await Deno.writeTextFile(abs, result.text);
    }
  }
  return report;
}

/** Render the report for the operator. */
export function formatBrandingReport(report: BrandingReport): string {
  const total = Object.values(report.totals).reduce((a, b) => a + b, 0);
  const lines: string[] = [
    "Branding transform report (Issue #4197)",
    `tree: ${report.tree}`,
    `mode: ${report.applied ? "applied in place" : "check only (no writes)"}`,
    `files-scanned: ${report.filesScanned}`,
    `files-rewritten: ${report.filesRewritten}`,
    `files-skipped-binary: ${report.filesSkippedBinary}`,
    `replacements-total: ${total}`,
  ];
  for (const { from, to } of BRANDING_VARIANTS) {
    lines.push(`  ${from} -> ${to}: ${report.totals[from] ?? 0}`);
  }
  lines.push(
    `repository URL/path references rewritten (review below): ${report.privateReferences.length}`,
  );
  lines.push("");

  if (report.files.length > 0) {
    lines.push("--- Replacements per file ---");
    for (const file of report.files) {
      const parts = BRANDING_VARIANTS
        .filter(({ from }) => (file.counts[from] ?? 0) > 0)
        .map(({ from }) => `${from}=${file.counts[from]}`);
      lines.push(`  ${file.path}: ${parts.join(" ")}`);
    }
    lines.push("");
  }

  if (report.privateReferences.length > 0) {
    lines.push(
      "--- Repository URL/path references rewritten to the public repository (Issue #4197) ---",
    );
    for (const ref of report.privateReferences) {
      lines.push(
        `  ${ref.path}:${ref.line}  ${ref.text} -> ${ref.rewritten}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
