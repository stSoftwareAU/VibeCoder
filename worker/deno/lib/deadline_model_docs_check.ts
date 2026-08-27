/**
 * Quality gate check: the published cycle-deadline model must be stated once
 * and must not restate the regime Issue #397 retired (Issue #426).
 *
 * The deadline model was documented across five pages, each describing the
 * pre-#397 regime: the cycle deadline killed in-flight issue work, progress
 * extensions were opt-in, and the supervisor cap was quoted as 5400 s long
 * after `loop.sh` had stopped saying so. A stale number of that kind survives
 * review — nobody re-derives it — so it is a check rather than a reader's
 * responsibility.
 *
 * Four rules, each anchored to a fact #397 changed:
 *
 *  1. `stale-run-cap` — a seconds figure quoted for the supervisor cap or its
 *     derived container watchdog must agree with the source that sets it:
 *     `loop.sh`'s `VIBE_RUN_MAX_SECONDS` default and
 *     `container_watchdog.ts`'s `WATCHDOG_MARGIN_SECONDS`. The retired 5400 s
 *     fails because the source says 10800 s — and the next raise fails the
 *     same way, without anyone having to remember to re-grep the docs.
 *  2. `extensions-off-by-default` — no page may describe progress extensions
 *     as off/disabled by default. They are on by default (Issue #422).
 *  3. `execute-deadline-rule` — no page may cite `resolveExecuteTimeoutSeconds`
 *     as the rule the execute phase applies. Issue work stopped applying it
 *     in Issue #420; the module now serves idle-task scans only, and the
 *     scan's bound is justified on its own terms in prose.
 *  4. `canonical-model` — the end-to-end model lives on exactly one page and
 *     the others link to it, so the repo does not re-acquire the five
 *     paraphrases `docs/DUPLICATED-KNOWLEDGE-SCAN.md` exists to prevent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Status of the cycle-deadline documentation check. */
export type DeadlineModelDocsStatus = "PASSED" | "SKIPPED" | "FAILED";

/** Which retired fact — or structural rule — a violation breaks. */
export type DeadlineModelRule =
  | "stale-run-cap"
  | "extensions-off-by-default"
  | "execute-deadline-rule"
  | "canonical-model";

/** A single documentation violation. */
export interface DeadlineModelViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number, or `0` for a whole-file structural violation. */
  line: number;
  /** The rule that was broken. */
  rule: DeadlineModelRule;
  /** What is wrong and what to write instead. */
  detail: string;
  /** The offending line, trimmed; empty for structural violations. */
  content: string;
}

/** Structured result of the cycle-deadline documentation check. */
export interface DeadlineModelDocsResult {
  status: DeadlineModelDocsStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** All violations found (empty when status is PASSED). */
  violations: DeadlineModelViolation[];
  /** Number of files scanned. */
  filesScanned: number;
}

/** The one page that states the model end to end. */
export const CANONICAL_MODEL_FILE = "docs/CONFIGURATION.md";

/** The canonical section's heading, matched exactly. */
export const CANONICAL_MODEL_HEADING = "### 🕰️ The cycle-deadline model";

/** The link target every other page must point at. */
export const CANONICAL_MODEL_ANCHOR =
  "CONFIGURATION.md#-the-cycle-deadline-model";

/**
 * Pages that previously paraphrased the model and must now link to it.
 * A page absent from the checkout is skipped, not failed.
 */
export const LINKING_MODEL_FILES = [
  "docs/DEPLOYMENT.md",
  "docs/IDLE-TASK-FRAMEWORK.md",
  "docs/INTERNALS.md",
  "docs/TROUBLESHOOTING.md",
];

/** `docs/archive/` is a historical record — it may describe the old regime. */
const EXCLUDED_PREFIXES = ["docs/archive/"];

/** The supervisor script that owns the cap's default. */
const LOOP_SCRIPT = "loop.sh";

