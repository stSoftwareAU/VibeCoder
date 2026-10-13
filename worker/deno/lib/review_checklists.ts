/**
 * Repo-owned, path-scoped review checklists (Issue #3594).
 *
 * A target repo declares `review-checklists.json` at its root. The reviewer
 * loads it once (at the base ref, so a PR cannot weaken its own checklist),
 * and for each checklist whose path globs match the diff's changed files the
 * reviewer reports every item as met, missing or not applicable. No file, or
 * no matching path, means no checklist section at all. A file that cannot be
 * read or parsed yields a loud section: it is never silently ignored.
 *
 * @module
 */

/** Name of the checklist file at the repo root. */
export const REVIEW_CHECKLISTS_FILE = "review-checklists.json";

/**
 * A changed-file list this long or longer is treated as possibly truncated by
 * callers.
 */
export const CHECKLIST_FILE_LIST_LIMIT = 3000;

export interface ReviewChecklist {
  name: string;
  paths: string[];
  items: string[];
}
export interface ReviewChecklistConfig {
  checklists: ReviewChecklist[];
}
export type ChecklistVerdictValue = "met" | "missing" | "not applicable";
export interface ChecklistVerdict {
  checklist: string;
  item: string;
  verdict: ChecklistVerdictValue;
  note: string;
}
export type ChecklistLoad =
  | { kind: "absent" }
  | { kind: "loaded"; config: ReviewChecklistConfig }
  | { kind: "malformed"; reason: string }
  | { kind: "unreadable"; reason: string };

const VERDICTS: readonly string[] = ["met", "missing", "not applicable"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(
  value: unknown,
  where: string,
  field: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where}: "${field}" must be a non-empty array`);
  }
  value.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `${where}: "${field}[${i}]" must be a non-empty string`,
      );
    }
  });
  return value as string[];
}

/** Parse and validate the checklist file; throws a descriptive Error. */
export function parseReviewChecklists(text: string): ReviewChecklistConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${REVIEW_CHECKLISTS_FILE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(raw)) {
    throw new Error(`${REVIEW_CHECKLISTS_FILE} must be a JSON object`);
  }
  if (!Array.isArray(raw.checklists)) {
    throw new Error(
      `${REVIEW_CHECKLISTS_FILE} must have a "checklists" array`,
    );
  }
  const checklists = raw.checklists.map((c: unknown, i: number) => {
    const where = `checklists[${i}]`;
    if (!isObject(c)) throw new Error(`${where} must be an object`);
    if (typeof c.name !== "string" || c.name.trim() === "") {
      throw new Error(`${where}: "name" must be a non-empty string`);
    }
    return {
      name: c.name,
      paths: stringList(c.paths, `${where} ("${c.name}")`, "paths"),
      items: stringList(c.items, `${where} ("${c.name}")`, "items"),
    };
  });
  return { checklists };
}

type Token =
  | { t: "lit"; c: string }
  | { t: "q" }
  | { t: "star" }
  | { t: "stars" }
  | { t: "dslash" };

function tokenise(glob: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      let j = i;
      while (glob[j] === "*") j++;
      if (j - i >= 2) {
        if (glob[j] === "/") {
          out.push({ t: "dslash" });
          j++;
        } else out.push({ t: "stars" });
      } else out.push({ t: "star" });
      i = j;
    } else {
      out.push(c === "?" ? { t: "q" } : { t: "lit", c });
      i++;
    }
  }
  return out;
}

function hasUnsafeSegment(s: string): boolean {
  if (s === "" || s.startsWith("/")) return true;
  return s.split("/").some((seg) => seg === ".." || seg === "");
}

/**
 * Glob match for repo-relative paths. `**` crosses `/` (`**` followed by `/`
 * also matches zero directories), `*` does not, `?` is one non-`/` character,
 * everything else is literal and case-sensitive. Paths or globs with a `..`
 * segment, an empty segment or a leading `/` never match. Runs a pattern x
 * text dynamic programme, so hostile input cannot backtrack exponentially.
 */
export function matchesPathGlob(glob: string, path: string): boolean {
  let p = path;
  while (p.startsWith("./")) p = p.slice(2);
  if (hasUnsafeSegment(p) || hasUnsafeSegment(glob)) return false;

  const toks = tokenise(glob);
  const n = p.length;
  const on = (a: boolean[], i: number) => a[i] === true;
  let cur = new Array<boolean>(n + 1).fill(false);
  cur[0] = true;
  for (const tok of toks) {
    const next = new Array<boolean>(n + 1).fill(false);
    switch (tok.t) {
      case "lit":
        for (let j = 0; j < n; j++) next[j + 1] = on(cur, j) && p[j] === tok.c;
        break;
      case "q":
        for (let j = 0; j < n; j++) next[j + 1] = on(cur, j) && p[j] !== "/";
        break;
      case "star":
        for (let j = 0; j <= n; j++) {
          next[j] = on(cur, j) ||
            (j > 0 && on(next, j - 1) && p[j - 1] !== "/");
        }
        break;
      case "stars":
        for (let j = 0; j <= n; j++) {
          next[j] = on(cur, j) || (j > 0 && on(next, j - 1));
        }
        break;
      case "dslash": {
        let seen = false; // some cur[k] true for k < j
        for (let j = 0; j <= n; j++) {
          next[j] = on(cur, j) || (j > 0 && p[j - 1] === "/" && seen);
          seen = seen || on(cur, j);
        }
        break;
      }
    }
    cur = next;
  }
  return on(cur, n);
}

/**
 * Turn the raw file text into a load result. `readError` set means the file
 * could not be read; `null` text means it does not exist at the base.
 */
export function loadChecklistsFromText(
  text: string | null,
  readError?: string,
): ChecklistLoad {
  if (readError !== undefined) return { kind: "unreadable", reason: readError };
  if (text === null) return { kind: "absent" };
  try {
    return { kind: "loaded", config: parseReviewChecklists(text) };
  } catch (error) {
    return {
      kind: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const MAX_REASON = 300;
const MAX_MATCHED_SHOWN = 10;

/** One line, no backticks, bounded: safe inside a markdown code span. */
function inlineSafe(text: string, max = MAX_REASON): string {
  const flat = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function blockingInstruction(file: string): string {
  return `Report a BLOCKING finding on \`${file}\` (line 1) saying the checklist file could not be applied and must be fixed. This must not be treated as "no checklist".`;
}

