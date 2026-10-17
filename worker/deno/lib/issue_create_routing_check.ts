/**
 * Quality gate check: every direct `gh issue create` argv call site (and every
 * `gh api` REST or GraphQL issue creation) must be on a reasoned allowlist
 * (Issue #3746).
 *
 * Every new issue should be filed through the routed filing chokepoint
 * `fileRoutedIssue` in `worker/deno/lib/issue_routing_filing.ts` (Issue
 * #3743), which picks the repository that owns the issue, de-duplicates
 * against it, and only then files. A call site that builds the
 * `"issue", "create"` argv itself skips that routing, so a new direct call
 * site must either use `fileRoutedIssue` or be added to
 * {@link ISSUE_CREATE_ROUTING_ALLOWLIST} with a one-line reason. The real-tree
 * scan in `worker/deno/tests/issue_create_routing_check_test.ts` enforces
 * this, and fails closed: an empty or missing scan is an error, never a pass.
 *
 * Like the issue-create label guard (Issue #1276), this is an architectural,
 * whole-codebase invariant, so the scanning functions are pure and exported
 * for behavioural tests against literal inputs. Migrating an existing call
 * site is a separate change; this check only stops new ones appearing
 * unreviewed.
 *
 * Detection is textual and deliberately simple. A line is a candidate when it
 * holds an `"issue",` or `'issue',` argv element, and the verb that follows
 * (inline after it, or on a later line within a few lines) is `create` or its
 * gh alias `new`. gh also accepts the persistent `-R`/`--repo` flag between
 * `issue` and the verb, so a `-R <repo>`, `--repo <repo>`, `-R<repo>` or
 * `--repo=<repo>` argument is skipped when looking for the verb, whether it is
 * written as a string literal or as a template literal (`` `--repo=${repo}` ``,
 * `` `-R${repo}` ``). The `"issue"` literal followed by `||` (a comparison,
 * not an argv element) is therefore not a candidate.
 *
 * The same issue is created by `gh api`, so an `"api",` argv is also a
 * candidate when it (a) has an endpoint ending in `/issues` and POSTs to it,
 * either with `-X POST`/`--method POST` or, absent an explicit method, with a
 * body flag (`-f`, `-F`, `--field`, `--raw-field`, `--input`), as gh then
 * defaults to POST; or (b) is a `gh api graphql` call in a file that names the
 * `createIssue` mutation. A plain GET list, `/issues/<n>/comments` and
 * `search/issues` are not creates.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { normaliseGhArgs } from "./gh_flag_parser.ts";

/** A single direct `gh issue create` call site found during scanning. */
export interface IssueCreateRoutingViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the `"issue"` (or `"api"`) argv element. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface IssueCreateRoutingCheckResult {
  violations: IssueCreateRoutingViolation[];
  /** Files actually scanned. Allowlisted files are skipped and not counted. */
  filesScanned: number;
}

/**
 * Files permitted to build a `gh issue create` argv directly, each with the
 * one-line reason it does so.
 */
