/**
 * Deterministic cost and speed pre-pass for the github-actions-audit
 * template (Issue #2578).
 *
 * The audit's "Cost and speed" group (prompt checks 37–41) asks whether a
 * workflow runs only when relevant, caches what it can, runs in parallel and
 * builds once. Those are judgement calls — a missing `paths:` filter is the
 * right choice on a required check — so this module never files anything.
 * It reads the workflow files the template already parsed and lists the
 * cheap-to-detect **leads** the prompt then confirms or rejects:
 *
 *   - **37** — a workflow on `push` / `pull_request` with no `paths:` /
 *     `paths-ignore:` on one of those events and no job-level change
 *     detection (a paths-filter action, or a job gated on another job's
 *     outputs).
 *   - **39** — a job that compiles with cargo and has no cargo cache, a
 *     `setup-*` action installing dependencies with no `cache` input, an
 *     `actions/cache` key unique to the run with no `restore-keys`, or a
 *     Docker build with no `cache-from`.
 *   - **40** — one job that lints, tests and builds back to back.
 *   - **41** — a deploying workflow that rebuilds something another push or
 *     pull-request workflow already builds, without downloading that run's
 *     artefact.
 *
 * Check 38 (duplicate or overlapping work) is left to the prompt: telling
 * overlapping scope from distinct scope needs reading, not matching.
 *
 * Pure — no I/O. Australian English throughout (behaviour, artefact).
 */

import type { WorkflowFile } from "./workflow_scan_common.ts";
import { readOnBlock } from "./workflow_trigger_scanner.ts";

/** The cost-group checks this pre-pass can raise a lead for. */
export type CostCheck = 37 | 39 | 40 | 41;

/** One lead for the prompt to confirm or reject. */
export interface CostCandidate {
  check: CostCheck;
  /** Repo-relative workflow path. */
  file: string;
  /** 1-based line: the job key for a job lead, `on:` for a workflow lead. */
  line: number;
  /** The job the lead is about, when it is about one. */
  job?: string;
  /** What was seen, in one line. */
  detail: string;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A step's `uses:` coordinate without its ref, lower-cased. */
function actionOf(step: Rec): string | undefined {
  const uses = step["uses"];
  if (typeof uses !== "string") return undefined;
  return uses.split("@")[0]!.trim().toLowerCase();
}

function withOf(step: Rec): Rec {
  const w = step["with"];
  return isRecord(w) ? w : {};
}

function stepsOf(job: Rec): Rec[] {
  const steps = job["steps"];
  return Array.isArray(steps) ? steps.filter(isRecord) : [];
}

/** Every `run:` script in a job, joined, for command matching. */
function runText(job: Rec): string {
  return stepsOf(job)
    .map((s) => (typeof s["run"] === "string" ? s["run"] : ""))
    .join("\n");
}

/** Line of `  <job>:` under `jobs:`, else the `jobs:` line, else 1. */
function jobLine(rawText: string, job: string): number {
  const lines = rawText.split("\n");
  const jobs = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  // A string comparison, not a `RegExp` built from the job name: the name
  // comes from the scanned repo, and a non-literal regex is a ReDoS surface
  // Semgrep blocks on.
  const keys = [`${job}:`, `"${job}":`, `'${job}':`];
  for (let i = Math.max(jobs, 0); i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s/.test(line)) continue;
    if (keys.includes(line.trim())) return i + 1;
  }
  return jobs >= 0 ? jobs + 1 : 1;
}

