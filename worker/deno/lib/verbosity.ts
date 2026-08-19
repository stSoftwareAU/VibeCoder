/**
 * Verbosity instruction templates for prompt injection.
 *
 * Issue #1331: Create instruction text for each verbosity level that gets
 * injected into prompts to control output verbosity.
 * Part of #1329 (caveman mode — configurable verbosity).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import {
  DEFAULT_VERBOSITY,
  PHASE_VERBOSITY_DEFAULTS,
} from "./config_defaults.ts";
import type { RepoConfig, VerbosityLevel } from "../types.ts";

/**
 * Instruction templates for each verbosity level.
 *
 * These are injected into prompts to guide Claude's response style. Each level
 * states the shape of the output to produce — a skeleton to mirror — rather
 * than a list of prohibitions, and every level (including `standard`) carries
 * an instruction, so no surface is silent about its published output
 * (Issue #3813). `verbose` is bounded to the decisions that were genuinely
 * close, so "thorough" does not mean "unbounded".
 */
const VERBOSITY_INSTRUCTIONS: Readonly<Record<VerbosityLevel, string>> = {
  minimal:
    "Produce a single sentence naming what you changed. That sentence is the " +
    "whole response.",
  concise:
    "Produce a brief response of 2-3 sentences: what you changed, and why. " +
    "Add one further sentence only for a decision a reader could not infer " +
    "from the diff.",
  standard:
    "Summarise what you changed once the work is done: what changed, why, and " +
    "anything a reviewer needs to know to check it. Write that summary at the " +
    "end — no running commentary while you work.",
  verbose:
    "Produce the standard summary — what changed, why, and what a reviewer " +
    "needs to know — then add one short section per decision that was " +
    "genuinely close: the option you took, the alternative you rejected, and " +
    "the fact that settled it. Give detailed explanations of those trade-offs " +
    "only; a decision with one obvious answer needs no section.",
};

/**
 * Returns the instruction text for a given verbosity level.
 *
 * The returned string is intended to be injected into a prompt template.
 * Every level returns a non-empty instruction, including "standard"
 * (Issue #3813).
 *
 * @param level - The verbosity level to get instructions for.
 * @returns Instruction text for the level.
 */
export function getVerbosityInstructions(level: VerbosityLevel): string {
  return VERBOSITY_INSTRUCTIONS[level];
}

/**
 * Resolves the effective verbosity level using the priority chain:
 *
 * 1. Per-repo override (highest priority)
 * 2. Phase default (from PHASE_VERBOSITY_DEFAULTS)
 * 3. Global default ("standard")
 *
 * @param phase - The current worker phase (e.g. "issue", "planning").
 * @param repoConfig - Optional per-repo configuration.
 * @returns The resolved VerbosityLevel.
 */
export function resolveVerbosity(
  phase: string,
  repoConfig?: RepoConfig,
): VerbosityLevel {
  // Per-repo override takes highest priority
  if (repoConfig?.verbosity) {
    return repoConfig.verbosity;
  }

  // Phase default from PHASE_VERBOSITY_DEFAULTS
  const phaseDefault = PHASE_VERBOSITY_DEFAULTS[phase];
  if (phaseDefault) {
    return phaseDefault as VerbosityLevel;
  }

  // Global default
  return DEFAULT_VERBOSITY;
}
