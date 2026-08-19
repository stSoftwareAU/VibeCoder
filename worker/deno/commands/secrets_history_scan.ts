/**
 * secrets-history-scan command (Issue #4190).
 *
 * One-shot, re-runnable full-history secrets sweep: gitleaks **and**
 * trufflehog over every ref (branches and tags), classified against a
 * committed baseline, written to a Markdown report under `docs/audits/`.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run --allow-env \
 *     mod.ts secrets-history-scan [--repo /path/to/repo] \
 *       [--baseline docs/audits/secrets-history-baseline.json] \
 *       [--report docs/audits/secrets-full-history-scan.md] \
 *       [--gitleaks-config .github/gitleaks.toml]
 *
 * Exits non-zero when the baseline is malformed, when any finding is
 * unbaselined, or while any confirmed finding is unrotated. A missing
 * scanner binary is an error, never a clean sweep (Issue #3234).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type FullHistoryScanResult,
  runFullHistoryScan,
} from "../lib/secrets_history_scan.ts";

/** Default baseline path, relative to the scanned repository. */
export const DEFAULT_BASELINE = "docs/audits/secrets-history-baseline.json";
/** Default report path, relative to the scanned repository. */
export const DEFAULT_REPORT = "docs/audits/secrets-full-history-scan.md";
/** Default gitleaks config, relative to the scanned repository. */
export const DEFAULT_GITLEAKS_CONFIG = ".github/gitleaks.toml";

/** Read a string argument, falling back to a default. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** Join a repo-relative path onto the repo root (absolute paths pass through). */
function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/** True when the path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export const secretsHistoryScanCommand: Command = {
  name: "secrets-history-scan",
  description:
    "Run gitleaks + trufflehog over every ref and report unbaselined or " +
    "unrotated secrets (Issue #4190)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<FullHistoryScanResult>> {
    const repoDir = stringArg(args, "repo", Deno.cwd());
    const baselinePath = resolve(
      repoDir,
      stringArg(args, "baseline", DEFAULT_BASELINE),
    );
    const reportPath = resolve(
      repoDir,
      stringArg(args, "report", DEFAULT_REPORT),
    );
    // An explicit --gitleaks-config must exist (fail loud on a typo); the
    // default one is used only when the repository actually ships it, so a
    // repo without a gitleaks config still scans with the default rule set.
    const explicitConfig = typeof args["gitleaks-config"] === "string";
    const gitleaksConfig = resolve(
      repoDir,
      stringArg(args, "gitleaks-config", DEFAULT_GITLEAKS_CONFIG),
    );
    const configExists = await exists(gitleaksConfig);
    if (explicitConfig && !configExists) {
      return {
        success: false,
        message: `❌ Full-history secret scan could not run: gitleaks config ` +
          `not found at ${gitleaksConfig}`,
      };
    }

    let result: FullHistoryScanResult;
    try {
      result = await runFullHistoryScan({
        repoDir,
        baselinePath,
        reportPath,
        ...(configExists ? { gitleaksConfig } : {}),
      });
    } catch (error) {
      // Fail loud — a scan that could not run is not a scan that passed.
      return {
        success: false,
        message: `❌ Full-history secret scan could not run: ` +
          `${(error as Error).message}`,
      };
    }

    const detail = [
      result.summary,
      `Report: ${result.reportPath}`,
      ...result.baselineErrors.map((e) => `Baseline error: ${e}`),
      ...result.unbaselined.map((f) => `Unbaselined: ${f.key}`),
      ...result.unrotated.map((e) =>
        `Unrotated: ${e.commit}|${e.path}|${e.rule} (${e.credentialClass})`
      ),
    ].join("\n");

    return { success: result.ok, message: detail, data: result };
  },
};
