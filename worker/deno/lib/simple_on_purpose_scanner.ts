/**
 * Ledger of `// SIMPLE-ON-PURPOSE:` markers (Issue #4027).
 *
 * Reads a repository tree and lists every marker with its path, line, ceiling
 * and `upgrade when` condition. A marker that omits `upgrade when` is flagged.
 * A marker that names neither a ceiling nor a condition is flagged as
 * malformed. A directory that cannot be listed, or a file that cannot be
 * read, fails the scan — an unreadable tree is never reported as an empty
 * ledger.
 *
 * Nothing is fetched and nothing is written. `.git` and `node_modules` are
 * not our corner cuts, so they are not walked.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

/** The marker the coding standard requires, including the colon. */
export const SIMPLE_ON_PURPOSE_PREFIX = "// SIMPLE-ON-PURPOSE:";

const UPGRADE_WHEN = "upgrade when";

/**
 * Whole-file read, so a marker past this size is a scan error rather than a
 * silent omission.
 */
// SIMPLE-ON-PURPOSE: whole-file read, fine to 8 MiB — upgrade when a source file larger than that holds a marker
const MAX_FILE_BYTES = 8_000_000;

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/** Why a marker is not a complete ledger entry. */
export type SimpleOnPurposeFlag = "ok" | "missing-upgrade-when" | "malformed";

/** One marker, already located in the tree. */
export interface SimpleOnPurposeMarker {
  /** Repo-relative path, `/`-separated. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Text before `upgrade when`. Empty when the marker is malformed. */
  ceiling: string;
  /** Text after `upgrade when`. Empty when the clause is absent or empty. */
  upgradeWhen: string;
  flag: SimpleOnPurposeFlag;
}

/**
 * Parse one source line.
 *
 * Returns null when the line does not carry the marker. A present marker
 * always returns a record: empty text and an `upgrade when` with nothing on
 * one side are malformed, and a ceiling with no `upgrade when` is flagged.
 */
export function parseSimpleOnPurposeLine(
  line: string,
): Omit<SimpleOnPurposeMarker, "path" | "line"> | null {
  const at = line.indexOf(SIMPLE_ON_PURPOSE_PREFIX);
  if (at < 0) return null;

  const rest = line.slice(at + SIMPLE_ON_PURPOSE_PREFIX.length).trim();
  if (rest.length === 0) {
    return { ceiling: "", upgradeWhen: "", flag: "malformed" };
  }

  const upgradeAt = rest.toLowerCase().indexOf(UPGRADE_WHEN);
  if (upgradeAt < 0) {
    return {
      ceiling: rest,
      upgradeWhen: "",
      flag: "missing-upgrade-when",
    };
  }

  const ceiling = rest.slice(0, upgradeAt).replace(/[\s—–-]+$/u, "").trim();
  const upgradeWhen = rest
    .slice(upgradeAt + UPGRADE_WHEN.length)
    .replace(/^[\s:—–-]+/u, "")
    .trim();
  if (ceiling.length === 0 || upgradeWhen.length === 0) {
    return { ceiling, upgradeWhen, flag: "malformed" };
  }
  return { ceiling, upgradeWhen, flag: "ok" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readSource(path: string, rel: string): Promise<string | null> {
  let size: number;
  try {
    size = (await Deno.stat(path)).size;
  } catch (err) {
    throw new Error(`cannot scan ${rel}: ${errorMessage(err)}`);
  }
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `cannot scan ${rel}: ${size} bytes exceeds ${MAX_FILE_BYTES}`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (err) {
    throw new Error(`cannot scan ${rel}: ${errorMessage(err)}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function walk(
  dir: string,
  rel: string,
  markers: SimpleOnPurposeMarker[],
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    throw new Error(`cannot scan ${rel || "."}: ${errorMessage(err)}`);
  }
  entries.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    const childPath = `${dir}/${entry.name}`;
    if (entry.isSymlink && entry.isDirectory) continue;
    if (entry.isSymlink && !entry.isDirectory && !entry.isFile) {
      throw new Error(`cannot scan ${childRel}: dangling symlink`);
    }
    if (entry.isDirectory) {
      await walk(childPath, childRel, markers);
      continue;
    }
    if (!entry.isFile && !entry.isSymlink) continue;

    const text = await readSource(childPath, childRel);
    if (text === null) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseSimpleOnPurposeLine(lines[i]!.replace(/\r$/, ""));
      if (parsed === null) continue;
      markers.push({ path: childRel, line: i + 1, ...parsed });
    }
  }
}

/**
 * List every marker under `repoPath`.
 *
 * Markers are ordered by path, then line. A walk or read error returns
 * `{ ok: false }` and no partial list.
 */
export async function scanSimpleOnPurposeMarkers(
  repoPath: string,
): Promise<Result<SimpleOnPurposeMarker[]>> {
  const root = repoPath.replace(/\/+$/, "");
  const markers: SimpleOnPurposeMarker[] = [];
  try {
    await walk(root, "", markers);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(errorMessage(err)),
    };
  }
  markers.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.line - b.line;
  });
  return { ok: true, value: markers };
}