export const ISSUE_CREATE_ROUTING_ALLOWLIST: ReadonlyMap<string, string> =
  new Map<string, string>([
    [
      "worker/deno/commands/maybe_file_idle_task.ts",
      "#1963 idle-task filer CLI; files into the picked monitored repo (targetRepo) with guarded labels; not yet routed",
    ],
    [
      "worker/deno/lib/alert_feeds/alert_feed_enable_issue.ts",
      "#3396 feed-unavailable enable/authorise issue, filed in the monitored repo it describes; not yet routed",
    ],
    [
      "worker/deno/lib/audit_failure_notifier.ts",
      "#2691 dependency-audit failure issue, filed in the monitored repo whose deno.lock advisory it reports; not yet routed",
    ],
    [
      "worker/deno/lib/baseline_carryover_tracker.ts",
      "#2605 deduplicated baseline-carryover tracking issue, filed in the repo whose baseline carried the findings; not yet routed",
    ],
    [
      "worker/deno/lib/bump_script_failure_streak.ts",
      "#207 bump-deps.sh rejection-streak issue, filed in the monitored repo whose bump script keeps failing; not yet routed",
    ],
    [
      "worker/deno/lib/create_all_idle_task_wrappers.ts",
      "#2577 seeds the standard idle-task wrapper issues into a freshly monitored repo; repo-scoped template filing; not yet routed",
    ],
    [
      "worker/deno/lib/degraded_delivery.ts",
      "#2562 degraded-run delivery issue, filed in the repo the run was delivering to; not yet routed",
    ],
    [
      "worker/deno/lib/idle_inversion_streak.ts",
      "#321/#459 idle-inversion escalation, filed in the worker's own repo by design (IDLE_INVERSION_TARGET_REPO); fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/idle_starvation_escalation.ts",
      "#1052/#459 idle-capacity escalation, filed in the worker's own repo by design; fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/alert_feed_template.ts",
      "#3394 alert-feed idle-task template; files a repo-scoped idle task into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/bash_script_refs_template.ts",
      "#3228 bash script-reference idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/bash_syntax_audit_template.ts",
      "#3238 bash syntax-audit idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/best_practices_template.ts",
      "#2148 best-practices idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/gate_skip_drift_template.ts",
      "#1597 gate-skip drift idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/github_actions_audit_template.ts",
      "#2256 GitHub Actions audit idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/idle_task_templates/workflow_annotation_scan_template.ts",
      "#3488 workflow-run annotation-scan idle-task template; files into the scanned repository; not yet routed",
    ],
    [
      "worker/deno/lib/issue_routing_filing.ts",
      "the routed filing chokepoint itself (#3743); the direct call here is the one fileRoutedIssue makes",
    ],
    [
      "worker/deno/lib/merge_fallback_issue.ts",
      "#2304 merge-fallback flag issue, filed in the repo whose conflict fallback left it behind; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_branch_self_heal.ts",
      "#3912 self-heal diagnostic for milestone branches deleted under open children, filed in the milestone's repo; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_completion.ts",
      "milestone completion tracking issue, filed in the milestone's repo; not yet routed",
    ],
    [
      "worker/deno/lib/milestone_gate_wedge.ts",
      "#2388 wedged milestone-sync gate diagnostic, filed in the worker's own repo by design (GATE_WEDGE_DIAGNOSTIC_REPO); not yet routed",
    ],
    [
      "worker/deno/lib/planning_carrier.ts",
      "#2995 zero-sub-issue planning carrier safety net, filed in the planning repo; not yet routed",
    ],
    [
      "worker/deno/lib/pr_branch_update_failure_streak.ts",
      "#335 PR branch-update failure-streak issue, filed in the repo whose branch failed to update; not yet routed",
    ],
    [
      "worker/deno/lib/provider_outage_alert.ts",
      "#2613 provider-outage alert, filed in the worker's own repo by design (PROVIDER_OUTAGE_TARGET_REPO); fleet-health diagnostic; not yet routed",
    ],
    [
      "worker/deno/lib/references_refresh.ts",
      "#665 references refresh sweep issue, filed in the swept repository (slug); not yet routed",
    ],
    [
      "worker/deno/lib/repo_fast_failure_issue.ts",
      "#2956/#2592 fleet-wide fast-failure tally must stay in the monitored repository it describes; not yet routed",
    ],
    [
      "worker/deno/lib/run_failure_issue.ts",
      "#4329 worker-fault run-failure issue, filed in the worker's own repo by default (RUN_FAILURE_TARGET_REPO); not yet routed",
    ],
    [
      "worker/deno/lib/runner_deprecation_filer.ts",
      "#2256 runner-deprecation finding issue, filed in the monitored repo whose workflows are deprecated; not yet routed",
    ],
    [
      "worker/deno/lib/security_tree_sweep.ts",
      "#4193 whole-tree security sweep finding issue, filed in the swept repository (slug); not yet routed",
    ],
    [
      "worker/deno/lib/workflow_scan_common.ts",
      "#2500 shared workflow-scan scaffolding for github-actions-audit pre-filers; files into the scanned repo; not yet routed",
    ],
  ]);

