/**
 * Native checkout-persist-credentials pre-filer for the
 * github-actions-audit template (Issue #2845, gap from #2834).
 *
 * Deterministically flags every `actions/checkout` step that does **not**
 * set `persist-credentials: false`, in a job that gives no static signal
 * of needing the persisted checkout token. This is the native,
 * deterministic counterpart to the long-documented but never-implemented
 * v3-slot prompt check #23 (Issue #2354): `docs/GITHUB-ACTIONS-AUDIT-SCAN.md`
 * records it as covered, but no prompt version or scanner ever filed it.
 *
 * The danger: by default `actions/checkout` writes the workflow's
 * `GITHUB_TOKEN` into `.git/config` as an `http.extraheader` auth value,
 * where any later step in the job — including a compromised dependency or
 * an injected script — can read it. A build/test/lint/package job rarely
 * needs that persisted credential, so `persist-credentials: false` removes
 * the credential from disk and shrinks the blast radius.
 *
 * Precision over recall (mirroring the sibling pre-filers): a job that
 * gives a static signal it needs the checkout token is **skipped**, not
 * flagged. The signals are:
 *
 *   - any `run:` text invoking `git push`/`fetch`/`pull`/`submodule`/
 *     `clone`/`remote` (the persisted credential's purpose),
 *   - any `uses:` referencing a known git-writing / push action,
 *   - the checkout step itself requesting `submodules:` (truthy), which
 *     needs the credential to fetch private submodules.
 *
 * The nuanced "a push cannot quite be ruled out" cases are left to the LLM
 * prompt, which can hedge in prose. The native scanner files only the
 * unambiguous build/test/lint jobs.
 *
 * Stable id is `BP-PERSIST-CREDS-<workflow-basename>-<job>-<step-index>`.
 * The `BP-` prefix is required: `idle_task_snapshot.listKnownOpenFindingIds`
 * defaults `idPrefix` to `BP-`, so a non-`BP-` id silently breaks dedup and
 * the LLM re-files.
 *
 * Severity is `medium` — a hardening gap that weakens the posture but is
 * not directly exploitable on its own (matches the documented band).
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

/** Matches an `actions/checkout` reference (any ref, case-insensitive). */
const CHECKOUT_USES = /^actions\/checkout(?:@.*)?$/i;

/**
 * `run:` invocations that consume the persisted checkout credential. A
 * job containing one of these is assumed to need `persist-credentials`
 * and is skipped (precision over recall). `\bgit\s+…` matches the bare
 * git sub-commands; the patterns are linear (no nested quantifiers) so
 * adversarial workflow content cannot trigger catastrophic backtracking.
 */
const GIT_CREDENTIAL_RUN =
  /\bgit\s+(?:-[^\s]+\s+)*(?:push|fetch|pull|submodule|clone|remote)\b/;

/**
 * Known actions that push to / write the repository using the checkout
 * credential. A job invoking one is skipped. Compared against the action
 * coordinate (the `uses:` value without its `@ref`), lower-cased.
 */
export const CREDENTIAL_USING_ACTIONS: readonly string[] = Object.freeze([
  "stefanzweifel/git-auto-commit-action",
  "ad-m/github-push-action",
  "peter-evans/create-pull-request",
  "endbug/add-and-commit",
  "jamesives/github-pages-deploy-action",
  "peaceiris/actions-gh-pages",
  "crazy-max/ghaction-github-pages",
  "googleapis/release-please-action",
  "google-github-actions/release-please-action",
  "cycjimmy/semantic-release-action",
]);

const CREDENTIAL_USING_SET: ReadonlySet<string> = new Set(
  CREDENTIAL_USING_ACTIONS,
);

