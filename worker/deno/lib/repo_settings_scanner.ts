/**
 * Repository-settings pre-filer for the GitHub Actions audit (Issues #4397,
 * #4398, #4401 — GHA-PERM-002/003/004, GHA-MONITOR-004).
 *
 * The workflow YAML can score perfectly on least privilege while the
 * repository settings underneath it are wide open — observed on this repo:
 * a read-write default `GITHUB_TOKEN` that may approve pull requests, no
 * allow-list of actions, platform SHA-pin enforcement off, a thoughtful
 * CODEOWNERS the Develop ruleset never consults, secret scanning and push
 * protection disabled. Only an admin can flip those; the worker cannot. So
 * the weekly audit reads them (read-only `gh api` calls) and files one
 * stable finding per open setting that says plainly a human must act —
 * drift becomes visible on the board instead of living in a report.
 *
 * Failure policy: an unreadable endpoint is reported through
 * `onLookupFailure` and yields no finding for that endpoint — never a
 * silent "hardened".
 *
 * Wording note: the outbound secret masker rewrites `secret_scanning*`
 * key/value pairs and `id-token: write` to `***REDACTED***` in issue bodies
 * (documented in the #4377 gap analysis), so the finding text names those
 * settings in prose and never as `key: value` pairs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { allowListCovers } from "./repo_settings_harden.ts";
import type {
  GhCommandFn,
  WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** One settings finding, shaped like the workflow-file findings. */
export interface RepoSettingsFinding {
  findingId: string;
  severity: WorkflowFindingSeverity;
  title: string;
  /** Always `repository settings` — there is no file to point at. */
  file: string;
  lines: number;
  whyItMatters: string;
  suggestedFix: string;
  evidence: string;
}

/** Options for {@link scanRepoSettings}. */
export interface ScanRepoSettingsOptions {
  /** The branch whose rules are read (the default branch). */
  defaultBranch: string;
  /** Whether `.github/CODEOWNERS` exists in the checkout. */
  hasCodeowners: boolean;
  knownOpenFindingIds?: Iterable<string>;
  onLookupFailure?: (what: string, reason: string) => void;
  /**
   * `<owner>/<repo>@*` patterns the workflows need — including the actions
   * their composite steps pull in (Issue #4424). When given and the
   * repository runs a "selected" allow-list, any pattern the list omits is a
   * finding: the job that needs it fails at set-up on every run.
   */
  requiredActionPatterns?: readonly string[];
}

const FILE = "repository settings";
const ADMIN =
  "Repository admin action — the worker cannot change repository settings.";

