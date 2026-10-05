/**
 * Repository-settings pre-filer for the GitHub Actions audit (Issues #4397,
 * #4398, #4401, #3227 — GHA-PERM-002/003/004, GHA-MONITOR-004).
 *
 * The workflow YAML can score perfectly on least privilege while the
 * repository settings underneath it are wide open — observed on this repo:
 * a read-write default `GITHUB_TOKEN` that may approve pull requests, no
 * allow-list of actions, platform SHA-pin enforcement off, a thoughtful
 * CODEOWNERS the Develop ruleset never consults, secret scanning and push
 * protection disabled, private vulnerability reporting off and no
 * SECURITY.md pointing a reporter at it. Only an admin can flip those; the
 * worker cannot. So the weekly audit reads them (read-only `gh api` calls)
 * and files one stable finding per open setting that says plainly a human
 * must act — drift becomes visible on the board instead of living in a
 * report.
 *
 * Failure policy: an unreadable endpoint is reported through
 * `onLookupFailure` and yields no finding for that endpoint — never a
 * silent "hardened".
 *
 * Exemption: secret scanning and push protection need the paid GitHub
 * Secret Protection add-on on a private or internal repository, so neither
 * finding is filed there (Issue #2225) — a finding that only asks an admin
 * to spend money is closed by hand every run. Private vulnerability
 * reporting and the SECURITY.md presence check are exempted the same way:
 * both apply to public repositories only (Issue #3227). Each skip travels
 * through `onCheckSkipped`, not `onLookupFailure`, because nothing failed,
 * and the audit names it in its own summary rather than passing it as
 * clean.
 *
 * Wording note: the outbound secret masker rewrites `secret_scanning*`
 * key/value pairs and `id-token: write` to `***REDACTED***` in issue bodies
 * (documented in the #4377 gap analysis), so the finding text names those
 * settings in prose and never as `key: value` pairs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  allowListCovers,
  needsPaidSecretProtection,
} from "./repo_settings_harden.ts";
import { isNotFoundError } from "./repo_rulesets.ts";
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
  knownOpenFindingIds?: Iterable<string>;
  onLookupFailure?: (what: string, reason: string) => void;
  /**
   * A check this run deliberately did not make (Issue #2225) — not a
   * failure, so it is reported separately from `onLookupFailure`, which
   * logs a fault. The audit records it as a skipped check so the summary
   * names what it did not cover.
   */
  onCheckSkipped?: (what: string, reason: string) => void;
  /**
   * `<owner>/<repo>@*` patterns the workflows need — including the actions
   * their composite steps pull in (Issue #4424). When given and the
   * repository runs a "selected" allow-list, any pattern the list omits is a
   * finding: the job that needs it fails at set-up on every run.
   */
  requiredActionPatterns?: readonly string[];
}

const FILE = "repository settings";
/** How the exempted check is named in the audit's skipped-checks list. */
export const SECRET_PROTECTION_SKIP_CHECK = "secret scanning / push protection";
/** Why it was skipped — rendered straight into the audit summary. */
export const SECRET_PROTECTION_SKIP_REASON =
  "private repository — needs paid GitHub Secret Protection";
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

