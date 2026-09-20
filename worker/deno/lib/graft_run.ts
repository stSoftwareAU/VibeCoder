/**
 * Wiring one agent run to the Graft code graph's tools (Issue #2314, part of
 * #2060).
 *
 * `graft_context.ts` builds the graph and injects a `graft ask --source`
 * bundle before the run starts — the **push** side. That bundle is a bounded
 * selection made from the issue text alone; once the agent is past it, it
 * explores the checkout the way it always did. This module is the **pull**
 * side: on an `ok` collection it hands the agent Graft's MCP server, rooted
 * at the checkout the graph was built in, and appends the one prompt line
 * that says the tools exist. The five wired run kinds — issue, planning,
 * question, PR feedback and CI fix — share this implementation, as they share
 * `codegraph_run.ts` for CodeGraph.
 *
 * ## The pair is indivisible
 *
 * The MCP entry and the prompt line are added together or not at all.
 * Handing the agent the line without the server tells it to call a tool that
 * does not exist; handing it the server without the line leaves a graph the
 * agent never queries. {@link GraftRun.applyPrompt} and
 * {@link GraftRun.mcpConfig} read the same `wired` verdict.
 *
 * ## Composes with CodeGraph, never replaces it
 *
 * The two trials run on the same five paths. {@link GraftRun.mcpConfig} takes
 * the request CodeGraph already produced — a browser grant, a `codegraph`
 * server, or nothing — and adds the `graft` entry beside it, so neither tool
 * widens or narrows what the other granted (Issue #2156).
 *
 * ## Never fails the run
 *
 * The tools are an accelerator. A collection that did not reach `ok`, a run
 * that names no checkout, a provider that cannot be resolved and a provider
 * with no MCP transport all leave the run exactly as it was, and say so on
 * one log line. The tally is recorded only when the tools were actually
 * handed over: a Gemini-routed run reports no `queries` figure at all rather
 * than `0`, so "could not ask" never reads as "never asked".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  countGraftQueries,
  GRAFT_MCP_SERVER_NAME,
  GRAFT_PROMPT_LINE,
  type GraftContextResult,
  graftMcpServer,
} from "./graft_context.ts";
import type { AgentMcpServerRequest } from "./agent_mcp_config.ts";
import {
  type AgentProviderSelector,
  GEMINI_PROVIDER_ID,
  selectAgentProvider,
} from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";

/** The greppable marker on the one line that says why the tools were withheld. */
export const GRAFT_TOOLS_UNAVAILABLE_MARKER = "[GRAFT_TOOLS_UNAVAILABLE]";

/**
 * The logging surface this module needs.
 *
 * Structurally satisfied by the worker's `Logger`, so every caller passes its
 * own straight through and a test passes a two-method stub.
 */
export interface GraftRunLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** What one run's stats say about the invocation that produced them. */
export interface GraftInvocationStats {
  /** Per-tool call counts, when the provider's stream carried tool events. */
  toolCallCounts?: Record<string, number>;
  /** The provider that actually served the invocation. */
  provider?: string;
}

/** An `mcpConfig` value as the runner accepts it, or none at all. */
export type McpConfigRequest = boolean | AgentMcpServerRequest | undefined;

/** Options for {@link bindGraftRun}. */
export interface BindGraftRunOptions {
  /** What `collectGraftContext` produced for this run; mutated by `record`. */
  result: GraftContextResult;
  /**
   * Absolute path of the checkout the graph was built in.
   *
   * Omitted — or empty — names no checkout: the CI-fix path's `workDir` is
   * optional, and the runner writes no MCP configuration without a truthy
   * `cwd`, so the tools are withheld rather than promised and not delivered.
   */
  repoDir?: string;
  /** Provider selection for this invocation; omit for the active provider. */
  agentProvider?: AgentProviderSelector;
  /** Sink for the one status line. */
  logger: GraftRunLogger;
  /**
   * Environment lookup for the provider resolution (Issue #880's rule).
   *
   * Production passes nothing and the real process environment is read. A
   * test naming a provider hands in a fixed map rather than mutating the
   * environment every parallel worker shares.
   */
  env?: EnvLookup;
}

