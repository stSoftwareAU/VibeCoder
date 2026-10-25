/**
 * Repo-owned, path-scoped review checklists (Issue #3594).
 *
 * A target repo declares `review-checklists.json` at its root. The reviewer
 * loads it at the base ref (so a PR cannot weaken its own checklist; a change
 * that edits the file is also parsed at its head, see
 * {@link effectiveChecklistLoad}), and for each checklist whose path globs match the diff's changed files the
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
// `headCopy` marks a load taken from the change's own copy of the file, not
// the base ref's (see effectiveChecklistLoad).
export type ChecklistLoad =
  | { kind: "absent" }
  | { kind: "loaded"; config: ReviewChecklistConfig; headCopy?: true }
  | { kind: "malformed"; reason: string; headCopy?: true }
  // Read, but unusable (an undecodable reply): a persistent problem the
  // reviewer must report.
  | { kind: "unreadable"; reason: string; headCopy?: true }
  // The fetch itself failed (a timeout, HTTP 5xx, rate limit): possibly
  // transient and says nothing about the file, so callers retry or skip the
  // check rather than hand it to a reviewer as a finding.
  | { kind: "fetch_failed"; reason: string };

/** A checklist item the reviewer was asked to report, as rendered. */
export interface ChecklistExpectation {
  checklist: string;
  item: string;
}
/**
 * What the code (not the model) knows about a checklist load: the problem
 * that stops the checklist being applied, and the items the brief asked a
 * verdict for. Carried beside the rendered section so a reply that ignores
 * the section cannot turn the review into an approval.
 */
