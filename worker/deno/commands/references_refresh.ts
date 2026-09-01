/**
 * references-refresh command (Issue #665).
 *
 * A maintenance sweep a person starts on demand: re-check every source
 * credited in `docs/REFERENCES.md`, ask each one "has anything new landed?",
 * and raise one unlabelled suggestion issue per gap for a human to vet. It is
 * deliberately not an idle task — the idle-task framework files work the fleet
 * then acts on, and nothing here may ever be acted on unvetted.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env --allow-run --allow-net \
 *     mod.ts references-refresh [--repo /path/to/checkout] \
 *       [--slug owner/repo] \
 *       [--references docs/REFERENCES.md] \
 *       [--state .github/references-refresh-state.json] \
 *       [--source mattpocock/skills] \
 *       [--file-issues] [--max-issues N]
 *
 * Report-only by default; `--file-issues` raises the suggestions and records
 * the new revisions. Exits non-zero when any source could not be probed or any
 * issue could not be filed — a sweep that could not run is not a clean sweep.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, Result } from "../types.ts";
import {
  createDefaultRefreshDeps,
  DEFAULT_MAX_ISSUES,
  DEFAULT_REFERENCES_PATH,
  DEFAULT_STATE_PATH,
  type RefreshDeps,
  type RefreshResult,
  runReferencesRefresh,
} from "../lib/references_refresh.ts";
import {
  createDefaultProbeDeps,
  probeReferenceSource,
} from "../lib/references_source_probe.ts";

/** Read a string argument, falling back to a default. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Read an optional string argument. */
function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** True for `--flag`, `--flag true`. */
function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

/** Join a repo-relative path onto the repo root (absolute paths pass through). */
function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/**
 * Parse `--max-issues`.
 *
 * @param raw - The argument as parsed from the command line
 * @returns The cap, or the reason it is not one
 */
export function parseMaxIssues(raw: unknown): Result<number, string> {
  if (raw === undefined) return { ok: true, value: DEFAULT_MAX_ISSUES };
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string"
    ? Number.parseInt(raw, 10)
    : Number.NaN;
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: "--max-issues must be a positive integer" };
  }
  return { ok: true, value };
}

/** Resolve the `owner/repo` slug: `--slug`, else `gh repo view` in the checkout. */
async function resolveSlug(
  args: Record<string, unknown>,
  ghCommandFn: RefreshDeps["ghCommandFn"],
): Promise<string> {
  const explicit = optionalStringArg(args, "slug");
  if (explicit !== undefined) return explicit;
  const slug = (await ghCommandFn([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ])).trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(
      "could not determine the repository slug — pass --slug owner/repo",
    );
  }
  return slug;
}

/** Build the command with injectable deps (tests) or the defaults. */
export function createReferencesRefreshCommand(deps?: RefreshDeps): Command {
  return {
    name: "references-refresh",
    description:
      "Re-check every docs/REFERENCES.md source for material that has landed " +
      "since we last took from it; --file-issues raises one unlabelled " +
      "suggestion issue per gap for a human to vet (Issue #665)",
    async execute(
      args: Record<string, unknown>,
    ): Promise<CommandResult<RefreshResult>> {
      const cap = parseMaxIssues(args["max-issues"]);
      if (!cap.ok) {
        return {
          success: false,
          message: `❌ References refresh could not run: ${cap.error}`,
        };
      }

      const probeDeps = createDefaultProbeDeps();
      const resolved = deps ?? createDefaultRefreshDeps(
        (entry, since) => probeReferenceSource(entry, since, probeDeps),
      );
      const repoDir = stringArg(args, "repo", Deno.cwd());
      const sourceFilter = optionalStringArg(args, "source");

      let result: RefreshResult;
      try {
        result = await runReferencesRefresh({
          slug: await resolveSlug(args, resolved.ghCommandFn),
          referencesPath: resolve(
            repoDir,
            stringArg(args, "references", DEFAULT_REFERENCES_PATH),
          ),
          statePath: resolve(
            repoDir,
            stringArg(args, "state", DEFAULT_STATE_PATH),
          ),
          fileIssues: boolArg(args, "file-issues"),
          maxIssues: cap.value,
          now: new Date(),
          ...(sourceFilter !== undefined ? { sourceFilter } : {}),
        }, resolved);
      } catch (error) {
        // Fail loud — a sweep that could not run is not a sweep that passed.
        return {
          success: false,
          message: `❌ References refresh could not run: ` +
            `${(error as Error).message}`,
        };
      }

      const detail = [
        result.summary,
        ...result.checked.map((name) => `Checked: ${name}`),
        ...result.found.map((gap) =>
          `Gap: ${gap.id} ${gap.sourceName} — ${gap.unit}`
        ),
        ...result.filed.map((filed) => `Filed: #${filed.number} ${filed.id}`),
        ...result.alreadyFiled.map((id) => `Already proposed: ${id}`),
        ...result.deferred.map((id) => `Deferred to the next run: ${id}`),
        ...result.errors.map((error) => `Error: ${error}`),
        result.stateWritten
          ? `Recorded revisions: ${result.statePath} — commit it so the next ` +
            "sweep starts from here"
          : `Recorded revisions unchanged: ${result.statePath}`,
      ].join("\n");

      return { success: result.ok, message: detail, data: result };
    },
  };
}

/** The registered command, wired to production deps. */
export const referencesRefreshCommand: Command =
  createReferencesRefreshCommand();
