/**
 * Command-specific argument types and validation (Issue #630).
 *
 * Provides typed argument interfaces for each command and validation
 * functions that return Result types for consistent error handling.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";

// =============================================================================
// Assess Clarity Args
// =============================================================================

/** Typed arguments for the assess-clarity command. */
export interface AssessClarityArgs {
  /** Issue title */
  title: string;
  /** Issue body/description */
  body: string;
  /** Issue labels */
  labels: string[];
  /** Issue comments (optional, for future use) */
  comments?: string[];
}

/**
 * Validate and parse assess-clarity command arguments.
 *
 * Defaults: title and body default to empty string, labels to empty array.
 * Returns an error if provided values have incorrect types.
 */
export function validateAssessClarityArgs(
  args: Record<string, unknown>,
): Result<AssessClarityArgs> {
  // Validate title if provided
  if (args.title !== undefined && typeof args.title !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'title' must be a string"),
    };
  }

  // Validate body if provided
  if (args.body !== undefined && typeof args.body !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'body' must be a string"),
    };
  }

  // Validate labels if provided
  if (args.labels !== undefined && !Array.isArray(args.labels)) {
    return {
      ok: false,
      error: new Error("Argument 'labels' must be an array"),
    };
  }

  // Validate comments if provided
  if (args.comments !== undefined && !Array.isArray(args.comments)) {
    return {
      ok: false,
      error: new Error("Argument 'comments' must be an array"),
    };
  }

  return {
    ok: true,
    value: {
      title: (args.title as string) ?? "",
      body: (args.body as string) ?? "",
      labels: (args.labels as string[]) ?? [],
      comments: (args.comments as string[]) ?? undefined,
    },
  };
}

// =============================================================================
// Check Parent Dependencies Args
// =============================================================================

/** Typed arguments for the check-parent-deps command. */
export interface CheckParentDepsArgs {
  /** Repository in "owner/repo" format */
  repo: string;
  /** Issue number to check */
  issue: number;
}

/**
 * Validate and parse check-parent-deps command arguments.
 *
 * Both repo and issue are required.
 */
export function validateCheckParentDepsArgs(
  args: Record<string, unknown>,
): Result<CheckParentDepsArgs> {
  if (args.repo === undefined || args.repo === null) {
    return {
      ok: false,
      error: new Error("Required argument 'repo' is missing"),
    };
  }

  if (typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string"),
    };
  }

  if (args.issue === undefined || args.issue === null) {
    return {
      ok: false,
      error: new Error("Required argument 'issue' is missing"),
    };
  }

  if (typeof args.issue !== "number") {
    return {
      ok: false,
      error: new Error("Argument 'issue' must be a number"),
    };
  }

  return {
    ok: true,
    value: {
      repo: args.repo,
      issue: args.issue,
    },
  };
}

// =============================================================================
// Check Repo Availability Args
// =============================================================================

/** Typed arguments for the check-repo-availability command. */
export interface CheckRepoAvailabilityArgs {
  /** Repository in "owner/repo" format */
  repo: string;
  /** GitHub username to check assignments against */
  githubUser: string;
}

/**
 * Validate and parse check-repo-availability command arguments.
 *
 * Both repo and github-user are required.
 */
export function validateCheckRepoAvailabilityArgs(
  args: Record<string, unknown>,
): Result<CheckRepoAvailabilityArgs> {
  if (args.repo === undefined || args.repo === null) {
    return {
      ok: false,
      error: new Error("Required argument 'repo' is missing"),
    };
  }

  if (typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string"),
    };
  }

  const githubUser = args["github-user"];
  if (githubUser === undefined || githubUser === null) {
    return {
      ok: false,
      error: new Error("Required argument 'github-user' is missing"),
    };
  }

  if (typeof githubUser !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'github-user' must be a string"),
    };
  }

  return {
    ok: true,
    value: {
      repo: args.repo,
      githubUser: githubUser,
    },
  };
}

// =============================================================================
// Suggest Improvements Args
// =============================================================================

/** Typed arguments for the suggest-improvements command. */
export interface SuggestImprovementsArgs {
  /** Target repository in "owner/repo" format (optional) */
  repo?: string;
  /** When true, do not create issues (just list suggestions) */
  dryRun: boolean;
}

/**
 * Validate and parse suggest-improvements command arguments.
 *
 * repo is optional. dry-run defaults to false.
 */
export function validateSuggestImprovementsArgs(
  args: Record<string, unknown>,
): Result<SuggestImprovementsArgs> {
  // Validate repo if provided
  if (args.repo !== undefined && typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string"),
    };
  }

  // Validate dry-run if provided
  const dryRunValue = args["dry-run"];
  if (dryRunValue !== undefined && typeof dryRunValue !== "boolean") {
    return {
      ok: false,
      error: new Error("Argument 'dry-run' must be a boolean"),
    };
  }

  return {
    ok: true,
    value: {
      repo: args.repo as string | undefined,
      dryRun: (dryRunValue as boolean) ?? false,
    },
  };
}