/**
 * How many lines below the `"issue",` element the scanner looks for the verb
 * when it is not inline. Argv arrays put the verb on the very next element, so
 * the window only has to cover a blank line or two plus a `--repo <repo>`
 * pair split across lines, without reaching into an unrelated statement.
 */
const VERB_LOOKAHEAD_LINES = 8;

/** The verbs gh runs as `issue create`: the command and its alias `new`. */
const ISSUE_CREATE_VERBS: ReadonlySet<string> = new Set(["create", "new"]);

/** A repo flag whose value is the next argv element: `-R repo`, `--repo repo`. */
const REPO_FLAG_WITH_VALUE_PATTERN = /^(?:-R|--repo)$/;

/** A repo flag carrying its value: `-Rowner/repo`, `--repo=owner/repo`. */
const REPO_FLAG_INLINE_PATTERN = /^(?:-R.|--repo=)/;

/** Matches an `"issue",` / `'issue',` argv element. Group 1 is the quote. */
const ISSUE_ELEMENT_PATTERN = /(["'`])issue\1\s*,/g;

/** Matches an `"api",` / `'api',` argv element. Group 1 is the quote. */
const API_ELEMENT_PATTERN = /(["'`])api\1\s*,/g;

/** Matches a quoted string literal that opens an argv entry, capturing its text. */
const LEADING_LITERAL_PATTERN = /^["']([^"'\n]*)["']/;

/**
 * The static text before the first `${` of a template-literal element that is
 * an inline repo flag: `` `-R${repo}` `` or `` `--repo=${repo}` ``.
 */
const INTERPOLATED_REPO_FLAG_PATTERN = /^(?:-R|--repo=)/;

/** How many lines below an `"api",` element the scanner reads its argv. */
const API_ARGV_LOOKAHEAD_LINES = 40;

/** The most argv elements read after `"api",` — a ceiling, not a target. */
const API_ARGV_MAX_ELEMENTS = 60;

/**
 * A REST endpoint that creates an issue when posted to: it ends in `/issues`,
 * with an optional trailing slash or query string. The quote closing the
 * literal is stripped first, so a concatenation ending in `"/issues"` matches.
 * `search/issues` is a search, never a create.
 */
const ISSUES_ENDPOINT_PATTERN = /(?<!search)\/issues\/?(?:\?[^"'`]*)?$/;

/** A `key=value` field argument: never an endpoint, whatever it ends with. */
const FIELD_ASSIGNMENT_PATTERN = /^["'`][\w.-]+=/;

/** A `gh api` flag that sends a request body, so gh defaults to POST. */
const API_FIELD_FLAG_PATTERN =
  /^(?:-[fF].*|--field(?:=.*)?|--raw-field(?:=.*)?|--input(?:=.*)?)$/;

/**
 * A `gh api` long method flag with its value inline: `--method=POST`. The
 * shorthand spellings (`-XPOST`, `-X=POST`) are expanded to `-X POST` by
 * `normaliseGhArgs` before this is read.
 */
const API_METHOD_INLINE_PATTERN = /^--method=(.*)$/;

/** Stands in for a non-literal argv element while `normaliseGhArgs` runs. */
const NON_LITERAL_ELEMENT = "\0non-literal";

/**
 * `gh api` flags whose next argv element is a value that can never be a body
 * flag, so a non-literal there (`"-H", header`) is not a possible `-f`.
 */
const API_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-H",
  "--header",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-p",
  "--preview",
  "--hostname",
  "--cache",
]);

/** A GraphQL mutation name that creates an issue. */
const CREATE_ISSUE_MUTATION_PATTERN = /\bcreateIssue\b/;

/**
 * Keywords after which a `/` opens a regular-expression literal rather than
 * dividing. After any other word, a number, a literal or a closing bracket it
 * is a division.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Matches one identifier or number character. */
const WORD_CHAR_PATTERN = /[\w$]/;

/**
 * Blank every comment, keeping string, template and regular-expression
 * literals as-is. Each comment character becomes a space except newlines, so
 * line numbers stay aligned with the raw source.
 *
 * A single left-to-right scan, so a comment marker inside a literal (such as
 * `"/*"`, `"https://x"` or `milestone/*` in a template) never opens a
 * comment:
 *
 * - `"…"` and `'…'` literals, with backslash escapes, end at their closing
 *   quote or at end of line, so an unterminated quote does not swallow the
 *   lines below it.
 * - Template literals may span lines. Code inside a `${…}` interpolation is
 *   scanned as code, nesting included, so a backtick or comment there is read
 *   as such and the template resumes at the matching `}`.
 * - A `/` where an operand is expected opens a regular-expression literal, so
 *   a quote or backtick inside one does not open a string.
 * - `//` runs to the end of the line; a block comment (slash-star to
 *   star-slash) may span lines.
 */
function stripComments(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** Brace depth at which each open `${…}` interpolation closes. */
  const interpolations: number[] = [];
  let braceDepth = 0;
  /** The previous token: a keyword, or "value" / a punctuator character. */
  let previous = "";
  let i = 0;

  /** Skip a template body from `i`; returns true when `${` opened code. */
  const skipTemplateBody = (): boolean => {
    while (i < source.length) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        i++;
        return false;
      } else if (c === "$" && source[i + 1] === "{") {
        i += 2;
        return true;
      } else {
        i++;
      }
    }
    return false;
  };

  /** Enter a template body at `i`, opening an interpolation when it hits one. */
  const scanTemplate = (): void => {
    if (skipTemplateBody()) {
      interpolations.push(braceDepth);
      braceDepth++;
      previous = "{";
    } else {
      previous = "value";
    }
  };

  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        i += source[i] === "\\" ? 2 : 1;
      }
      if (source[i] === c) i++;
      previous = "value";
    } else if (c === "`") {
      i++;
      scanTemplate();
    } else if (c === "/") {
      const opensRegex = previous === "" ||
        REGEX_PRECEDING_KEYWORDS.has(previous) ||
        (previous.length === 1 && !")]}".includes(previous));
      i++;
      if (opensRegex) {
        let inClass = false;
        while (i < source.length && source[i] !== "\n") {
          const r = source[i];
          if (r === "\\") {
            i += 2;
            continue;
          }
          i++;
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
        }
        previous = "value";
      } else {
        previous = "/";
      }
    } else if (WORD_CHAR_PATTERN.test(c)) {
      const start = i;
      while (i < source.length && WORD_CHAR_PATTERN.test(source[i] ?? "")) i++;
      const word = source.slice(start, i);
      previous = REGEX_PRECEDING_KEYWORDS.has(word) ? word : "value";
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "}" && interpolations.at(-1) === braceDepth - 1) {
      interpolations.pop();
      braceDepth--;
      i++;
      scanTemplate();
    } else {
      if (c === "{") braceDepth++;
      else if (c === "}") braceDepth--;
      previous = c;
      i++;
    }
  }

  return out.join("");
}

