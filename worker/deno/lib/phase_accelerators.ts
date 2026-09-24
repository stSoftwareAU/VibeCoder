/**
 * Graft, CodeGraph and RTK for one phase run (Issue #2569).
 *
 * Grill-me (Issue #2561) prepares the three accelerators inline. Clarity,
 * refinement, revision and quorum need the identical sequence, so it lives
 * here once: one Graft collection, one CodeGraph preparation and one RTK
 * preparation per run, handed to the run's spawn(s), with the three outcomes
 * returned for the phase's stats comment.
 *
 * Every step reports a fault as `failed` (or `unsupported`) rather than
 * throwing, so losing an accelerator never fails the phase — it reads `failed`
 * on the run's stats comment instead.
 *
 * @module
 */

import type { AgentMcpServerRequest } from "./agent_mcp_config.ts";
import type { CodegraphContextResult } from "./codegraph_context.ts";
import {
  type CodegraphRun,
  type PrepareCodegraphContextFn,
  prepareCodegraphRun,
} from "./codegraph_run.ts";
import type { WorkerConfig } from "../types.ts";
import {
  collectGraftContext,
  describeGraftContext,
  formatGraftContextSection,
  type GraftContextCollector,
  type GraftContextResult,
  graftQueryFor,
} from "./graft_context.ts";
import { isGraftContextEnabled } from "./graft_context_config.ts";
import { bindGraftRun, type GraftRun } from "./graft_run.ts";
import { repoCheckoutPath } from "./repo_checkout_path.ts";
import {
  type prepareRtkRun,
  type RtkOutputResult,
  type RtkRun,
  type rtkProviderId,
  settingsJsonOption,
} from "./rtk_output.ts";

/** The logging surface the three preparations share. */
export interface PhaseAcceleratorLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** The `ClaudeDeps` seams the preparation reads. */
export interface PhaseAcceleratorClaudeDeps {
  prepareCodegraphContext: PrepareCodegraphContextFn;
  prepareRtkRun: typeof prepareRtkRun;
  rtkProviderId: typeof rtkProviderId;
}

export interface PreparePhaseAcceleratorsOptions {
  config: WorkerConfig;
  /** `owner/name`, naming the checkout under `config.workDir`. */
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  claude: PhaseAcceleratorClaudeDeps;
  logger: PhaseAcceleratorLogger;
  /** The Graft collection seam; defaults to {@link collectGraftContext}. */
  collectGraftContext?: GraftContextCollector;
}

/** The spawn options the accelerators add to one invocation. */
export interface PhaseAcceleratorSpawnOptions {
  mcpConfig?: boolean | AgentMcpServerRequest;
  settingsJson?: string;
}

/** The three outcomes, shaped for `reportPhaseDegradation`. */
export interface PhaseAcceleratorReport {
  graft: GraftContextResult;
  codegraph: CodegraphContextResult;
  rtk: RtkOutputResult;
}

export interface PhaseAccelerators {
  /** The provider the run was prepared for; `""` when unresolvable. */
  readonly providerId: string;
  readonly graft: GraftRun;
  readonly codegraph: CodegraphRun;
  readonly rtk: RtkRun;
  /**
   * The prompt this run sends: the Graft bundle appended (when there is one),
   * then the CodeGraph, Graft and RTK rules — RTK's outermost, the order
   * planning and grill-me use. Appending keeps the template's cached prefix.
   */
  applyPrompt(prompt: string): string;
  /** `mcpConfig` and `settingsJson`, spread-ready; `{}` when all are off. */
  spawnOptions(): PhaseAcceleratorSpawnOptions;
  /** Fold one successful invocation's stats into the Graft and CodeGraph tallies. */
  recordSuccess(stats?: {
    toolCallCounts?: Record<string, number>;
    provider?: string;
  }): void;
  /** Re-read RTK's savings; call after the spawn(s), success or not. */
  afterSpawn(): Promise<void>;
  /** The three outcomes for the phase's stats comment. */
  report(): PhaseAcceleratorReport;
}

/**
 * Prepare Graft, CodeGraph and RTK once for a phase run.
 *
 * @param options - The run's config, issue and seams
 * @returns The prepared accelerators, bound to the run's active provider
 */
export async function preparePhaseAccelerators(
  options: PreparePhaseAcceleratorsOptions,
): Promise<PhaseAccelerators> {
  const { config, repo, issueNumber, issueTitle, issueBody, claude, logger } =
    options;
  const repoDir = repoCheckoutPath(config.workDir, repo);

  const collect = options.collectGraftContext ?? collectGraftContext;
  const graftContext = await collect({
    repoDir,
    query: graftQueryFor(issueTitle, issueBody),
    enabled: isGraftContextEnabled(config),
    logger,
  });
  if (graftContext.status !== "off") {
    logger.info(describeGraftContext(graftContext), { repo, issueNumber });
  }

  const codegraph = await prepareCodegraphRun({
    repoDir,
    enabled: config.codegraphContext.enabled,
    logger,
    prepare: claude.prepareCodegraphContext,
  });
  const graft = bindGraftRun({ result: graftContext, repoDir, logger });

  const providerId = claude.rtkProviderId(undefined, logger);
  const rtk = await claude.prepareRtkRun({
    enabled: config.rtkOutput.enabled,
    providerId,
    logger,
    cwd: repoDir,
  });

  const bundleSection = formatGraftContextSection(graftContext.bundle);

  return {
    providerId,
    graft,
    codegraph,
    rtk,
    applyPrompt: (prompt) => {
      const withBundle = bundleSection === ""
        ? prompt
        : `${prompt}\n\n${bundleSection}`;
      return rtk.applyPrompt(
        graft.applyPrompt(codegraph.applyPrompt(withBundle)),
      );
    },
    spawnOptions: () => ({
      ...graft.mcpConfigOption(codegraph.mcpConfig()),
      ...settingsJsonOption(undefined, rtk.hookSettings()),
    }),
    recordSuccess: (stats) => {
      codegraph.record(stats);
      graft.record(stats);
    },
    afterSpawn: () => rtk.record(),
    report: () => ({
      graft: graft.result,
      codegraph: codegraph.result,
      rtk: rtk.result,
    }),
  };
}
