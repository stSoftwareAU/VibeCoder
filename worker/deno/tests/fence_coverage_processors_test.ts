/** Fence coverage for issue processors and planning repair (Issue #4206). */
import {
  buildCritiqueFallbackPublishPrompt,
  buildFallbackDraftPlanningPrompt,
  buildRetryPlanningPrompt,
  buildSingleInvocationPlanningPrompt,
} from "../lib/planning_processor.ts";
import { buildRefinementPrompt } from "../lib/refinement_processor.ts";
import { buildRevisionPrompt } from "../lib/revision_processor.ts";
import { buildBasicQuestionPrompt } from "../lib/question_processor.ts";
import { buildGrillMePrompt } from "../lib/grill_me_processor.ts";
import { buildClarityAssessmentPrompt } from "../lib/clarity_assessment.ts";
import { buildCoverageRepairPrompt } from "../lib/plan_coverage_repair.ts";
import {
  assertOnlyInsideUntrustedFence,
  type FenceCoverageRow,
  knownLeakRow,
  makeCanary,
  runFenceCoverageRows,
} from "./support/untrusted_fence.ts";

const BOUNDARY_ID = "a1b2c3d4e5f6";
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// Repository identity and numeric IDs are worker routing metadata. Template
// guidance is worker-authored; the GitHub text and repo context below are not.
const single = {
  issueTitle: makeCanary("SingleTitle"),
  issueBody: makeCanary("SingleBody"),
  issueComments: makeCanary("SingleComments"),
  milestoneTitle: makeCanary("SingleMilestone"),
};
const draft = {
  issueTitle: makeCanary("DraftTitle"),
  issueBody: makeCanary("DraftBody"),
  issueComments: makeCanary("DraftComments"),
  milestoneTitle: makeCanary("DraftMilestone"),
};
const retry = {
  issueTitle: makeCanary("RetryTitle"),
  issueBody: makeCanary("RetryBody"),
  issueComments: makeCanary("RetryComments"),
  milestoneTitle: makeCanary("RetryMilestone"),
};
const critiqueMilestone = makeCanary("CritiqueMilestone");
const refinement = {
  title: makeCanary("RefinementTitle"),
  body: makeCanary("RefinementBody"),
  feedback: makeCanary("RefinementFeedback"),
};
const revision = {
  title: makeCanary("RevisionTitle"),
  body: makeCanary("RevisionBody"),
  feedback: makeCanary("RevisionFeedback"),
};
const question = {
  issueTitle: makeCanary("QuestionTitle"),
  issueBody: makeCanary("QuestionBody"),
  issueComments: makeCanary("QuestionComments"),
};
const grill = {
  issueTitle: makeCanary("GrillTitle"),
  issueBody: makeCanary("GrillBody"),
  commentHistory: makeCanary("GrillHistory"),
  graftContextBundle: makeCanary("GrillGraft"),
};
const clarity = {
  issueTitle: makeCanary("ClarityTitle"),
  issueBody: makeCanary("ClarityBody"),
  issueLabels: makeCanary("ClarityLabels"),
  issueComments: makeCanary("ClarityComments"),
};
const coverage = {
  parentTitle: makeCanary("CoverageParentTitle"),
  parentBody: makeCanary("CoverageParentBody"),
  firstTitle: makeCanary("CoverageFirstTitle"),
  firstBody: makeCanary("CoverageFirstBody"),
  secondTitle: makeCanary("CoverageSecondTitle"),
  secondBody: makeCanary("CoverageSecondBody"),
};

const rows: FenceCoverageRow[] = [
  {
    name: "buildSingleInvocationPlanningPrompt",
    canaries: Object.values(single),
    render: () =>
      buildSingleInvocationPlanningPrompt({
        ...single,
        repo: "owner/repo",
        issueNumber: 1,
        commentBoundaryId: BOUNDARY_ID,
      }),
  },
  // Pending dedicated follow-up: draft-milestone. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildFallbackDraftPlanningPrompt",
    canaries: Object.values(draft),
    render: () => {
      const prompt = buildFallbackDraftPlanningPrompt({
        ...draft,
        issueNumber: 1,
        commentBoundaryId: BOUNDARY_ID,
      });
      // The milestone defect must not mask a new leak in protected fields.
      for (
        const canary of [
          draft.issueTitle,
          draft.issueBody,
          draft.issueComments,
        ]
      ) assertOnlyInsideUntrustedFence(prompt, canary);
      return prompt;
    },
  }),
  {
    name: "buildRetryPlanningPrompt",
    canaries: Object.values(retry),
    render: () =>
      buildRetryPlanningPrompt({
        ...retry,
        repo: "owner/repo",
        issueNumber: 1,
        commentBoundaryId: BOUNDARY_ID,
      }),
  },
  {
    name: "buildCritiqueFallbackPublishPrompt",
    canaries: [critiqueMilestone],
    render: () =>
      buildCritiqueFallbackPublishPrompt({
        repo: "owner/repo",
        issueNumber: 1,
        milestoneTitle: critiqueMilestone,
      }),
  },
  {
    name: "buildRefinementPrompt",
    canaries: Object.values(refinement),
    render: () =>
      buildRefinementPrompt(
        refinement.title,
        refinement.body,
        refinement.feedback,
      ),
  },
  {
    name: "buildRevisionPrompt",
    canaries: Object.values(revision),
    render: () =>
      buildRevisionPrompt(
        revision.title,
        revision.body,
        revision.feedback,
      ),
  },
  {
    name: "buildBasicQuestionPrompt",
    canaries: Object.values(question),
    render: () =>
      buildBasicQuestionPrompt({
        ...question,
        repo: "owner/repo",
        issueNumber: 1,
        commentBoundaryId: BOUNDARY_ID,
      }),
  },
  // Pending dedicated follow-up: grill-fields. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildGrillMePrompt",
    canaries: Object.values(grill),
    render: async () => {
      const result = await buildGrillMePrompt({
        ...grill,
        repo: "owner/repo",
        issueNumber: 1,
        roundNumber: 1,
        maxRounds: 3,
        codingGuidelines: "Use Australian English.",
        verbosityInstructions: "Be concise.",
        commentBoundaryId: BOUNDARY_ID,
        promptsDir: PROMPTS_DIR,
      });
      if (!result.ok) throw result.error;
      assertOnlyInsideUntrustedFence(result.value, grill.graftContextBundle);
      return result.value;
    },
  }),
  // Pending dedicated follow-up: clarity-end-line. Draft scaffold; replace before marking the PR ready.
  knownLeakRow({
    knownLeak: "#3896",
    name: "buildClarityAssessmentPrompt",
    canaries: Object.values(clarity),
    render: () =>
      buildClarityAssessmentPrompt({
        ...clarity,
        clarificationRound: 1,
        commentBoundaryId: BOUNDARY_ID,
      }),
  }),
  {
    name: "buildCoverageRepairPrompt",
    canaries: Object.values(coverage),
    render: () =>
      buildCoverageRepairPrompt({
        parent: {
          number: 1,
          title: coverage.parentTitle,
          body: coverage.parentBody,
        },
        subIssues: [
          { number: 2, title: coverage.firstTitle, body: coverage.firstBody },
          { number: 3, title: coverage.secondTitle, body: coverage.secondBody },
        ],
      }, BOUNDARY_ID),
  },
];

runFenceCoverageRows(rows);
