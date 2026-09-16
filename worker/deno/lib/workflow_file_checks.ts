/**
 * The file-scoped GitHub Actions audit checks, as one ordered table
 * (Issue #1822, part of #1755).
 *
 * The `github-actions-audit` idle task runs a pile of native pre-filers
 * over the workflow files it reads, and `quality.sh` runs two workflow
 * hygiene rules over this repository's own `.github/workflows`. Both sets
 * decide entirely from the **file text** — no run history, no network, no
 * repository settings — so both are checks a rendered workflow template
 * can be held to before it is ever pushed into a managed repository.
 *
 * This table is the single list of those checks. It duplicates no scanner
 * logic: every entry is a thin adapter over the pure scanner the audit
 * template already calls, normalising its finding into one shape so a
 * caller can iterate the checks rather than hand-writing a call per
 * scanner (and silently omitting one).
 *
 * Deliberately **not** in the table, because no template can satisfy them
 * — they read something other than the file:
 *
 *   - `scanRecentRunsForDeprecations` — reads recent **run logs** via `gh`
 *   - `scanGitleaksPrCoverage`        — reads recent **pull requests**
 *   - `scanActionAdvisories`          — queries the **GHSA database**
 *   - `scanRepoSettings`              — reads **repository settings**
 *   - `scanWorkerTokenPrivileges`     — reads **token privileges**
 *   - `checkLinterInCI`               — reads the **repository tree**
 *
 * The last one is the near miss worth stating: it decides from workflow
 * text, but it takes a `repoPath`, walks `.github/workflows` and the repo
 * root, and answers a **repository-level** question — "does *this repo*
 * run a linter in CI". No single template can satisfy it, because the
 * answer depends on the whole set of workflows a repository ends up with,
 * so it is excluded on the same "a template cannot control it" ground as
 * the five above rather than being a check this table drops.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import type { WorkflowFile } from "./workflow_scan_common.ts";
import { scanActionPins } from "./action_pin_scanner.ts";
import { scanWorkflowPermissions } from "./workflow_permissions_scanner.ts";
import { scanWorkflowTriggers } from "./workflow_trigger_scanner.ts";
import {
  persistCredentialsStepId,
  scanCheckoutPersistCredentials,
} from "./checkout_persist_credentials_scanner.ts";
import { scanMilestoneBranchFilters } from "./milestone_branch_filter_scanner.ts";
import { scanCiInstallPins } from "./ci_install_pin_scanner.ts";
import { scanRunInjection } from "./run_injection_scanner.ts";
import {
  artifactUploadStepId,
  scanArtifactUploads,
} from "./artifact_upload_scanner.ts";
import { scanGitleaksDrift } from "./gitleaks_drift_scanner.ts";
import {
  collectActionPins,
  findVersionCommentDrift,
  scanWorkflowForStrictMode,
} from "./workflow_hygiene_check.ts";

/**
 * One violation reported by a {@link WorkflowFileCheck}, normalised across
 * the two finding shapes the underlying scanners return.
 */
export interface WorkflowFileCheckFinding {
  /** Stable finding id (scanners) or hygiene kind (hygiene rules). */
  id: string;
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line the finding anchors to. */
  line: number;
  /** Human-readable description of what is wrong. */
  detail: string;
}

/** Repository facts a check may need beyond the files themselves. */
export interface WorkflowFileCheckContext {
  /** The repository's default branch, e.g. `main`. */
  defaultBranch: string;
}

/** One file-scoped audit check. */
export interface WorkflowFileCheck {
  /** Stable kebab-case identifier, unique within the table. */
  id: string;
  /** Short human-readable statement of the rule the check enforces. */
  label: string;
  /** Run the check, returning one finding per violation. */
  run(
    files: readonly WorkflowFile[],
    ctx: WorkflowFileCheckContext,
  ): WorkflowFileCheckFinding[];
}

/** Shape every native pre-filer finding shares. */
interface ScannerFinding {
  findingId: string;
  title: string;
  file: string;
  lines: number;
}

/** Adapt a native pre-filer finding to the common shape. */
function fromScanner(finding: ScannerFinding): WorkflowFileCheckFinding {
  return {
    id: finding.findingId,
    file: finding.file,
    line: finding.lines,
    detail: finding.title,
  };
}

/** The per-file pre-filer finding shape (Issue #2221). */
interface PerFileScannerFinding {
  workflowPath: string;
  file: string;
  steps: readonly { job: string; stepIndex: number; line: number }[];
}