/** The decisions one bound run hands its caller. */
export interface GraftRun {
  /** The collection outcome, carrying `queries` once recorded. */
  readonly result: GraftContextResult;
  /** Whether the tools were handed to the agent. */
  readonly wired: boolean;
  /**
   * The user prompt this run sends.
   *
   * The Graft rule leads the prompt when wired and the prompt is returned
   * unchanged otherwise (Issue #2435 — as a trailing sentence it was
   * ignored). Leading — rather than injecting into the template — puts the
   * rule outside the untrusted fences the builder wrote, and because the
   * text is constant the prefix a wired run shares with the next is too.
   */
  applyPrompt(prompt: string): string;
  /**
   * The run's `mcpConfig`, given whatever it already had.
   *
   * When wired the `graft` entry rides beside the prior request: a browser
   * grant is kept as it was, a `codegraph` server stays, and a run with no
   * request gains the server and no browser. Otherwise the prior value is
   * returned untouched, so a switched-off host writes byte-identical
   * configuration.
   */
  mcpConfig(prior?: McpConfigRequest): McpConfigRequest;
  /**
   * The same decision as {@link mcpConfig}, spread-ready: an `undefined`
   * answer becomes an absent key rather than a present one.
   */
  mcpConfigOption(
    prior?: McpConfigRequest,
  ): { mcpConfig?: boolean | AgentMcpServerRequest };
  /**
   * Fold one completed invocation's stats into the result.
   *
   * Called once per invocation, so a path that makes several (planning) sums
   * its queries. Nothing is recorded when the tools were not handed over.
   */
  record(stats?: GraftInvocationStats): void;
}

/**
 * Bind the pull-side decisions to one run's Graft collection.
 *
 * Logs at most one line. Never throws: see the module docstring.
 *
 * @param options - Collection outcome, checkout, provider selection and logger
 * @returns The run's prompt, MCP and tally decisions
 */
export function bindGraftRun(options: BindGraftRunOptions): GraftRun {
  const { result, logger } = options;
  const repoDir = options.repoDir ?? "";
  let providerId = "";
  let wired = false;

  if (result.status === "ok") {
    if (repoDir === "") {
      logger.warn(
        `${GRAFT_TOOLS_UNAVAILABLE_MARKER} the run names no checkout, so ` +
          `there is nothing to root the graft server at (Issue #2314)`,
      );
    } else if ((providerId = resolveProviderId(options, logger)) === "") {
      // Already reported by resolveProviderId.
    } else if (providerId === GEMINI_PROVIDER_ID) {
      logger.info(
        `Graft tools: not handed to the agent — provider '${providerId}' ` +
          `has no MCP transport (Issue #2314)`,
      );
    } else {
      wired = true;
      logger.info(
        `Graft tools: handed to the agent as MCP server ` +
          `'${GRAFT_MCP_SERVER_NAME}' rooted at ${repoDir} (Issue #2314)`,
        { provider: providerId },
      );
    }
  }

  const mcpConfig = (prior?: McpConfigRequest): McpConfigRequest => {
    if (!wired) return prior;
    const graft = graftMcpServer(repoDir);
    if (typeof prior === "object") {
      return {
        ...prior,
        servers: { ...(prior.servers ?? {}), [GRAFT_MCP_SERVER_NAME]: graft },
      };
    }
    return {
      playwright: prior === true,
      servers: { [GRAFT_MCP_SERVER_NAME]: graft },
    };
  };

  return {
    result,
    wired,
    applyPrompt: (prompt: string) =>
      wired ? `${GRAFT_PROMPT_LINE}\n\n${prompt}` : prompt,
    mcpConfig,
    mcpConfigOption: (prior?: McpConfigRequest) => {
      const request = mcpConfig(prior);
      return request === undefined ? {} : { mcpConfig: request };
    },
    record: (stats?: GraftInvocationStats) => {
      if (!wired) return;
      const queries = countGraftQueries(stats?.toolCallCounts);
      if (queries !== undefined) {
        result.queries = (result.queries ?? 0) + queries;
      }
      if (
        stats?.provider !== undefined && providerId !== "" &&
        stats.provider !== providerId
      ) {
        logger.warn(
          `Graft tools were handed over for provider '${providerId}' but ` +
            `the run was served by '${stats.provider}' (Issue #2314)`,
        );
      }
    },
  };
}

/**
 * The provider id this run will use, or `""` when it could not be resolved.
 *
 * `selectAgentProvider` throws on an unregistered id and on a provider the
 * running image did not install. Caught here so losing the tools cannot fail
 * the run: the fault is logged with the marker, and the agent invocation that
 * follows raises the real provider error on its own.
 */
function resolveProviderId(
  options: BindGraftRunOptions,
  logger: GraftRunLogger,
): string {
  try {
    return selectAgentProvider(
      options.agentProvider,
      options.env ? { env: options.env } : {},
    ).id;
  } catch (err) {
    logger.warn(
      `${GRAFT_TOOLS_UNAVAILABLE_MARKER} the run's agent provider could not ` +
        `be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}
