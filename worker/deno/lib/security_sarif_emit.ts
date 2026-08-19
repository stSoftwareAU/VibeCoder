/**
 * Orchestrates the additive SARIF emission for the security-scan idle task
 * (Issue #3538, gap G2). Sits between the pure builder (`security_sarif.ts`)
 * and the uploader (`security_sarif_upload.ts`), and is the single unit the
 * template calls after the scan has filed its issues.
 *
 * It reads back the just-filed `security` issues, parses them into structured
 * findings, builds a SARIF 2.1.0 document, resolves the checkout's commit/ref,
 * and uploads to GitHub code scanning. SARIF is **additive** — the issue path
 * has already succeeded, so this never throws and never fails the wrapper
 * task; instead it returns a short status line the template appends to its
 * summary. Every outcome is surfaced (fail-loud, Issue #3234) — a missing
 * code-scanning surface or a hard upload error is reported, never hidden.
 *
 * Australian English throughout (behaviour, normalise).
 */

import {
  buildSecuritySarif,
  parseSecurityFindings,
  type SecurityIssueLike,
} from "./security_sarif.ts";
import {
  defaultGhExec,
  defaultGitRunner,
  type GhExec,
  type GitRunner,
  resolveGitRef,
  type SarifUploadResult,
  uploadSecuritySarif,
} from "./security_sarif_upload.ts";
import { parseGhJsonArray } from "./idle_task_snapshot.ts";

/** Injected dependencies for {@link emitSecuritySarif}. */
export interface EmitSarifDeps {
  /** `gh` runner used to read the filed issues (template's retrying runner). */
  ghListFn: (args: string[]) => Promise<string>;
  /** `gh` executor (with stdin) used to upload the SARIF. */
  ghExecFn?: GhExec;
  /** git runner used to resolve the checkout's commit + ref. */
  runGitFn?: GitRunner;
}

/** Arguments for {@link emitSecuritySarif}. */
export interface EmitSarifOptions {
  /** `owner/repo` slug of the target repo. */
  repo: string;
  /** Local checkout directory of the target repo (for git rev-parse). */
  checkoutDir: string;
  /** Issue numbers filed by this scan run (the SARIF scope). */
  newlyFiled: readonly number[];
}

/** Outcome of an emission attempt — one line of it goes into the summary. */
export interface EmitSarifOutcome {
  /** Short status line appended to the wrapper close-comment summary. */
  summary: string;
  /**
   * The upload result when an upload was attempted; `null` when the run was
   * skipped before upload (no findings, no git ref, or a read error).
   */
  upload: SarifUploadResult | null;
}

/**
 * Read the just-filed `security` issues, keeping only those in `newlyFiled`,
 * and return them as {@link SecurityIssueLike}. A gh failure or malformed
 * payload returns an empty list — the SARIF step is additive, so a read hiccup
 * degrades to "nothing to upload" rather than failing the scan.
 */
async function readFiledIssues(
  repo: string,
  newlyFiled: ReadonlySet<number>,
  ghListFn: (args: string[]) => Promise<string>,
): Promise<SecurityIssueLike[]> {
  let raw: string;
  try {
    raw = await ghListFn([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      "security",
      "--json",
      "number,title,body,labels",
      "--limit",
      "200",
    ]);
  } catch {
    return [];
  }
  const issues: SecurityIssueLike[] = [];
  for (const item of parseGhJsonArray(raw, "read filed security issues")) {
    if (item === null || typeof item !== "object") continue;
    const record = item as {
      number?: unknown;
      title?: unknown;
      body?: unknown;
      labels?: unknown;
    };
    const number = record.number;
    if (typeof number !== "number" || !newlyFiled.has(number)) continue;
    const labels = Array.isArray(record.labels)
      ? record.labels
        .map((l) =>
          l && typeof l === "object" &&
            typeof (l as { name?: unknown }).name === "string"
            ? (l as { name: string }).name
            : typeof l === "string"
            ? l
            : ""
        )
        .filter((l) => l.length > 0)
      : [];
    issues.push({
      title: typeof record.title === "string" ? record.title : "",
      body: typeof record.body === "string" ? record.body : "",
      labels,
    });
  }
  return issues;
}

/**
 * Emit and upload SARIF for the findings filed by a security-scan run.
 *
 * Never throws. Returns a status summary and the raw upload result (or `null`
 * when skipped before upload). The returned `summary` is designed to be
 * appended to the wrapper's close comment.
 */
export async function emitSecuritySarif(
  options: EmitSarifOptions,
  deps: EmitSarifDeps,
): Promise<EmitSarifOutcome> {
  const newlyFiled = new Set(options.newlyFiled);
  if (newlyFiled.size === 0) {
    return { summary: "SARIF: skipped (0 findings).", upload: null };
  }

  const ghExecFn = deps.ghExecFn ?? defaultGhExec;
  const runGitFn = deps.runGitFn ?? defaultGitRunner;

  try {
    const issues = await readFiledIssues(
      options.repo,
      newlyFiled,
      deps.ghListFn,
    );
    const findings = parseSecurityFindings(issues);
    if (findings.length === 0) {
      return {
        summary: "SARIF: skipped (no parseable findings).",
        upload: null,
      };
    }

    const gitRef = await resolveGitRef(options.checkoutDir, runGitFn);
    if (!gitRef.ok) {
      return {
        summary: `SARIF: not uploaded — ${gitRef.error}`,
        upload: null,
      };
    }

    const sarif = buildSecuritySarif(findings);
    const upload = await uploadSecuritySarif(
      {
        repo: options.repo,
        commitSha: gitRef.value.commitSha,
        ref: gitRef.value.ref,
        sarifJson: JSON.stringify(sarif),
      },
      ghExecFn,
    );

    switch (upload.kind) {
      case "uploaded":
        return {
          summary:
            `SARIF: uploaded ${findings.length} findings to code scanning.`,
          upload,
        };
      case "code-scanning-unavailable":
        return {
          summary:
            `SARIF: code scanning unavailable (HTTP ${upload.status}) — findings filed as issues only.`,
          upload,
        };
      case "error":
        return {
          summary: `SARIF: upload failed — ${upload.error}`,
          upload,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { summary: `SARIF: emission threw — ${message}`, upload: null };
  }
}
