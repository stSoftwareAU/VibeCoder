/**
 * Assess clarity command for the Vibe Coder worker.
 *
 * Analyses an issue's title and body to determine if the requirements
 * are clear enough to proceed with implementation.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  LABEL_DEFAULTS,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { validateAssessClarityArgs } from "../lib/command_args.ts";
import {
  type ClarityAssessmentResult,
  runClarityAssessment,
} from "../lib/clarity_assessment.ts";

/**
 * Result of clarity analysis.
 */
export interface ClarityResult {
  /** Whether the issue requirements are clear enough to proceed */
  isClear: boolean;
  /** Reason for the clarity decision */
  reason:
    | "specific"
    | "vague"
    | "missing_details"
    | "too_broad"
    | "too_complex"
    | "has_context"
    | "skip_label";
  /** Questions to ask for clarification (if not clear) */
  questions: string[];
}

/**
 * Patterns that indicate a clear, specific issue.
 */
const SPECIFIC_PATTERNS = [
  // File paths with optional line numbers
  /\b[a-zA-Z0-9_-]+\.(ts|js|tsx|jsx|py|sh|json|md|css|html)\b/i,
  /line\s+\d+/i,
  /:\d+\b/, // file.ts:123 format
  // Code snippets
  /```[\s\S]*?```/,
  /`[^`]+`/,
  // Specific values
  /change\s+['"][^'"]+['"]\s+to\s+['"][^'"]+['"]/i,
  /replace\s+['"][^'"]+['"]\s+with\s+['"][^'"]+['"]/i,
  // Specific actions with targets
  /add\s+(a\s+)?\d+-?(second|minute|ms|millisecond)\s+timeout/i,
  /remove\s+the\s+\w+/i,
  /rename\s+\w+\s+to\s+\w+/i,
  // Error messages
  /error:\s*\w+/i,
  /exception:\s*\w+/i,
];

/**
 * Patterns that indicate a vague, unclear issue.
 */
const VAGUE_PATTERNS = [
  // Generic bug references
  /^fix\s+(the\s+)?bug$/i,
  /something\s+is\s+(broken|wrong)/i,
  /doesn'?t\s+work/i,
  // Generic improvement requests
  /make\s+it\s+(better|faster|nicer)/i,
  /improve\s+(the\s+)?(performance|code|quality)$/i,
  /clean\s+up/i,
  // Overly broad scope
  /entire\s+codebase/i,
  /everywhere/i,
  /all\s+(the\s+)?(files|code|tests)/i,
];

/**
 * Topics that require specific details.
 */
const REQUIRES_DETAILS = [
  {
    pattern: /add\s+(user\s+)?authentication/i,
    needs: "authentication method (OAuth, JWT, session, etc.)",
  },
  {
    pattern: /add\s+(a\s+)?database/i,
    needs: "database type and schema requirements",
  },
  {
    pattern: /add\s+(a\s+)?cache/i,
    needs: "caching strategy and what to cache",
  },
  {
    pattern: /add\s+(a\s+)?api/i,
    needs: "API endpoints and request/response formats",
  },
  {
    pattern: /add\s+(real-?time|websocket)/i,
    needs: "which events to handle in real-time",
  },
  {
    pattern: /refactor/i,
    needs: "specific areas to refactor and target architecture",
  },
];

/** Threshold for directory references that indicate complexity */
const DIRECTORY_COUNT_THRESHOLD = 3;

/** Threshold for acceptance criteria checkboxes that indicate complexity */
const CHECKBOX_COUNT_THRESHOLD = 10;

/** Threshold for file counts mentioned in issue body */
const FILE_COUNT_THRESHOLD = 20;

/**
 * Threshold for distinct questions/requests that suggest complexity (Issue #872).
 *
 * Raised from 3 to 5 because countDistinctRequests() counts all imperative
 * sentences (e.g., "Fix the bug. Update the tests. Ensure CI passes.") which
 * are normal for focused issues with a few action steps.
 */
const QUESTION_COUNT_THRESHOLD = 5;

/**
 * Threshold for cross-repo references that suggest coordination complexity (Issue #872).
 *
 * Raised from 2 to 3 because referencing 2 external issues for context is
 * normal — only 3+ suggests actual multi-repo coordination work.
 */
const CROSS_REPO_REF_THRESHOLD = 3;

/** Threshold for vague/research-oriented phrases that suggest investigation */
const VAGUE_LANGUAGE_THRESHOLD = 3;

/**
 * Patterns indicating vague or research-oriented language.
 * Presence of multiple such phrases suggests a research task.
 */
const INVESTIGATIVE_PATTERNS: RegExp[] = [
  /please\s+check/i,
  /are\s+there\s+any/i,
  /is\s+there\s+more/i,
  /investigate/i,
  /look\s+into/i,
  /find\s+out/i,
  /should\s+we/i,
  /could\s+we/i,
  /what\s+about/i,
  /any\s+other/i,
  /anything\s+else/i,
  /all\s+instances/i,
];

/**
 * Imperative verb patterns for detecting action requests.
 */
const IMPERATIVE_PATTERN =
  /(?:^|\.\s+)(?:add|fix|check|remove|update|create|delete|rename|move|refactor|implement|migrate|ensure|verify)\s+/gim;

/**
 * Result of complexity detection analysis.
 */
export interface ComplexityIndicators {
  isComplex: boolean;
  directoryCount: number;
  fileCount: number;
  checkboxCount: number;
  /** Count of distinct questions or action requests */
  questionCount: number;
  /** Count of cross-repo references (owner/repo#N or GitHub URLs) */
  crossRepoRefs: number;
  /** Count of vague/research-oriented phrases detected */
  vagueLanguageCount: number;
}

/**
 * Count distinct questions and action requests in the issue body.
 *
 * Looks for question marks, numbered action items, and imperative sentences.
 */
function countDistinctRequests(body: string): number {
  let count = 0;

  // Count sentences ending with '?'
  const questionMatches = body.match(/[^?]*\?/g) ?? [];
  count += questionMatches.length;

  // Count numbered list action items (e.g., "1. Add logging")
  const numberedItems = body.match(/^\s*\d+\.\s+\S/gm) ?? [];
  count += numberedItems.length;

  // Count imperative sentences (only if not already counted as numbered items or questions)
  // Reset lastIndex for global regex
  IMPERATIVE_PATTERN.lastIndex = 0;
  let imperativeMatch: RegExpExecArray | null;
  while ((imperativeMatch = IMPERATIVE_PATTERN.exec(body)) !== null) {
    // Skip if this is part of a numbered list item (already counted)
    const prefix = body.slice(
      Math.max(0, imperativeMatch.index - 10),
      imperativeMatch.index,
    );
    if (/\d+\.\s*$/.test(prefix)) continue;
    // Skip if the sentence ends with '?' (already counted)
    const rest = body.slice(imperativeMatch.index, imperativeMatch.index + 200);
    const nextPeriod = rest.indexOf(".");
    const nextQuestion = rest.indexOf("?");
    if (nextQuestion >= 0 && (nextPeriod < 0 || nextQuestion < nextPeriod)) {
      continue;
    }
    count++;
  }

  return count;
}

/**
 * Count cross-repo references in the issue body.
 *
 * Detects owner/repo#N patterns and full GitHub URLs to other repositories.
 * Plain #N references are considered same-repo and are not counted.
 */
function countCrossRepoRefs(body: string): number {
  let count = 0;

  // Match owner/repo#N patterns
  const ownerRepoPattern = /\b[\w.-]+\/[\w.-]+#\d+/g;
  const ownerRepoMatches = body.match(ownerRepoPattern) ?? [];
  count += ownerRepoMatches.length;

  // Match full GitHub URLs to other repos (issues, PRs, etc.)
  const githubUrlPattern =
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|pulls|discussions)\/\d+/g;
  const githubUrlMatches = body.match(githubUrlPattern) ?? [];
  count += githubUrlMatches.length;

  return count;
}

/**
 * Count vague or research-oriented phrases in the issue body.
 *
 * Detects investigative language that suggests the issue requires
 * research rather than direct implementation.
 */
function countVagueLanguage(body: string): number {
  let count = 0;
  for (const pattern of INVESTIGATIVE_PATTERNS) {
    const matches = body.match(new RegExp(pattern.source, "gi")) ?? [];
    count += matches.length;
  }
  return count;
}

/**
 * Detect structured and semantic complexity indicators in issue body.
 *
 * Identifies issues that have clear requirements but are too large
 * for a single implementation attempt, based on:
 * - Multiple directory references (3+)
 * - High file counts (~N files)
 * - Many acceptance criteria checkboxes (5+)
 * - Multiple distinct questions/requests (3+)
 * - Cross-repo references (2+)
 * - Vague/research-oriented language (3+ phrases)
 */
export function detectComplexity(body: string): ComplexityIndicators {
  // Count distinct directory-style paths (e.g., src/auth/, test/unit/)
  const directoryPattern = /\b[\w.-]+(?:\/[\w.-]+)+\//g;
  const directoryMatches = body.match(directoryPattern) ?? [];
  const uniqueDirectories = new Set(
    directoryMatches.map((d) => d.toLowerCase()),
  );
  const directoryCount = uniqueDirectories.size;

  // Detect high file counts (e.g., "~64 files", "47 files", "~193 test cases")
  const fileCountPattern = /~?(\d+)\s+files?\b/gi;
  let maxFileCount = 0;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileCountPattern.exec(body)) !== null) {
    const count = parseInt(fileMatch[1] ?? "0", 10);
    if (count > maxFileCount) {
      maxFileCount = count;
    }
  }

  // Count acceptance criteria checkboxes (- [ ] items)
  const checkboxPattern = /^[ \t]*-\s+\[[ x]\]/gm;
  const checkboxMatches = body.match(checkboxPattern) ?? [];
  const checkboxCount = checkboxMatches.length;

  // Semantic heuristics (Issue #862)
  const questionCount = countDistinctRequests(body);
  const crossRepoRefs = countCrossRepoRefs(body);
  const vagueLanguageCount = countVagueLanguage(body);

  // Determine if the issue is too complex based on structural thresholds
  const structurallyComplex = directoryCount >= DIRECTORY_COUNT_THRESHOLD ||
    maxFileCount >= FILE_COUNT_THRESHOLD ||
    checkboxCount >= CHECKBOX_COUNT_THRESHOLD;

  // Determine if the issue is semantically complex (Issue #862)
  const semanticallyComplex = questionCount >= QUESTION_COUNT_THRESHOLD ||
    crossRepoRefs >= CROSS_REPO_REF_THRESHOLD ||
    vagueLanguageCount >= VAGUE_LANGUAGE_THRESHOLD ||
    // Combined: 3+ questions/requests AND 3+ vague phrases (Issue #872)
    // Raised from (2,2) to (3,3) to avoid flagging simple issues that
    // have a few action steps with minor investigative language.
    (questionCount >= 3 && vagueLanguageCount >= 3);

  const isComplex = structurallyComplex || semanticallyComplex;

  return {
    isComplex,
    directoryCount,
    fileCount: maxFileCount,
    checkboxCount,
    questionCount,
    crossRepoRefs,
    vagueLanguageCount,
  };
}

/**
 * Analyse issue clarity to determine if requirements are clear.
 *
 * @param title - Issue title
 * @param body - Issue body/description
 * @param labels - Issue labels
 * @returns Clarity analysis result
 */
export function analyseIssueClarity(
  title: string,
  body: string,
  _labels: string[],
): ClarityResult {
  const content = `${title}\n${body}`.toLowerCase();
  const questions: string[] = [];

  // Check for specific patterns that indicate clarity
  const hasSpecificPatterns = SPECIFIC_PATTERNS.some((pattern) =>
    pattern.test(title) || pattern.test(body)
  );

  if (hasSpecificPatterns) {
    return {
      isClear: true,
      reason: "specific",
      questions: [],
    };
  }

  // Check for vague patterns
  const isVague = VAGUE_PATTERNS.some((pattern) => pattern.test(content));

  if (isVague) {
    // Generate clarifying questions based on the content
    if (/bug/i.test(content)) {
      questions.push(
        "Which bug specifically needs to be fixed? Please provide steps to reproduce or error messages.",
      );
    }
    if (
      /performance/i.test(content) || /slow/i.test(content) ||
      /faster/i.test(content)
    ) {
      questions.push(
        "Which specific operation or feature is slow? Do you have any performance measurements?",
      );
    }
    if (/clean\s*up/i.test(content) || /refactor/i.test(content)) {
      questions.push(
        "Which specific files or modules need attention? What is the desired end state?",
      );
    }

    if (questions.length === 0) {
      questions.push(
        "Could you provide more specific details about what needs to be done?",
      );
    }

    return {
      isClear: false,
      reason: "vague",
      questions,
    };
  }

  // Check for structural and semantic complexity indicators.
  // This runs before missing_details and too_broad because complexity is the
  // primary concern when an issue has size or semantic indicators.
  const complexityResult = detectComplexity(body);
  if (complexityResult.isComplex) {
    const parts: string[] = [];
    if (complexityResult.directoryCount > 0) {
      parts.push(`${complexityResult.directoryCount} directories`);
    }
    if (complexityResult.fileCount > 0) {
      parts.push(`~${complexityResult.fileCount} files`);
    }
    if (complexityResult.checkboxCount > 0) {
      parts.push(`${complexityResult.checkboxCount} acceptance criteria`);
    }
    if (complexityResult.questionCount >= QUESTION_COUNT_THRESHOLD) {
      parts.push(`${complexityResult.questionCount} distinct requests`);
    }
    if (complexityResult.crossRepoRefs >= CROSS_REPO_REF_THRESHOLD) {
      parts.push(`${complexityResult.crossRepoRefs} cross-repo references`);
    }
    if (complexityResult.vagueLanguageCount >= VAGUE_LANGUAGE_THRESHOLD) {
      parts.push(
        `${complexityResult.vagueLanguageCount} investigative phrases`,
      );
    }
    // Combined heuristic note
    if (
      complexityResult.questionCount >= 2 &&
      complexityResult.vagueLanguageCount >= 2 &&
      complexityResult.questionCount < QUESTION_COUNT_THRESHOLD &&
      complexityResult.vagueLanguageCount < VAGUE_LANGUAGE_THRESHOLD
    ) {
      parts.push("multiple requests with investigative language");
    }
    const scope = parts.join(", ");
    questions.push(
      `This issue covers a large scope (${scope}). It will be automatically broken into sub-issues via planning mode — would you prefer to break it down manually instead?`,
    );
    return {
      isClear: false,
      reason: "too_complex",
      questions,
    };
  }

  // Check for topics that require specific details
  for (const { pattern, needs } of REQUIRES_DETAILS) {
    if (pattern.test(content)) {
      // Check if the body has substantial content that might answer the question
      if (body.length > 200 && !VAGUE_PATTERNS.some((p) => p.test(body))) {
        continue; // Probably has enough detail
      }
      questions.push(`What ${needs} should be used?`);
    }
  }

  if (questions.length > 0) {
    return {
      isClear: false,
      reason: "missing_details",
      questions,
    };
  }

  // Check for overly broad scope
  const broadIndicators = [
    /and\s+also/gi,
    /as\s+well\s+as/gi,
    /plus/gi,
    /additionally/gi,
  ];

  const broadCount = broadIndicators.reduce((count, pattern) => {
    const matches = content.match(pattern);
    return count + (matches ? matches.length : 0);
  }, 0);

  if (
    broadCount >= 2 ||
    /entire|everywhere|all\s+(the\s+)?(files|code)/i.test(content)
  ) {
    questions.push(
      "This issue seems to cover multiple concerns. Could you break it into smaller, focused issues?",
    );
    return {
      isClear: false,
      reason: "too_broad",
      questions,
    };
  }

  // If we got here, the issue has some context but isn't obviously specific
  // Consider it clear enough to proceed
  return {
    isClear: true,
    reason: "has_context",
    questions: [],
  };
}

/**
 * Assess clarity command implementation.
 */
export const assessClarityCommand: Command = {
  name: "assess-clarity",
  description:
    "Analyse an issue to determine if requirements are clear enough to proceed",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<ClarityResult>> {
    // Validate args using typed schema (Issue #630)
    const parsed = validateAssessClarityArgs(args);
    if (!parsed.ok) {
      return {
        success: false,
        message: parsed.error.message,
      };
    }

    const { title, body, labels } = parsed.value;

    // Check if documentation label is present (bypasses clarity assessment)
    const skipLabels = [
      LABEL_DEFAULTS.documentationLabel,
    ];
    const lowerLabels = labels.map((l) => l.toLowerCase());
    const matchedSkip = skipLabels.find((sl) =>
      lowerLabels.includes(sl.toLowerCase())
    );
    if (matchedSkip) {
      return {
        success: true,
        message: "CLEAR",
        data: {
          isClear: true,
          reason: "skip_label",
          questions: [],
        },
      };
    }

    const operation = String(args["operation"] ?? "assess");

    // assess-with-claude operation: full Claude-based clarity assessment (Issue #1225)
    if (operation === "assess-with-claude") {
      const comments = String(args["comments"] ?? "");
      const round = typeof args["round"] === "number"
        ? args["round"]
        : parseInt(String(args["round"] ?? "0"), 10);

      const claudeResult: ClarityAssessmentResult = await runClarityAssessment({
        params: {
          issueTitle: title,
          issueBody: body,
          issueLabels: labels.join(","),
          issueComments: comments,
          // Genuine per-comment trust-header nonce, when supplied (Issue #3638).
          commentBoundaryId: args["comment-boundary-id"]
            ? String(args["comment-boundary-id"])
            : undefined,
          clarificationRound: round,
        },
        timeoutSeconds: _config.clarificationTimeout ??
          OPERATIONAL_DEFAULTS.clarificationTimeout,
        killAfterSeconds: _config.clarificationKillAfter ??
          OPERATIONAL_DEFAULTS.clarificationKillAfter,
        cwd: String(args["cwd"] ?? ""),
      });

      if (claudeResult.status === "clear") {
        return { success: true, message: "CLEAR" };
      }
      if (claudeResult.status === "failed") {
        return { success: false, message: "FAILED" };
      }
      // unclear — return the questions text
      return { success: true, message: claudeResult.questions };
    }

    const result = analyseIssueClarity(title, body, labels);

    // check-too-complex operation: return simple "TOO_COMPLEX" or empty
    if (operation === "check-too-complex") {
      if (!result.isClear && result.reason === "too_complex") {
        return {
          success: true,
          message: "TOO_COMPLEX",
          data: result,
        };
      }
      return {
        success: true,
        message: "",
        data: result,
      };
    }

    // Default assess operation
    if (result.isClear) {
      return {
        success: true,
        message: "CLEAR",
        data: result,
      };
    }

    // Format questions for output
    const questionsText = result.questions
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n");

    return {
      success: true,
      message: questionsText,
      data: result,
    };
  },
};