/** Markdown the reviewer brief embeds; empty when no checklist applies. */
export function renderChecklistSection(
  load: ChecklistLoad,
  changedFiles: readonly string[] | null,
): string {
  const file = REVIEW_CHECKLISTS_FILE;
  if (load.kind === "absent") return "";
  if (load.kind === "malformed" || load.kind === "unreadable") {
    const what = load.kind === "malformed"
      ? "is malformed"
      : "could not be read";
    return [
      `### Review checklist file problem`,
      "",
      `The repo's \`${file}\` ${what}: \`${inlineSafe(load.reason)}\``,
      "",
      blockingInstruction(file),
    ].join("\n");
  }
  if (changedFiles === null) {
    return [
      `### Review checklists NOT checked`,
      "",
      `The repo declares review checklists in \`${file}\`, but the changed-file list was unavailable or truncated, so they could not be matched to this change and were NOT checked. Report a BLOCKING finding on \`${file}\` (line 1) saying the checklists were not checked; this must not be treated as "no checklist".`,
    ].join("\n");
  }
  const selected = load.config.checklists
    .map((c) => ({
      c,
      matched: changedFiles.filter((f) =>
        c.paths.some((g) => matchesPathGlob(g, f))
      ),
    }))
    .filter((s) => s.matched.length > 0);
  if (selected.length === 0) return "";

  const lines = [
    `### Review checklists for this change`,
    "",
    `The repo declares these checklists in \`${file}\` (read at the base ref). Each applies because the change touches matching files. Report EVERY item below in the reply \`checklist\` array with a verdict of \`met\`, \`missing\` or \`not applicable\` and a short note. Any item that is \`missing\` also needs a blocking entry in \`findings\`.`,
  ];
  for (const { c, matched } of selected) {
    const shown = matched.slice(0, MAX_MATCHED_SHOWN).map((f) =>
      `\`${inlineSafe(f, 200)}\``
    ).join(", ");
    const more = matched.length > MAX_MATCHED_SHOWN
      ? ` and ${matched.length - MAX_MATCHED_SHOWN} more`
      : "";
    lines.push(
      "",
      `Checklist \`${
        inlineSafe(c.name, 200)
      }\` — matched files: ${shown}${more}`,
    );
    c.items.forEach((item, i) =>
      lines.push(`${i + 1}. ${inlineSafe(item, 500)}`)
    );
  }
  return lines.join("\n");
}

/** Validate the reply's `checklist` array; throws naming the problem. */
export function parseChecklistVerdicts(value: unknown): ChecklistVerdict[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("review JSON checklist is not an array");
  }
  return value.map((raw, i) => {
    if (!isObject(raw)) {
      throw new Error(`review JSON checklist[${i}] is not an object`);
    }
    for (const key of ["checklist", "item"] as const) {
      const v = raw[key];
      if (typeof v !== "string" || v.trim() === "") {
        throw new Error(
          `review JSON checklist[${i}] lacks a non-empty "${key}"`,
        );
      }
    }
    if (typeof raw.verdict !== "string" || !VERDICTS.includes(raw.verdict)) {
      throw new Error(
        `review JSON checklist[${i}] has verdict=${
          JSON.stringify(raw.verdict)
        }; expected met, missing or not applicable`,
      );
    }
    if (raw.note !== undefined && typeof raw.note !== "string") {
      throw new Error(`review JSON checklist[${i}] has a non-string note`);
    }
    return {
      checklist: raw.checklist as string,
      item: raw.item as string,
      verdict: raw.verdict as ChecklistVerdictValue,
      note: (raw.note as string | undefined) ?? "",
    };
  });
}
