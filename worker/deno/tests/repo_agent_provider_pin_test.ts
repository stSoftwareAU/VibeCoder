/**
 * Tests for the per-repo `agent_provider` pin (Issue #2048).
 *
 * `repo_config.<repo>.agent_provider` pins the coding-agent provider for that
 * repository alone, layered between the explicit per-invocation selection
 * (which stays absolute — a Quorum draft names its own provider) and the
 * process-wide default (`.config.json` `agent_provider`, then
 * `VIBE_AGENT_PROVIDER`, then Claude).
 *
 * The layering lives in `agent_provider.ts` as a pure helper so the
 * execute-claude-phase wiring is a one-line change and every precedence case
 * is unit-testable without the phase harness.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  agentProviderIds,
  repoPinnedAgentProvider,
  resolveInvocationAgentProvider,
} from "../lib/agent_provider.ts";
import type { RepoConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// The repo pin itself
// ---------------------------------------------------------------------------

Deno.test("repo agent provider - a pin resolves to its canonical id", () => {
  assertEquals(
    repoPinnedAgentProvider({ agentProvider: "deepseek" }),
    "deepseek",
  );
  // Trimming matches every other source (Issue #1032's parser behaviour).
  assertEquals(
    repoPinnedAgentProvider({ agentProvider: " claude " }),
    "claude",
  );
});

Deno.test("repo agent provider - no pin and a blank pin resolve to undefined", () => {
  assertEquals(repoPinnedAgentProvider(undefined), undefined);
  assertEquals(repoPinnedAgentProvider({}), undefined);
  assertEquals(repoPinnedAgentProvider({ agentProvider: "" }), undefined);
  assertEquals(repoPinnedAgentProvider({ agentProvider: "   " }), undefined);
});

Deno.test("repo agent provider - an unregistered id fails loudly, naming the repo key", () => {
  let thrown: unknown;
  try {
    repoPinnedAgentProvider({ agentProvider: "aider" } as RepoConfig);
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error, "an unregistered repo pin must throw");
  const message = (thrown as Error).message;
  assertStringIncludes(message, "aider");
  assertStringIncludes(message, "repo_config");
  for (const id of agentProviderIds()) {
    assertStringIncludes(message, id);
  }
});

// ---------------------------------------------------------------------------
// The invocation layering
// ---------------------------------------------------------------------------

Deno.test("repo agent provider - an explicit per-invocation selection stays absolute", () => {
  // A Quorum draft that names a provider must beat the repo's pin — the draft
  // is the operator's per-invocation choice (Issue #4109's precedence).
  assertEquals(
    resolveInvocationAgentProvider("codex", { agentProvider: "deepseek" }),
    "codex",
  );
});

Deno.test("repo agent provider - the repo pin binds when nothing is explicit", () => {
  assertEquals(
    resolveInvocationAgentProvider(undefined, { agentProvider: "deepseek" }),
    "deepseek",
  );
});

Deno.test("repo agent provider - no explicit selection and no pin leaves the default alone", () => {
  assertEquals(resolveInvocationAgentProvider(undefined, undefined), undefined);
  assertEquals(resolveInvocationAgentProvider(undefined, {}), undefined);
});
