/**
 * Tests for security_scanner.ts (Issues #1940, #2097, #2135).
 *
 * Issue #2097 rewrote the executor to an outcome-only contract:
 *   - The prompt instructs Claude to file findings directly via
 *     `gh issue create`; the executor no longer parses a JSON block.
 *   - `runSecurityScan` returns `Result<{ ok: true }, ScanError>` —
 *     success means Claude exited cleanly, failure surfaces the
 *     timeout / non-zero exit / prompt-load reason.
 *
 * Issue #2135 (v6): the `{{REPO_FULL_NAME}}` placeholder was retired —
 * the executor's cwd is the cloned repo, so `gh issue create` operates
 * on the right one without explicit substitution. The three remaining
 * placeholders still substitute.
 *
 * These tests verify:
 *   - Placeholder substitution covers the three remaining placeholders.
 *   - A successful Claude run returns `Result.ok({ ok: true })`.
 *   - A timeout returns `Result.err({ kind: "timeout" })` with the
 *     partial output captured up to that point.
 *   - A non-zero exit returns `Result.err({ kind: "claude" })`.
 *   - The runner was invoked with Write/Edit/MultiEdit/NotebookEdit
 *     and plan-mode tools disallowed (Bash remains allowed).
 *   - The working directory is forwarded to the runner as `cwd`.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildLlmGateText,
  buildSecurityScanPrompt,
  runSecurityScan,
  type ScannerDeps,
  type ScanOptions,
  SECURITY_SCAN_DISALLOWED_TOOLS,
} from "../lib/security_scanner.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import type { LlmUsageVerdict } from "../lib/llm_usage_detection.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Build a fake runner that returns a clean exit by default. */
function fakeRunner(
  output: string,
  captured?: { options?: RunClaudeOptions },
): ScannerDeps["runClaudeFn"] {
  return (opts) => {
    if (captured) captured.options = opts;
    return Promise.resolve({
      ok: true,
      value: { exitCode: 0, output, timedOut: false },
    });
  };
}

function makeDeps(
  output: string,
  captured?: { options?: RunClaudeOptions },
): ScannerDeps {
  return {
    loadPromptFn: async (name: string) => {
      const { loadPrompt } = await import("../lib/prompt_manager.ts");
      return loadPrompt(name, PROMPTS_DIR);
    },
    runClaudeFn: fakeRunner(output, captured),
  };
}

const BASE_OPTS: ScanOptions = {
  repo: "stSoftwareAU/VibeCoder",
  workDir: "/tmp/scan",
  knownOpenFindingIds: ["SEC-known00000a"],
  openIssueTitles: [],
  suppressedIds: ["SEC-suppressed1"],
};

// ---------------------------------------------------------------------------
// buildSecurityScanPrompt — placeholder substitution
// ---------------------------------------------------------------------------

Deno.test("buildSecurityScanPrompt - substitutes the two placeholders", () => {
  const template = [
    "Suppressed:",
    "{{SUPPRESSED_IDS}}",
    "Known open:",
    "{{KNOWN_OPEN_FINDING_IDS}}",
  ].join("\n");

  const rendered = buildSecurityScanPrompt(template, {
    suppressedIds: ["SEC-aaa", "SEC-bbb"],
    knownOpenFindingIds: ["SEC-ccc"],
  });

  assertStringIncludes(rendered, "SEC-aaa\nSEC-bbb");
  assertStringIncludes(rendered, "SEC-ccc");
  assertEquals(rendered.includes("{{SUPPRESSED_IDS}}"), false);
  assertEquals(rendered.includes("{{KNOWN_OPEN_FINDING_IDS}}"), false);
});

Deno.test(
  "buildSecurityScanPrompt - does not substitute REPO_FULL_NAME (Issue #2135)",
  () => {
    // v6 retired the repo-name placeholder; leave any literal `{{REPO_FULL_NAME}}`
    // untouched so a stale template surfaces visibly instead of silently
    // rendering as the wrong identifier.
    const rendered = buildSecurityScanPrompt("Repo: {{REPO_FULL_NAME}}", {
      suppressedIds: [],
      knownOpenFindingIds: [],
    });
    assertStringIncludes(rendered, "Repo: {{REPO_FULL_NAME}}");
  },
);

Deno.test(
  "buildSecurityScanPrompt - does not substitute LANGUAGE_HINTS (Issue #2159)",
  () => {
    // v8 retired the language-hints placeholder; the scanner agent
    // detects languages at scan time. Any literal `{{LANGUAGE_HINTS}}`
    // remains in the template so a stale prompt surfaces visibly
    // instead of silently rendering as an empty/wrong value.
    const rendered = buildSecurityScanPrompt("Languages: {{LANGUAGE_HINTS}}", {
      suppressedIds: [],
      knownOpenFindingIds: [],
    });
    assertStringIncludes(rendered, "Languages: {{LANGUAGE_HINTS}}");
  },
);

