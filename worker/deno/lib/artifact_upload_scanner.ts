/**
 * Native broad-artefact-upload pre-filer for the github-actions-audit
 * template (Issue #2846, gap from #2834).
 *
 * Deterministically flags every `actions/upload-artifact` step whose
 * `with.path` is the whole workspace — the statically-decidable core of
 * v9 prompt check #30 (broad artefact uploads). This is the gap the
 * Corgea checklist §9 ("avoid broad artifact uploads such as `path: .`")
 * identified: v8 only flagged artefacts that contain the GitHub
 * environment (checks #3 and #27), never a broad-path upload in general.
 *
 * The danger: a `path: .` (or `./`, `${{ github.workspace }}`, `*`, `**`)
 * upload ships the **entire** checkout to a build artefact — `.git/`
 * (which holds the persisted `GITHUB_TOKEN` unless
 * `persist-credentials: false` was set), any `.env` or build secret
 * written during the run, and all source. The artefact is downloadable by
 * every collaborator (and by anyone on a public repo), so a broad upload
 * is a credential- and source-exfiltration surface.
 *
 * Precision over recall (mirroring the sibling pre-filers): only the
 * unambiguous whole-workspace tokens are flagged natively —
 *   - `.` and `./`
 *   - `*` and `**` (a bare top-level glob captures the whole cwd)
 *   - `${{ github.workspace }}` (any internal whitespace, optional
 *     trailing slash)
 *
 * The judgement-heavy "otherwise unscoped" long tail (a parent directory,
 * a glob anchored at the workspace root that is not a bare `*`/`**`) is
 * left to the LLM prompt, which can hedge in prose.
 *
 * Severity is `low` baseline, escalated to `medium` when the job has
 * secrets in scope (a `${{ secrets.* }}` reference at workflow-level `env`,
 * the job, or a step) **or** the workflow uses a trigger from the
 * privileged-trigger set — both statically decidable.
 *
 * Stable id is `BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>`.
 * The `BP-` prefix is required: `idle_task_snapshot.listKnownOpenFindingIds`
 * defaults `idPrefix` to `BP-`, so a non-`BP-` id silently breaks dedup and
 * the LLM re-files.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`. Never throws on malformed input.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import {
  isFindingSuppressed,
  type WorkflowFile,
  type WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** Matches an `actions/upload-artifact` reference (any ref, case-insensitive). */
const UPLOAD_ARTIFACT_USES = /^actions\/upload-artifact(?:@.*)?$/i;

/**
 * The privileged-trigger set (v10 prompt definition): `on:` events that run
 * with repo secrets and a write `GITHUB_TOKEN` in a context an attacker can
 * influence. A workflow using any of these escalates a broad upload to
 * `medium`. `pull_request_review` and `pull_request_review_comment` were
 * added in Issue #2847 — they run with the same secrets + write token and
 * carry an attacker-influenced review body (`github.event.review.body`).
 */
