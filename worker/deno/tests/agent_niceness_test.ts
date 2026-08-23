/**
 * Tests for the agent's scheduler priority (Issue #324).
 *
 * On 2026-08-22 two agents each wrote an unbounded bash busy-wait — one with
 * no `sleep` at all — and pinned the container. The worker's own watchdogs
 * fired 1350 s and 2737 s late, `vminitd` stopped answering, and the cycle had
 * to be killed by hand. `quality.sh` already nices itself for exactly this
 * reason; the agent, and every shell it spawns, did not.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_AGENT_NICENESS,
  resolveAgentNiceness,
  resolveNiceBinary,
} from "../lib/claude_runner.ts";

/** An env reader over a fixed map. */
function env(values: Record<string, string>) {
  return (key: string): string | undefined => values[key];
}

Deno.test("#324 - the agent is niced by default", () => {
  assertEquals(resolveAgentNiceness(env({})), DEFAULT_AGENT_NICENESS);
  assertEquals(
    resolveAgentNiceness(env({ VIBE_AGENT_NICE: "" })),
    DEFAULT_AGENT_NICENESS,
  );
});

Deno.test("#324 - an operator can raise the niceness", () => {
  assertEquals(resolveAgentNiceness(env({ VIBE_AGENT_NICE: "12" })), 12);
});

Deno.test("#324 - zero means do not wrap, not 'nice -n 0'", () => {
  // The off switch. `nice -n 0` would be a pointless extra process in the
  // tree for no priority change.
  assertEquals(resolveAgentNiceness(env({ VIBE_AGENT_NICE: "0" })), undefined);
});

Deno.test("#324 - a negative niceness is refused, not applied", () => {
  // Raising the agent *above* the worker is the opposite of the point, and
  // needs privileges the container does not have.
  assertEquals(resolveAgentNiceness(env({ VIBE_AGENT_NICE: "-5" })), undefined);
});

Deno.test("#324 - an unparseable value degrades to today's behaviour", () => {
  // A typo must not become a surprising priority.
  assertEquals(
    resolveAgentNiceness(env({ VIBE_AGENT_NICE: "low" })),
    undefined,
  );
  assertEquals(
    resolveAgentNiceness(env({ VIBE_AGENT_NICE: "NaN" })),
    undefined,
  );
});

Deno.test("#324 - niceness is clamped to the POSIX maximum", () => {
  assertEquals(resolveAgentNiceness(env({ VIBE_AGENT_NICE: "99" })), 19);
});

Deno.test("#324 - a fractional value is floored rather than rejected", () => {
  assertEquals(resolveAgentNiceness(env({ VIBE_AGENT_NICE: "7.9" })), 7);
});

Deno.test("#324 - nice is resolved by absolute path, never through PATH", () => {
  // The agent is spawned with clearEnv and a curated environment, so a
  // PATH-based lookup depends on that environment containing a directory it
  // was never guaranteed to have. The first cut of this change did exactly
  // that and broke every `withGhLessStubClaude` test, whose PATH holds only
  // the stub.
  const seen: string[] = [];
  resolveNiceBinary((path) => {
    seen.push(path);
    return false;
  });
  assert(seen.length > 0, "candidates must be probed");
  assert(
    seen.every((p) => p.startsWith("/")),
    `every candidate must be absolute; got ${seen.join(", ")}`,
  );
});

Deno.test("#324 - an absent nice means the agent is spawned unwrapped", () => {
  assertEquals(resolveNiceBinary(() => false), undefined);
});

Deno.test("#324 - the first present candidate wins", () => {
  assertEquals(resolveNiceBinary((p) => p === "/bin/nice"), "/bin/nice");
});
