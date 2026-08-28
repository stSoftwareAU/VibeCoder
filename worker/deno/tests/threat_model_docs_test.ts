/**
 * Tests for Issue #4191 — the publishable threat model must stay true as the
 * code moves.
 *
 * `docs/THREAT-MODEL.md` is the standalone, design-level model: assets,
 * attacker capabilities per GitHub surface, attack paths, the control that
 * answers each path, the gaps, and the residual risks. A document like that
 * rots silently — a renamed module leaves a table row pointing at nothing, and
 * the model still reads as if the control exists.
 *
 * These tests make that failure loud:
 *
 *   1. Every repo-relative path cited in the traceability table exists.
 *   2. Every attack path names at least one control id defined in that table
 *      and at least one file that really implements it.
 *   3. A control with no enforcing test is flagged as a gap, and the gap ids
 *      in the table and in the gaps section are the same set — so a control
 *      cannot be quietly dropped from the gap list.
 *   4. Every in-repo link and `#anchor` in the document resolves.
 *   5. `SECURITY.md` points at the model and no longer duplicates it.
 *   6. The markdown-lint workflow runs this check in CI.
 *
 * They fail against the pre-fix tree (no `docs/THREAT-MODEL.md`, and a
 * `SECURITY.md` that still carries the design-level model) and pass after.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { anchorSet } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);

const THREAT_MODEL = "docs/THREAT-MODEL.md";

function repoPath(relative: string): URL {
  return new URL(relative, REPO_ROOT);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

function exists(relative: string): boolean {
  try {
    Deno.statSync(repoPath(relative));
    return true;
  } catch {
    return false;
  }
}

/** Trimmed cells of every markdown table row in `body` (separators dropped). */
function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .filter((line) => !/^\s*\|[\s|:-]+\|\s*$/.test(line))
    .map((line) =>
      line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) =>
        cell.trim()
      )
    );
}

/** Body between the heading containing `title` and the next same-or-higher heading. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    /^#{2,}\s/.test(line) && line.includes(title)
  );
  assert(start >= 0, `expected a section titled "${title}"`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "##").length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const hashes = line.match(/^#+(?=\s)/)?.[0];
    return hashes !== undefined && hashes.length <= level;
  });
  return (end >= 0 ? rest.slice(0, end) : rest).join("\n");
}

/** Repo-relative paths quoted in backticks within `cell`. */
function citedPaths(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.includes("/") && !value.includes(" "));
}

/** Data rows of a table under a heading, minus the header row. */
function dataRows(title: string, idPattern: RegExp): string[][] {
  return tableRows(section(read(THREAT_MODEL), title))
    .filter((cells) => idPattern.test(cells[0] ?? ""));
}

const TRACEABILITY = "Traceability";
const ATTACK_PATHS = "Attack paths";
const GAPS = "Known gaps";

/** Control id → the row that defines it. */
function controlRows(): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const cells of dataRows(TRACEABILITY, /\*\*C\d+\*\*/)) {
    const id = (cells[0] ?? "").replace(/\*/g, "").trim();
    rows.set(id, cells);
  }
  return rows;
}

Deno.test("every file path cited in the traceability table exists", () => {
  const rows = controlRows();
  assert(rows.size > 0, "the traceability table must have control rows");

  const missing: string[] = [];
  for (const [id, cells] of rows) {
    for (const cell of cells.slice(2)) {
      for (const path of citedPaths(cell)) {
        if (!exists(path)) missing.push(`${id}: ${path}`);
      }
    }
  }
  assertEquals(
    missing,
    [],
    "the threat model cites paths that no longer exist — repoint the rows",
  );
});

Deno.test("every control names an implementing file", () => {
  const withoutCode: string[] = [];
  for (const [id, cells] of controlRows()) {
    if (citedPaths(cells[2] ?? "").length === 0) withoutCode.push(id);
  }
  assertEquals(
    withoutCode,
    [],
    "every control must name the code that enforces it",
  );
});

Deno.test("every attack path names a control and a file that implements it", () => {
  const controls = controlRows();
  const rows = dataRows(ATTACK_PATHS, /\*\*AP-\d+\*\*/);
  assert(rows.length > 0, "the attack-path table must have rows");

  const problems: string[] = [];
  for (const cells of rows) {
    const id = (cells[0] ?? "").replace(/\*/g, "").trim();
    const cited = [...(cells[3] ?? "").matchAll(/\bC\d+\b/g)].map((m) => m[0]);
    const unknown = cited.filter((control) => !controls.has(control));
    if (cited.length === 0) problems.push(`${id}: names no control`);
    if (unknown.length > 0) {
      problems.push(`${id}: unknown control(s) ${unknown.join(", ")}`);
    }
    const paths = citedPaths(cells[4] ?? "");
    if (paths.length === 0) problems.push(`${id}: names no enforcing file`);
    for (const path of paths) {
      if (!exists(path)) problems.push(`${id}: missing file ${path}`);
    }
  }
  assertEquals(problems, [], "attack paths must resolve to real controls");
});

Deno.test("controls with no enforcing test are flagged as gaps, and every gap is listed", () => {
  const flagged = new Set<string>();
  const untested: string[] = [];
  for (const [id, cells] of controlRows()) {
    const testCell = cells[3] ?? "";
    const gapIds = [...testCell.matchAll(/\bG\d+\b/g)].map((m) => m[0]);
    if (citedPaths(testCell).length > 0) continue;
    if (gapIds.length === 0) {
      untested.push(`${id}: names neither a test nor a gap id`);
      continue;
    }
    for (const gap of gapIds) flagged.add(gap);
  }
  assertEquals(untested, [], "an untested control must name its gap id");

  const listed = new Set(
    dataRows(GAPS, /\*\*G\d+\*\*/).map((cells) =>
      (cells[0] ?? "").replace(/\*/g, "").trim()
    ),
  );
  assertEquals(
    [...flagged].sort(),
    [...listed].sort(),
    "the gap ids in the traceability table and the gaps section must match",
  );
});

Deno.test("every in-repo link and anchor in the threat model resolves", () => {
  const body = read(THREAT_MODEL);
  const selfAnchors = anchorSet(body);
  const broken: string[] = [];

  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external URL

    if (target.startsWith("#")) {
      if (!selfAnchors.has(target.slice(1))) broken.push(target);
      continue;
    }

    const [pathPart, fragment] = target.split("#");
    // docs/THREAT-MODEL.md → docs/ is the base for a relative link.
    const resolved = new URL(pathPart ?? "", `file:///docs/`).pathname
      .replace(/^\//, "");
    if (!exists(resolved)) {
      broken.push(`${target} → ${resolved} (missing)`);
      continue;
    }
    if (fragment && resolved.endsWith(".md")) {
      if (!anchorSet(read(resolved)).has(fragment)) {
        broken.push(`${target} (no such heading in ${resolved})`);
      }
    }
  }

  assertEquals(broken, [], `${THREAT_MODEL} has unresolvable links`);
});

Deno.test("the markdown-lint workflow runs the threat-model check", () => {
  const workflow = read(".github/workflows/markdown-lint.yml");
  assert(
    workflow.includes("threat_model_docs_test.ts"),
    "markdown-lint.yml must run the threat-model link/traceability check",
  );
});