/** A single checkout-persist-credentials finding for one checkout step. */
export interface CheckoutPersistCredentialsFinding {
  /** Stable id `BP-PERSIST-CREDS-<basename>-<job>-<step-index>`. */
  findingId: string;
  /** Repo-relative workflow path, e.g. `.github/workflows/ci.yml`. */
  workflowPath: string;
  /** Job name the step belongs to. */
  job: string;
  /** 0-based index of the step within the job's `steps` array. */
  stepIndex: number;
  /** Always `medium` — a hardening gap, not a direct exploit. */
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

/** Options for {@link scanCheckoutPersistCredentials}. */
export interface ScanCheckoutPersistCredentialsOptions {
  /** Stable ids suppressed by prior triage — skip these findings. */
  suppressedIds?: Iterable<string>;
  /** Stable ids already open as findings — skip these findings. */
  knownOpenFindingIds?: Iterable<string>;
}

const MEDIUM_EMOJI = "🟠";

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

/** Is this step a `uses: actions/checkout` step (any ref)? */
function isCheckoutStep(step: Record<string, unknown>): boolean {
  const uses = step["uses"];
  return typeof uses === "string" && CHECKOUT_USES.test(uses.trim());
}

/**
 * Is this checkout step already safe — i.e. its `with:` map sets
 * `persist-credentials: false`? A YAML 1.2 parser yields the boolean
 * `false`; a string `"false"` is honoured defensively. Any other value
 * (including `true`, a missing key, or a missing `with:` block) is not
 * safe.
 */
export function checkoutSetsPersistCredentialsFalse(
  step: Record<string, unknown>,
): boolean {
  const withBlock = step["with"];
  if (!isRecord(withBlock)) return false;
  const value = withBlock["persist-credentials"];
  if (value === false) return true;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") {
    return true;
  }
  return false;
}

/** Does the checkout step request submodule fetching (truthy)? */
function checkoutWantsSubmodules(step: Record<string, unknown>): boolean {
  const withBlock = step["with"];
  if (!isRecord(withBlock)) return false;
  const value = withBlock["submodules"];
  if (value === true) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "recursive";
  }
  return false;
}

/**
 * Does any step in the job give a static signal that it needs the
 * persisted checkout credential? A `run:` git write/fetch invocation or a
 * known credential-using action means the job legitimately keeps the
 * credential, so its checkout steps are not flagged.
 *
 * Pure — no I/O. Exported for direct unit testing.
 */
export function jobNeedsCheckoutCredentials(
  steps: readonly unknown[],
): boolean {
  for (const step of steps) {
    if (!isRecord(step)) continue;

    const run = step["run"];
    if (typeof run === "string" && GIT_CREDENTIAL_RUN.test(run)) return true;

    const uses = step["uses"];
    if (typeof uses === "string") {
      const at = uses.indexOf("@");
      const coordinate = (at >= 0 ? uses.slice(0, at) : uses).trim()
        .toLowerCase();
      if (CREDENTIAL_USING_SET.has(coordinate)) return true;
    }
  }
  return false;
}

/**
 * Best-effort 1-based line numbers of every `uses: actions/checkout`
 * declaration in raw text, in file order. Used to anchor each finding's
 * citation to the matching checkout step.
 */
function checkoutUsesLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S.*)$/);
    if (!m || !m[1]) continue;
    // Strip quotes / inline comment to get the bare coordinate.
    let value = m[1].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const ws = value.search(/\s/);
      if (ws >= 0) value = value.slice(0, ws);
    }
    if (CHECKOUT_USES.test(value)) out.push(i + 1);
  }
  return out;
}

/**
 * Scan every workflow file for `actions/checkout` steps lacking
 * `persist-credentials: false` and return one
 * {@link CheckoutPersistCredentialsFinding} per affected step.
 *
 * Behaviour:
 *   - Only `kind === "workflow"` files are scanned — `jobs.*.steps[]` is a
 *     workflow concept (composite actions use `runs.steps`).
 *   - Unparseable workflows (parsed `null`) and non-record roots yield no
 *     finding.
 *   - A job giving a static signal it needs the credential (a `run:` git
 *     write/fetch, a known push action, or a `submodules:`-requesting
 *     checkout) is skipped entirely.
 *   - A checkout step that already sets `persist-credentials: false` is
 *     safe and never flagged.
 *   - A finding suppressed by an in-source `best-practice-ignore:
 *     BP-PERSIST-CREDS-…` marker near its cited line is dropped.
 *   - Findings whose stable id appears in `suppressedIds` or
 *     `knownOpenFindingIds` are dropped (the LLM / a prior run owns them).
 *
 * Findings are returned sorted by stable id for deterministic output.
 *
 * Pure aside from reading the already-parsed/raw `WorkflowFile` — callers
 * read the files via `readWorkflowFiles`.
 */
