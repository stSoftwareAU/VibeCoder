/**
 * Wiring one agent run to the CodeGraph index (Issue #2159, part of #2145).
 *
 * `codegraph_context.ts` owns the index step, the MCP entry, the prompt line
 * and the query tally; this module is the one place that turns those four
 * surfaces into the decisions a run makes, so the issue, planning and question
 * paths share a single implementation rather than four near-copies.
 *
 * ## The pair is indivisible
 *
 * The MCP entry and the prompt line are added together or not at all. Handing
 * the agent the line without the server tells it to call a tool that does not
 * exist; handing it the server without the line leaves an indexed repository
 * the agent never queries. {@link CodegraphRun.applyPrompt} and
 * {@link CodegraphRun.mcpConfig} therefore read the *same* status, and no
 * caller gets to decide one without the other.
 *
 * ## Never fails the run
 *
 * The index is an accelerator. `prepareCodegraphContext` never throws, and the
 * one thing this module adds on top — resolving the provider id the run will
 * use — is caught here: a provider that cannot be resolved is recorded as
 * `failed` with the usual `[CODEGRAPH_UNAVAILABLE]` line, and the agent
 * invocation that follows raises the real fault loudly on its own.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  CODEGRAPH_PROMPT_LINE,
  CODEGRAPH_UNAVAILABLE_MARKER,
  type CodegraphContextResult,
  codegraphMcpServer,
  countCodegraphQueries,
  prepareCodegraphContext,
  type PrepareCodegraphContextOptions,
} from "./codegraph_context.ts";
import type { AgentMcpServerRequest } from "./agent_mcp_config.ts";
import {
  type AgentProviderSelector,
  selectAgentProvider,
} from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";

/** The preparation seam — {@link prepareCodegraphContext} in production. */
export type PrepareCodegraphContextFn = (
  options: PrepareCodegraphContextOptions,
) => Promise<CodegraphContextResult>;

/**
 * The logging surface this module needs.
 *
 * Structurally satisfied by the worker's `Logger`, so every caller passes its
 * own straight through and a test passes a two-method stub.
 */
export interface CodegraphRunLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** What one run's stats say about the invocation that produced them. */
export interface CodegraphInvocationStats {
  /** Per-tool call counts, when the provider's stream carried tool events. */
  toolCallCounts?: Record<string, number>;
  /** The provider that actually served the invocation (Issue #4109). */
  provider?: string;
}

/** Options for {@link prepareCodegraphRun}. */
export interface PrepareCodegraphRunOptions {
  /** Absolute path of the repository checkout to index. */
  repoDir: string;
  /** The host switch, from `config.codegraphContext.enabled`. */
  enabled: boolean;
  /** Provider selection for this invocation; omit for the active provider. */
  agentProvider?: AgentProviderSelector;
  /** Sink for the one status line and any `[CODEGRAPH_UNAVAILABLE]` line. */
  logger: CodegraphRunLogger;
  /**
   * Environment lookup for the provider resolution (Issue #880's rule).
   *
   * Production passes nothing and the real process environment is read,
   * exactly as `claude_runner.ts` resolves the same descriptor. A test naming
   * a provider hands in a fixed map rather than mutating the environment
   * every parallel worker shares.
   */
  env?: EnvLookup;
  /** The preparation seam; defaults to {@link prepareCodegraphContext}. */
  prepare?: PrepareCodegraphContextFn;
}

/** The decisions one prepared run hands its caller. */
export interface CodegraphRun {
  /** What the preparation produced, carrying `queries` once recorded. */
  readonly result: CodegraphContextResult;
  /**
   * The user prompt this run sends.
   *
   * The CodeGraph line is appended on `ok` and the prompt is returned
   * unchanged on every other status. Appending — rather than injecting into
   * the template — is what keeps the prompt cache untouched, and it puts the
   * line outside the untrusted issue fences the builder wrote.
   */
  applyPrompt(prompt: string): string;
  /**
   * The run's `mcpConfig`, given the browser grant it already had.
   *
   * On `ok` the `codegraph` entry rides beside that grant, never widening it
   * (Issue #2156). On every other status the caller's own value is returned
   * untouched, so a switched-off host writes byte-identical configuration.
   */
  mcpConfig(playwright?: boolean): boolean | AgentMcpServerRequest | undefined;
  /**
   * The same decision as {@link mcpConfig}, spread-ready.
   *
   * A caller that passes no `mcpConfig` today must keep passing none, so an
   * `undefined` answer has to become an *absent key* rather than a present
   * one — spreading `{}` is the only way to say that. Written here so the
   * omission rule has one implementation instead of one per call site.
   */
  mcpConfigOption(
    playwright?: boolean,
  ): { mcpConfig?: boolean | AgentMcpServerRequest };
  /**
   * Fold one completed invocation's stats into the result.
   *
   * Called once per invocation, so a path that makes several (planning) sums
   * its queries. A provider that differs from the one the index step was
   * prepared for is reported, never corrected — the index is already built.
   */
  record(stats?: CodegraphInvocationStats): void;
}

