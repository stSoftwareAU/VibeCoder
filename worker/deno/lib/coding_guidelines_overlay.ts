/**
 * Per-model coding-guidelines overlay (Issue #374, parent #358).
 *
 * The shared `coding_guidelines` template is model-agnostic
 * (Issue #373): it states the standing directives as rules rather than
 * asserting one generation's traits to every agent that runs them. Genuine
 * per-model tuning still has to live somewhere, so this module resolves an
 * optional overlay fragment keyed off the **active provider identity** —
 * the same identity `lib/agent_provider.ts` resolves — and
 * `buildCodingGuidelines()` appends it behind the agnostic baseline.
 *
 * Overlays are ordinary prompts: `prompts/coding_guidelines_<id>/prompt.md`.
 * Two candidates are tried, most specific first:
 *
 *   1. `coding_guidelines_<provider>_<model>` — tuning for one model,
 *   2. `coding_guidelines_<provider>`         — tuning for the whole provider.
 *
 * No candidate directory → no overlay, and the baseline is returned byte for
 * byte. A directory that *does* exist but carries no `prompt.md` is an
 * authoring mistake and fails loud rather than passing for "no overlay".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { getPromptsDir, loadPrompt } from "./prompt_manager.ts";

/**
 * Identity of the agent a prompt is being built for (Issue #374).
 *
 * Both fields are optional: a caller that has no identity to hand passes
 * nothing and gets the model-agnostic baseline. Overlays are keyed off the
 * provider, so a `model` with no `provider` selects nothing — there is no
 * second notion of "current model" here.
 */
export interface AgentIdentity {
  /**
   * Active provider id, as resolved by `resolveAgentProviderId()`
   * (`claude`, `codex`, `gemini`).
   */
  provider?: string;
  /** Resolved model id or tier, where the caller knows it (e.g. `opus`). */
  model?: string;
}

/** Prompt-type prefix every overlay directory carries. */
export const CODING_GUIDELINES_OVERLAY_PREFIX = "coding_guidelines_";

/** Longest slug accepted for one identity segment. */
const MAX_SEGMENT_LENGTH = 40;

/**
 * Reduce an operator-supplied identity to a single safe path segment.
 *
 * Provider and model ids reach here from `.config.json` and the environment,
 * so they are untrusted for path purposes: everything outside `[a-z0-9]` is
 * collapsed to `-`, which leaves no separator or `..` behind.
 *
 * @param value - Raw identity segment.
 * @returns The slug, or undefined when nothing usable remains.
 */
function slugify(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/-+$/, "");
  return slug === "" ? undefined : slug;
}

/**
 * The overlay prompt names an identity selects, most specific first.
 *
 * @param identity - Active provider and, where known, model.
 * @returns Candidate prompt-type names; empty when there is no usable
 *   provider identity.
 */
export function codingGuidelinesOverlayNames(
  identity?: AgentIdentity,
): string[] {
  const provider = slugify(identity?.provider);
  if (!provider) return [];

  const model = slugify(identity?.model);
  const names = [`${CODING_GUIDELINES_OVERLAY_PREFIX}${provider}`];
  if (model) {
    names.unshift(`${CODING_GUIDELINES_OVERLAY_PREFIX}${provider}_${model}`);
  }
  return names;
}

/** Whether `path` is an existing directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Load the working-style overlay for an identity, if one is authored.
 *
 * @param identity - Active provider and, where known, model.
 * @param promptsDir - Prompts directory (defaults to the worker's).
 * @returns The overlay text, or `undefined` when no overlay directory exists
 *   for this identity. Errors only when an overlay directory exists but
 *   cannot be read or carries no `prompt.md`.
 */