export function scanCheckoutPersistCredentials(
  files: readonly WorkflowFile[],
  opts: ScanCheckoutPersistCredentialsOptions = {},
): CheckoutPersistCredentialsFinding[] {
  const suppressed = new Set(opts.suppressedIds ?? []);
  const knownOpen = new Set(opts.knownOpenFindingIds ?? []);
  const findings: CheckoutPersistCredentialsFinding[] = [];

  for (const file of files) {
    if (file.kind !== "workflow") continue;
    if (!isRecord(file.parsed)) continue;
    const jobs = file.parsed.jobs;
    if (!isRecord(jobs)) continue;

    const basename = slugify(workflowBasename(file.path));
    const rawLines = file.rawText.split("\n");
    const checkoutLines = checkoutUsesLines(rawLines);
    let checkoutSeen = 0;

    for (const [jobName, jobValue] of Object.entries(jobs)) {
      if (!isRecord(jobValue)) continue;
      const steps = jobValue.steps;
      if (!Array.isArray(steps)) continue;

      const jobNeedsCreds = jobNeedsCheckoutCredentials(steps);

      for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const step = steps[stepIndex];
        if (!isRecord(step) || !isCheckoutStep(step)) continue;

        // Anchor the citation line to this checkout, then advance the
        // cursor regardless of whether the step is flagged.
        const line = checkoutLines[checkoutSeen] ?? 1;
        checkoutSeen++;

        // Safe already, or the job needs the credential → skip.
        if (checkoutSetsPersistCredentialsFalse(step)) continue;
        if (jobNeedsCreds || checkoutWantsSubmodules(step)) continue;

        const findingId = `BP-PERSIST-CREDS-${basename}-${
          slugify(jobName)
        }-${stepIndex}`;
        if (suppressed.has(findingId)) continue;
        if (knownOpen.has(findingId)) continue;
        if (isFindingSuppressed(file.rawText, line, findingId, file.path)) {
          continue;
        }

        findings.push(buildFinding(file, findingId, jobName, stepIndex, line));
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
): CheckoutPersistCredentialsFinding {
  return {
    findingId: id,
    workflowPath: file.path,
    job,
    stepIndex,
    severity: "medium",
    title: `${MEDIUM_EMOJI} Job \`${job}\` checkout persists credentials ` +
      `(\`${file.path}\`)`,
    file: file.path,
    lines: line,
    whyItMatters:
      `Job \`${job}\` step ${stepIndex} runs \`actions/checkout\` ` +
      "without `persist-credentials: false`. By default checkout writes the " +
      "workflow's `GITHUB_TOKEN` into `.git/config` as an auth header, where " +
      "any later step in the job — including a compromised dependency or an " +
      "injected script — can read it and act as the token. This job shows no " +
      "static sign of pushing back to the repository or fetching private " +
      "submodules, so it does not need the persisted credential, and keeping " +
      "it on disk only widens the blast radius of a compromised step.",
    suggestedFix:
      "Add `persist-credentials: false` to the checkout step so the token is " +
      "not written to disk:\n\n```yaml\n      - uses: actions/checkout@<sha>\n" +
      "        with:\n          persist-credentials: false\n```\n\nIf a later " +
      "step in this job genuinely pushes back to the repository (or fetches a " +
      "private submodule) using the checkout credential, this is a false " +
      "positive — suppress it with an in-source `# best-practice-ignore: " +
      `${id} — <reason>\` comment above the \`uses:\` line.`,
    evidence: `\`${file.path}\`:${line} — \`uses: actions/checkout\` with no ` +
      "`persist-credentials: false`",
  };
}