/**
 * Adapt a per-file pre-filer finding to **one gate finding per offending
 * step**.
 *
 * The audit files one issue per workflow file (Issue #2221) because one
 * edit fixes every step in it, but this gate answers a different
 * question: what did *this branch* introduce? Its base-vs-head diff is
 * keyed by `(finding id, file)`, so collapsing a file's steps into one
 * entry here would let a step the run **added** hide behind a
 * pre-existing one. The id reported per step is the one an in-source
 * `best-practice-ignore` marker suppresses, so the remedy the gate
 * message names still works.
 */
function fromPerFileScanner(
  findings: readonly PerFileScannerFinding[],
  stepId: (path: string, job: string, stepIndex: number) => string,
  detail: (job: string, stepIndex: number, file: string) => string,
): WorkflowFileCheckFinding[] {
  return findings.flatMap((finding) =>
    finding.steps.map((step) => ({
      id: stepId(finding.workflowPath, step.job, step.stepIndex),
      file: finding.file,
      line: step.line,
      detail: detail(step.job, step.stepIndex, finding.file),
    }))
  );
}

/** Adapt a workflow-hygiene violation to the common shape. */
function fromHygiene(
  violation: { kind: string; file: string; line: number; detail: string },
): WorkflowFileCheckFinding {
  return {
    id: violation.kind,
    file: violation.file,
    line: violation.line,
    detail: violation.detail,
  };
}

/**
 * Every audit check decidable from the workflow files alone, in the order
 * the audit template runs them, with the two `quality.sh` hygiene rules
 * appended.
 *
 * Adding or removing an entry is a deliberate edit:
 * `worker/deno/tests/workflow_template_audit_conformance_test.ts` asserts
 * the exact id list.
 */
export const WORKFLOW_FILE_CHECKS: readonly WorkflowFileCheck[] = [
  {
    id: "action-pins",
    label: "every `uses:` reference is pinned to a 40-character commit SHA",
    run: (files) => scanActionPins(files).map(fromScanner),
  },
  {
    id: "workflow-permissions",
    label: "every workflow and job declares least-privilege `permissions:`",
    run: (files) => scanWorkflowPermissions(files).map(fromScanner),
  },
  {
    id: "workflow-triggers",
    label: "no test/lint/scan workflow triggers on push to the default branch",
    run: (files, ctx) =>
      scanWorkflowTriggers(files, { defaultBranch: ctx.defaultBranch })
        .map(fromScanner),
  },
  {
    id: "checkout-persist-credentials",
    label:
      "every `actions/checkout` sets `persist-credentials: false` unless the job pushes",
    run: (files) =>
      fromPerFileScanner(
        scanCheckoutPersistCredentials(files),
        persistCredentialsStepId,
        (job, stepIndex, file) =>
          `🟠 Job \`${job}\` step ${stepIndex} checkout persists credentials ` +
          `(\`${file}\`)`,
      ),
  },
  {
    id: "milestone-branch-filters",
    label:
      "every `pull_request` branch filter also matches `milestone/<slug>` branches",
    run: (files) => scanMilestoneBranchFilters(files).map(fromScanner),
  },
  {
    id: "ci-install-pins",
    label: "every `run:` package install pins an exact version",
    run: (files) => scanCiInstallPins(files).map(fromScanner),
  },
  {
    id: "run-injection",
    label:
      "no `run:` step interpolates an attacker-controllable `${{ github.* }}` field",
    run: (files) => scanRunInjection(files).map(fromScanner),
  },
  {
    id: "artifact-uploads",
    label: "no `actions/upload-artifact` step uploads the whole workspace",
    run: (files) =>
      fromPerFileScanner(
        scanArtifactUploads(files),
        artifactUploadStepId,
        (job, stepIndex, file) =>
          `🟢 Job \`${job}\` step ${stepIndex} uploads the whole workspace ` +
          `as an artefact (\`${file}\`)`,
      ),
  },
  {
    id: "gitleaks-drift",
    label: "the gitleaks workflow still matches the canonical hardened shape",
    run: (files) => scanGitleaksDrift(files).map(fromScanner),
  },
  {
    id: "strict-mode",
    label: "multi-line `run:` opens with `set -euo pipefail`",
    run: (files) =>
      files.flatMap((file) =>
        scanWorkflowForStrictMode(file.rawText, file.path).map(fromHygiene)
      ),
  },
  {
    id: "version-comment-drift",
    label: "one pinned SHA carries one version comment",
    run: (files) =>
      findVersionCommentDrift(
        files.flatMap((file) => collectActionPins(file.rawText, file.path)),
      ).map(fromHygiene),
  },
];