/** The module that owns the launcher watchdog's margin over that cap. */
const WATCHDOG_SOURCE = "worker/deno/lib/container_watchdog.ts";

/**
 * Seconds values below this are units of the model's own machinery (a `0`
 * that disables the cap, a small grace), not a restatement of the cap.
 */
const CAP_SECONDS_FLOOR = 60;

/** The figures a page may quote for the cap, read from the code that sets them. */
export interface CapFacts {
  /** `loop.sh`'s `VIBE_RUN_MAX_SECONDS` default, in seconds. */
  capSeconds: number;
  /** `container_watchdog.ts`'s margin over that cap, in seconds. */
  marginSeconds: number;
}

/** Where `loop.sh`'s cap default is set. */
const LOOP_CAP_DEFAULT = /VIBE_RUN_MAX_SECONDS:-(\d+)\}/;

/** Where the launcher's watchdog margin is set. */
const WATCHDOG_MARGIN = /WATCHDOG_MARGIN_SECONDS\s*=\s*(\d+)/;

/** Environment variables whose seconds figures this rule checks. */
const CAP_VARIABLES = [
  "VIBE_RUN_MAX_SECONDS",
  "VIBE_CONTAINER_WATCHDOG_SECONDS",
];

/**
 * Read the cap figures from the source that sets them.
 *
 * Returns `null` — never a guess — when either figure has moved, so the
 * caller can fail loudly rather than validate the docs against a default it
 * invented.
 *
 * @param loopSh - Contents of `loop.sh`.
 * @param watchdogTs - Contents of `worker/deno/lib/container_watchdog.ts`.
 */
export function parseCapFacts(
  loopSh: string,
  watchdogTs: string,
): CapFacts | null {
  const cap = LOOP_CAP_DEFAULT.exec(loopSh);
  const margin = WATCHDOG_MARGIN.exec(watchdogTs);
  if (!cap || !margin) return null;
  return { capSeconds: Number(cap[1]), marginSeconds: Number(margin[1]) };
}

/** The seconds figures a page may legitimately quote beside the cap. */
function allowedCapSeconds(facts: CapFacts): Set<number> {
  return new Set([
    facts.capSeconds,
    facts.marginSeconds,
    facts.capSeconds + facts.marginSeconds,
  ]);
}

/** Issue/PR references — `#421` is not a seconds value. */
const ISSUE_REFERENCE = /#\d+/g;

/** A seconds literal: `5400s`, `5400 s`, `5400 seconds`. */
const SECONDS_LITERAL = /\b(\d+)\s*(?:s\b|seconds\b)/g;

/**
 * Progress extensions, however the prose spells them — "progress extension",
 * "progress-extended deadline", `progress_extension_enabled`. Matching the
 * "exten" stem covers both the verb ("extend", "extended") and the noun
 * ("extension", "extensions"), which no single spelling would.
 */
const PROGRESS_EXTENSION = /progress[-_ ]?exten/i;

/** "off by default", "disabled by default", "`false` by default". */
const OFF_BY_DEFAULT =
  /\b(?:off|disabled|not enabled|`?false`?)\s+by\s+default/i;

/** The execute-phase rule that retired with truncation (Issue #420). */
const EXECUTE_RULE_SYMBOL = "resolveExecuteTimeoutSeconds";

/** Lines of context joined when testing the off-by-default wording. */
const WINDOW_LINES = 3;

/**
 * Scan one file's content for the three line-level retired facts.
 *
 * Pure, so the matching logic is testable without a filesystem.
 *
 * @param relPath - Repo-relative path, used in the violation records.
 * @param content - The whole file.
 * @param facts - Cap figures read from the source that sets them.
 * @returns Every violation found, in line order.
 */