/** Read the five settings surfaces and return one finding per open setting. */
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
    // Every default branch needs one approval (Issue #2680) — code-owner
    // review alone gates only the owned paths, so it no longer excuses a
    // zero count. Setup's `repo-settings-harden` closes this finding.
    if (approvals < 1) {
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
    // Code-owner review being off is deliberate, never a finding: the fleet
    // reviewer App cannot be a code owner, so repo-settings-harden turns it
    // off and a finding would only turn it back on.
  }

  // 4. Secret scanning and push protection (GHA-MONITOR-004).
  const repoInfo = await readJson<{
    security_and_analysis?: Record<string, { status?: string } | undefined>;
    visibility?: string;
    private?: boolean;
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
    const scanningOff = scanning !== undefined && scanning !== "enabled";
    const pushOff = push !== undefined && push !== "enabled";
    // Both settings need the paid GitHub Secret Protection add-on on a
    // private or internal repository, so a finding there only asks the admin
    // to spend money (Issue #2225). The skip is recorded, never silent.
    const exempt = (scanningOff || pushOff) &&
      needsPaidSecretProtection(repoInfo.visibility, repoInfo.private);
    if (exempt) {
      options.onCheckSkipped?.(
        SECRET_PROTECTION_SKIP_CHECK,
        SECRET_PROTECTION_SKIP_REASON,
      );
    }
    if (!exempt && scanningOff) {
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
    if (!exempt && pushOff) {
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

  // 5. Private vulnerability reporting and a SECURITY.md pointing at it
  // (Issue #3227). Both apply to public repositories only — the same
  // exemption as section 4, recorded through `onCheckSkipped` rather than
  // `onLookupFailure` because nothing failed.
  if (repoInfo) {
    const exempt = needsPaidSecretProtection(
      repoInfo.visibility,
      repoInfo.private,
    );
    if (exempt) {
      options.onCheckSkipped?.(
        PVR_AND_SECURITY_MD_SKIP_CHECK,
        PVR_AND_SECURITY_MD_SKIP_REASON,
      );
    } else {
      const pvr = await readJson<{ enabled?: boolean }>(
        ghCommandFn,
        `repos/${repo}/private-vulnerability-reporting`,
        "private-vulnerability-reporting",
        options.onLookupFailure,
      );
      if (pvr?.enabled === false) {
        add({
          findingId: "BP-REPO-PVR-OFF",
          severity: "medium",
          title: "🟠 Private vulnerability reporting is disabled",
          file: FILE,
          lines: 0,
          whyItMatters:
            "Without it, a security reporter on this public repository has no private channel to the maintainers and " +
            "may disclose the vulnerability publicly instead (Issue #3227).",
          suggestedFix:
            `${ADMIN} Settings → Code security → Private vulnerability reporting → Enable.`,
          evidence: `private-vulnerability-reporting enabled=${pvr.enabled}`,
        });
      }

      const securityMd = await findSecurityMdOnDefaultBranch(
        repo,
        ghCommandFn,
        options.onLookupFailure,
      );
      if (securityMd === "absent") {
        add({
          findingId: "BP-REPO-SECURITY-POLICY-MISSING",
          severity: "medium",
          title: "🟠 No SECURITY.md security policy",
          file: FILE,
          lines: 0,
          whyItMatters:
            "With no SECURITY.md a reporter has no documented, private way to disclose a vulnerability and may default " +
            "to a public issue instead (Issue #3227).",
          suggestedFix:
            "Commit a SECURITY.md to the root, .github/ or docs/ of the default branch that points reporters at " +
            "private vulnerability reporting.",
          evidence: "SECURITY.md not found at SECURITY.md, .github/SECURITY.md or docs/SECURITY.md",
        });
      }
    }
  }

  return out;
}

/** The locations GitHub reads a SECURITY.md security policy from. */
const SECURITY_MD_PATHS = [
  "SECURITY.md",
  ".github/SECURITY.md",
  "docs/SECURITY.md",
] as const;

/**
 * Find a SECURITY.md on the default branch. Only a 404 at every location is
 * `"absent"`; any other error is reported through `onLookupFailure` and
 * yields `"error"` — never mistaken for a missing file (Issue #3227).
 */
async function findSecurityMdOnDefaultBranch(
  repo: string,
  defaultBranch: string,
  ghCommandFn: GhCommandFn,
  onLookupFailure?: (what: string, reason: string) => void,
): Promise<"present" | "absent" | "error"> {
  for (const path of SECURITY_MD_PATHS) {
    try {
      await ghCommandFn([
        "api",
        `repos/${repo}/contents/${path}?ref=${
          encodeURIComponent(defaultBranch)
        }`,
      ]);
      return "present";
    } catch (err) {
      if (isNotFoundError(err)) continue;
      onLookupFailure?.(
        "SECURITY.md",
        err instanceof Error ? err.message : String(err),
      );
      return "error";
    }
  }
  return "absent";
}