/**
 * Index just past the template literal whose body starts at `from` (the index
 * after the opening backtick). Code inside a `${…}` interpolation is skipped
 * with its own strings and templates, so a nested backtick does not end the
 * outer template early. Returns `text.length` when the template is unterminated.
 */
function indexAfterTemplate(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (c === "`") {
      return i + 1;
    } else if (c === "$" && text[i + 1] === "{") {
      i = indexAfterInterpolation(text, i + 2);
    } else {
      i++;
    }
  }
  return text.length;
}

/** Index just past the `}` closing an interpolation whose code starts at `from`. */
function indexAfterInterpolation(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      i = indexAfterTemplate(text, i + 1);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/**
 * Index just past the first top-level comma at or after `from`, skipping
 * string, template and bracketed content. Returns `text.length` when the
 * argv array ends first, so there is no further element.
 */
function indexAfterElement(text: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      i = indexAfterTemplate(text, i + 1) - 1;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.length;
      depth--;
    } else if (c === "," && depth === 0) {
      return i + 1;
    }
    i++;
  }
  return text.length;
}

/** The leading argv element of some text: its static text and where it ends. */
interface LeadingElement {
  /** The literal's text; for an interpolated template, the text before `${`. */
  value: string;
  /** True for a template literal holding a `${…}` interpolation. */
  interpolated: boolean;
  /** Index just past the element's closing quote. */
  end: number;
}

