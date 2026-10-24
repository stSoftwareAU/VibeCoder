/** Canary coverage for public prompt entry points (Issue #4205). */
import { assertEquals } from "@std/assert";
import {
  buildCiFixPrompt,
  buildCustomPrPrompt,
  buildIssuePrompt,
  buildMergeConflictPrompt,
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
  buildPrFeedbackPrompt,
  buildQuestionPrompt,
  buildSpellingFixPrompt,
  buildWorkflowSetupPrompt,
  type IssuePromptOptions,
  type PromptParts,
} from "../lib/prompt_builder.ts";
import { buildCachedIssuePrompt } from "../lib/prompt_builder_cache.ts";
import { PromptCache } from "../lib/prompt_cache.ts";
import { fenceUntrustedIssueText } from "../lib/prompt_delimiter.ts";
import type { Result } from "../types.ts";
import {
  assertOnlyInsideUntrustedFence,
  knownLeakRow,
  makeCanary,
  runFenceCoverageRows,
} from "./support/untrusted_fence.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const BOUNDARY_ID = "0123456789ab";
const REPO = "owner/repo";
const common = { repo: REPO, promptsDir: PROMPTS_DIR };
const issueBase = {
  ...common,
  issueNumber: "4205",
  commentBoundaryId: BOUNDARY_ID,
};
// Operator instructions, template paths and numeric GitHub IDs are trusted
// control inputs. Inspect both turns so an accidental move to system leaks too.
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function rendered(
  parts: PromptParts,
  protectedCanaries: readonly string[] = [],
): string {
  const prompt = `${parts.systemPrompt}\n${parts.prompt}`;
  // A tracked leak must not hide a regression in another, already-fenced input.
  for (const canary of protectedCanaries) {
    assertOnlyInsideUntrustedFence(prompt, canary);
  }
  return prompt;
}
function issueCanaries(prefix: string) {
  return {
    issueTitle: makeCanary(`${prefix}Title`),
    issueBody: makeCanary(`${prefix}Body`),
    issueLabels: makeCanary(`${prefix}Labels`),
    issueComments: makeCanary(`${prefix}Comments`),
    repoContextContent: makeCanary(`${prefix}RepoContext`),
  };
}
const issue = {
  ...issueCanaries("issue"),
  milestoneBranch: makeCanary("issueMilestoneBranch"),
  recentActivity: makeCanary("issueRecentActivity"),
  codebaseMap: makeCanary("issueCodebaseMap"),
  graftContextBundle: makeCanary("issueGraftBundle"),
  parentOwnerDirection: makeCanary("issueParentDirection"),
  ciLog: makeCanary("issueCiLog"),
  securityDeclaration: makeCanary("issueSecurityDeclaration"),
  securityReason: makeCanary("issueSecurityReason"),
};
function issueOptions(values: typeof issue): IssuePromptOptions {
  const { ciLog, securityDeclaration, securityReason, ...fields } = values;
  return {
    ...issueBase,
    ...fields,
    qualityInstructions: "Run ./quality.sh.",
    // This input's contract is an already-fenced upstream log. Preserve the
    // real upstream framing rather than injecting an impossible raw blob.
    ciFailureContext: fenceUntrustedIssueText(
      ciLog,
      "CI console log",
      BOUNDARY_ID,
    ).join("\n"),
    ciFailureBoundaryId: BOUNDARY_ID,
    securityGateBlock: {
      repo: REPO,
      issueNumber: 4205,
      blockedAt: "2026-10-24T00:00:00Z",
      blockCount: 1,
      missing: ["test-identifier-in-diff", "discrimination-not-checked"],
      declarations: [securityDeclaration],
      discrimination: { kind: "not_checked", reason: securityReason },
    },
  };
}
const planning = {
  ...issueCanaries("planning"),
  milestoneTitle: makeCanary("planningMilestone"),
  graftContextBundle: makeCanary("planningGraft"),
};
const critique = {
  ...issueCanaries("critique"),
  milestoneTitle: makeCanary("critiqueMilestone"),
  draftPlan: makeCanary("critiqueDraftPlan"),
};
const question = {
  ...issueCanaries("question"),
  graftContextBundle: makeCanary("questionGraft"),
};
const feedback = {
  commentBody: makeCanary("feedbackComment"),
  repoContextContent: makeCanary("feedbackRepoContext"),
  graftContextBundle: makeCanary("feedbackGraft"),
  ownerDirection: makeCanary("feedbackOwnerDirection"),
};
function reviewCanaries(prefix: string) {
  return {
    login: makeCanary(`${prefix}Login`),
    path: makeCanary(`${prefix}Path`),
    body: makeCanary(`${prefix}Body`),
    diffHunk: makeCanary(`${prefix}Hunk`),
  };
}
const feedbackReview = reviewCanaries("feedbackReview");
const custom = {
  prTitle: makeCanary("customPrTitle"),
  prBody: makeCanary("customPrBody"),
  repoContextContent: makeCanary("customPrRepoContext"),
};
const customReview = reviewCanaries("customReview");
function reviewComment(fields: ReturnType<typeof reviewCanaries>) {
  // htmlUrl is metadata, not emitted by buildBotReviewCommentsSection.
  return {
    ...fields,
    id: 1,
    line: 1,
    htmlUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
  };
}
const spelling = {
  checkName: makeCanary("spellingCheck"),
  annotationDetails: makeCanary("spellingAnnotations"),
  repoContextContent: makeCanary("spellingRepoContext"),
};
const workflow = {
  languages: makeCanary("workflowLanguages"),
  missingWorkflows: makeCanary("workflowMissing"),
  defaultBranch: makeCanary("workflowBranch"),
  existingWorkflows: makeCanary("workflowExisting"),
  repoContextContent: makeCanary("workflowRepoContext"),
};
const ci = {
  checkName: makeCanary("ciCheck"),
  annotationDetails: makeCanary("ciAnnotations"),
  repoContextContent: makeCanary("ciRepoContext"),
  graftContextBundle: makeCanary("ciGraft"),
  prFailureActions: makeCanary("ciFailureActions"),
};
const conflict = {
  baseBranch: makeCanary("conflictBaseBranch"),
  intoBranch: makeCanary("conflictIntoBranch"),
  file: makeCanary("conflictFile"),
  repoContextContent: makeCanary("conflictRepoContext"),
  prTitle: makeCanary("conflictPrIssueTitle"),
  prBody: makeCanary("conflictPrIssueBody"),
  baseTitle: makeCanary("conflictBaseIssueTitle"),
  baseBody: makeCanary("conflictBaseIssueBody"),
  basePath: makeCanary("conflictBasePath"),
  warning: makeCanary("conflictWarning"),
  truncatedPath: makeCanary("conflictTruncatedPath"),
  failingCommand: makeCanary("conflictFailingCommand"),
  output: makeCanary("conflictOutput"),
  subject: makeCanary("conflictCommitSubject"),
};
const cached = Object.fromEntries(
  Object.keys(issue).map((field) => [field, makeCanary(`cached${field}`)]),
) as typeof issue;

