/**
 * Dispatch a custom-labelled issue into the generic implementation phase
 * (Issue #848, part of #843).
 *
 * An operator maps a GitHub label to a private prompt file
 * (`custom_label_prompts`, Issue #846); the label adder must be on the
 * allowlist (Issue #847). This module is what happens next: the issue runs the
 * **same** `workOnIssue` pipeline `work-on` runs — real branch, commits and PR
 * — with the operator's template substituted for `prompts/issue/`.
 *
 * ## Fail loud at dispatch
 *
 * The prompt file was readable at config load. If it has since been deleted,
 * truncated, or edited into an invalid template, this refuses the run and
 * throws with the label and the path named. It never falls back to the
 * built-in `issue` template (the operator's label would silently run someone
 * else's prompt) and never skips the issue quietly (the operator would believe
 * their extension was live). The throw reaches the priority dispatcher's
 * catch, which logs it as an error against the named handler.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type {
  CustomLabelPromptMapping,
  GitHubClient,
  Logger,
} from "../types.ts";
import type { IssueContext, WorkOnIssueResult } from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { workOnIssue } from "./issue_worker.ts";
import { loadCustomPromptTemplate } from "./custom_prompt_loader.ts";

/**
 * A mapped prompt file that is missing, unreadable, empty or invalid.
 *
 * Typed so the scan loop can tell "this operator's file is broken" from any
 * other failure (a `gh` fault, a rate limit) and keep the two apart: the first
 * is reported per mapping and re-raised once the scan finishes, the second
 * propagates immediately to the dispatcher that knows how to handle it.
 */
export class CustomPromptDispatchError extends Error {
  constructor(message: string, readonly label: string) {
    super(message);
    this.name = "CustomPromptDispatchError";
  }
}

/** Dependencies for one custom-label dispatch. */
export interface CustomLabelDispatchDeps {
  logger: Logger;
  deps: WorkerDeps;
  /** The orchestrator to run. Injected for tests; production uses `workOnIssue`. */
  runOrchestrator?: (
    ctx: IssueContext,
    deps: WorkerDeps,
  ) => Promise<WorkOnIssueResult>;
}

/**
 * Outcome of a custom-label dispatch.
 *
 * `ok` is what `findAndProcessByLabel` reads to log handled vs declined, so it
 * tracks the pipeline's own success flag rather than "the call returned".
 */
export interface CustomLabelDispatchResult {
  ok: boolean;
  result: WorkOnIssueResult;
}

/**
 * Run the generic implementation phase for an issue carrying a custom label.
 *
 * @param ctx - Issue context built by the label finder
 * @param mapping - The validated label → prompt-path mapping that matched
 * @param deps - Logger, worker dependencies, optional orchestrator override
 * @returns The pipeline result, with `ok` mirroring its success flag
 * @throws When the mapped prompt file is missing, unreadable, empty or invalid
 */
export async function processCustomLabelIssue(
  ctx: IssueContext,
  mapping: CustomLabelPromptMapping,
  deps: CustomLabelDispatchDeps,
): Promise<CustomLabelDispatchResult> {
  const { logger } = deps;

  // Re-read the operator's file before the run starts. Cheap, and it turns a
  // deleted or broken prompt into a loud refusal here rather than a wasted
  // clone followed by a build failure.
  const template = await loadCustomPromptTemplate(
    mapping.promptPath,
    mapping.label,
  );
  if (!template.ok) {
    throw new CustomPromptDispatchError(
      `Refusing to dispatch ${ctx.repo}#${ctx.issueNumber} for custom label ` +
        `'${mapping.label}': ${template.error.message}. The built-in issue ` +
        `template is never substituted for an operator's prompt — fix ` +
        `${mapping.promptPath} or remove the mapping from .config.json.`,
      mapping.label,
    );
  }

  logger.info(
    `Dispatching ${ctx.repo}#${ctx.issueNumber} to the implementation phase ` +
      `with the custom prompt for '${mapping.label}' (${mapping.promptPath})`,
  );

  const run = deps.runOrchestrator ?? workOnIssue;
  const result = await run(
    {
      ...ctx,
      customPromptPath: mapping.promptPath,
      customPromptLabel: mapping.label,
    },
    deps.deps,
  );
  return { ok: result.success, result };
}

/**
 * The label finder this dispatch drives — `findAndProcessByLabel`.
 *
 * Structural, so the helper below can be tested without standing up the
 * production dependency graph.
 */
export type LabelScanner = (
  label: string,
  processFn: (
    ctx: IssueContext,
    deps: { ghClient: GitHubClient; logger: Logger; deps: WorkerDeps },
  ) => Promise<{ ok: boolean }>,
  deadlineEpochMs?: number,
) => Promise<{ processed: boolean }>;

/**
 * Try each configured custom label in configuration order (Issue #848).
 *
 * Stops at the first label that produced work, so one cycle works one issue —
 * the same shape as every other label priority. With no mappings it scans
 * nothing and reports `processed: false`, which is why the priority row itself
 * is only wired when the operator configured at least one.
 *
 * A broken prompt file does not starve the labels behind it: the fault is
 * reported through `onFault` as it happens, the remaining mappings are still
 * scanned, and — when nothing else was worked — it is raised so the handler
 * fails rather than reporting a quiet idle pass. What it must never do is let
 * one operator's typo silently block every other custom label.
 *
 * @param mappings - The validated `custom_label_prompts` list
 * @param scan - The label finder (production: `findAndProcessByLabel`)
 * @param options.deadlineEpochMs - Watchdog deadline for the calling handler
 * @param options.onFault - Reports each broken mapping as it is found
 * @returns Whether an issue was found and worked
 * @throws When a mapped prompt file could not be dispatched and no other
 *   custom label produced work this pass
 */
export async function dispatchCustomLabelPrompts(
  mappings: readonly CustomLabelPromptMapping[],
  scan: LabelScanner,
  options: {
    deadlineEpochMs?: number;
    onFault?: (fault: CustomPromptDispatchError) => void;
  } = {},
): Promise<{ processed: boolean }> {
  const faults: CustomPromptDispatchError[] = [];

  for (const mapping of mappings) {
    let result: { processed: boolean };
    try {
      result = await scan(
        mapping.label,
        (ctx, processorDeps) =>
          processCustomLabelIssue(ctx, mapping, processorDeps),
        options.deadlineEpochMs,
      );
    } catch (error) {
      // Only a broken operator prompt is held over; anything else — a `gh`
      // fault, a primary rate limit — belongs to the dispatcher, now.
      if (!(error instanceof CustomPromptDispatchError)) throw error;
      faults.push(error);
      options.onFault?.(error);
      continue;
    }
    // Work done this pass wins the return value; the faults above were already
    // reported, and an unfixed file surfaces again on the next pass.
    if (result.processed) return { processed: true };
  }

  if (faults.length > 0) throw aggregateFault(faults);
  return { processed: false };
}

/** One error naming every mapping whose prompt file could not be dispatched. */
function aggregateFault(
  faults: readonly CustomPromptDispatchError[],
): CustomPromptDispatchError {
  if (faults.length === 1) return faults[0]!;
  return new CustomPromptDispatchError(
    `${faults.length} custom label prompts could not be dispatched: ${
      faults.map((fault) => fault.message).join(" | ")
    }`,
    faults.map((fault) => fault.label).join(","),
  );
}