/**
 * Read the string or template literal that opens `text` at or after `from`.
 * Returns `null` when the next element is not a literal (an identifier, a
 * spread, a call).
 */
function leadingElement(text: string, from: number): LeadingElement | null {
  let start = from;
  while (start < text.length && /\s/.test(text[start] ?? "")) start++;
  if (text[start] === "`") {
    const end = indexAfterTemplate(text, start + 1);
    const body = text.slice(start + 1, end - 1);
    const interpolation = body.indexOf("${");
    return interpolation === -1
      ? { value: body, interpolated: false, end }
      : { value: body.slice(0, interpolation), interpolated: true, end };
  }
  const literal = LEADING_LITERAL_PATTERN.exec(text.slice(start));
  if (literal === null) return null;
  return {
    value: literal[1] ?? "",
    interpolated: false,
    end: start + literal[0].length,
  };
}

/**
 * Resolve the verb that follows an `"issue",` element.
 *
 * The verb is the string literal that opens the rest of the same line (the
 * inline form, `["issue", "create", …]`), otherwise the literal that opens a
 * later line within {@link VERB_LOOKAHEAD_LINES}. A `-R`/`--repo` flag (and
 * its value element) between `issue` and the verb is skipped, as gh accepts
 * it there, including a template-literal flag such as `` `--repo=${repo}` ``
 * or `` `-R${repo}` ``. An interpolation-free template literal reads as the
 * string it holds. Returns `null` when the next element is not a literal.
 *
 * @param lines - Comment-stripped source lines.
 * @param index - Zero-based index of the line holding the `"issue",` element.
 * @param rest - The text on that line after the `"issue",` element.
 */
function verbAfterIssueElement(
  lines: readonly string[],
  index: number,
  rest: string,
): string | null {
  const window = lines.slice(index + 1, index + 1 + VERB_LOOKAHEAD_LINES);
  const text = [rest, ...window].join("\n");
  let pos = 0;
  // A repo flag is at most one flag, so two skips is a generous ceiling.
  for (let skipped = 0; skipped < 3; skipped++) {
    const element = leadingElement(text, pos);
    if (element === null) return null;
    const { value, interpolated, end } = element;
    if (interpolated) {
      // Only an inline repo flag has a static prefix we can read; a verb
      // built by interpolation is unknowable, so it is not a candidate.
      if (!INTERPOLATED_REPO_FLAG_PATTERN.test(value)) return null;
      pos = indexAfterElement(text, end);
    } else if (REPO_FLAG_WITH_VALUE_PATTERN.test(value)) {
      pos = indexAfterElement(text, indexAfterElement(text, end));
    } else if (REPO_FLAG_INLINE_PATTERN.test(value)) {
      pos = indexAfterElement(text, end);
    } else {
      return value;
    }
  }
  return null;
}

/**
 * Split the argv array that starts at `text` (just after its `"api",`
 * element) into raw element texts, stopping at the array's closing bracket.
 */
function splitArgvElements(text: string): string[] {
  const elements: string[] = [];
  let pos = 0;
  while (pos < text.length && elements.length < API_ARGV_MAX_ELEMENTS) {
    const next = indexAfterElement(text, pos);
    const closed = text[next - 1] !== ",";
    const element = text.slice(pos, closed ? next : next - 1).trim();
    // A closing bracket may sit inside the last segment: cut it off there.
    const cut = closed ? elementBeforeClose(element) : element;
    if (cut !== "") elements.push(cut);
    if (closed) break;
    pos = next;
  }
  return elements;
}

/**
 * The last element's text up to the first top-level `]` or `)` — the end of
 * the argv array — skipping strings, templates and nested brackets.
 */
function elementBeforeClose(segment: string): string {
  let depth = 0;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === "`") {
      i = indexAfterTemplate(segment, i + 1);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < segment.length && segment[i] !== c) {
        i += segment[i] === "\\" ? 2 : 1;
      }
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return segment.slice(0, i).trim();
      depth--;
    }
    i++;
  }
  return segment;
}

