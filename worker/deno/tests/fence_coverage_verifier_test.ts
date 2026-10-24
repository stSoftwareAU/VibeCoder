/** Canary coverage for verifier and gate-retry prompts (Issue #4204). */
import { renderChecklistSection } from "../lib/review_checklists.ts";
import { buildPrePrVerifierPrompt } from "../lib/pre_pr_verifier.ts";
import { buildClosureVerdictPrompt } from "../lib/closure_verdict_recovery.ts";
import { buildSummaryClaimCorrectionPrompt } from "../lib/summary_claim_correction.ts";
import { buildSummaryClaimQuestionPrompt } from "../lib/summary_claim_check.ts";
import { buildSummaryRuleRetryPrompt } from "../lib/summary_rule_gate_retry.ts";
import { buildSecurityFixGateRetryPrompt } from "../lib/security_fix_gate_retry.ts";
import {
  buildReplyPlaceholderRetryPrompt,
  findResultPlaceholders,
} from "../lib/result_placeholder_gate.ts";
import { buildRetryPrompt } from "../lib/quality_gate_phase.ts";
import {
  assertOnlyInsideUntrustedFence,
  knownLeakRow,
  makeCanary,
  runFenceCoverageRows,
} from "./support/untrusted_fence.ts";

const BOUNDARY_ID = "0123456789ab";
const REPO = "owner/repo";
const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-4204.md";
const template = await Deno.readTextFile(
  new URL("../../../prompts/pr_review_brief/prompt.md", import.meta.url),
);
const prePr = {
  issueTitle: makeCanary("prePrTitle"),
  issueBody: makeCanary("prePrBody"),
  finding: makeCanary("prePrFinding"),
  criterionOne: makeCanary("prePrCriterionOne"),
  criterionTwo: makeCanary("prePrCriterionTwo"),
  checklistName: makeCanary("prePrChecklistName"),
  checklistItem: makeCanary("prePrChecklistItem"),
  changedFile: makeCanary("prePrChangedFile"),
  changedTest: makeCanary("prePrChangedTest"),
  symbol: makeCanary("prePrCallerSymbol"),
  definition: makeCanary("prePrCallerDefinition"),
  caller: makeCanary("prePrCallerPath"),
  note: makeCanary("prePrCallerNote"),
};
const closure = {
  criterionOne: makeCanary("closureCriterionOne"),
  criterionTwo: makeCanary("closureCriterionTwo"),
  problem: makeCanary("closureProblem"),
  shortfall: makeCanary("closureShortfall"),
};
const correction = makeCanary("claimCorrectionComment");
const claimQuestion = {
  doc: makeCanary("claimQuestionDoc"),
  baseRef: makeCanary("claimQuestionBaseRef"),
  range: makeCanary("claimQuestionRange"),
};
const summaryRetry = {
  reason: makeCanary("summaryRetryReason"),
  comment: makeCanary("summaryRetryComment"),
  section: makeCanary("summaryRetrySection"),
  standing: makeCanary("summaryRetryStanding"),
  criterion: makeCanary("summaryRetryCriterion"),
};
const security = {
  declaration: makeCanary("securityDeclaration"),
  reason: makeCanary("securityReason"),
  file: makeCanary("securityTestFile"),
  name: makeCanary("securityTestName"),
  unrunFile: makeCanary("securityUnrunFile"),
  unrunName: makeCanary("securityUnrunName"),
  unrunReason: makeCanary("securityUnrunReason"),
};
const placeholder = makeCanary("replyPlaceholder").toUpperCase() +
  "_PLACEHOLDER";
const quality = makeCanary("qualityOutput");

