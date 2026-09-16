/**
 * Reading the root a run's `codegraph` MCP server is started at (Issue #2200).
 *
 * The invariant every wired path shares is one sentence — the directory the
 * server resolves must be the directory the index was built in — so the six
 * path tests assert it through this one helper rather than six copies of the
 * same argument arithmetic.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { CODEGRAPH_ROOT_FLAG } from "../../lib/codegraph_context.ts";

/** The shape a run's `mcpConfig` takes once the CodeGraph entry rides in it. */
export interface CodegraphMcpConfig {
  playwright?: boolean;
  servers?: Record<string, { command: string; args?: string[] }>;
}

/**
 * The checkout the `codegraph` server in this `mcpConfig` is rooted at.
 *
 * @param mcpConfig - The value the run was handed, in whatever form
 * @returns The path following `--path`, or `undefined` when the entry names none
 */
export function codegraphServerRoot(
  mcpConfig: unknown,
): string | undefined {
  const request = mcpConfig as CodegraphMcpConfig | undefined;
  const args = request?.servers?.codegraph?.args;
  if (!Array.isArray(args)) return undefined;
  const flag = args.indexOf(CODEGRAPH_ROOT_FLAG);
  return flag < 0 ? undefined : args[flag + 1];
}

/**
 * Assert the server is rooted at the checkout the index was built in.
 *
 * @param mcpConfig - The `mcpConfig` the path handed its agent invocation
 * @param repoDir - The `repoDir` that path handed `prepareCodegraphContext`
 * @param path - Name of the run path, so a failure says which one drifted
 */
export function assertCodegraphRootedAt(
  mcpConfig: unknown,
  repoDir: string | undefined,
  path: string,
): void {
  assertEquals(
    codegraphServerRoot(mcpConfig),
    repoDir,
    `${path}: the codegraph MCP server must be rooted at the indexed ` +
      `checkout (Issue #2200)`,
  );
}
