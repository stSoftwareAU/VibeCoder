/**
 * Condense an over-long idle-task wrapper preview to a summary + permalink
 * (Issue #3863).
 *
 * An idle-task wrapper body is a *preview* of the scan prompt: it is filed so a
 * human reading the issue sees the fully-substituted prompt, while the scan
 * re-loads the canonical prompt from `prompts/<scan>/prompt.md` at run time
 * (`template.runTask`). Prompts outgrew that: `security_scan` builds a
 * 100,961-character body against GitHub's 65,536-character ceiling, so the
 * clamp added by Issue #3634 dropped 35,946 characters out of the middle of
 * every seeded wrapper — the reader got a truncated copy and the only signal
 * was one `action=truncated_body` log line.
 *
 * This module fixes the cause rather than the symptom. When a preview would
 * exceed the budget, {@link buildPromptPreviewBody} stops inlining the prompt
 * and files a short summary instead:
 *
 *   - the prompt's own first heading, verbatim, so each template's body
 *     fingerprint still dispatches (`idle_task_claim_handler.ts`);
 *   - a visible notice naming the full prompt's size;
 *   - a **permalink to `prompts/<name>/prompt.md` pinned to the seeding
 *     commit SHA**, so the reader can open the exact prompt text that ran;
 *   - the template's scope, an outline of the prompt's sections, and the dedup
 *     rules that decide what gets filed.
 *
 * {@link clampIdleTaskBody} stays in place as the backstop, and
 * `idle_task_body_preview_limit_test.ts` is the gate that fails the build when
 * a future prompt edit pushes a preview over the budget.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { GITHUB_ISSUE_BODY_MAX_CHARS } from "./idle_task_body_limit.ts";
import { PROMPT_FILENAME } from "./prompt_manager.ts";
import { runGitCommand as defaultRunGitCommand } from "./git_timeout.ts";

/** Repository that hosts the canonical `prompts/` tree. */
export const PROMPT_SOURCE_REPO = "stSoftwareAU/VibeCoder";

/**
 * Characters reserved for the attribution footer and run-id metadata block that
 * both filers append after `buildIssueBody` returns. Comfortably ample — the
 * two together run to a few hundred characters.
 */
export const ATTRIBUTION_RESERVE_CHARS = 1_024;

/**
 * Budget a template's preview body must fit inside, leaving room for the
 * attribution tail so the assembled wrapper never reaches the clamp.
 */
export const IDLE_TASK_PREVIEW_MAX_CHARS = GITHUB_ISSUE_BODY_MAX_CHARS -
  ATTRIBUTION_RESERVE_CHARS;

/** Leading text of the visible "this preview is a summary" notice. */
export const IDLE_TASK_PREVIEW_CONDENSED_MARKER =
  "ℹ️ **Prompt preview condensed — the full prompt is linked below.**";

/** Most section headings listed in the outline. */
const MAX_OUTLINE_ENTRIES = 40;

/** Longest single outline entry, in characters. */
const MAX_OUTLINE_ENTRY_CHARS = 160;

/** First Markdown heading in a body — carries the template's fingerprint. */
const FIRST_HEADING = /^#{1,6}[ \t]+\S.*$/m;

/** Level-2 section headings, used to build the outline. */
const SECTION_HEADING = /^##[ \t]+(\S.*?)[ \t]*$/gm;

/** A 40-character git commit SHA. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Repo root of this checkout — where `prompts/` and `.git` live. The
 * launcher's VIBE_BASE_DIR wins (Issue #4302): in container mode the driver
 * runs from a staged copy of worker/deno, so the module-relative path would
 * name the copy, not the checkout.
 */
const REPO_ROOT = (() => {
  try {
    const baseDir = Deno.env.get("VIBE_BASE_DIR");
    if (baseDir) return baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  } catch {
    // no env permission — fall through to the module-relative default
  }
  return new URL("../../../", import.meta.url).pathname;
})();

/** Everything {@link condensePromptPreview} needs to describe the prompt. */
export interface PromptPreviewSource {
  /** Prompt directory under `prompts/`, e.g. `security_scan`. */
  promptName: string;
  /** Seeding commit SHA to pin the permalink to, or null when unreadable. */
  commitSha: string | null;
  /** One-line scope summary — normally the template's `description`. */
  scope: string;
}

/** Injectable lookups for {@link buildPromptPreviewBody}. */
export interface PromptPreviewDeps {
  /** Read the seeding commit SHA. Defaults to {@link headCommitSha}. */
  headCommitShaFn?: () => Promise<string | null>;
}

/** Options for {@link buildPromptPreviewBody}. */
export interface PromptPreviewOptions {
  /** Prompt directory under `prompts/`, e.g. `security_scan`. */
  promptName: string;
  /** One-line scope summary — normally the template's `description`. */
  scope: string;
  /** Override the budget. Defaults to {@link IDLE_TASK_PREVIEW_MAX_CHARS}. */
  maxChars?: number;
  /**
   * Checkout whose HEAD pins the prompt permalink (Issue #1024). Defaults to
   * {@link REPO_ROOT}. Threaded from the template's
   * `IdleTaskBodyOptions.rootDir` so a caller that named a root gets a
   * permalink pinned to *that* checkout, not to whatever the environment
   * happens to name.
   */
  rootDir?: string;
}

