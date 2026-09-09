/**
 * The output adapter reaches the runner through the provider descriptor
 * (Issue #1695, parent #1694).
 *
 * The point of the seam: no vendor check anywhere in `claude_runner.ts` — the
 * descriptor names the adapter, and the runner asks the descriptor. The
 * end-to-end test runs a stub agent that replays a recorded Claude 2.1.261
 * stream and asserts the normalised result the runner carries back.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const FIXTURE_DIR = new URL("./fixtures/agent_output/", import.meta.url);

Deno.test("provider descriptor - Claude and DeepSeek share the Claude adapter; Codex has its own", () => {
  assertEquals(resolveAgentProvider("claude").output?.providerId, "claude");
  // DeepSeek runs the same Claude Code binary, so it reads the same events.
  assertEquals(resolveAgentProvider("deepseek").output?.providerId, "claude");
  assertEquals(resolveAgentProvider("codex").output?.providerId, "codex");
});

Deno.test({
  name:
    "runClaudeWithRetry - a replayed Claude refusal comes back normalised (Issue #1695)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const raw = Deno.readTextFileSync(
      new URL("claude-2.1.261-auth-failure.jsonl", FIXTURE_DIR),
    );
    // The stub replays the recorded stream on stdout and exits like the CLI.
    const body = `cat <<'AGENT_FIXTURE_EOF'\n${raw}AGENT_FIXTURE_EOF\nexit 1\n`;

    const result = await withAgentStub(
      body,
      (stub) =>
        runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentBinaryPath: stub.path,
          },
          { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 1 },
        ),
      { prefix: "agent_output_stub_" },
    );

    assert(result.ok, "the runner returned an error");
    if (!result.ok) return;
    assertEquals(result.value.agentOutput?.status, "failed");
    assertEquals(result.value.agentOutput?.textSource, "final");
    assertEquals(result.value.agentFailure?.category, "authentication");
    // The existing contract is untouched: the extracted text is still there.
    assertEquals(result.value.output, "Not logged in · Please run /login");
  },
});