export const PRIVILEGED_TRIGGERS: readonly string[] = Object.freeze([
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

const PRIVILEGED_TRIGGER_SET: ReadonlySet<string> = new Set(
  PRIVILEGED_TRIGGERS,
);

/** Matches a `${{ secrets.* }}` reference (any internal whitespace). */
const SECRETS_REFERENCE = /\$\{\{\s*secrets\./;

/** Matches the `${{ github.workspace }}` token, optional trailing slash. */
const GITHUB_WORKSPACE = /^\$\{\{\s*github\.workspace\s*\}\}\/?$/;

/** A single broad-artefact-upload finding for one upload step. */
export interface ArtifactUploadFinding {
  /** Stable id `BP-ARTIFACT-UPLOAD-<basename>-<job>-<step-index>`. */
  findingId: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Job name the step belongs to. */
  job: string;
  /** 0-based index of the step within the job's `steps` array. */
  stepIndex: number;
  /** `low` baseline; `medium` with secrets in scope or a privileged trigger. */
  severity: WorkflowFindingSeverity;
  /** Issue title (carries the severity emoji prefix). */
  title: string;
  /** File the finding is raised against (the workflow path). */
  file: string;
  /** Best-effort 1-based line number for the cited `uses:` location. */
  lines: number;
  /** `## Why this matters` rationale. */
  whyItMatters: string;
  /** `## Suggested fix` guidance. */
  suggestedFix: string;
  /** `## Evidence` block. */
  evidence: string;
}

/** Options for {@link scanArtifactUploads}. */
export interface ScanArtifactUploadsOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const MEDIUM_EMOJI = "🟠";
const LOW_EMOJI = "🟢";

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

/** Strip surrounding single/double quotes from a trimmed scalar. */
function unquote(value: string): string {
  const v = value.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Is a single (already-trimmed, unquoted) path entry a whole-workspace
 * token? `.`, `./`, `*`, `**`, or `${{ github.workspace }}` (optional
 * trailing slash).
 *
 * Pure — no I/O. Exported for direct unit testing.
 */
export function isBroadPathEntry(entry: string): boolean {
  const v = entry.trim();
  if (v === "." || v === "./" || v === "*" || v === "**") return true;
  if (GITHUB_WORKSPACE.test(v)) return true;
  return false;
}

/**
 * Does an `actions/upload-artifact` `with.path` value resolve to the whole
 * workspace? The value may be a single scalar or a multi-line block (one
 * path per line); it is broad when **any** non-empty line is a
 * whole-workspace token.
 *
 * Pure — no I/O. Exported for direct unit testing.
 */
export function isBroadArtifactPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (const rawLine of value.split("\n")) {
    const line = unquote(rawLine);
    if (line === "") continue;
    if (isBroadPathEntry(line)) return true;
  }
  return false;
}

/** Is this step a `uses: actions/upload-artifact` step (any ref)? */
function isUploadArtifactStep(step: Record<string, unknown>): boolean {
  const uses = step["uses"];
  return typeof uses === "string" && UPLOAD_ARTIFACT_USES.test(uses.trim());
}

/** Extract the `with.path` value of an upload step (may be undefined). */
function uploadPathValue(step: Record<string, unknown>): unknown {
  const withBlock = step["with"];
  if (!isRecord(withBlock)) return undefined;
  return withBlock["path"];
}

/**
 * Collect the trigger event names from a parsed workflow's `on:` block.
 * Handles the scalar (`on: push`), array (`on: [a, b]`), and map
 * (`on: { a: …, b: … }`) forms. Returns lower-cased names.
 *
 * Pure — no I/O. Exported for direct unit testing.
 */
export function extractTriggerEvents(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const on = parsed["on"];
  if (typeof on === "string") return [on.trim().toLowerCase()];
  if (Array.isArray(on)) {
    return on
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase());
  }
  if (isRecord(on)) {
    return Object.keys(on).map((k) => k.trim().toLowerCase());
  }
  return [];
}

/** Does the workflow use any trigger from the privileged-trigger set? */
export function workflowHasPrivilegedTrigger(parsed: unknown): boolean {
  return extractTriggerEvents(parsed).some((e) =>
    PRIVILEGED_TRIGGER_SET.has(e)
  );
}

/**
 * Does the job (or the workflow-level `env`) reference a secret via
 * `${{ secrets.* }}`? Scoped to the job subtree plus workflow-level env so
 * an unrelated secret elsewhere in the workflow does not over-escalate.
 *
 * Pure — no I/O. Exported for direct unit testing.
 */
export function secretsInScope(
  parsed: unknown,
  jobValue: unknown,
): boolean {
  if (SECRETS_REFERENCE.test(JSON.stringify(jobValue ?? null))) return true;
  if (isRecord(parsed)) {
    const env = parsed["env"];
    if (env !== undefined && SECRETS_REFERENCE.test(JSON.stringify(env))) {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort 1-based line numbers of every `uses: actions/upload-artifact`
 * declaration in raw text, in file order. Used to anchor each finding's
 * citation to the matching upload step.
 */
function uploadUsesLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S.*)$/);
    if (!m || !m[1]) continue;
    let value = m[1].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const ws = value.search(/\s/);
      if (ws >= 0) value = value.slice(0, ws);
    }
    if (UPLOAD_ARTIFACT_USES.test(value)) out.push(i + 1);
  }
  return out;
}

/**
 * Scan every workflow file for `actions/upload-artifact` steps that upload
 * a whole-workspace path and return one {@link ArtifactUploadFinding} per
 * affected step.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned — `jobs.*.steps[]` is a
 *     workflow concept (composite actions use `runs.steps`).
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - Only broad `with.path` values (`.`, `./`, `*`, `**`,
 *     `${{ github.workspace }}`) are flagged; a scoped path
 *     (`dist/`, `target/release/bin`) is never flagged.
 *   - Severity is `low` baseline, `medium` when the job has secrets in
 *     scope or the workflow uses a privileged trigger.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-ARTIFACT-UPLOAD-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`.
 */
export function scanArtifactUploads(
  files: readonly WorkflowFile[],
  opts: ScanArtifactUploadsOptions = {},
): ArtifactUploadFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: ArtifactUploadFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;
    const jobs = file.parsed.jobs;
    if (!isRecord(jobs)) continue;

    const basename = slugify(workflowBasename(file.path));
    const rawLines = file.rawText.split("\n");
    const uploadLines = uploadUsesLines(rawLines);
    let uploadSeen = 0;

    const privileged = workflowHasPrivilegedTrigger(file.parsed);

    for (const [jobName, jobValue] of Object.entries(jobs)) {
      if (!isRecord(jobValue)) continue;
      const steps = jobValue.steps;
      if (!Array.isArray(steps)) continue;

      const hasSecrets = secretsInScope(file.parsed, jobValue);

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const step = steps[stepIndex];
        if (!isRecord(step) || !isUploadArtifactStep(step)) continue;

        // Anchor the citation to this upload, then advance the cursor
        // regardless of whether the step is flagged.
        const line = uploadLines[uploadSeen] ?? 1;
        uploadSeen++;

        if (!isBroadArtifactPath(uploadPathValue(step))) continue;

        const findingId = `BP-ARTIFACT-UPLOAD-${basename}-${
          slugify(jobName)
        }-${stepIndex}`;
        if (suppressed.has(findingId)) continue;
        if (knownOpen.has(findingId)) continue;
        if (isFindingSuppressed(file.rawText, line, findingId, file.path)) {
          continue;
        }

        const severity: WorkflowFindingSeverity = privileged || hasSecrets
          ? "medium"
          : "low";
        findings.push(
          buildFinding(file, findingId, jobName, stepIndex, line, severity, {
            privileged,
            hasSecrets,
          }),
        );
      }
    }
  }

  findings.sort((a, b) => a.findingId.localeCompare(b.findingId));
  return findings;
}