runFenceCoverageRows([
  knownLeakRow({
    // Pending dedicated follow-up: security_replay (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildIssuePrompt",
    canaries: Object.values(issue),
    render: async () =>
      rendered(
        unwrap(await buildIssuePrompt(issueOptions(issue))),
        Object.entries(issue).filter(([field]) => !field.startsWith("security"))
          .map(([, canary]) => canary),
      ),
  }),
  {
    name: "buildPlanningPrompt",
    canaries: Object.values(planning),
    render: async () =>
      rendered(
        unwrap(await buildPlanningPrompt({ ...issueBase, ...planning })),
      ),
  },
  {
    name: "buildPlanningCritiquePrompt",
    canaries: Object.values(critique),
    render: async () =>
      rendered(
        unwrap(
          await buildPlanningCritiquePrompt({ ...issueBase, ...critique }),
        ),
      ),
  },
  {
    name: "buildQuestionPrompt",
    canaries: Object.values(question),
    render: async () =>
      rendered(
        unwrap(await buildQuestionPrompt({ ...issueBase, ...question })),
      ),
  },
  {
    name: "buildPrFeedbackPrompt",
    canaries: [...Object.values(feedback), ...Object.values(feedbackReview)],
    render: async () =>
      rendered(unwrap(
        await buildPrFeedbackPrompt({
          ...common,
          prNumber: "42",
          ...feedback,
          additionalReviewComments: [reviewComment(feedbackReview)],
        }),
      )),
  },
  {
    name: "buildCustomPrPrompt",
    canaries: [...Object.values(custom), ...Object.values(customReview)],
    render: async () => {
      const path = await Deno.makeTempFile({ suffix: ".md" });
      try {
        await Deno.writeTextFile(
          path,
          "Review PR #{{PR_NUMBER}}.\n{{QUALITY_INSTRUCTIONS}}\n",
        );
        return rendered(unwrap(
          await buildCustomPrPrompt({
            ...common,
            prNumber: "42",
            ...custom,
            mapping: {
              label: "private-review",
              targetPhase: "pr",
              promptPath: path,
            },
            reviewComments: [reviewComment(customReview)],
          }),
        ));
      } finally {
        await Deno.remove(path);
      }
    },
  },
  {
    name: "buildSpellingFixPrompt",
    canaries: Object.values(spelling),
    render: async () =>
      rendered(
        unwrap(
          await buildSpellingFixPrompt({
            ...common,
            prNumber: "42",
            ...spelling,
          }),
        ),
      ),
  },
  knownLeakRow({
    // Pending dedicated follow-up: workflow_profile (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildWorkflowSetupPrompt",
    canaries: Object.values(workflow),
    render: async () =>
      rendered(
        unwrap(await buildWorkflowSetupPrompt({ ...common, ...workflow })),
        [
          workflow.missingWorkflows,
          workflow.existingWorkflows,
          workflow.repoContextContent,
        ],
      ),
  }),
  knownLeakRow({
    // Pending dedicated follow-up: ci_classification (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildCiFixPrompt",
    canaries: Object.values(ci),
    // Raw annotations/logExcerpt only choose a finite classification; emitted
    // annotation/log text arrives through annotationDetails/prFailureActions.
    render: async () =>
      rendered(
        unwrap(await buildCiFixPrompt({ ...common, prNumber: "42", ...ci })),
        Object.entries(ci).filter(([field]) => field !== "checkName").map((
          [, canary],
        ) => canary),
      ),
  }),
  knownLeakRow({
    // Pending dedicated follow-up: conflict_context (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildMergeConflictPrompt",
    canaries: Object.values(conflict),
    render: async () =>
      rendered(
        unwrap(
          await buildMergeConflictPrompt({
            ...common,
            target: { kind: "branch", intoBranch: conflict.intoBranch },
            baseBranch: conflict.baseBranch,
            conflictedFiles: [conflict.file],
            repoContextContent: conflict.repoContextContent,
            issueContext: {
              repo: REPO,
              prNumber: 42,
              prSide: {
                resolved: true,
                signal: "body",
                issue: {
                  number: 1,
                  title: conflict.prTitle,
                  body: conflict.prBody,
                  state: "OPEN",
                  bodyTruncated: false,
                },
              },
              baseSide: [{
                path: conflict.basePath,
                commitsInspected: 1,
                prNumbers: [43],
                issues: [{
                  number: 2,
                  title: conflict.baseTitle,
                  body: conflict.baseBody,
                  state: "OPEN",
                  bodyTruncated: false,
                }],
                unresolved: null,
                partial: false,
              }],
              truncation: {
                commitCapPaths: [conflict.truncatedPath],
                issueCapHit: false,
                textTruncatedIssues: [],
                ghCallCapHit: false,
              },
              ghCallsUsed: 1,
              warnings: [conflict.warning],
            },
            repair: {
              round: 1,
              maxRounds: 2,
              failingCommand: conflict.failingCommand,
              output: conflict.output,
              mergedCommitSubjects: [conflict.subject],
            },
          }),
        ),
        Object.entries(conflict).filter(([field]) =>
          !["basePath", "warning", "truncatedPath"].includes(field)
        ).map(([, canary]) => canary),
      ),
  }),
  knownLeakRow({
    // Pending dedicated follow-up: security_replay (draft scaffold; replace before marking ready).
    knownLeak: "#3896",
    name: "buildCachedIssuePrompt",
    canaries: Object.values(cached),
    render: async () => {
      const dir = await Deno.makeTempDir({ prefix: "fence-prompt-cache-" });
      try {
        const cache = new PromptCache({ cacheDir: dir });
        const options = { ...issueOptions(cached), cache };
        const miss = unwrap(await buildCachedIssuePrompt(options));
        const hit = unwrap(await buildCachedIssuePrompt(options));
        assertEquals(miss.cacheHit, false);
        assertEquals(hit.cacheHit, true);
        const protectedCanaries = Object.entries(cached).filter(([field]) =>
          !field.startsWith("security")
        ).map(([, canary]) => canary);
        return `${rendered(miss, protectedCanaries)}\n${
          rendered(hit, protectedCanaries)
        }`;
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  }),
]);
