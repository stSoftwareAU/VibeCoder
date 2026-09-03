/**
 * Per-model coding-guidelines overlay (Issue #374, parent #358).
 *
 * The shared `coding_guidelines` template is model-agnostic from v42
 * (Issue #373): it states the standing directives as rules rather than
 * asserting one generation's traits to every agent that runs them. Genuine
 * per-model tuning still has to live somewhere, so this module resolves an
 * optional overlay fragment keyed off the **active provider identity** —
 * the same identity `lib/agent_provider.ts` resolves — and
 * `buildCodingGuidelines()` appends it behind the agnostic baseline.
 *
 * Overlays are ordinary versioned prompts: `prompts/coding_guidelines_<id>/`
 * holding immutable `vN.md` files, of which the highest wins. Two candidates
 * are tried, most specific first:
 *
 *   1. `coding_guidelines_<provider>_<model>` — tuning for one model,
 *   2. `coding_guidelines_<provider>`         — tuning for the whole provider.
 *
 * No candidate directory → no overlay, and the baseline is returned byte for
 * byte. A directory that *does* exist but carries no `vN.md` is an authoring
 * mistake and fails loud rather than passing for "no overlay".
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
 *   cannot be read or carries no version.
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
          `Coding-guidelines overlay '${name}' exists but no version could be loaded: ${loaded.error.message}`,
        ),
      };
    }
    return { ok: true, value: loaded.value };
  }

  return { ok: true, value: undefined };
}