Deno.test(
  "buildSecurityScanPrompt - empty suppressed/known lists render as '(none)' (Issue #2138)",
  () => {
    // v6 substituted empty lists as the empty string, producing broken
    // English when the placeholder was wrapped in inline backticks (e.g.
    // "appears in `` or ``"). v7 + this substitution rule together
    // guarantee that empty inputs always read naturally.
    const template = [
      "Suppressed:",
      "{{SUPPRESSED_IDS}}",
      "Known open:",
      "{{KNOWN_OPEN_FINDING_IDS}}",
    ].join("\n");
    const rendered = buildSecurityScanPrompt(template, {
      suppressedIds: [],
      knownOpenFindingIds: [],
    });
    assertStringIncludes(rendered, "Suppressed:\n(none)");
    assertStringIncludes(rendered, "Known open:\n(none)");
  },
);

Deno.test(
  "buildSecurityScanPrompt - populated suppressed/known lists join with newlines (Issue #2138)",
  () => {
    // Sanity check: the "(none)" sentinel only fires for empty lists.
    // Populated lists must still substitute as the original newline join
    // so dedup against prior findings continues to work.
    const template =
      "Suppressed:\n{{SUPPRESSED_IDS}}\nKnown:\n{{KNOWN_OPEN_FINDING_IDS}}";
    const rendered = buildSecurityScanPrompt(template, {
      suppressedIds: ["SEC-aaa", "SEC-bbb"],
      knownOpenFindingIds: ["SEC-ccc"],
    });
    assertStringIncludes(rendered, "Suppressed:\nSEC-aaa\nSEC-bbb");
    assertStringIncludes(rendered, "Known:\nSEC-ccc");
    assertEquals(rendered.includes("(none)"), false);
  },
);

Deno.test(
  "buildSecurityScanPrompt - attribution footer is substituted (Issue #2439)",
  () => {
    const template = "Footer:\n{{ATTRIBUTION_FOOTER}}";
    const footer =
      "🏷️ Filed by idle-task template: `security-scan` · Run id: `vibe-sec-test`";
    const rendered = buildSecurityScanPrompt(template, {
      suppressedIds: [],
      knownOpenFindingIds: [],
      attributionFooter: footer,
    });
    assertEquals(rendered.includes("{{ATTRIBUTION_FOOTER}}"), false);
    assertStringIncludes(rendered, footer);
  },
);

// ---------------------------------------------------------------------------
// runSecurityScan — outcome-only contract
// ---------------------------------------------------------------------------

Deno.test("runSecurityScan - clean Claude exit returns ok", async () => {
  // Claude's output is irrelevant under the v5 contract — the executor
  // does not parse it. A clean exit is the success signal.
  const result = await runSecurityScan(
    BASE_OPTS,
    makeDeps("Claude filed three issues via gh and exited."),
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.ok, true);
  }
});

Deno.test("runSecurityScan - empty Claude output still returns ok on a clean exit", async () => {
  // A scan that finds nothing produces no `gh issue create` calls and
  // may emit no prose at all. That is still a successful run.
  const result = await runSecurityScan(BASE_OPTS, makeDeps(""));
  assertEquals(result.ok, true);
});

Deno.test("runSecurityScan - non-zero exit returns claude error", async () => {
  const deps: ScannerDeps = {
    loadPromptFn: async (name) => {
      const { loadPrompt } = await import("../lib/prompt_manager.ts");
      return loadPrompt(name, PROMPTS_DIR);
    },
    runClaudeFn: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 1, output: "boom", timedOut: false },
      }),
  };
  const result = await runSecurityScan(BASE_OPTS, deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "claude");
    assertStringIncludes(result.error.partialOutput ?? "", "boom");
  }
});

Deno.test("runSecurityScan - timeout returns timeout error with partial output", async () => {
  const deps: ScannerDeps = {
    loadPromptFn: async (name) => {
      const { loadPrompt } = await import("../lib/prompt_manager.ts");
      return loadPrompt(name, PROMPTS_DIR);
    },
    runClaudeFn: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 124, output: "partial scan log...", timedOut: true },
      }),
  };
  const result = await runSecurityScan(BASE_OPTS, deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "timeout");
    assertStringIncludes(result.error.partialOutput ?? "", "partial scan log");
  }
});

