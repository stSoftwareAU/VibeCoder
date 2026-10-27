/**
 * Tests for the worker pre-scan cloud permission-chain section of the
 * security-scan prompt (Issue #4416).
 *
 * These tests verify:
 *   - With no cloud-chain input (absent, undefined or empty) the rendered
 *     prompt is byte-identical to the plain template render.
 *   - With content, the section is appended after the substituted template,
 *     separated by a blank line, with its sub-sections in order.
 *   - Placeholder tokens inside a candidate line are not substituted.
 *   - The omitted-count and not-checked blocks render correctly.
 *   - `runSecurityScan` passes `cloudChains` through into the prompt Claude
 *     receives, and omits the heading when it is not supplied.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSecurityScanPrompt,
  CLOUD_CHAIN_SECTION_HEADING,
  type CloudChainPromptInput,
  runSecurityScan,
  type ScannerDeps,
  type ScanOptions,
} from "../lib/security_scanner.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const EMPTY_CHAINS: CloudChainPromptInput = {
  lines: [],
  incompleteLines: [],
  omitted: 0,
  notChecked: [],
};

const BASE_PROMPT_OPTS = {
  suppressedIds: ["SEC-suppressed1"],
  knownOpenFindingIds: ["SEC-known00000a"],
};

const BASE_SCAN_OPTS: ScanOptions = {
  repo: "stSoftwareAU/VibeCoder",
  workDir: "/tmp/scan",
  knownOpenFindingIds: ["SEC-known00000a"],
  openIssueTitles: [],
  suppressedIds: ["SEC-suppressed1"],
};

/** Load the real security-scan template from the prompts directory. */
async function loadTemplate(): Promise<string> {
  const { loadPrompt } = await import("../lib/prompt_manager.ts");
  const result = await loadPrompt("security_scan", PROMPTS_DIR);
  if (!result.ok) {
    throw new Error(
      `could not load security_scan prompt: ${result.error.message}`,
    );
  }
  return result.value;
}

/** Build deps that capture the options Claude is invoked with. */
function makeCapturingDeps(
  captured: { options?: RunClaudeOptions },
): ScannerDeps {
  return {
    loadPromptFn: async (name: string) => {
      const { loadPrompt } = await import("../lib/prompt_manager.ts");
      return loadPrompt(name, PROMPTS_DIR);
    },
    runClaudeFn: (opts) => {
      captured.options = opts;
      return Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "", timedOut: false },
      });
    },
    detectLlmUsageFn: () => Promise.resolve({ isLlmUsing: false, signals: [] }),
  };
}

// ---------------------------------------------------------------------------
// buildSecurityScanPrompt — byte-identical when there is no cloud-chain content
// ---------------------------------------------------------------------------

Deno.test("buildSecurityScanPrompt - cloud chains absent, undefined or empty leave the prompt byte-identical", async () => {
  const template = await loadTemplate();
  const baseline = buildSecurityScanPrompt(template, BASE_PROMPT_OPTS);

  assertEquals(
    buildSecurityScanPrompt(template, {
      ...BASE_PROMPT_OPTS,
      cloudChains: undefined,
    }),
    baseline,
  );
  assertEquals(
    buildSecurityScanPrompt(template, {
      ...BASE_PROMPT_OPTS,
      cloudChains: EMPTY_CHAINS,
    }),
    baseline,
  );
  assertEquals(baseline.includes(CLOUD_CHAIN_SECTION_HEADING), false);
});

// ---------------------------------------------------------------------------
// buildSecurityScanPrompt — section rendering
// ---------------------------------------------------------------------------

Deno.test("buildSecurityScanPrompt - renders the section after the template with all sub-sections in order", async () => {
  const template = await loadTemplate();
  const baseline = buildSecurityScanPrompt(template, BASE_PROMPT_OPTS);
  const out = buildSecurityScanPrompt(template, {
    ...BASE_PROMPT_OPTS,
    cloudChains: {
      lines: ["chain: iam-role-a -> iam-role-b (cfn.yaml:10-22)"],
      incompleteLines: ["chain: iam-role-c -> ? (main.tf:4)"],
      omitted: 2,
      notChecked: ["infra/legacy.tf"],
    },
  });

  // Template part is unchanged and the section follows after a blank line.
  assertEquals(out.startsWith(`${baseline.trimEnd()}\n\n`), true);

  const order = [
    CLOUD_CHAIN_SECTION_HEADING,
    "DATA from the scanned repository",
    "### Complete chains",
    "- chain: iam-role-a -> iam-role-b (cfn.yaml:10-22)",
    "### Incomplete evidence — file nothing for these",
    "Unresolved external policies, trust policies, boundaries or values are unknown: this is neither a proven exploit nor a clean result; record them in your scratch notes as not checked.",
    "- chain: iam-role-c -> ? (main.tf:4)",
    "2 further chain candidate(s) were not listed (listing cap); they are not checked this run.",
    "### IaC files the pre-scan could not check",
    "- infra/legacy.tf",
  ];
  let cursor = -1;
  for (const needle of order) {
    const at = out.indexOf(needle);
    assert(
      at > cursor,
      `expected "${needle}" after position ${cursor}, found ${at}`,
    );
    cursor = at;
  }
});

