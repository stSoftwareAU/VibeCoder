/**
 * Self-contained links in the staged export (Issues #4197, #4198).
 *
 * The private tree links freely between its documents; the export
 * withholds the operator ones (exclusion list, hard-deny gate). A published
 * page must not point at a page that is not there, so after staging:
 *
 *   - a relative Markdown link whose target exists in the SOURCE tree but
 *     not in the STAGED tree is **unlinked** — the label stays, the link
 *     goes (`[the manual](OPERATOR.md)` → `the manual`; an image keeps its
 *     alt text) — and is reported, one line per link;
 *   - a relative link whose target exists in neither tree is a private-tree
 *     defect or a prompt placeholder (`docs/evidence/filename.png`) — it is
 *     reported as broken-in-source and left alone, so the private tree can
 *     be fixed rather than the symptom hidden;
 *   - absolute URLs, `mailto:` and pure `#anchor` links are never touched.
 *
 * Only `.md` files are rewritten. Deterministic and idempotent.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { listTreeFiles } from "./export_tree.ts";

/** One relative link that was changed or flagged. */
export interface LinkRecord {
  /** Staged path of the file holding the link. */
  path: string;
  /** 1-based line. */
  line: number;
  /** Target as written. */
  raw: string;
  /** Target resolved tree-relative (no anchor). */
  target: string;
}

/** Result of {@link unlinkWithheld}. */
export interface UnlinkedText {
  text: string;
  unlinked: LinkRecord[];
  brokenInSource: LinkRecord[];
}

/** Callbacks answering "does this tree-relative path exist?". */
export interface LinkResolvers {
  existsInTree: (rel: string) => boolean;
  existsInSource: (rel: string) => boolean;
}

// `![alt](target)` or `[label](target "title")`, target without spaces.
const LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isRelative(target: string): boolean {
  if (target.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith("//")) return false;
  return true;
}

/** Resolve `target` against the directory of `path`, POSIX, no `..` left. */
export function resolveTarget(path: string, target: string): string {
  const stripped = target.replace(/[#?].*$/, "");
  const base = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const parts = base === "" ? [] : base.split("/");
  for (const seg of stripped.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Unlink withheld targets in one Markdown text. */
export function unlinkWithheld(
  text: string,
  path: string,
  resolvers: LinkResolvers,
): UnlinkedText {
  const unlinked: LinkRecord[] = [];
  const brokenInSource: LinkRecord[] = [];
  const out = text.replace(
    LINK_RE,
    (whole, bang: string, label: string, target: string, offset: number) => {
      if (!isRelative(target)) return whole;
      const resolved = resolveTarget(path, target);
      if (resolved === "" || resolvers.existsInTree(resolved)) return whole;
      const record: LinkRecord = {
        path,
        line: lineNumberAt(text, offset),
        raw: target,
        target: resolved,
      };
      if (resolvers.existsInSource(resolved)) {
        unlinked.push(record);
        void bang;
        return label;
      }
      brokenInSource.push(record);
      return whole;
    },
  );
  return { text: out, unlinked, brokenInSource };
}

/** Options for {@link relinkTree}. */
export interface RelinkOptions {
  /** The private source tree the staged tree was copied from. */
  sourceDir: string;
}

/** Report of a tree relink. */
export interface LinkReport {
  root: string;
  filesScanned: number;
  filesRewritten: number;
  unlinked: LinkRecord[];
  brokenInSource: LinkRecord[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite every `.md` in the staged tree; report what changed. */
export async function relinkTree(
  root: string,
  options: RelinkOptions,
): Promise<LinkReport> {
  const files = await listTreeFiles(root);
  const inTree = new Set(files);
  // Directories count as existing too (a link may point at a folder).
  for (const rel of files) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      inTree.add(parts.slice(0, i).join("/"));
    }
  }
  const sourceCache = new Map<string, boolean>();
  const existsInSource = (rel: string): boolean => {
    // Synchronous cache fill happens in the pre-pass below.
    return sourceCache.get(rel) ?? false;
  };

  const markdown = files.filter((rel) => rel.endsWith(".md"));
  const texts = new Map<string, string>();
  const candidates = new Set<string>();
  for (const rel of markdown) {
    const text = await Deno.readTextFile(`${root}/${rel}`);
    texts.set(rel, text);
    for (const m of text.matchAll(LINK_RE)) {
      const target = m[3] ?? "";
      if (!isRelative(target)) continue;
      const resolved = resolveTarget(rel, target);
      if (resolved !== "" && !inTree.has(resolved)) candidates.add(resolved);
    }
  }
  for (const rel of candidates) {
    sourceCache.set(rel, await fileExists(`${options.sourceDir}/${rel}`));
  }

  const report: LinkReport = {
    root,
    filesScanned: markdown.length,
    filesRewritten: 0,
    unlinked: [],
    brokenInSource: [],
  };
  for (const [rel, text] of texts) {
    const out = unlinkWithheld(text, rel, {
      existsInTree: (p) => inTree.has(p),
      existsInSource,
    });
    report.unlinked.push(...out.unlinked);
    report.brokenInSource.push(...out.brokenInSource);
    if (out.text !== text) {
      await Deno.writeTextFile(`${root}/${rel}`, out.text);
      report.filesRewritten++;
    }
  }
  return report;
}

/** Operator-facing report (beside the staging tree, never inside). */
export function renderLinkReport(report: LinkReport): string {
  const lines = [
    "Export link report (Issues #4197, #4198)",
    `tree: ${report.root}`,
    `markdown-files-scanned: ${report.filesScanned}`,
    `files-rewritten: ${report.filesRewritten}`,
    `unlinked: ${report.unlinked.length}`,
    `broken-in-source: ${report.brokenInSource.length}`,
    "",
    "--- Unlinked (target withheld from the export; label kept) ---",
    ...report.unlinked.map((u) => `  ${u.path}:${u.line}  ${u.target}`),
    "",
    "--- Broken in the source tree too (left as written; fix or a placeholder) ---",
    ...report.brokenInSource.map((b) => `  ${b.path}:${b.line}  ${b.target}`),
    "",
  ];
  return lines.join("\n");
}
