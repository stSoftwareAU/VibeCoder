/**
 * Tests for `lib/graft_run.ts` — the pull side of Graft: handing one agent
 * run the `graft` MCP server and its prompt line (Issue #2314, part of #2060).
 *
 * The invariant under test is that the MCP entry and the prompt line are
 * added together or not at all, that they compose with whatever request the
 * run already had, and that the tally is recorded only when the tools were
 * actually handed over.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GRAFT_MCP_TOOLS,
  GRAFT_PROMPT_LINE,
  type GraftContextResult,
} from "../lib/graft_context.ts";
import {
  bindGraftRun,
  GRAFT_TOOLS_UNAVAILABLE_MARKER,
  type GraftRunLogger,
} from "../lib/graft_run.ts";

/** A logger that keeps what it was told, so a test can read the status line. */
function recordingLogger(): GraftRunLogger & {
  lines: { level: string; message: string }[];
} {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    info: (message: string) => lines.push({ level: "info", message }),
    warn: (message: string) => lines.push({ level: "warn", message }),
  };
}

function okCollection(): GraftContextResult {
  return {
    status: "ok",
    enabled: true,
    buildSeconds: 2.2,
    bundleChars: 4096,
    nodeCount: 820,
    callEdgeCount: 1204,
    bundle: "export function parseIsoDate(raw: string): number {}",
  };
}

const CLAUDE = { agentProvider: "claude", env: () => undefined } as const;

Deno.test("bindGraftRun - an ok collection on Claude gains the line and the server together", () => {
  const logger = recordingLogger();
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    ...CLAUDE,
    logger,
  });
  assertEquals(run.wired, true);

  const prompt = run.applyPrompt("user prompt");
  assertStringIncludes(prompt, GRAFT_PROMPT_LINE);
  // Issue #2435: read first, not last. As a trailing sentence after the issue,
  // the repo documents and the bundle it was ignored on 25 of 29 runs.
  assert(
    prompt.startsWith(GRAFT_PROMPT_LINE),
    "the rule leads the prompt, ahead of the task",
  );
  assert(
    prompt.endsWith("\n\nuser prompt"),
    "the task text follows whole and unaltered — led, never injected",
  );
  for (const tool of GRAFT_MCP_TOOLS) {
    if (tool === "graft_check_freshness") continue;
    assertStringIncludes(GRAFT_PROMPT_LINE, tool);
  }

  const mcp = run.mcpConfig(undefined);
  assert(typeof mcp === "object", "the graft server must be requested");
  assertEquals(mcp.playwright, false, "no request means no browser grant");
  assertEquals(mcp.servers?.graft?.command, "graft");
  assertEquals(mcp.servers?.graft?.args, ["mcp", "/tmp/checkout"]);
  assertEquals(mcp.servers?.graft?.env?.DO_NOT_TRACK, "1");

  assert(
    logger.lines.some((l) =>
      l.level === "info" && l.message.includes("rooted at /tmp/checkout")
    ),
    `one status line names the checkout, got: ${
      logger.lines.map((l) => l.message).join(" | ")
    }`,
  );
});

Deno.test("bindGraftRun - the server rides beside a browser grant and a codegraph server", () => {
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    ...CLAUDE,
    logger: recordingLogger(),
  });

  // A screenshot run keeps its browser.
  const withBrowser = run.mcpConfig(true);
  assert(typeof withBrowser === "object");
  assertEquals(withBrowser.playwright, true);
  assertEquals(withBrowser.servers?.graft?.command, "graft");

  // CodeGraph's request keeps its server and its (absent) browser grant.
  const prior = {
    playwright: false,
    servers: { codegraph: { command: "codegraph", args: ["serve"] } },
  };
  const both = run.mcpConfig(prior);
  assert(typeof both === "object");
  assertEquals(both.playwright, false);
  assertEquals(both.servers?.codegraph?.command, "codegraph");
  assertEquals(both.servers?.graft?.command, "graft");
  assertEquals(
    prior.servers,
    { codegraph: { command: "codegraph", args: ["serve"] } },
    "the prior request is never mutated",
  );

  const option = run.mcpConfigOption(false);
  assert(typeof option.mcpConfig === "object");
  assertEquals(option.mcpConfig.playwright, false);
  assertEquals(Object.keys(option.mcpConfig.servers ?? {}), ["graft"]);
});

Deno.test("bindGraftRun - every status short of ok adds neither half", () => {
  for (
    const result of [
      { status: "off", enabled: false },
      { status: "failed", enabled: true, buildSeconds: 300 },
    ] as const
  ) {
    const logger = recordingLogger();
    const run = bindGraftRun({
      result: { ...result },
      repoDir: "/tmp/checkout",
      ...CLAUDE,
      logger,
    });
    assertEquals(run.wired, false);
    assertEquals(run.applyPrompt("p"), "p");
    assertEquals(run.mcpConfig(true), true);
    assertEquals(run.mcpConfig(undefined), undefined);
    assertEquals(run.mcpConfigOption(undefined), {});
    const prior = { playwright: false, servers: {} };
    assertEquals(run.mcpConfig(prior), prior);
    assertEquals(logger.lines, [], `${result.status} logs nothing new`);
    run.record({ toolCallCounts: { graft_find_code: 3 } });
    assertEquals(run.result.queries, undefined, "nothing was handed over");
  }
});

