/**
 * One place every phase resolves its prompt template (Issue #849, part of
 * #843).
 *
 * Each built-in phase used to call `loadPrompt(<name>)` directly. An operator
 * override has to be consulted *before* that fallback, and doing it per phase
 * would be five copies of the same decision — so the decision lives here and
 * each builder calls {@link resolvePromptTemplate} instead.
 *
 * ## Fail loud, never fall back
 *
 * The override file was readable and placeholder-complete at config load, but
 * it can be deleted, truncated or edited between then and the build. Every such
 * fault is returned as an error naming the label, the phase and the path. It
 * never falls back to the repository's template: an operator who mapped a label
 * to their own prompt and silently got the built-in one would have no way to
 * know.
 *
 * ## Traceability
 *
 * Every resolution logs the file it used, so a run can be traced back to the
 * operator file behind it rather than only to the prompts checkout commit
 * (`recordPromptCommit`, Issue #844).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { CustomLabelPromptMapping, Logger, Result } from "../types.ts";
import { defaultLogger } from "./logger.ts";
import { loadCustomPromptTemplate } from "./custom_prompt_loader.ts";
import { loadPrompt, promptTemplatePath } from "./prompt_manager.ts";

/** A template a phase actually used, and where it came from. */
export interface ResolvedPromptTemplate {
  /** The phase the template was loaded for (`planning`, `issue`, …). */
  phase: string;
  /** The template text. */
  content: string;
  /** The file the text came from — the run's traceability record. */
  source: string;
  /** The label whose mapping supplied it, when it was not the built-in file. */
  overrideLabel?: string;
}

/** How a phase asks for its template. */
export interface PromptTemplateOptions {
  /** Prompts directory override (tests, container staging). */
  promptsDir?: string;
  /** The validated `custom_label_prompts` list, when the operator has one. */
  overrides?: readonly CustomLabelPromptMapping[];
  /**
   * An operator template chosen for this run rather than by phase — the
   * Issue #848 custom-label dispatch. Takes precedence over a phase override.
   */
  explicit?: { promptPath: string; label?: string };
  /** Logger for the traceability line; defaults to the process logger. */
  logger?: Logger;
}

/**
 * Find the mapping that overrides `phase`, if the operator configured one.
 *
 * @param overrides - The validated `custom_label_prompts` list
 * @param phase - The phase being loaded
 * @returns The mapping, or undefined when the phase has no override
 */
export function promptOverrideForPhase(
  overrides: readonly CustomLabelPromptMapping[] | undefined,
  phase: string,
): CustomLabelPromptMapping | undefined {
  return overrides?.find((mapping) => mapping.overridesPhase === phase);
}

/**
 * Load the template a phase should run with.
 *
 * Resolution order: an explicit per-run template (Issue #848 dispatch), then a
 * configured override for this phase (Issue #849), then the repository's
 * `prompts/<phase>/prompt.md`.
 *
 * @param phase - The template type / phase name
 * @param options - Prompts directory, overrides, explicit template, logger
 * @returns The template and the file it came from, or the fault that stopped it
 */
export async function resolvePromptTemplate(
  phase: string,
  options: PromptTemplateOptions = {},
): Promise<Result<ResolvedPromptTemplate>> {
  const logger = options.logger ?? defaultLogger;

  const operatorFile = options.explicit ??
    toExplicit(promptOverrideForPhase(options.overrides, phase));

  if (operatorFile) {
    const loaded = await loadCustomPromptTemplate(
      operatorFile.promptPath,
      operatorFile.label,
      phase,
    );
    if (!loaded.ok) return loaded;
    return record(logger, {
      phase,
      content: loaded.value,
      source: operatorFile.promptPath,
      ...(operatorFile.label !== undefined
        ? { overrideLabel: operatorFile.label }
        : {}),
    });
  }

  const loaded = await loadPrompt(phase, options.promptsDir);
  if (!loaded.ok) return loaded;
  return record(logger, {
    phase,
    content: loaded.value,
    source: promptTemplatePath(phase, options.promptsDir),
  });
}

/** Narrow a mapping to the explicit-template shape, if there is one. */
function toExplicit(
  mapping: CustomLabelPromptMapping | undefined,
): { promptPath: string; label?: string } | undefined {
  return mapping
    ? { promptPath: mapping.promptPath, label: mapping.label }
    : undefined;
}

/** Log the traceability line and hand the resolution back. */
function record(
  logger: Logger,
  resolved: ResolvedPromptTemplate,
): Result<ResolvedPromptTemplate> {
  logger.info(
    `Prompt template for phase '${resolved.phase}': ${resolved.source}`,
    {
      phase: resolved.phase,
      template: resolved.source,
      ...(resolved.overrideLabel !== undefined
        ? { overrideLabel: resolved.overrideLabel }
        : {}),
    },
  );
  return { ok: true, value: resolved };
}