/**
 * Read a checkout's HEAD commit SHA, or null when it cannot be read.
 *
 * Null is not swallowed: {@link condensePromptPreview} falls back to a `main`
 * link and says in the body that the SHA was unavailable, so a reader can never
 * mistake an unpinned link for a pinned one.
 *
 * @param runGitCommandFn - git runner; defaults to the production one
 * @param rootDir - Checkout to read HEAD from (Issue #1024). Defaults to
 *   {@link REPO_ROOT}, which honours the launcher's `VIBE_BASE_DIR`; a caller
 *   that named a root reads that checkout instead of the ambient one.
 * @returns The 40-character SHA, or null
 */
export async function headCommitSha(
  runGitCommandFn = defaultRunGitCommand,
  rootDir: string = REPO_ROOT,
): Promise<string | null> {
  try {
    const result = await runGitCommandFn(["rev-parse", "HEAD"], {
      cwd: rootDir,
    });
    if (!result.ok || result.value.code !== 0) return null;
    const sha = result.value.stdout.trim();
    return COMMIT_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Format a character count with thousands separators, e.g. `100,841`. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Build the permalink line naming the exact prompt file that will run. */
function buildPromptLink(source: PromptPreviewSource): string {
  const path = `prompts/${source.promptName}/${PROMPT_FILENAME}`;
  const ref = source.commitSha ?? "main";
  const url = `https://github.com/${PROMPT_SOURCE_REPO}/blob/${ref}/${path}`;
  const pin = source.commitSha === null
    ? "the seeding run's commit SHA was unavailable, so this link tracks " +
      "`main` and may move"
    : `pinned to commit \`${source.commitSha}\``;
  return `**Prompt:** [\`${path}\`](${url}) — ${pin}.`;
}

/** Render the prompt's level-2 headings as a bounded outline. */
function buildOutline(fullBody: string): string[] {
  const headings: string[] = [];
  for (const match of fullBody.matchAll(SECTION_HEADING)) {
    headings.push(match[1]!.slice(0, MAX_OUTLINE_ENTRY_CHARS));
  }
  if (headings.length === 0) return [];

  const shown = headings.slice(0, MAX_OUTLINE_ENTRIES);
  const lines = shown.map((h) => `- ${h}`);
  if (headings.length > shown.length) {
    lines.push(`- …and ${headings.length - shown.length} more sections.`);
  }
  return lines;
}

/**
 * Condense a prompt body to a summary plus a commit-pinned permalink to the
 * exact prompt text, keeping the first heading verbatim so the template's body
 * fingerprint still dispatches.
 *
 * Throws when the body carries no Markdown heading — without one the condensed
 * wrapper would not be recognised by `matchesIdleTaskBody`, and filing an
 * undispatchable wrapper is worse than failing here.
 */
export function condensePromptPreview(
  fullBody: string,
  source: PromptPreviewSource,
): string {
  const heading = fullBody.match(FIRST_HEADING)?.[0];
  if (heading === undefined) {
    throw new Error(
      `condensePromptPreview: prompt ${source.promptName} has no Markdown ` +
        `heading to carry the wrapper body fingerprint`,
    );
  }

  const notice = [
    `> ${IDLE_TASK_PREVIEW_CONDENSED_MARKER}`,
    `> The fully-substituted prompt is ${groupDigits(fullBody.length)}`,
    `> characters, over GitHub's ${
      groupDigits(GITHUB_ISSUE_BODY_MAX_CHARS)
    }-character`,
    "> issue-body limit, so this wrapper summarises it and links the exact",
    "> prompt rather than inlining a truncated copy. The scan is unaffected —",
    "> it loads the full prompt from `prompts/` at run time, not from this",
    "> issue body.",
  ].join("\n");

  const parts: string[] = [
    heading,
    notice,
    buildPromptLink(source),
    `**Scope:** ${source.scope}`,
  ];

  const outline = buildOutline(fullBody);
  if (outline.length > 0) {
    parts.push("**What it checks**", outline.join("\n"));
  }

  parts.push(
    "**Dedup rules**",
    [
      "- A wrapper is only seeded when no open wrapper with the same title",
      "  already exists in the target repo.",
      "- The scan is handed the repo's open findings and its suppression list at",
      "  run time, and skips any candidate already covered by one of them.",
      "- Findings are filed as individual issues; this wrapper closes with a",
      "  summary of what landed.",
    ].join("\n"),
  );

  return parts.join("\n\n");
}

/**
 * Return `fullBody` when it fits the preview budget, otherwise the condensed
 * summary-plus-permalink form.
 */
export async function buildPromptPreviewBody(
  fullBody: string,
  opts: PromptPreviewOptions,
  deps: PromptPreviewDeps = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? IDLE_TASK_PREVIEW_MAX_CHARS;
  if (fullBody.length <= maxChars) return fullBody;

  const headCommitShaFn = deps.headCommitShaFn ??
    (() => headCommitSha(defaultRunGitCommand, opts.rootDir ?? REPO_ROOT));

  return condensePromptPreview(fullBody, {
    promptName: opts.promptName,
    commitSha: await headCommitShaFn(),
    scope: opts.scope,
  });
}
