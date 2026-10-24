/** Fence coverage for repair and diagnostic builders (Issue #4207). */
import {
  buildBatchRepairPrompt,
  buildRepairPrompt,
} from "../lib/failure_detection_repair.ts";
import {
  buildDriftQuestionPrompt,
  buildDriftRecoveryPrompt,
} from "../lib/pr_feedback_drift_check.ts";
import { buildRebasePassPrompt } from "../lib/branch_conflict_pass.ts";
import { buildSummariseUserPrompt } from "../lib/claude_runner.ts";
import {
  buildLlmGateText,
  buildSecurityScanPrompt,
} from "../lib/security_scanner.ts";
import { buildQualityFixPrompt } from "../lib/phases/quality_gate_remediation_phase.ts";
import { formatCarryoverFindings } from "../lib/baseline_gate.ts";
import {
  assertOnlyInsideUntrustedFence,
  type FenceCoverageRow,
  knownLeakRow,
  makeCanary,
  runFenceCoverageRows,
} from "./support/untrusted_fence.ts";

const BOUNDARY_ID = "a1b2c3d4e5f6";
const repair = {
  title: makeCanary("RepairTitle"),
  body: makeCanary("RepairBody"),
};
const batch = {
  firstTitle: makeCanary("BatchFirstTitle"),
  firstBody: makeCanary("BatchFirstBody"),
  secondTitle: makeCanary("BatchSecondTitle"),
  secondBody: makeCanary("BatchSecondBody"),
};
const drift = {
  baseRef: makeCanary("DriftBaseRef"),
  file: makeCanary("DriftFile"),
  request: makeCanary("DriftRequest"),
  proseFile: makeCanary("DriftProseFile"),
};
const recovery = {
  file: makeCanary("RecoveryFile"),
  sentence: makeCanary("RecoverySentence"),
  reason: makeCanary("RecoveryReason"),
  mismatch: makeCanary("RecoveryMismatch"),
  docsSweep: makeCanary("RecoveryDocsSweep"),
  staleQuote: makeCanary("RecoveryStaleQuote"),
  staleCitation: makeCanary("RecoveryStaleCitation"),
  uncheckedFigure: makeCanary("RecoveryUncheckedFigure"),
  mutationComment: makeCanary("RecoveryMutationComment"),
};
const rebase = {
  branch: makeCanary("RebaseBranch"),
  baseRef: makeCanary("RebaseBaseRef"),
  detail: makeCanary("RebaseDetail"),
};
const summariseContent = makeCanary("SummariseContent");
const scan = {
  knownId: makeCanary("ScanKnownId"),
  title: makeCanary("ScanTitle"),
  llmEvidence: makeCanary("ScanLlmEvidence"),
};
const quality = {
  output: makeCanary("QualityOutput"),
  finding: makeCanary("QualityFinding"),
};

const rows: FenceCoverageRow[] = [
  {
    name: "buildRepairPrompt",
    canaries: Object.values(repair),
    render: () => buildRepairPrompt({ number: 1, ...repair }, BOUNDARY_ID),
  },
  {
    name: "buildBatchRepairPrompt",
    canaries: Object.values(batch),
    render: () =>
      buildBatchRepairPrompt([
        { number: 1, title: batch.firstTitle, body: batch.firstBody },
        { number: 2, title: batch.secondTitle, body: batch.secondBody },
      ], BOUNDARY_ID),
  },
  // Pending dedicated follow-up: drift-base-ref. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildDriftQuestionPrompt",
    canaries: Object.values(drift),
    render: () => {
      const prompt = buildDriftQuestionPrompt({
        repo: "owner/repo",
        prNumber: 1,
        beforeSha: "a".repeat(40),
        // A legal ref still comes from the PR's GitHub-controlled base name.
        baseRef: `milestone/1-${drift.baseRef}`,
        files: [`docs/${drift.file}.md`],
        changeRequest: drift.request,
        proseRanges: [{
          file: `docs/${drift.proseFile}.md`,
          start: 1,
          end: 2,
          kind: "changed prose",
        }],
        boundaryId: BOUNDARY_ID,
      });
      for (const canary of [drift.file, drift.request, drift.proseFile]) {
        assertOnlyInsideUntrustedFence(prompt, canary);
      }
      return prompt;
    },
  }),
  {
    name: "buildDriftRecoveryPrompt",
    canaries: Object.values(recovery),
    render: () =>
      buildDriftRecoveryPrompt({
        repo: "owner/repo",
        prNumber: 1,
        findings: [{
          file: recovery.file,
          sentence: recovery.sentence,
          reason: recovery.reason,
        }],
        mismatches: [recovery.mismatch],
        docsSweepProblems: [recovery.docsSweep],
        staleQuotes: [recovery.staleQuote],
        staleCitations: [recovery.staleCitation],
        uncheckedFigures: [recovery.uncheckedFigure],
        mutationGateComment: recovery.mutationComment,
        boundaryId: BOUNDARY_ID,
      }),
  },
  // Pending dedicated follow-up: rebase-detail. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildRebasePassPrompt",
    canaries: Object.values(rebase),
    render: () =>
      buildRebasePassPrompt({
        branch: `issue-1-${rebase.branch}`,
        baseRef: `origin/milestone/1-${rebase.baseRef}`,
        // The merge failure carries Git output, including repository paths.
        detail: `Automatic merge failed: ${rebase.detail}`,
      }),
  }),
  {
    name: "buildSummariseUserPrompt",
    canaries: [summariseContent],
    render: () => buildSummariseUserPrompt(summariseContent, BOUNDARY_ID),
  },
  // Pending dedicated follow-up: scan-external-data. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildSecurityScanPrompt",
    canaries: Object.values(scan),
    render: async () =>
      buildSecurityScanPrompt(
        await Deno.readTextFile(
          new URL("../../../prompts/security_scan/prompt.md", import.meta.url),
        ),
        {
          // Production supplies no suppressions. Known IDs are extracted from
          // editable issue bodies as SEC- followed by letters/digits/hyphens.
          suppressedIds: [],
          knownOpenFindingIds: [`SEC-${scan.knownId}`],
          openIssueTitles: [{ number: 1, title: scan.title }],
          // The verdict is worker-authored; its evidence can quote repo paths.
          llmGate: buildLlmGateText({
            isLlmUsing: true,
            signals: [{
              pattern: "dependency",
              evidence: scan.llmEvidence,
              tier: "primary",
            }],
          }),
          attributionFooter: "Filed by the worker.",
        },
      ),
  }),
  // Pending dedicated follow-up: quality-override. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildQualityFixPrompt",
    canaries: Object.values(quality),
    render: () => {
      const prompt = buildQualityFixPrompt(
        quality.output,
        // Exercise the real override producer: finding display text comes
        // from the branch's quality tools, despite its worker-authored frame.
        formatCarryoverFindings([{
          check: "markdownlint",
          key: "finding",
          display: quality.finding,
        }]),
        BOUNDARY_ID,
      );
      assertOnlyInsideUntrustedFence(prompt, quality.output);
      return prompt;
    },
  }),
];

runFenceCoverageRows(rows);
