/**
 * The agent pre-flight registry (Issue #3394): `loadConfig` registers a repo's
 * pre-flight commands and the agent runner resolves them by `owner/repo`.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  agentPreFlightCommands,
  registerAgentPreFlightConfigs,
  resetAgentPreFlightConfigsForTest,
} from "../lib/agent_pre_flight.ts";
import { loadConfig } from "../lib/config.ts";

Deno.test("agentPreFlightCommands - returns the registered repo's commands, [] otherwise (Issue #3394)", () => {
  try {
    registerAgentPreFlightConfigs({ "o/r": { preFlight: ["./x.sh"] } });
    assertEquals(agentPreFlightCommands("o/r"), ["./x.sh"]);
    assertEquals(agentPreFlightCommands("o/other"), []);
    assertEquals(agentPreFlightCommands(undefined), []);
    resetAgentPreFlightConfigsForTest();
    assertEquals(agentPreFlightCommands("o/r"), []);
  } finally {
    resetAgentPreFlightConfigsForTest();
  }
});

Deno.test({
  name:
    "loadConfig - registers the repo_config pre-flight commands (Issue #3394)",
  permissions: { read: true, write: true, env: true },
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "agent_pre_flight_3394_" });
    try {
      const path = `${dir}/.config.json`;
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          repos: ["o/r"],
          repo_config: { "o/r": { "pre-flight": ["./x.sh"] } },
        }),
      );
      resetAgentPreFlightConfigsForTest();
      await loadConfig(path);
      assertEquals(agentPreFlightCommands("o/r"), ["./x.sh"]);
    } finally {
      resetAgentPreFlightConfigsForTest();
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
});