/**
 * Prepare the CodeGraph index for one run and report what it decided.
 *
 * Logs exactly one status line per run. Never throws: see the module
 * docstring.
 *
 * @param options - Checkout, host switch, provider selection, logger and seam
 * @returns The run's prompt, MCP and tally decisions
 */
export async function prepareCodegraphRun(
  options: PrepareCodegraphRunOptions,
): Promise<CodegraphRun> {
  const { repoDir, enabled, logger } = options;
  const prepare = options.prepare ?? prepareCodegraphContext;

  // Resolved only when the switch is on: an off host must spend nothing, and
  // `prepareCodegraphContext` short-circuits before it reads the id anyway.
  let providerId = "";
  let result: CodegraphContextResult;
  if (enabled && (providerId = resolveProviderId(options, logger)) === "") {
    // A provider that cannot be resolved is a recorded outcome, never a
    // silent skip: the status line below still names it `failed`, which is
    // what the trial's figure reader looks for.
    result = { status: "failed", enabled: true };
  } else {
    result = await prepare({ repoDir, enabled, providerId, logger });
  }

  // Exactly one status line per run, on every path through this function.
  logger.info(describeOutcome(result), {
    codegraphStatus: result.status,
    ...(result.indexSeconds === undefined
      ? {}
      : { indexSeconds: result.indexSeconds }),
    ...(result.nodeCount === undefined ? {} : { nodes: result.nodeCount }),
    ...(result.relationshipCount === undefined
      ? {}
      : { relationships: result.relationshipCount }),
  });
  return buildRun(result, providerId, logger);
}

/**
 * The provider id this run will use, or `""` when it could not be resolved.
 *
 * `selectAgentProvider` throws on an unregistered id and on a provider the
 * running image did not install. Caught here so losing the index cannot fail
 * the run: the fault is logged with the usual marker, and the agent
 * invocation that follows raises the real provider error on its own.
 */
function resolveProviderId(
  options: PrepareCodegraphRunOptions,
  logger: CodegraphRunLogger,
): string {
  try {
    return selectAgentProvider(
      options.agentProvider,
      options.env ? { env: options.env } : {},
    ).id;
  } catch (err) {
    logger.warn(
      `${CODEGRAPH_UNAVAILABLE_MARKER} the run's agent provider could not ` +
        `be resolved: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}

/** The one status line a run logs, naming the status and whatever figures. */
function describeOutcome(result: CodegraphContextResult): string {
  const figures = [
    result.indexSeconds === undefined
      ? undefined
      : `index=${result.indexSeconds}s`,
    result.nodeCount === undefined ? undefined : `nodes=${result.nodeCount}`,
    result.relationshipCount === undefined
      ? undefined
      : `relationships=${result.relationshipCount}`,
  ].filter((part): part is string => part !== undefined);
  return `CodeGraph context: status=${result.status}` +
    (figures.length > 0 ? `, ${figures.join(", ")}` : "") +
    " (Issue #2159)";
}

/** Bind the decisions to one prepared result. */
function buildRun(
  result: CodegraphContextResult,
  providerId: string,
  logger: CodegraphRunLogger,
): CodegraphRun {
  const wired = result.status === "ok";
  const mcpConfig = (
    playwright?: boolean,
  ): boolean | AgentMcpServerRequest | undefined =>
    wired
      ? {
        playwright: playwright === true,
        servers: { codegraph: codegraphMcpServer() },
      }
      : playwright;
  return {
    result,
    applyPrompt: (prompt: string) =>
      wired ? `${prompt}\n\n${CODEGRAPH_PROMPT_LINE}` : prompt,
    mcpConfig,
    mcpConfigOption: (playwright?: boolean) => {
      const request = mcpConfig(playwright);
      return request === undefined ? {} : { mcpConfig: request };
    },
    record: (stats?: CodegraphInvocationStats) => {
      const queries = countCodegraphQueries(stats?.toolCallCounts);
      if (queries !== undefined) {
        result.queries = (result.queries ?? 0) + queries;
      }
      if (
        wired && stats?.provider !== undefined && providerId !== "" &&
        stats.provider !== providerId
      ) {
        logger.warn(
          `CodeGraph context was prepared for provider '${providerId}' but ` +
            `the run was served by '${stats.provider}' (Issue #2159)`,
        );
      }
    },
  };
}
