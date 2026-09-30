/**
 * Which agent runs are handed the Playwright MCP browser (Issue #2925).
 *
 * Every run that can change a repository's code is given the browser unless
 * the repository sets `skip_screenshot_check`. Issue #192 wired it only on an
 * explicit need signal (the `needs-screenshot` label or `requiresScreenshots`),
 * but the completion gate decides "UI change" afterwards, from the diff: a run
 * that touched UI files with no label had no tool to take the screenshot the
 * gate then demanded, and failed (GRQ-AutoTrader#1772, #1788 and four more).
 * Starting the browser costs seconds; a failed run and its retry cost an hour.
 *
 * `skip_screenshot_check` still withholds it (Issue #1584): that repository
 * gets neither the screenshot gate nor the screenshot instructions, so a
 * browser buys it nothing. Issue #192's guards on the server itself — cloud
 * metadata origins blocked, a disposable profile, secrets denied — are
 * unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RepoConfig } from "../types.ts";
import { getRepoConfig } from "./repo_config.ts";

/** Whether an agent run in `repo` is handed the Playwright MCP browser. */
export function browserGranted(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): boolean {
  return getRepoConfig(repoConfigs, repo, "skipScreenshotCheck") !== "true";
}
