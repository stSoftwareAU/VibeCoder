/**
 * Pure helpers for reasoning about the public export (Issues #4198, #4199).
 *
 * `export-public.sh` (Issue #4195) is bash, so anything a Deno test wants to
 * assert about the export — which files the manifest stages and where, which
 * operator documents the exclusion list withholds, whether every `uses:` in
 * an exported workflow is SHA-pinned, which secrets a workflow names, and the
 * pixel size of the social-preview PNG — needs a small TypeScript twin of the
 * script's parsing rules. These functions are that twin. They are pure and
 * do no I/O; the tests read the files and hand the bytes in.
 *
 * The manifest grammar mirrors `collect_candidates()` in `export-public.sh`:
 * one repo-relative path per line, `#` comments, blank lines ignored, and an
 * optional `SRC -> DEST` mapping. The exclusion-list grammar mirrors
 * `load_exclusions()`: one path per line, `#` comments, blank lines ignored.
 *
 * Australian English throughout (behaviour, licence, organisation).
 */

import { extractUsesValue } from "./action_pin_scanner.ts";

/** One resolved manifest line. */
export interface ManifestEntry {
  /** Repo-relative source path, without a trailing slash. */
  source: string;
  /** Repo-relative staged path (equal to `source` for a plain entry). */
  dest: string;
  /** 1-based manifest line number, for error messages. */
  line: number;
}

/** Strip a trailing slash so `docs/` and `docs` compare equal. */
function trimSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Parse `export/public-manifest.txt`. Blank lines and `#` comments are
 * skipped; `SRC -> DEST` lines are split into source and destination.
 */
export function parsePublicManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const arrow = line.indexOf(" -> ");
    if (arrow >= 0) {
      entries.push({
        source: trimSlash(line.slice(0, arrow).trim()),
        dest: trimSlash(line.slice(arrow + 4).trim()),
        line: index + 1,
      });
    } else {
      const path = trimSlash(line);
      entries.push({ source: path, dest: path, line: index + 1 });
    }
  });
  return entries;
}

/**
 * Parse `export/operator-docs-exclusions.txt`: one repo-relative path per
 * line (a directory withholds everything beneath it), `#` comments and blank
 * lines ignored. Returned without trailing slashes, in file order.
 */
export function parseExclusionList(text: string): string[] {
  return text
    .split("\n")
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(trimSlash);
}

/**
 * True when `path` is named by the exclusion list, either exactly or as a
 * file beneath an excluded directory.
 */
export function isExcludedPath(
  path: string,
  exclusions: readonly string[],
): boolean {
  const candidate = trimSlash(path);
  return exclusions.some((entry) =>
    candidate === entry || candidate.startsWith(`${entry}/`)
  );
}

/**
 * Where a source-tree path lands in the staged export, or `null` when no
 * manifest entry covers it. A file entry maps itself; a directory entry maps
 * everything beneath it, preserving the remainder of the path.
 */
export function stagedPathFor(
  sourcePath: string,
  entries: readonly ManifestEntry[],
): string | null {
  const path = trimSlash(sourcePath);
  for (const entry of entries) {
    if (path === entry.source) return entry.dest;
    if (path.startsWith(`${entry.source}/`)) {
      return `${entry.dest}/${path.slice(entry.source.length + 1)}`;
    }
  }
  return null;
}

/** A full 40-character lower-case hex commit SHA. */
const SHA_PIN = /^[0-9a-f]{40}$/;

/** One `uses:` reference that is not pinned to a commit SHA. */
export interface UnpinnedUses {
  /** 1-based line number in the workflow. */
  line: number;
  /** The raw `uses:` value, e.g. `actions/checkout@v4`. */
  value: string;
}

/**
 * Every `uses:` in a workflow that is not pinned to a 40-character commit
 * SHA. Stricter than the audit scanner's `classifyUses`: there is no
 * first-party carve-out, because a public repository has no first-party
 * organisation whose tags it may trust. Local `./…` references (same-repo
 * composite actions) carry no ref and are exempt; `docker://` images are
 * pinned by digest, not commit, and are exempt here too.
 */
export function findUnpinnedUses(workflowText: string): UnpinnedUses[] {
  const unpinned: UnpinnedUses[] = [];
  workflowText.split("\n").forEach((rawLine, index) => {
    const value = extractUsesValue(rawLine);
    if (value === null) return;
    if (value.startsWith("./") || value.startsWith("docker://")) return;
    const at = value.lastIndexOf("@");
    const ref = at >= 0 ? value.slice(at + 1) : "";
    if (!SHA_PIN.test(ref)) unpinned.push({ line: index + 1, value });
  });
  return unpinned;
}

/**
 * The distinct secret names a workflow reads via `${{ secrets.NAME }}`, in
 * order of first appearance. `GITHUB_TOKEN` is included when named — the
 * caller decides which names exist in the target repository.
 */
export function referencedSecrets(workflowText: string): string[] {
  const names: string[] = [];
  for (
    const match of workflowText.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)
  ) {
    const name = match[1] ?? "";
    if (name.length > 0 && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Pixel dimensions read from an image header. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Width and height from a PNG's IHDR chunk, or `null` when the bytes are not
 * a PNG. The eight-byte signature is followed immediately by the IHDR chunk:
 * four bytes of length, the ASCII `IHDR` tag, then width and height as
 * big-endian 32-bit integers.
 */
export function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  if (!signature.every((byte, i) => bytes[i] === byte)) return null;
  const tag = String.fromCharCode(...bytes.slice(12, 16));
  if (tag !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The `viewBox` size of an SVG root element, or `null` when absent. Used to
 * pin the social-preview source to the 1280×640 frame GitHub expects.
 */
export function svgViewBox(svgText: string): ImageDimensions | null {
  const match = svgText.match(/viewBox\s*=\s*"\s*0\s+0\s+(\d+)\s+(\d+)\s*"/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Every in-repo link target in a Markdown document — `[text](target)` and
 * `<img src="target">` — excluding external URLs and pure `#anchors`. Fenced
 * code blocks are skipped so an illustrative link in a snippet is not
 * checked. Targets keep their `#fragment` so the caller can verify anchors.
 */
export function relativeLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  let fence: string | null = null;
  for (const rawLine of markdown.split("\n")) {
    const fenceMatch = rawLine.match(/^\s*(`|~)\1\1/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").repeat(3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const found = [
      ...rawLine.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
      ...rawLine.matchAll(/<img[^>]*\ssrc="([^"]+)"/g),
    ];
    for (const match of found) {
      const target = match[1] ?? "";
      if (target.length === 0) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URL
      if (target.startsWith("#")) continue; // same-document anchor
      targets.push(target);
    }
  }
  return targets;
}