function onLine(rawText: string): number {
  const i = rawText.split("\n").findIndex((l) => /^["']?on["']?:/.test(l));
  return i >= 0 ? i + 1 : 1;
}

// ---------------------------------------------------------------------------
// 37 — runs only when relevant
// ---------------------------------------------------------------------------

const SCOPED_EVENTS = ["push", "pull_request"] as const;

/** The push / pull_request events that fire with no path scoping. */
function unscopedEvents(on: unknown): string[] {
  if (typeof on === "string") {
    return (SCOPED_EVENTS as readonly string[]).includes(on) ? [on] : [];
  }
  if (Array.isArray(on)) {
    return on.filter((e): e is string =>
      typeof e === "string" &&
      (SCOPED_EVENTS as readonly string[]).includes(e)
    );
  }
  if (!isRecord(on)) return [];
  return SCOPED_EVENTS.filter((event) => {
    if (!(event in on)) return false;
    const cfg = on[event];
    return !(isRecord(cfg) && ("paths" in cfg || "paths-ignore" in cfg));
  });
}

const CHANGE_DETECTION_ACTIONS = new Set([
  "dorny/paths-filter",
  "tj-actions/changed-files",
]);

/** A paths-filter step, or a job whose `if:` reads another job's outputs. */
function hasChangeDetection(jobs: Rec): boolean {
  return Object.values(jobs).filter(isRecord).some((job) =>
    (typeof job["if"] === "string" &&
      /needs\.[\w-]+\.outputs\./.test(job["if"])) ||
    stepsOf(job).some((s) => CHANGE_DETECTION_ACTIONS.has(actionOf(s) ?? ""))
  );
}

// ---------------------------------------------------------------------------
// 39 — cached from previous runs
// ---------------------------------------------------------------------------

/** cargo subcommands that compile the workspace (not fmt, deny, audit). */
const CARGO_COMPILE_RE =
  /\bcargo\s+(?:\+\S+\s+)?(?:build|test|clippy|check|run|llvm-cov|nextest|lambda\s+build|doc)\b/;

const CARGO_CACHE_ACTIONS = new Set(["swatinem/rust-cache"]);

/** Generic caches that satisfy any toolchain's cache in a job. */
const GENERIC_CACHE_ACTIONS = new Set([
  "actions/cache",
  "actions/cache/restore",
]);

/**
 * `setup-*` actions with a built-in cache input, and the install command
 * that makes the cache worth having — a global tool install has no lockfile
 * to key a cache on.
 */
const SETUP_CACHES: readonly {
  action: string;
  input: string;
  install: RegExp;
}[] = [
  {
    action: "actions/setup-node",
    input: "cache",
    install:
      /\b(?:npm\s+ci|npm\s+(?:install|i)(?![^\n]*\s(?:-g|--global)\b)|pnpm\s+install|yarn(?:\s+install)?\s*$)/m,
  },
  {
    action: "actions/setup-python",
    input: "cache",
    install:
      /\b(?:pip\s+install\s+(?:-r|-e|\.)|poetry\s+install|pipenv\s+install|uv\s+sync)/,
  },
  {
    action: "actions/setup-java",
    input: "cache",
    install: /\b(?:gradle|gradlew|mvn|mvnw|sbt)\b/,
  },
  {
    action: "actions/setup-dotnet",
    input: "cache",
    install: /\bdotnet\s+(?:restore|build|test)\b/,
  },
  {
    action: "denoland/setup-deno",
    input: "cache",
    install: /\bdeno\s+(?:task|test|install|cache|check|compile|run)\b/,
  },
  {
    action: "ruby/setup-ruby",
    input: "bundler-cache",
    install: /\bbundle\s+install\b/,
  },
];

/** A cache key that is unique to the run, so it is never hit again. */
const RUN_UNIQUE_KEY_RE =
  /github\.(?:run_id|run_number|run_attempt)|\$\(date|\bdate\s+\+/;

function cacheLeads(job: Rec): string[] {
  const steps = stepsOf(job);
  const actions = new Set(
    steps.map(actionOf).filter((a): a is string => a !== undefined),
  );
  const hasGeneric = [...actions].some((a) => GENERIC_CACHE_ACTIONS.has(a));
  const run = runText(job);
  const leads: string[] = [];

  if (
    CARGO_COMPILE_RE.test(run) && !hasGeneric &&
    ![...actions].some((a) => CARGO_CACHE_ACTIONS.has(a))
  ) {
    leads.push(
      "compiles with cargo but has no cargo cache (no `Swatinem/rust-cache` " +
        "or `actions/cache` step), so every run builds the tree from nothing",
    );
  }

  for (const step of steps) {
    const action = actionOf(step);
    const setup = SETUP_CACHES.find((s) => s.action === action);
    if (setup) {
      const input = withOf(step)[setup.input];
      const cached = input !== undefined && input !== false && input !== "";
      if (!cached && !hasGeneric && setup.install.test(run)) {
        leads.push(
          `\`${setup.action}\` installs dependencies with no \`${setup.input}:\` ` +
            "input and no `actions/cache` step",
        );
      }
    }
    if (action !== undefined && GENERIC_CACHE_ACTIONS.has(action)) {
      const w = withOf(step);
      const key = typeof w["key"] === "string" ? w["key"] : "";
      if (RUN_UNIQUE_KEY_RE.test(key) && !("restore-keys" in w)) {
        leads.push(
          "`actions/cache` key is unique to the run and has no " +
            "`restore-keys`, so it is saved every run and never restored",
        );
      }
    }
    if (
      action === "docker/build-push-action" && !("cache-from" in withOf(step))
    ) {
      leads.push(
        "`docker/build-push-action` has no `cache-from`, so every layer " +
          "rebuilds on every run",
      );
    }
  }
  return leads;
}

// ---------------------------------------------------------------------------
// 40 — runs in parallel
// ---------------------------------------------------------------------------

const LINT_RE =
  /\b(?:cargo\s+fmt|cargo\s+clippy|eslint|prettier\s+--check|deno\s+(?:lint|fmt\s+--check)|npm\s+run\s+lint|ruff|flake8|golangci-lint|shellcheck|markdownlint)/;
const TEST_RE =
  /\b(?:cargo\s+test|cargo\s+nextest|npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|deno\s+test|pytest|go\s+test|dotnet\s+test|mvn\s+(?:\S+\s+)*test|gradlew?\s+test)\b/;

// ---------------------------------------------------------------------------
// 41 — build once, deploy the artefact
// ---------------------------------------------------------------------------

/**
 * Build commands, captured as a normalised signature so the same build in
 * two workflows compares equal. A repo build script whose name says it
 * builds or packages counts, by path.
 */
const BUILD_RES: readonly RegExp[] = [
  /\bcargo\s+(?:lambda\s+)?build\b/g,
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/g,
  /\bdeno\s+task\s+build\b/g,
  /\bdocker\s+(?:buildx\s+)?build\b/g,
  /\bgo\s+build\b/g,
  /\bdotnet\s+publish\b/g,
  /(?:\.\/|\.github\/)?[\w./-]*(?:build|artifact|artefact|package)[\w.-]*\.sh\b/g,
];

function buildSignatures(job: Rec): Set<string> {
  const run = runText(job);
  const sigs = new Set<string>();
  for (const re of BUILD_RES) {
    for (const m of run.matchAll(re)) {
      sigs.add(m[0].replace(/^\.\//, "").replace(/\s+/g, " "));
    }
  }
  if (
    stepsOf(job).some((s) => actionOf(s) === "docker/build-push-action")
  ) {
    sigs.add("docker build");
  }
  return sigs;
}

const DEPLOY_RE =
  /\b(?:aws\s+(?:cloudformation\s+deploy|lambda\s+update-function-code|s3\s+sync|ecs\s+update-service)|cdk\s+deploy|sam\s+deploy|serverless\s+deploy|sls\s+deploy|terraform\s+apply|pulumi\s+up|kubectl\s+apply|helm\s+upgrade|docker\s+push|npm\s+publish|cargo\s+publish|flyctl\s+deploy|wrangler\s+(?:deploy|publish)|vercel\s+deploy)\b/;

function deploys(jobs: Rec): boolean {
  return Object.values(jobs).filter(isRecord).some((job) =>
    DEPLOY_RE.test(runText(job)) || job["environment"] !== undefined
  );
}

/** A download of another run's artefact — the build-once shape. */
function downloadsCiArtefact(jobs: Rec): boolean {
  return Object.values(jobs).filter(isRecord).some((job) =>
    stepsOf(job).some((s) => {
      const action = actionOf(s);
      if (action === "dawidd6/action-download-artifact") return true;
      return action === "actions/download-artifact" &&
        "run-id" in withOf(s);
    })
  );
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface ParsedWorkflow {
  file: WorkflowFile;
  jobs: Rec;
  on: unknown;
}

function parsedWorkflows(files: readonly WorkflowFile[]): ParsedWorkflow[] {
  const out: ParsedWorkflow[] = [];
  for (const file of files) {
    if (file.kind !== "workflow" || !isRecord(file.parsed)) continue;
    const jobs = file.parsed["jobs"];
    if (!isRecord(jobs)) continue;
    out.push({ file, jobs, on: readOnBlock(file.parsed) });
  }
  return out;
}

/** Whether a workflow fires on push or pull_request at all. */
function firesOnPushOrPr(on: unknown): boolean {
  if (typeof on === "string") return on === "push" || on === "pull_request";
  if (Array.isArray(on)) {
    return on.includes("push") || on.includes("pull_request");
  }
  return isRecord(on) && ("push" in on || "pull_request" in on);
}

/**
 * List the cost and speed leads in a repository's workflows.
 *
 * @param files - The workflow files the audit template already read.
 * @returns Leads sorted by file, check and line; empty when none apply.
 */
export function scanWorkflowCost(
  files: readonly WorkflowFile[],
): CostCandidate[] {
  const workflows = parsedWorkflows(files);
  const out: CostCandidate[] = [];

  for (const { file, jobs, on } of workflows) {
    const unscoped = unscopedEvents(on);
    if (unscoped.length > 0 && !hasChangeDetection(jobs)) {
      out.push({
        check: 37,
        file: file.path,
        line: onLine(file.rawText),
        detail: `runs every job on ${
          unscoped.map((e) => `\`${e}\``).join(" and ")
        } with no \`paths:\` / \`paths-ignore:\` and no job-level change ` +
          "detection",
      });
    }

    for (const [name, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const line = jobLine(file.rawText, name);
      for (const detail of cacheLeads(job)) {
        out.push({ check: 39, file: file.path, line, job: name, detail });
      }
      const run = runText(job);
      if (
        LINT_RE.test(run) && TEST_RE.test(run) && buildSignatures(job).size > 0
      ) {
        out.push({
          check: 40,
          file: file.path,
          line,
          job: name,
          detail: "lints, tests and builds back to back in one job; the " +
            "phases share no output and could run as parallel jobs",
        });
      }
    }

    if (!deploys(jobs) || downloadsCiArtefact(jobs)) continue;
    for (const [name, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      for (const sig of buildSignatures(job)) {
        const elsewhere = workflows
          .filter((w) => w.file.path !== file.path && firesOnPushOrPr(w.on))
          .filter((w) =>
            Object.values(w.jobs).filter(isRecord).some((j) =>
              buildSignatures(j).has(sig)
            )
          )
          .map((w) => `\`${w.file.path}\``);
        if (elsewhere.length === 0) continue;
        out.push({
          check: 41,
          file: file.path,
          line: jobLine(file.rawText, name),
          job: name,
          detail: `deploy rebuilds \`${sig}\`, which ${
            elsewhere.join(", ")
          } already builds, instead of downloading that run's artefact`,
        });
      }
    }
  }

  return out.sort((a, b) =>
    a.file.localeCompare(b.file) || a.check - b.check || a.line - b.line
  );
}

/**
 * Render leads for the prompt's `{{COST_CANDIDATES}}` block — one line per
 * lead, or the `(none)` sentinel.
 *
 * @param candidates - Leads from {@link scanWorkflowCost}.
 * @returns Markdown list text, or `(none)`.
 */
export function renderCostCandidates(
  candidates: readonly CostCandidate[],
): string {
  if (candidates.length === 0) return "(none)";
  return candidates.map((c) =>
    `- check ${c.check} | ${c.file}:${c.line}` +
    (c.job !== undefined ? ` | job \`${c.job}\`` : "") +
    ` | ${c.detail}`
  ).join("\n");
}