export function scanDeadlineModelContent(
  relPath: string,
  content: string,
  facts: CapFacts,
): DeadlineModelViolation[] {
  const violations: DeadlineModelViolation[] = [];
  const lines = content.split("\n");
  const allowed = allowedCapSeconds(facts);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (CAP_VARIABLES.some((name) => line.includes(name))) {
      const stripped = line.replace(ISSUE_REFERENCE, "");
      SECONDS_LITERAL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SECONDS_LITERAL.exec(stripped)) !== null) {
        const seconds = Number(match[1]);
        if (seconds < CAP_SECONDS_FLOOR || allowed.has(seconds)) continue;
        violations.push({
          file: relPath,
          line: i + 1,
          rule: "stale-run-cap",
          detail:
            `quotes ${seconds}s, which the source does not set. loop.sh caps ` +
            `a run at ${facts.capSeconds}s and container_watchdog.ts adds ` +
            `${facts.marginSeconds}s for the launcher watchdog ` +
            `(${facts.capSeconds + facts.marginSeconds}s) — quote one of ` +
            `those, or describe the figure instead of copying it.`,
          content: line.trim(),
        });
        break;
      }
    }

    if (line.includes(EXECUTE_RULE_SYMBOL)) {
      violations.push({
        file: relPath,
        line: i + 1,
        rule: "execute-deadline-rule",
        detail:
          `cites ${EXECUTE_RULE_SYMBOL}. The execute phase stopped bounding ` +
          `its timeout by the cycle deadline in Issue #420 — describe the ` +
          `idle-task scan's bound on its own terms instead.`,
        content: line.trim(),
      });
    }

    const window = lines.slice(i, i + WINDOW_LINES).join(" ");
    if (PROGRESS_EXTENSION.test(window) && OFF_BY_DEFAULT.test(window)) {
      violations.push({
        file: relPath,
        line: i + 1,
        rule: "extensions-off-by-default",
        detail:
          "describes progress extensions as off by default. They are on by " +
          "default (Issue #422).",
        content: line.trim(),
      });
    }
  }

  return violations;
}

/**
 * Check that the model is stated once and linked from everywhere else.
 *
 * @param files - Repo-relative path → file content, for the files present.
 * @returns A violation per page that states nothing and links to nothing.
 */
export function checkCanonicalModel(
  files: Map<string, string>,
): DeadlineModelViolation[] {
  const violations: DeadlineModelViolation[] = [];

  const canonical = files.get(CANONICAL_MODEL_FILE);
  if (canonical !== undefined && !canonical.includes(CANONICAL_MODEL_HEADING)) {
    violations.push({
      file: CANONICAL_MODEL_FILE,
      line: 0,
      rule: "canonical-model",
      detail: `is the canonical home of the cycle-deadline model but has no ` +
        `"${CANONICAL_MODEL_HEADING}" section. The model must be stated ` +
        `end to end in exactly one place.`,
      content: "",
    });
  }

  for (const relPath of LINKING_MODEL_FILES) {
    const content = files.get(relPath);
    if (content === undefined) continue;
    if (content.includes(CANONICAL_MODEL_ANCHOR)) continue;
    violations.push({
      file: relPath,
      line: 0,
      rule: "canonical-model",
      detail: `does not link to the canonical model ` +
        `(${CANONICAL_MODEL_ANCHOR}). Link to it rather than paraphrasing it.`,
      content: "",
    });
  }

  return violations;
}

/**
 * Collect the published Markdown set: every `.md` under `docs/` except the
 * historical archive.
 *
 * @param rootDir - Repository root.
 * @returns Repo-relative paths, sorted for deterministic output.
 */
export async function collectDeadlineModelFiles(
  rootDir: string,
): Promise<string[]> {
  const files: string[] = [];
  await walk(`${rootDir}/docs`, "docs", files);
  files.sort();
  return files;
}

/** Read a file, or `null` when it is not there. */
async function readOrNull(absPath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(absPath);
  } catch {
    return null;
  }
}