Deno.test("runSecurityScan - prompt-load failure returns prompt error", async () => {
  const deps: ScannerDeps = {
    loadPromptFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("no prompts directory"),
      }),
    runClaudeFn: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "", timedOut: false },
      }),
  };
  const result = await runSecurityScan(BASE_OPTS, deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "prompt");
  }
});

Deno.test(
  "runSecurityScan - assembles prompt with the two placeholders substituted (Issues #2135, #2159)",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const result = await runSecurityScan(BASE_OPTS, makeDeps("", captured));
    assertEquals(result.ok, true);

    const prompt = captured.options?.prompt ?? "";
    assertStringIncludes(prompt, "SEC-suppressed1");
    assertStringIncludes(prompt, "SEC-known00000a");
    // v6 dropped the repo placeholder, v8 dropped the language-hints
    // placeholder — neither should appear in the rendered prompt.
    assertEquals(prompt.includes("{{REPO_FULL_NAME}}"), false);
    assertEquals(prompt.includes("{{LANGUAGE_HINTS}}"), false);
    assertEquals(prompt.includes("{{SUPPRESSED_IDS}}"), false);
    assertEquals(prompt.includes("{{KNOWN_OPEN_FINDING_IDS}}"), false);
  },
);

Deno.test("runSecurityScan - disables write and edit tools but leaves Bash allowed", async () => {
  const captured: { options?: RunClaudeOptions } = {};
  await runSecurityScan(BASE_OPTS, makeDeps("", captured));

  const disallowed = captured.options?.disallowedTools ?? [];
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assertEquals(
      disallowed.includes(tool),
      true,
      `Expected disallowedTools to include '${tool}' for read-only scan`,
    );
  }
  // Bash must remain allowed so Claude can call `gh issue create`.
  assertEquals(
    disallowed.includes("Bash"),
    false,
    "Bash must remain allowed so Claude can file findings via gh",
  );
  for (const tool of SECURITY_SCAN_DISALLOWED_TOOLS) {
    assertEquals(disallowed.includes(tool), true);
  }
});

Deno.test("runSecurityScan - passes the working directory through to the runner", async () => {
  const captured: { options?: RunClaudeOptions } = {};
  await runSecurityScan(
    { ...BASE_OPTS, workDir: "/var/scan-work" },
    makeDeps("", captured),
  );
  assertEquals(captured.options?.cwd, "/var/scan-work");
});

// ---------------------------------------------------------------------------
// LLM-usage gate (Issue #3014)
// ---------------------------------------------------------------------------

Deno.test("buildLlmGateText - YES verdict lists the matched signals", () => {
  const verdict: LlmUsageVerdict = {
    isLlmUsing: true,
    signals: [
      {
        tier: "primary",
        pattern: "LLM client SDK dependency: openai",
        evidence: "npm:openai@^4",
      },
    ],
  };
  const text = buildLlmGateText(verdict);
  assertStringIncludes(text, "LLM-using = YES");
  assertStringIncludes(text, "openai");
});

Deno.test("buildLlmGateText - NO verdict instructs a skip", () => {
  const text = buildLlmGateText({ isLlmUsing: false, signals: [] });
  assertStringIncludes(text, "LLM-using = NO");
  assertStringIncludes(text, "Skip the entire OWASP GenAI / LLM");
});

Deno.test("buildSecurityScanPrompt - substitutes the LLM gate placeholder", () => {
  const rendered = buildSecurityScanPrompt("Gate:\n{{LLM_GATE}}", {
    suppressedIds: [],
    knownOpenFindingIds: [],
    llmGate: "**LLM-using = YES.**",
  });
  assertEquals(rendered.includes("{{LLM_GATE}}"), false);
  assertStringIncludes(rendered, "**LLM-using = YES.**");
});

/** Deps whose injected detector returns a fixed verdict. */
function makeDepsWithVerdict(
  verdict: LlmUsageVerdict,
  captured?: { options?: RunClaudeOptions },
): ScannerDeps {
  return {
    loadPromptFn: async (name: string) => {
      const { loadPrompt } = await import("../lib/prompt_manager.ts");
      return loadPrompt(name, PROMPTS_DIR);
    },
    runClaudeFn: fakeRunner("", captured),
    detectLlmUsageFn: () => Promise.resolve(verdict),
  };
}