runFenceCoverageRows([
  knownLeakRow({
    // Pending dedicated follow-up: prepr_paths (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildPrePrVerifierPrompt",
    canaries: Object.values(prePr),
    render: () => {
      const prompt = buildPrePrVerifierPrompt({
        template,
        repo: REPO,
        issueNumber: 4204,
        issueTitle: prePr.issueTitle,
        issueBody: prePr.issueBody,
        previousFindings: [prePr.finding],
        closureItems: [
          { criterion: prePr.criterionOne },
          { criterion: prePr.criterionTwo },
        ],
        changedFiles: [
          `src/${prePr.changedFile}.ts`,
          `tests/${prePr.changedTest}_test.ts`,
        ],
        callerChecks: {
          expected: [{
            symbol: prePr.symbol,
            definedAt: `${prePr.definition}.ts:1`,
            caller: `${prePr.caller}.ts:2`,
          }],
          notes: [prePr.note],
        },
        // Follow the real upstream renderer: repo-owned checklists contain
        // author-controlled names/items even when loaded from the base ref.
        reviewChecklists: renderChecklistSection({
          kind: "loaded",
          config: {
            checklists: [{
              name: prePr.checklistName,
              paths: ["src/*"],
              items: [prePr.checklistItem],
            }],
          },
        }, ["src/checklist.ts"]),
        checkoutPath: "/tmp/verifier-checkout",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        summaryPath: SUMMARY_PATH,
        boundaryId: BOUNDARY_ID,
      });
      // A separately tracked filename leak must never mask a regression of
      // the title/closure fences, or of the other already-fenced fields.
      for (const [field, canary] of Object.entries(prePr)) {
        if (field !== "changedTest" && !field.startsWith("checklist")) {
          assertOnlyInsideUntrustedFence(prompt, canary);
        }
      }
      return prompt;
    },
  }),
  {
    name: "buildClosureVerdictPrompt",
    canaries: Object.values(closure),
    render: () =>
      buildClosureVerdictPrompt({
        repo: REPO,
        issueNumber: 4204,
        criteria: [closure.criterionOne, closure.criterionTwo],
        problems: [closure.problem],
        shortfalls: [closure.shortfall],
        boundaryId: BOUNDARY_ID,
      }),
  },
  {
    name: "buildSummaryClaimCorrectionPrompt",
    canaries: [correction],
    render: () =>
      buildSummaryClaimCorrectionPrompt({
        repo: REPO,
        issueNumber: 4204,
        summaryPath: SUMMARY_PATH,
        comment: correction,
        boundaryId: BOUNDARY_ID,
      }),
  },
  knownLeakRow({
    // Pending dedicated follow-up: summary_question (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildSummaryClaimQuestionPrompt",
    canaries: Object.values(claimQuestion),
    render: () => {
      const prompt = buildSummaryClaimQuestionPrompt({
        repo: REPO,
        issueNumber: 4204,
        baseRef: claimQuestion.baseRef,
        summaryPath: SUMMARY_PATH,
        docFiles: [`docs/${claimQuestion.doc}.md`],
        proseRanges: [{
          file: `src/${claimQuestion.range}.ts`,
          start: 1,
          end: 2,
          kind: "source comment",
        }],
        boundaryId: BOUNDARY_ID,
      });
      assertOnlyInsideUntrustedFence(prompt, claimQuestion.range);
      return prompt;
    },
  }),
  {
    name: "buildSummaryRuleRetryPrompt",
    canaries: Object.values(summaryRetry),
    // Exercise both the single-comment fallback and folded sections. `reason`
    // uses the same fence as the comments. Cited locations are not emitted.
    render: () =>
      [
        buildSummaryRuleRetryPrompt(
          { reason: summaryRetry.reason, comment: summaryRetry.comment },
          REPO,
          4204,
          BOUNDARY_ID,
        ),
        buildSummaryRuleRetryPrompt(
          {
            reason: summaryRetry.reason,
            comment: "combined notice",
            sections: [summaryRetry.section],
            standingViolations: [{ text: summaryRetry.standing, cited: [] }],
            unmetCriteria: [{
              criterion: summaryRetry.criterion,
              status: "missing",
            }],
          },
          REPO,
          4204,
          BOUNDARY_ID,
        ),
      ].join("\n"),
  },
  knownLeakRow({
    // Pending dedicated follow-up: security_replay (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildSecurityFixGateRetryPrompt",
    canaries: Object.values(security),
    render: () =>
      buildSecurityFixGateRetryPrompt({
        repo: REPO,
        issueNumber: 4204,
        blockedAt: "2026-10-24T00:00:00Z",
        blockCount: 1,
        missing: ["test-identifier-in-diff", "discrimination-not-checked"],
        declarations: [security.declaration],
        discrimination: {
          kind: "not_checked",
          reason: security.reason,
          runs: [{
            test: { file: security.file, name: security.name },
            preFix: "pass",
            postFix: "pass",
          }],
          notRun: [{
            test: { file: security.unrunFile, name: security.unrunName },
            reason: security.unrunReason,
          }],
        },
      }),
  }),
  knownLeakRow({
    // Pending dedicated follow-up: reply_placeholder (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildReplyPlaceholderRetryPrompt",
    canaries: [placeholder],
    render: () =>
      buildReplyPlaceholderRetryPrompt(
        findResultPlaceholders(`deno test: ${placeholder}`),
      ),
  }),
  {
    name: "buildRetryPrompt",
    canaries: [quality],
    render: () => buildRetryPrompt(quality, 100, BOUNDARY_ID),
  },
]);