export interface ChecklistState {
  problem: string | null;
  expected: ChecklistExpectation[];
}

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
    const label = `${where} ("${c.name}")`;
    const paths = stringList(c.paths, label, "paths");
    paths.forEach((glob, j) => {
      if (hasUnsafeSegment(stripDotSlash(glob))) {
        throw new Error(
          `${label}: "paths[${j}]" ${
            JSON.stringify(glob)
          } can never match: a path glob must be repo-relative, with no leading "/", empty segment, trailing "/" or ".." segment`,
        );
      }
    });
    return {
      name: c.name,
      paths,
      items: stringList(c.items, label, "items"),
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

function stripDotSlash(s: string): string {
  let out = s;
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

function hasUnsafeSegment(s: string): boolean {
  if (s === "" || s.startsWith("/")) return true;
  return s.split("/").some((seg) => seg === ".." || seg === "");
}

/**
 * Glob match for repo-relative paths. `**` crosses `/` (`**` followed by `/`
 * also matches zero directories), `*` does not, `?` is one non-`/` character,
 * everything else is literal and case-sensitive. A leading `./` is dropped
 * from both. Paths or globs with a `..` segment, an empty segment or a
 * leading `/` never match. Runs a pattern x
 * text dynamic programme, so hostile input cannot backtrack exponentially.
 */
export function matchesPathGlob(glob: string, path: string): boolean {
  const p = stripDotSlash(path);
  const g = stripDotSlash(glob);
  if (hasUnsafeSegment(p) || hasUnsafeSegment(g)) return false;

  const toks = tokenise(g);
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
 * could not be read; `null` text means it does not exist at that ref.
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
export function inlineSafe(text: string, max = MAX_REASON): string {
  const flat = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function blockingInstruction(file: string): string {
  return `Report a BLOCKING finding on \`${file}\` (line 1) saying the checklist file could not be applied and must be fixed. This must not be treated as "no checklist".`;
}

const NAME_MAX = 200;
const ITEM_MAX = 500;

/** How the file is named in a problem: the change's copy, or the base's. */
function fileLabel(load: ChecklistLoad): string {
  const file = `\`${REVIEW_CHECKLISTS_FILE}\``;
  return "headCopy" in load && load.headCopy
    ? `${file} as changed by this PR`
    : file;
}

function loadProblem(load: ChecklistLoad): string | null {
  switch (load.kind) {
    case "malformed":
      return `${fileLabel(load)} is malformed: ${inlineSafe(load.reason)}`;
    case "unreadable":
    case "fetch_failed":
      return `${fileLabel(load)} could not be read: ${inlineSafe(load.reason)}`;
    default:
      return null;
  }
}

/** The ChecklistLoad kinds that stop the checklist being applied. */
function isBroken(load: ChecklistLoad): boolean {
  return load.kind === "malformed" || load.kind === "unreadable";
}

/**
 * Whether the change's own copy of the checklist file must also be read: the
 * file is among the changed paths, or the list is unknown (null) so it may be.
 */
export function mustReadHeadChecklists(
  changedFiles: readonly string[] | null,
): boolean {
  return changedFiles === null || changedFiles.includes(REVIEW_CHECKLISTS_FILE);
}

/**
 * Combine the base ref's load with the change's own copy (`head`, null when
 * the change does not touch the file). The base copy governs, so a change
 * cannot weaken its own checklist, with two exceptions that keep a broken
 * file from stranding a repo:
 *
 * - the change's copy is broken: that is the result, so a change that adds or
 *   leaves a malformed file is sent back and cannot merge it;
 * - the base copy is broken and the change's copy is usable (or removes the
 *   file): the change is the repair, so it is judged on its own copy and not
 *   blocked by the base problem.
 *
 * A failed fetch of either copy is returned as is, for the caller to retry.
 */
export function effectiveChecklistLoad(
  base: ChecklistLoad,
  head: ChecklistLoad | null,
): ChecklistLoad {
  if (base.kind === "fetch_failed") return base;
  if (head === null) return base;
  if (head.kind === "fetch_failed") return head;
  if (head.kind === "malformed" || head.kind === "unreadable") {
    return { ...head, headCopy: true };
  }
  if (isBroken(base)) {
    return head.kind === "loaded" ? { ...head, headCopy: true } : head;
  }
  return base;
}

/** The checklists with at least one changed file matching their paths. */
function selectChecklists(
  config: ReviewChecklistConfig,
  changedFiles: readonly string[],
) {
  return config.checklists
    .map((c) => ({
      c,
      matched: changedFiles.filter((f) =>
        c.paths.some((g) => matchesPathGlob(g, f))
      ),
    }))
    .filter((s) => s.matched.length > 0);
}

/**
 * The problem and expected items for a load, as the brief renders them. A
 * load that cannot be applied (malformed, unreadable, a changed-file list
 * that is null) always carries a problem; only an absent file or a diff that
 * touches no listed path carries neither a problem nor items.
 */
export function checklistState(
  load: ChecklistLoad,
  changedFiles: readonly string[] | null,
): ChecklistState {
  const problem = loadProblem(load);
  if (problem !== null) return { problem, expected: [] };
  if (load.kind !== "loaded") return { problem: null, expected: [] };
  if (changedFiles === null) {
    return {
      problem:
        `the changed-file list was unavailable or truncated, so the checklists in \`${REVIEW_CHECKLISTS_FILE}\` could not be matched to this change and were NOT checked`,
      expected: [],
    };
  }
  return {
    problem: null,
    expected: selectChecklists(load.config, changedFiles).flatMap(({ c }) =>
      c.items.map((item) => ({
        checklist: inlineSafe(c.name, NAME_MAX),
        item: inlineSafe(item, ITEM_MAX),
      }))
    ),
  };
}

/** Markdown the reviewer brief embeds; empty when no checklist applies. */
export function renderChecklistSection(
  load: ChecklistLoad,
  changedFiles: readonly string[] | null,
): string {
  const file = REVIEW_CHECKLISTS_FILE;
  if (load.kind === "absent") return "";
  if (
    load.kind === "malformed" || load.kind === "unreadable" ||
    load.kind === "fetch_failed"
  ) {
    const what = load.kind === "malformed"
      ? "is malformed"
      : "could not be read";
    return [
      `### Review checklist file problem`,
      "",
      `The repo's ${fileLabel(load)} ${what}: \`${inlineSafe(load.reason)}\``,
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
  const selected = selectChecklists(load.config, changedFiles);
  if (selected.length === 0) return "";

  const source = load.headCopy
    ? "the change's own copy, because the base ref's copy is unusable"
    : "read at the base ref";
  const lines = [
    `### Review checklists for this change`,
    "",
    `The repo declares these checklists in \`${file}\` (${source}). Each applies because the change touches matching files. Report EVERY item below in the reply \`checklist\` array with a verdict of \`met\`, \`missing\` or \`not applicable\` and a short note, copying the checklist name and the item text exactly as written here. Any item that is \`missing\` also needs a blocking entry in \`findings\`. The worker checks that every item got a verdict; an item with none sends the change back.`,
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
        inlineSafe(c.name, NAME_MAX)
      }\` — matched files: ${shown}${more}`,
    );
    c.items.forEach((item, i) =>
      lines.push(`${i + 1}. ${inlineSafe(item, ITEM_MAX)}`)
    );
  }
  return lines.join("\n");
}

/** A blocking finding the worker adds itself. */
export interface ChecklistGapFinding {
  file: string;
  line: number;
  problem: string;
  fix: string;
}

const MAX_GAPS_NAMED = 5;

/** Untrusted text on one line, with mentions and HTML neutralised. */
export function gapText(text: string, max: number): string {
  return inlineSafe(text, max).replace(
    /[<>@]/g,
    (c) => c === "@" ? "@\u200b" : " ",
  );
}

/** Same item, ignoring case, spacing, backticks and a leading "1." number. */
function verdictKey(checklist: string, item: string): string {
  return `${normaliseVerdictText(checklist)}\u0000${
    normaliseVerdictText(item).replace(/^\d+[.)] /, "")
  }`;
}

/** Collapse whitespace, turn backticks into quotes, trim and lower-case. */
export function normaliseVerdictText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/`/g, "'").trim().toLowerCase();
}

/**
 * Blocking findings for a checklist that was not applied, decided by the code
 * and not the model: a load problem, and every item the brief asked a verdict
 * for that the reply left out. Empty only when the checklist was applied in
 * full or none applied. "No verdict" is never read as a pass.
 */
export function checklistGapFindings(
  state: ChecklistState,
  verdicts: readonly ChecklistVerdict[],
): ChecklistGapFinding[] {
  const out: ChecklistGapFinding[] = [];
  if (state.problem !== null) {
    out.push({
      file: REVIEW_CHECKLISTS_FILE,
      line: 1,
      problem: `Repository review checklists were not applied: ${
        gapText(state.problem, 600)
      }.`,
      fix:
        `Repair \`${REVIEW_CHECKLISTS_FILE}\` in this change, or reduce the change so its file list is complete. The base ref's copy governs, except that a change which edits the file is judged on its own copy when the base copy is unusable, so a repair can be reviewed and merged.`,
    });
  }
  const reported = new Set(
    verdicts.map((v) => verdictKey(v.checklist, v.item)),
  );
  const unreported = state.expected.filter((e) =>
    !reported.has(verdictKey(e.checklist, e.item))
  );
  if (unreported.length > 0) {
    const named = unreported.slice(0, MAX_GAPS_NAMED).map((e) =>
      `"${gapText(e.checklist, NAME_MAX)}" — "${gapText(e.item, ITEM_MAX)}"`
    ).join("; ");
    const more = unreported.length > MAX_GAPS_NAMED
      ? `; and ${unreported.length - MAX_GAPS_NAMED} more`
      : "";
    out.push({
      file: REVIEW_CHECKLISTS_FILE,
      line: 1,
      problem:
        `Repository review checklists: no verdict was reported for ${unreported.length} of ${state.expected.length} checklist item(s), so they were not checked: ${named}${more}.`,
      fix:
        `Report each of these items as met, missing or not applicable, with the checklist name and item text as listed.`,
    });
  }
  return out;
}

/**
 * Read the reply's `checklist` array, keeping every entry that is usable.
 * Never throws: a non-array value and a malformed entry are dropped. A dropped
 * entry's item then falls into the unchanged `checklistGapFindings` "no verdict
 * was reported ... so they were not checked" finding, which blocks, so a
 * dropped verdict is never read as a pass. Verdicts are matched after trim and
 * lower-casing.
 */
export function parseChecklistVerdicts(value: unknown): ChecklistVerdict[] {
  if (!Array.isArray(value)) return [];
  const out: ChecklistVerdict[] = [];
  for (const raw of value as unknown[]) {
    if (!isObject(raw)) continue;
    const { checklist, item, verdict, note } = raw;
    if (typeof checklist !== "string" || checklist.trim() === "") continue;
    if (typeof item !== "string" || item.trim() === "") continue;
    if (typeof verdict !== "string") continue;
    const normalised = verdict.trim().toLowerCase();
    if (!VERDICTS.includes(normalised)) continue;
    if (note !== undefined && typeof note !== "string") continue;
    out.push({
      checklist,
      item,
      verdict: normalised as ChecklistVerdictValue,
      note: note ?? "",
    });
  }
  return out;
}