Deno.test(
  "runSecurityScan - injects a YES gate when the detector flags LLM usage",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const result = await runSecurityScan(
      BASE_OPTS,
      makeDepsWithVerdict(
        {
          isLlmUsing: true,
          signals: [
            {
              tier: "secondary",
              pattern: "Anthropic API host",
              evidence: "a.ts:1",
            },
          ],
        },
        captured,
      ),
    );
    assertEquals(result.ok, true);
    assertStringIncludes(captured.options?.prompt ?? "", "LLM-using = YES");
    assertEquals(
      (captured.options?.prompt ?? "").includes("{{LLM_GATE}}"),
      false,
    );
  },
);

Deno.test(
  "runSecurityScan - injects a NO gate when the detector finds no LLM signal",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const result = await runSecurityScan(
      BASE_OPTS,
      makeDepsWithVerdict({ isLlmUsing: false, signals: [] }, captured),
    );
    assertEquals(result.ok, true);
    assertStringIncludes(captured.options?.prompt ?? "", "LLM-using = NO");
  },
);

Deno.test(
  "runSecurityScan - a throwing detector falls back to a NO gate (skip on absence)",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const deps: ScannerDeps = {
      loadPromptFn: async (name: string) => {
        const { loadPrompt } = await import("../lib/prompt_manager.ts");
        return loadPrompt(name, PROMPTS_DIR);
      },
      runClaudeFn: fakeRunner("", captured),
      detectLlmUsageFn: () => Promise.reject(new Error("walk failed")),
    };
    const result = await runSecurityScan(BASE_OPTS, deps);
    assertEquals(result.ok, true);
    assertStringIncludes(captured.options?.prompt ?? "", "LLM-using = NO");
  },
);

// ---------------------------------------------------------------------------
// Model tier (Issue #4010)
// ---------------------------------------------------------------------------

Deno.test(
  "runSecurityScan - an explicit model tier reaches the runner as `model`",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const result = await runSecurityScan(
      { ...BASE_OPTS, model: "sonnet" },
      makeDeps("", captured),
    );
    assertEquals(result.ok, true);
    assertEquals(captured.options?.model, "sonnet");
  },
);

Deno.test(
  "runSecurityScan - a fable tier reaches the runner as `model`",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    await runSecurityScan(
      { ...BASE_OPTS, model: "fable" },
      makeDeps("", captured),
    );
    assertEquals(captured.options?.model, "fable");
  },
);

Deno.test(
  "runSecurityScan - no model tier leaves the runner options without a `model` key",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    await runSecurityScan(BASE_OPTS, makeDeps("", captured));
    const options = captured.options as unknown as Record<string, unknown>;
    assertEquals(
      Object.hasOwn(options, "model"),
      false,
      "expected no --model arg to be requested for an unstamped scan",
    );
  },
);

// ---------------------------------------------------------------------------
// Repo-wide open-issue titles (Issue #537)
// ---------------------------------------------------------------------------

Deno.test("buildSecurityScanPrompt - open issue titles are substituted", () => {
  const rendered = buildSecurityScanPrompt(
    "Already open:\n{{OPEN_ISSUE_TITLES}}",
    {
      suppressedIds: [],
      knownOpenFindingIds: [],
      openIssueTitles: [
        { number: 37, title: "Add a CODEOWNERS file" },
        { number: 64, title: "Repo has no CODEOWNERS" },
      ],
    },
  );
  assertEquals(rendered.includes("{{OPEN_ISSUE_TITLES}}"), false);
  assertStringIncludes(rendered, "#37 — Add a CODEOWNERS file");
  assertStringIncludes(rendered, "#64 — Repo has no CODEOWNERS");
});

Deno.test(
  "buildSecurityScanPrompt - an empty open-issue list renders (none)",
  () => {
    const rendered = buildSecurityScanPrompt(
      "Already open:\n{{OPEN_ISSUE_TITLES}}",
      { suppressedIds: [], knownOpenFindingIds: [], openIssueTitles: [] },
    );
    assertEquals(rendered, "Already open:\n(none)");
  },
);

Deno.test(
  "runSecurityScan - the scan options' open issue titles reach the prompt",
  async () => {
    const captured: { options?: RunClaudeOptions } = {};
    const result = await runSecurityScan(
      {
        ...BASE_OPTS,
        openIssueTitles: [{ number: 37, title: "Add a CODEOWNERS file" }],
      },
      {
        loadPromptFn: () =>
          Promise.resolve({
            ok: true,
            value: "Already open:\n{{OPEN_ISSUE_TITLES}}",
          }),
        runClaudeFn: fakeRunner("", captured),
        detectLlmUsageFn: () =>
          Promise.resolve({ isLlmUsing: false, signals: [] }),
      },
    );
    assertEquals(result.ok, true);
    assertStringIncludes(
      captured.options?.prompt ?? "",
      "#37 — Add a CODEOWNERS file",
    );
  },
);