/** The text inside a fully quoted element, or `null` for a non-literal one. */
function literalValue(element: string): string | null {
  const match = /^(["'`])([\s\S]*)\1$/.exec(element);
  return match === null ? null : match[2] ?? "";
}

/**
 * Whether a `gh api` argv creates an issue: a POST (explicit, or implied by a
 * body flag) to an endpoint ending in `/issues`, or any `gh api graphql` argv
 * in a file that names the `createIssue` mutation.
 *
 * gh defaults to POST when a field flag is given, and an explicit method wins
 * over that default (`-X GET` with `-f` sends query parameters). A method that
 * is not a literal cannot be ruled out, so it counts as a POST. With no
 * method, a non-literal element (a `...fields` spread, a flag variable) that
 * is not the endpoint or the value of a known value flag may be a body flag,
 * so it counts as one: input the gate cannot read fails closed.
 *
 * @param elements - Raw argv element texts after the `"api"` element.
 * @param fileMentionsCreateIssue - Whether the file's code names `createIssue`.
 */
function apiArgvCreatesIssue(
  elements: readonly string[],
  fileMentionsCreateIssue: boolean,
): boolean {
  // pflag spellings (`-X=POST`, `-XPOST`, `-iXPOST`) become `-X POST`.
  const values = normaliseGhArgs(
    elements.map((element) => literalValue(element) ?? NON_LITERAL_ELEMENT),
  ).map((value) => value === NON_LITERAL_ELEMENT ? null : value);
  if (fileMentionsCreateIssue && values.includes("graphql")) return true;

  const isEndpoint = (element: string) =>
    !FIELD_ASSIGNMENT_PATTERN.test(element) &&
    ISSUES_ENDPOINT_PATTERN.test(element.replace(/["'`]\s*$/, ""));
  if (!elements.some(isEndpoint)) return false;

  let method: string | null | undefined;
  let hasField = false;
  let unreadable = false;
  let afterValueFlag = false;
  // The non-literal elements, in order, so each null maps back to its text.
  const nonLiteral = elements.filter((element) =>
    literalValue(element) === null
  );
  let nonLiteralSeen = 0;
  values.forEach((value, i) => {
    const skip = afterValueFlag;
    afterValueFlag = false;
    if (value === null) {
      const raw = nonLiteral[nonLiteralSeen++] ?? "";
      if (!skip && !isEndpoint(raw)) unreadable = true;
      return;
    }
    if (API_VALUE_FLAGS.has(value)) afterValueFlag = true;
    if (value === "-X" || value === "--method") {
      const methodValue = values[i + 1];
      method = methodValue === undefined || methodValue === null
        ? null
        : methodValue.toUpperCase();
      return;
    }
    const inline = API_METHOD_INLINE_PATTERN.exec(value);
    if (inline !== null) method = (inline[1] ?? "").toUpperCase();
    else if (API_FIELD_FLAG_PATTERN.test(value)) hasField = true;
  });

  if (method === undefined) return hasField || unreadable;
  return method === null || method === "POST";
}

/**
 * Scan a file's content for direct `gh issue create` argv call sites.
 *
 * Operates on comment-stripped source, so prose and commented-out code
 * mentioning the pattern cannot trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line, ordered by line number.
 */
export function scanContentForDirectIssueCreate(
  content: string,
  repoRelPath: string,
): IssueCreateRoutingViolation[] {
  const rawLines = content.split("\n");
  const lines = stripComments(content).split("\n");
  const violations: IssueCreateRoutingViolation[] = [];
  const fileMentionsCreateIssue = CREATE_ISSUE_MUTATION_PATTERN.test(
    lines.join("\n"),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isCliCreate = [...line.matchAll(ISSUE_ELEMENT_PATTERN)].some(
      (match) => {
        const rest = line.slice((match.index ?? 0) + match[0].length);
        const verb = verbAfterIssueElement(lines, i, rest);
        return verb !== null && ISSUE_CREATE_VERBS.has(verb);
      },
    );
    const isApiCreate = !isCliCreate &&
      [...line.matchAll(API_ELEMENT_PATTERN)].some((match) => {
        const rest = line.slice((match.index ?? 0) + match[0].length);
        const text = [
          rest,
          ...lines.slice(i + 1, i + 1 + API_ARGV_LOOKAHEAD_LINES),
        ]
          .join("\n");
        return apiArgvCreatesIssue(
          splitArgvElements(text),
          fileMentionsCreateIssue,
        );
      });
    if (!isCliCreate && !isApiCreate) continue;
    violations.push({
      file: repoRelPath,
      line: i + 1,
      text: (rawLines[i] ?? "").trim(),
    });
  }

  return violations;
}

/** Recursively walk a directory yielding `.ts` file paths, sorted by name. */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await Array.fromAsync(Deno.readDir(dir));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Fail closed unless `absDir` exists and is a directory.
 *
 * @throws Error naming the directory when it is missing or not a directory.
 */
async function assertScannableDirectory(
  absDir: string,
  relDir: string,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(absDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `issue-create routing check: scan directory "${relDir}" does not exist`,
      );
    }
    throw error;
  }
  if (!info.isDirectory) {
    throw new Error(
      `issue-create routing check: scan path "${relDir}" is not a directory`,
    );
  }
}

/**
 * Scan the given repo-relative directories for direct `gh issue create` argv
 * call sites that are not on {@link ISSUE_CREATE_ROUTING_ALLOWLIST}.
 *
 * Allowlisted files are skipped and do not count towards `filesScanned`.
 * Fails closed: a missing or non-directory `relDir`, or a scan that examines
 * no `.ts` file at all, throws rather than reporting a pass.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 * @throws Error when a directory is missing, is not a directory, or yields no
 *   scannable `.ts` files.
 */
export async function scanDirectoriesForDirectIssueCreate(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<IssueCreateRoutingCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: IssueCreateRoutingViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    const absDir = `${root}/${relDir}`;
    await assertScannableDirectory(absDir, relDir);
    for await (const absFile of walkTsFiles(absDir)) {
      const repoRel = absFile.slice(root.length + 1);
      if (ISSUE_CREATE_ROUTING_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForDirectIssueCreate(content, repoRel));
    }
  }

  if (filesScanned === 0) {
    throw new Error(
      `issue-create routing check: no .ts files were scanned under ${
        relDirs.join(", ")
      } — refusing to report a pass for an empty scan`,
    );
  }

  return { violations, filesScanned };
}

/**
 * Find allowlist entries that no longer earn their place: the file is gone,
 * or it no longer contains a direct `gh issue create` call site.
 *
 * Keeps the allowlist honest after a call site is migrated. Entries are
 * checked whether or not the file is in a scanned directory.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param allowlist - The allowlist to audit.
 * @returns Stale repo-relative paths, sorted.
 */
export async function findStaleAllowlistEntries(
  repoRoot: string,
  allowlist: ReadonlyMap<string, string> = ISSUE_CREATE_ROUTING_ALLOWLIST,
): Promise<string[]> {
  const root = repoRoot.replace(/\/$/, "");
  const stale: string[] = [];

  for (const relPath of [...allowlist.keys()].sort()) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${root}/${relPath}`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        stale.push(relPath);
        continue;
      }
      throw error;
    }
    if (scanContentForDirectIssueCreate(content, relPath).length === 0) {
      stale.push(relPath);
    }
  }

  return stale;
}

/**
 * Render violations as one line each, naming the file and line, for the
 * quality gate's failure message.
 *
 * @param violations - Violations to render.
 * @returns Newline-joined messages; empty when there are none.
 */
export function formatIssueCreateRoutingViolations(
  violations: readonly IssueCreateRoutingViolation[],
): string {
  return violations
    .map((v) =>
      `${v.file}:${v.line}: direct issue-create call site (\`gh issue create\` or \`gh api\`) is not on the routing allowlist — route it through fileRoutedIssue (issue_routing_filing.ts) or add an ISSUE_CREATE_ROUTING_ALLOWLIST entry with a one-line reason: ${v.text}`
    )
    .join("\n");
}