async function walk(
  absDir: string,
  relDir: string,
  acc: string[],
): Promise<void> {
  try {
    const stat = await Deno.stat(absDir);
    if (!stat.isDirectory) return;
  } catch {
    return;
  }

  for await (const entry of Deno.readDir(absDir)) {
    const absPath = `${absDir}/${entry.name}`;
    const relPath = `${relDir}/${entry.name}`;
    if (EXCLUDED_PREFIXES.some((p) => `${relPath}/`.startsWith(p))) continue;
    if (entry.isDirectory) {
      await walk(absPath, relPath, acc);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      acc.push(relPath);
    }
  }
}

/**
 * Run the cycle-deadline documentation check across the repository.
 *
 * SKIPPED when there is no `docs/` tree (the check is repo-specific);
 * PASSED when every rule holds; FAILED with the offending lines otherwise.
 *
 * @param rootDir - Repository root.
 */
export async function runDeadlineModelDocsCheck(
  rootDir: string,
): Promise<DeadlineModelDocsResult> {
  const paths = await collectDeadlineModelFiles(rootDir);
  if (paths.length === 0) {
    return {
      status: "SKIPPED",
      output: "cycle-deadline docs: SKIPPED (no docs/ directory)",
      violations: [],
      filesScanned: 0,
    };
  }

  // The model is this repository's own: only the supervisor that sets the cap
  // has these pages. Elsewhere the check has nothing to say.
  const loopSh = await readOrNull(`${rootDir}/${LOOP_SCRIPT}`);
  const watchdogTs = await readOrNull(`${rootDir}/${WATCHDOG_SOURCE}`);
  if (loopSh === null || watchdogTs === null) {
    return {
      status: "SKIPPED",
      output: `cycle-deadline docs: SKIPPED (no ${LOOP_SCRIPT} — not the ` +
        `supervisor repository)`,
      violations: [],
      filesScanned: 0,
    };
  }

  const facts = parseCapFacts(loopSh, watchdogTs);
  if (facts === null) {
    const violation: DeadlineModelViolation = {
      file: LOOP_SCRIPT,
      line: 0,
      rule: "stale-run-cap",
      detail: `no VIBE_RUN_MAX_SECONDS default in ${LOOP_SCRIPT}, or no ` +
        `WATCHDOG_MARGIN_SECONDS in ${WATCHDOG_SOURCE}. The check validates ` +
        `the documented figures against those two, so it fails rather than ` +
        `pass the docs against a default it invented.`,
      content: "",
    };
    return {
      status: "FAILED",
      output: `cycle-deadline docs: FAILED (the cap figures are no longer ` +
        `derivable)\n\n  [${violation.rule}] ${violation.file} ` +
        `${violation.detail}`,
      violations: [violation],
      filesScanned: 0,
    };
  }

  const contents = new Map<string, string>();
  const violations: DeadlineModelViolation[] = [];
  for (const relPath of paths) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${rootDir}/${relPath}`);
    } catch {
      continue;
    }
    contents.set(relPath, content);
    violations.push(...scanDeadlineModelContent(relPath, content, facts));
  }
  violations.push(...checkCanonicalModel(contents));

  if (violations.length === 0) {
    return {
      status: "PASSED",
      output:
        `cycle-deadline docs: PASSED (${paths.length} file(s) checked against ` +
        `the Issue #397 model)`,
      violations: [],
      filesScanned: paths.length,
    };
  }

  const lines = [
    `cycle-deadline docs: FAILED (${violations.length} violation(s) in ` +
    `${paths.length} file(s) scanned)`,
    "",
    `The cycle-deadline model is stated once, in ${CANONICAL_MODEL_FILE} ` +
    `under "${CANONICAL_MODEL_HEADING}". Every other page links to it.`,
    "",
    ...violations.map((v) =>
      `  [${v.rule}] ${v.file}${v.line > 0 ? `:${v.line}` : ""} ${v.detail}` +
      (v.content ? `\n      ${v.content}` : "")
    ),
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    violations,
    filesScanned: paths.length,
  };
}