Deno.test("buildSecurityScanPrompt - heading is the exported constant and sits on its own line", async () => {
  assertEquals(
    CLOUD_CHAIN_SECTION_HEADING,
    "## Cloud permission-chain candidates (worker pre-scan)",
  );
  const template = await loadTemplate();
  const out = buildSecurityScanPrompt(template, {
    ...BASE_PROMPT_OPTS,
    cloudChains: { ...EMPTY_CHAINS, lines: ["chain: a -> b (x.yaml:1)"] },
  });
  assertStringIncludes(out, `\n${CLOUD_CHAIN_SECTION_HEADING}\n`);
});

Deno.test("buildSecurityScanPrompt - placeholder text in a candidate line stays literal", async () => {
  const template = await loadTemplate();
  const candidate = "chain: {{SUPPRESSED_IDS}} -> {{LLM_GATE}} (cfn.yaml:5)";
  const out = buildSecurityScanPrompt(template, {
    ...BASE_PROMPT_OPTS,
    cloudChains: { ...EMPTY_CHAINS, lines: [candidate] },
  });

  assertStringIncludes(out, `- ${candidate}`);
  // The token survives exactly once, and was not replaced by the suppressed IDs.
  assertEquals(out.split("{{SUPPRESSED_IDS}}").length - 1, 1);
  assertEquals(out.includes(`- chain: SEC-suppressed1`), false);
});

Deno.test("buildSecurityScanPrompt - omitted count renders the cap line and (none), with no incomplete block", async () => {
  const template = await loadTemplate();
  const out = buildSecurityScanPrompt(template, {
    ...BASE_PROMPT_OPTS,
    cloudChains: { ...EMPTY_CHAINS, omitted: 3 },
  });

  assertStringIncludes(out, "### Complete chains\n\n(none)");
  assertStringIncludes(
    out,
    "3 further chain candidate(s) were not listed (listing cap); they are not checked this run.",
  );
  assertEquals(out.includes("### Incomplete evidence"), false);
  assertEquals(
    out.includes("### IaC files the pre-scan could not check"),
    false,
  );
});

Deno.test("buildSecurityScanPrompt - notChecked renders its heading and bullets, with no omitted line when omitted is 0", async () => {
  const template = await loadTemplate();
  const out = buildSecurityScanPrompt(template, {
    ...BASE_PROMPT_OPTS,
    cloudChains: {
      ...EMPTY_CHAINS,
      notChecked: ["infra/legacy.tf", "infra/main.tf"],
    },
  });

  assertStringIncludes(out, "### IaC files the pre-scan could not check");
  assertStringIncludes(out, "- infra/legacy.tf\n- infra/main.tf");
  assertEquals(out.includes("further chain candidate"), false);
});

// ---------------------------------------------------------------------------
// runSecurityScan — pass-through to the prompt Claude receives
// ---------------------------------------------------------------------------

Deno.test("runSecurityScan - passes cloudChains through into the prompt Claude receives", async () => {
  const captured: { options?: RunClaudeOptions } = {};
  const result = await runSecurityScan(
    {
      ...BASE_SCAN_OPTS,
      cloudChains: {
        ...EMPTY_CHAINS,
        lines: ["chain: pass-through-marker -> role-x (cfn.yaml:9)"],
      },
    },
    makeCapturingDeps(captured),
  );
  assertEquals(result.ok, true);

  const prompt = captured.options?.prompt ?? "";
  assertStringIncludes(prompt, CLOUD_CHAIN_SECTION_HEADING);
  assertStringIncludes(
    prompt,
    "- chain: pass-through-marker -> role-x (cfn.yaml:9)",
  );
});

Deno.test("runSecurityScan - without cloudChains the prompt has no cloud-chain heading", async () => {
  const captured: { options?: RunClaudeOptions } = {};
  const result = await runSecurityScan(
    BASE_SCAN_OPTS,
    makeCapturingDeps(captured),
  );
  assertEquals(result.ok, true);

  const prompt = captured.options?.prompt ?? "";
  assertEquals(prompt.includes(CLOUD_CHAIN_SECTION_HEADING), false);
});