Deno.test("bindGraftRun - a Gemini-routed run keeps the bundle and gets no tools", () => {
  const logger = recordingLogger();
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    agentProvider: "gemini",
    env: () => undefined,
    logger,
  });
  assertEquals(run.wired, false);
  assertEquals(run.result.status, "ok", "the push side is untouched");
  assertEquals(run.applyPrompt("p"), "p");
  assertEquals(run.mcpConfig(false), false);
  assert(
    logger.lines.some((l) =>
      l.level === "info" && l.message.includes("no MCP transport")
    ),
    "the withheld tools are said plainly",
  );
  run.record({ toolCallCounts: { Bash: 4 } });
  assertEquals(
    run.result.queries,
    undefined,
    "no tally: could not ask must never read as never asked",
  );
});

Deno.test("bindGraftRun - a run that names no checkout withholds the tools loudly", () => {
  for (const repoDir of [undefined, ""]) {
    const logger = recordingLogger();
    const run = bindGraftRun({
      result: okCollection(),
      ...(repoDir === undefined ? {} : { repoDir }),
      ...CLAUDE,
      logger,
    });
    assertEquals(run.wired, false);
    assertEquals(run.applyPrompt("p"), "p");
    assert(
      logger.lines.some((l) =>
        l.level === "warn" &&
        l.message.includes(GRAFT_TOOLS_UNAVAILABLE_MARKER) &&
        l.message.includes("names no checkout")
      ),
      "the fault must carry the marker",
    );
  }
});

Deno.test("bindGraftRun - an unresolvable provider withholds the tools, not the run", () => {
  const logger = recordingLogger();
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    agentProvider: "not-a-registered-provider",
    env: () => undefined,
    logger,
  });
  assertEquals(run.wired, false);
  assertEquals(run.result.status, "ok");
  assertEquals(run.mcpConfig(true), true);
  assert(
    logger.lines.some((l) =>
      l.message.includes(GRAFT_TOOLS_UNAVAILABLE_MARKER) &&
      l.message.includes("could not be resolved")
    ),
  );
});

Deno.test("bindGraftRun - queries are summed across invocations in both spellings", () => {
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    ...CLAUDE,
    logger: recordingLogger(),
  });
  run.record({ toolCallCounts: { mcp__graft__graft_find_code: 3, Bash: 9 } });
  run.record({
    toolCallCounts: { graft_file_api: 1, graft_trace_calls: 2, Read: 4 },
  });
  assertEquals(run.result.queries, 6);
  run.record({});
  assertEquals(run.result.queries, 6, "a missing tally adds nothing");
  run.record({ toolCallCounts: { Bash: 1 } });
  assertEquals(run.result.queries, 6, "a tally with no Graft call adds 0");
});

Deno.test("bindGraftRun - a tally with no Graft call is a real zero, not an absence", () => {
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    ...CLAUDE,
    logger: recordingLogger(),
  });
  run.record({ toolCallCounts: { Bash: 12, Read: 30 } });
  assertEquals(run.result.queries, 0);
});

Deno.test("bindGraftRun - a provider that differs is reported, not corrected", () => {
  const logger = recordingLogger();
  const run = bindGraftRun({
    result: okCollection(),
    repoDir: "/tmp/checkout",
    ...CLAUDE,
    logger,
  });
  run.record({ provider: "codex", toolCallCounts: { graft_find_code: 1 } });
  assertEquals(run.result.queries, 1);
  assert(
    logger.lines.some((l) =>
      l.level === "warn" && l.message.includes("served by 'codex'")
    ),
    "the drift must be reported",
  );
});

Deno.test("GRAFT_PROMPT_LINE - a rule with its reason, not a note (Issue #2435)", () => {
  // Every query tool the server offers is named, so the agent is never told
  // about a tool that is not there, nor left to discover one that is.
  for (const tool of GRAFT_MCP_TOOLS) {
    assertStringIncludes(GRAFT_PROMPT_LINE, tool);
  }
  // Each Bash habit it replaces is named beside its replacement; a rule that
  // does not say what to stop doing changes nothing.
  for (const habit of ["grep", "cat", "sed"]) {
    assertStringIncludes(GRAFT_PROMPT_LINE, habit);
  }
  // It says why, and it says when the old way is still right — an absolute
  // ban would be disobeyed the first time Graft has no answer.
  assertStringIncludes(GRAFT_PROMPT_LINE, "context");
  assertStringIncludes(GRAFT_PROMPT_LINE.toLowerCase(), "still");
});

Deno.test("GRAFT_PROMPT_LINE - names no provider and no provider-only tool (Issue #2435)", () => {
  // One text serves every provider with an MCP transport.
  for (const word of ["Claude", "Codex", "DeepSeek", "ToolSearch", "mcp__"]) {
    assert(
      !GRAFT_PROMPT_LINE.includes(word),
      `the rule must stay provider-neutral, found ${word}`,
    );
  }
});