async function readJson<T>(
  gh: GhCommandFn,
  endpoint: string,
  what: string,
  onFailure?: (what: string, reason: string) => void,
): Promise<T | undefined> {
  try {
    const raw = await gh(["api", endpoint]);
    return JSON.parse(raw) as T;
  } catch (err) {
    onFailure?.(what, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** Read the four settings surfaces and return one finding per open setting. */
export async function scanRepoSettings(
  repo: string,
  ghCommandFn: GhCommandFn,
  options: ScanRepoSettingsOptions,
): Promise<RepoSettingsFinding[]> {
  const known = new Set(options.knownOpenFindingIds ?? []);
  const out: RepoSettingsFinding[] = [];
  const add = (f: RepoSettingsFinding) => {
    if (!known.has(f.findingId)) out.push(f);
  };

  // 1. Workflow token defaults (GHA-PERM-002).
  const workflow = await readJson<{
    default_workflow_permissions?: string;
    can_approve_pull_request_reviews?: boolean;
  }>(
    ghCommandFn,
    `repos/${repo}/actions/permissions/workflow`,
    "actions/permissions/workflow",
    options.onLookupFailure,
  );
  if (workflow) {
    if (workflow.default_workflow_permissions === "write") {
      add({
        findingId: "BP-REPO-DEFAULT-TOKEN-WRITE",
        severity: "high",
        title:
          "🔴 Repository default GITHUB_TOKEN is read-write — any workflow without its own permissions block inherits write scope",
        file: FILE,
        lines: 0,
        whyItMatters:
          "Settings → Actions → General → Workflow permissions is set to read-and-write. Every workflow in the tree declares " +
          "its own read-only permissions today, so safety rests on every future author remembering the block; the guide's " +
          "core ask is a read-only default so a forgotten block fails closed (Issue #4398, GHA-PERM-002).",
        suggestedFix:
          `${ADMIN} Settings → Actions → General → Workflow permissions → "Read repository contents and packages permissions".`,
        evidence:
          `default_workflow_permissions=${workflow.default_workflow_permissions}`,
      });
    }
    if (workflow.can_approve_pull_request_reviews === true) {
      add({
        findingId: "BP-REPO-ACTIONS-MAY-APPROVE-PRS",
        severity: "high",
        title:
          "🔴 GitHub Actions may create and approve pull requests — the workflow token is a self-approval path",
        file: FILE,
        lines: 0,
        whyItMatters:
          "With this setting on, a workflow token can approve a pull request; combined with a ruleset that requires no " +
          "human approval this is a self-approval path for anything that can run a workflow (Issue #4398, GHA-PERM-002).",
        suggestedFix:
          `${ADMIN} Settings → Actions → General → untick "Allow GitHub Actions to create and approve pull requests".`,
        evidence:
          `can_approve_pull_request_reviews=${workflow.can_approve_pull_request_reviews}`,
      });
    }
  }

  // 2. Which actions may run, and platform SHA-pin enforcement (GHA-PERM-003).
  const actions = await readJson<{
    allowed_actions?: string;
    sha_pinning_required?: boolean;
  }>(
    ghCommandFn,
    `repos/${repo}/actions/permissions`,
    "actions/permissions",
    options.onLookupFailure,
  );
  if (actions) {
    if (actions.allowed_actions === "all") {
      add({
        findingId: "BP-REPO-ACTIONS-ALLOW-ALL",
        severity: "medium",
        title:
          "🟠 All GitHub Actions are allowed — no allow-list restricts which third-party actions may run",
        file: FILE,
        lines: 0,
        whyItMatters:
          'Actions permissions is "Allow all actions and reusable workflows". An allow-list confines what a workflow ' +
          "edit can pull in to the actions the repository has vetted (Issue #4398, GHA-PERM-003 / GHA-HYGIENE-004).",
        suggestedFix:
          `${ADMIN} Settings → Actions → General → "Allow enterprise, and select non-enterprise, actions and reusable workflows", ` +
          "listing the actions the workflows use (see the SHA-pin catalogue).",
        evidence: `allowed_actions=${actions.allowed_actions}`,
      });
    }
    if (
      actions.allowed_actions === "selected" &&
      options.requiredActionPatterns &&
      options.requiredActionPatterns.length > 0
    ) {
      const selected = await readJson<{ patterns_allowed?: string[] }>(
        ghCommandFn,
        `repos/${repo}/actions/permissions/selected-actions`,
        "actions/permissions/selected-actions",
        options.onLookupFailure,
      );
      if (selected) {
        const have = selected.patterns_allowed ?? [];
        const missing = options.requiredActionPatterns.filter((p) =>
          !allowListCovers(have, p)
        );
        if (missing.length > 0) {
          add({
            findingId: "BP-REPO-ACTIONS-ALLOW-LIST-INCOMPLETE",
            severity: "medium",
            title:
              "🟠 The action allow-list omits an action the workflows need — the job that uses it fails at set-up on every run",
            file: FILE,
            lines: 0,
            whyItMatters:
              'Actions permissions is "selected" but the pattern list does not cover every action the workflows run — ' +
              "including the ones a composite action pulls in (a composite `uses:` is enforced like a workflow `uses:`). " +
              "The affected job is refused before its first step, so the check it provides is silently absent (Issue #4424).",
            suggestedFix:
              `${ADMIN} Run \`mod.ts repo-settings-harden --repo <owner/name> --apply\` from the checkout: it follows composite ` +
              "actions' own uses: and extends the list; --allow-action owner/repo adds anything it cannot read.",
            evidence: `patterns_allowed misses: ${missing.join(", ")}`,
          });
        }
      }
    }
    if (actions.sha_pinning_required === false) {
      add({
        findingId: "BP-REPO-SHA-PIN-NOT-ENFORCED",
        severity: "medium",
        title:
          "🟠 Platform SHA-pin enforcement is off — pinning is convention plus a weekly audit, not a rule",
        file: FILE,
        lines: 0,
        whyItMatters:
          '"Require actions to be pinned to a full-length commit SHA" (GA since August 2025) makes a mutable-tag ' +
          "reference fail to run outright. Today a tag reference merged by mistake would run until the weekly audit " +
          "noticed (Issue #4398, GHA-PERM-003).",
        suggestedFix:
          `${ADMIN} Settings → Actions → General → tick "Require actions to be pinned to a full-length commit SHA".`,
        evidence: `sha_pinning_required=${actions.sha_pinning_required}`,
      });
    }
  }

  // 3. The default branch's pull-request rule (GHA-PERM-004).
  const rules = await readJson<
    Array<{ type?: string; parameters?: Record<string, unknown> }>
  >(
    ghCommandFn,
    `repos/${repo}/rules/branches/${encodeURIComponent(options.defaultBranch)}`,
    `rules/branches/${options.defaultBranch}`,
    options.onLookupFailure,
  );
  if (rules) {
    const pr = rules.find((r) => r.type === "pull_request")?.parameters ??
      undefined;
    const approvals = typeof pr?.required_approving_review_count === "number"
      ? pr.required_approving_review_count as number
      : 0;
    const codeowners = pr?.require_code_owner_review === true;
    // Code-owner review is a human gate on the paths that matter (workflows,
    // actions, scripts — Issue #4397); with it enforced, a zero approval
    // count on the rest is the operator's chosen policy for an autonomous
    // fleet, not a missing review.
    if (!pr || (approvals < 1 && !codeowners)) {
      add({
        findingId: "BP-REPO-RULESET-NO-REVIEW",
        severity: "high",
        title:
          `🔴 The ${options.defaultBranch} ruleset requires no approving review — any actor who can open a PR can merge it`,
        file: FILE,
        lines: 0,
        whyItMatters:
          `The pull-request rule on ${options.defaultBranch} sets required approving reviews to ${approvals}` +
          (pr ? "" : " (no pull_request rule at all)") +
          ". A change to .github/workflows/ — an unreviewed grant of CI credentials — can merge unreviewed " +
          "(Issue #4397, GHA-PERM-004).",
        suggestedFix:
          `${ADMIN} On the ${options.defaultBranch} ruleset's pull_request rule set required approving review count to at least 1 ` +
          "and consider requiring last-push approval.",
        evidence: `required_approving_review_count=${approvals}`,
      });
    }
    if (options.hasCodeowners && !codeowners) {
      add({
        findingId: "BP-REPO-CODEOWNERS-NOT-ENFORCED",
        severity: "high",
        title:
          "🔴 CODEOWNERS is inert — the ruleset does not require code-owner review",
        file: FILE,
        lines: 0,
        whyItMatters:
          ".github/CODEOWNERS names owners for the workflow directory, but a CODEOWNERS entry only takes effect when the " +
          "branch rule requires code-owner review; it does not (Issue #4397, GHA-PERM-004).",
        suggestedFix:
          `${ADMIN} On the ${options.defaultBranch} ruleset's pull_request rule tick "Require review from Code Owners".`,
        evidence: `require_code_owner_review=${codeowners}`,
      });
    }
  }

  // 4. Secret scanning and push protection (GHA-MONITOR-004).
  const repoInfo = await readJson<{
    security_and_analysis?: Record<string, { status?: string } | undefined>;
  }>(
    ghCommandFn,
    `repos/${repo}`,
    "repos (security_and_analysis)",
    options.onLookupFailure,
  );
  if (repoInfo?.security_and_analysis) {
    const sa = repoInfo.security_and_analysis;
    const scanning = sa["secret_scanning"]?.status;
    const push = sa["secret_scanning_push_protection"]?.status;
    if (scanning !== undefined && scanning !== "enabled") {
      add({
        findingId: "BP-REPO-SECRET-SCANNING-OFF",
        severity: "medium",
        title: "🟠 GitHub secret scanning is disabled for the repository",
        file: FILE,
        lines: 0,
        whyItMatters:
          "gitleaks scans each PR diff after the push; GitHub's own secret scanning watches the whole repository and " +
          "its history continuously and adds validity checks — a leaked credential is found even when no PR touches it " +
          "(Issue #4401, GHA-MONITOR-004). Private repositories need GitHub Secret Protection for this.",
        suggestedFix:
          `${ADMIN} Settings → Code security → enable secret scanning (and validity checks); may require enabling Secret Protection.`,
        evidence: `secret scanning status: ${scanning}`,
      });
    }
    if (push !== undefined && push !== "enabled") {
      add({
        findingId: "BP-REPO-PUSH-PROTECTION-OFF",
        severity: "medium",
        title:
          "🟠 Push protection is disabled — a leaked secret lands in history before anything scans it",
        file: FILE,
        lines: 0,
        whyItMatters:
          "Push protection blocks the push before the credential is in history — the difference between rotating a " +
          "credential and rotating it AND rewriting history across every clone (Issue #4401, GHA-MONITOR-004).",
        suggestedFix:
          `${ADMIN} Settings → Code security → enable push protection.`,
        evidence: `push protection status: ${push}`,
      });
    }
  }

  return out;
}