function buildFinding(
  file: WorkflowFile,
  id: string,
  job: string,
  stepIndex: number,
  line: number,
  severity: WorkflowFindingSeverity,
  reason: { privileged: boolean; hasSecrets: boolean },
): ArtifactUploadFinding {
  const emoji = severity === "medium" ? MEDIUM_EMOJI : LOW_EMOJI;
  const escalation = severity === "medium"
    ? " The severity is raised to medium because this job " +
      (reason.hasSecrets && reason.privileged
        ? "has secrets in scope and the workflow runs under a privileged trigger"
        : reason.hasSecrets
        ? "has secrets in scope"
        : "runs under a privileged trigger") +
      ", widening the blast radius of the exposed artefact."
    : "";

  return {
    findingId: id,
    workflowPath: file.path,
    job,
    stepIndex,
    severity,
    title: `${emoji} Job \`${job}\` uploads the whole workspace as an ` +
      `artefact (\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters:
      `Job \`${job}\` step ${stepIndex} runs \`actions/upload-artifact\` ` +
      "with a whole-workspace `path` (`.`, `./`, `${{ github.workspace }}`, " +
      "`*`, or `**`). This ships the **entire** checkout to a build " +
      "artefact: `.git/` (which holds the persisted `GITHUB_TOKEN` unless " +
      "`persist-credentials: false` was set), any `.env` or build secret " +
      "written during the run, and all source. The artefact is downloadable " +
      "by every collaborator — and by anyone on a public repo — so a broad " +
      "upload is a credential- and source-exfiltration surface." + escalation,
    suggestedFix:
      "Upload only the specific build-output path(s) instead of the " +
      "workspace root:\n\n```yaml\n      - uses: actions/upload-artifact@<sha>\n" +
      "        with:\n          name: build-output\n          path: dist/\n" +
      "```\n\nIf the whole tree genuinely must move between jobs, scope it to " +
      "a dedicated output directory and exclude `.git`, `.env`, and secret " +
      "files. If this upload is intentional and safe, suppress it with an " +
      `in-source \`# best-practice-ignore: ${id} — <reason>\` comment above ` +
      "the `uses:` line.",
    evidence: `\`${file.path}\`:${line} — \`uses: actions/upload-artifact\` ` +
      "with a whole-workspace `path`",
  };
}