export async function loadCodingGuidelinesOverlay(
  identity?: AgentIdentity,
  promptsDir?: string,
): Promise<Result<string | undefined>> {
  const names = codingGuidelinesOverlayNames(identity);
  if (names.length === 0) return { ok: true, value: undefined };

  // Resolve through the same seam `loadPrompt` uses, so an overlay is looked
  // for wherever the run's prompts actually live (PROMPTS_DIR, the staged
  // container checkout, or the module-relative default).
  const dir = promptsDir ?? getPromptsDir();

  for (const name of names) {
    let exists: boolean;
    try {
      exists = await isDirectory(`${dir}/${name}`);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `Coding-guidelines overlay '${name}' could not be read: ${
            (error as Error).message
          }`,
        ),
      };
    }
    if (!exists) continue;

    const loaded = await loadPrompt(name, dir);
    if (!loaded.ok) {
      // The directory was authored deliberately, so an unloadable overlay is
      // a fault — reporting "no overlay" here would mask it.
      return {
        ok: false,
        error: new Error(
          `Coding-guidelines overlay '${name}' exists but its prompt could not be loaded: ${loaded.error.message}`,
        ),
      };
    }
    return { ok: true, value: loaded.value };
  }

  return { ok: true, value: undefined };
}

/**
 * How much of the shared guidelines a phase loads (Issue #2574).
 *
 * - `core` — the rules every phase needs: working style, fail loud, secure
 *   coding, the `gh` and lifecycle rules, escalation and the escape hatch.
 *   Phases that read and report but write no code (`planning`,
 *   `planning_critique`, `question`, `grill_me`) stop here.
 * - `commit` — core plus the rules for running commands and committing:
 *   non-interactive execution, streaming reads, commit safety and the run-id
 *   trailer. `spelling_fix` commits dictionary and prose edits, so it needs
 *   these but not the code-writing layer.
 * - `code` — everything, for the phases that edit, test and commit code.
 */
export type CodingGuidelinesLayer = "core" | "commit" | "code";

/** Layers in load order: each includes every layer before it. */
const LAYER_ORDER: readonly CodingGuidelinesLayer[] = [
  "core",
  "commit",
  "code",
];

/** Opens a block that the named layer and above load, on a line of its own. */
const LAYER_OPEN_RE = /^<!-- guidelines-layer: ([a-z-]+) -->$/;
/** Closes the open block. */
const LAYER_CLOSE = "<!-- /guidelines-layer -->";

/**
 * Keep the parts of the guidelines a layer loads (Issue #2574).
 *
 * The template marks each block that not every phase needs with a
 * `<!-- guidelines-layer: commit|code -->` line and closes it with
 * `<!-- /guidelines-layer -->`. Unmarked text is core. A block is kept when the
 * requested layer includes its layer; the marker lines themselves are always
 * removed, so a code-writing phase sees the template exactly as authored.
 *
 * One template file keeps each rule in one place and keeps
 * `computeStaticPromptHash()` covering both layers: an edit to either changes
 * the file, and so the hash.
 *
 * @param text - The guidelines template
 * @param layer - The layer the phase loads
 * @returns The selected text, or an error for an unknown layer, a nested or
 *   stray marker, or a block left open — an authoring mistake that would
 *   otherwise silently drop or leak a rule.
 */
export function selectCodingGuidelinesLayer(
  text: string,
  layer: CodingGuidelinesLayer,
): Result<string> {
  const rank = LAYER_ORDER.indexOf(layer);
  const output: string[] = [];
  let open: CodingGuidelinesLayer | undefined;
  const fail = (lineNo: number, why: string): Result<string> => ({
    ok: false,
    error: new Error(
      `coding_guidelines layer marker at line ${lineNo}: ${why}`,
    ),
  });

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const opened = LAYER_OPEN_RE.exec(line.trim());
    if (opened) {
      if (open) return fail(i + 1, "a layer block cannot nest inside another");
      const named = opened[1] as CodingGuidelinesLayer;
      if (named === "core" || !LAYER_ORDER.includes(named)) {
        return fail(i + 1, `unknown layer '${opened[1]}'`);
      }
      open = named;
      continue;
    }
    if (line.trim() === LAYER_CLOSE) {
      if (!open) return fail(i + 1, "closes a block that was never opened");
      open = undefined;
      continue;
    }
    if (open && LAYER_ORDER.indexOf(open) > rank) continue;
    output.push(line);
  }
  if (open) return fail(lines.length, `the '${open}' block is never closed`);

  // A marker sits between blank lines, so removing it (or its block) leaves a
  // double blank line behind; the template itself never carries one.
  return { ok: true, value: output.join("\n").replace(/\n{3,}/g, "\n\n") };
}
