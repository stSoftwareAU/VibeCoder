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

// =============================================================================
// Shared CLI flag coercion (Issue #1266)
// =============================================================================

/**
 * Render a rejected flag value for an operator-facing message.
 *
 * Values are summarised rather than dumped: a flag value can carry whatever
 * the operator's shell expanded into it.
 */
function describeFlagValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

/**
 * Coerce a parsed CLI flag into a boolean, failing closed.
 *
 * `mod.ts::parseArgs` JSON-parses every flag value and treats a value that
 * begins with `--` as the next flag, so a boolean flag arrives as a real
 * boolean only when it was written well: `--dry-run`, `--dry-run true` and
 * `--dry-run false`. Anything else — a number, an unrecognised word, an
 * empty shell expansion that swallowed the next flag — is **refused** rather
 * than mapped to `undefined`. That distinction is the whole point: for a
 * safety flag, `undefined` means "absent", and absence selects the more
 * dangerous default, so a value that cannot be read would silently disarm
 * the guard the operator believed they had set.
 *
 * @param value    Raw value from the parsed argument record.
 * @param flag     Flag name without the leading `--`, used in the message.
 * @param fallback Value used when the flag is genuinely absent.
 */
export function coerceBooleanFlag(
  value: unknown,
  flag: string,
  fallback: boolean,
): Result<boolean> {
  if (value === undefined || value === null) {
    return { ok: true, value: fallback };
  }
  if (typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return { ok: true, value: true };
    if (normalised === "false") return { ok: true, value: false };
  }
  return {
    ok: false,
    error: new Error(
      `Invalid --${flag}: expected true or false, got ` +
        `${describeFlagValue(value)}. A flag whose value cannot be read is ` +
        `refused, not ignored — ignoring it would select the default.`,
    ),
  };
}

/**
 * Coerce a parsed CLI flag into a list of strings, failing closed.
 *
 * Accepts a comma-separated string (`--repos org/a,org/b`), a JSON array
 * (`parseArgs` will already have parsed `--repos '["org/a"]'` into one), or
 * absence, which yields the empty list so a caller can apply its own
 * default. A value that is *present but not a usable list* — `true` from a
 * swallowed next flag, a number, an empty expansion — is an error, because
 * quietly treating it as absence widens whatever the list was narrowing.
 *
 * @param value Raw value from the parsed argument record.
 * @param flag  Flag name without the leading `--`, used in the message.
 */
export function coerceStringListFlag(
  value: unknown,
  flag: string,
): Result<string[]> {
  const refuse = (reason: string): Result<string[]> => ({
    ok: false,
    error: new Error(
      `Invalid --${flag}: ${reason}. A list flag whose value cannot be read ` +
        `is refused, not treated as absent.`,
    ),
  });

  if (value === undefined || value === null) {
    return { ok: true, value: [] };
  }

  const entries: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return refuse(
          `every entry must be a non-empty string, got ` +
            `${describeFlagValue(entry)}`,
        );
      }
      entries.push(entry.trim());
    }
  } else if (typeof value === "string") {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) entries.push(trimmed);
    }
  } else {
    return refuse(
      `expected a comma-separated list, got ${describeFlagValue(value)}`,
    );
  }

  if (entries.length === 0) {
    return refuse("present but empty");
  }
  return { ok: true, value: entries };
}

/**
 * List the options a command was given that it does not recognise.
 *
 * `parseArgs` ignores an unrecognised flag, so a typo is indistinguishable
 * from absence — and for a safety flag, absence is the dangerous branch. A
 * destructive command pairs this with a `KNOWN_OPTIONS` set so a misspelled
 * `--dry-run` is refused rather than silently dropped, the discipline
 * `commands/export_scrub_gate.ts` already applied.
 *
 * Injected test seams are ordinary keys, so a command that uses one lists it
 * in its own known set.
 *
 * @param args  Parsed argument record.
 * @param known Option names, without the leading `--`, the command accepts.
 * @returns The unrecognised names, without the leading `--`, in input order.
 */
export function findUnknownOptions(
  args: Record<string, unknown>,
  known: ReadonlySet<string>,
): string[] {
  return Object.keys(args).filter((key) => !known.has(key));
}
