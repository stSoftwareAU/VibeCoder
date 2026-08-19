/**
 * Tests for the shared LLM-usage detection mechanism (Issue #3013,
 * parent #3009).
 *
 * The detection rule decides whether a repo is **LLM-using** — one that
 * talks to a Large Language Model in code — so the `security_scan` prompt
 * can apply the OWASP GenAI / LLM Top 10 (2025) classes. The same rule is
 * shared with the precision-first generic gate (#3014).
 *
 * The load-bearing acceptance criterion for #3013 is the final test:
 * **VibeCoder self-identifies as LLM-using** under the shared rule (via
 * genuine source signals, not a hardcoded repo name), so the LLM classes
 * apply to its scan.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  classifyLlmUsage,
  detectLlmUsage,
  detectLlmUsageForRepo,
  isLlmAuditAllowlisted,
  matchAgenticWorkflowSignals,
  matchPrimarySignals,
  matchSecondarySignals,
  normaliseDependencyName,
} from "../lib/llm_usage_detection.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

// --- normaliseDependencyName ---

Deno.test("normaliseDependencyName - strips registry prefix and version", () => {
  assertEquals(normaliseDependencyName("npm:openai@^4.0.0"), "openai");
  assertEquals(
    normaliseDependencyName("@anthropic-ai/sdk@1.2.3"),
    "@anthropic-ai/sdk",
  );
  assertEquals(normaliseDependencyName("anthropic==0.39.0"), "anthropic");
  assertEquals(normaliseDependencyName("  lodash  "), "lodash");
  assertEquals(normaliseDependencyName("@langchain/core"), "@langchain/core");
});

// --- matchPrimarySignals ---

Deno.test("matchPrimarySignals - flags a declared LLM client SDK", () => {
  const signals = matchPrimarySignals([
    "npm:@anthropic-ai/sdk@1.0.0",
    "lodash",
  ]);
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.tier, "primary");
  assert(signals[0]!.pattern.includes("@anthropic-ai/sdk"));
});

Deno.test("matchPrimarySignals - flags a scoped SDK family member", () => {
  const signals = matchPrimarySignals(["@langchain/openai@0.3.0"]);
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.tier, "primary");
});

Deno.test("matchPrimarySignals - ignores non-LLM dependencies (precision)", () => {
  // private-repo-14's only "openai" hit is the OpenAI Gym RL env package `gym`,
  // never the `openai` SDK — so a non-LLM dep set must not be flagged.
  const signals = matchPrimarySignals(["gym", "numpy", "lodash", "express"]);
  assertEquals(signals.length, 0);
});

// --- matchSecondarySignals ---

Deno.test("matchSecondarySignals - flags an API host with a line citation", () => {
  const content = [
    "const x = 1;",
    'const URL = "https://api.anthropic.com/v1/messages";',
  ].join("\n");
  const signals = matchSecondarySignals("lib/batch_api.ts", content);
  assert(signals.length >= 1);
  const host = signals.find((s) => s.pattern.includes("Anthropic"));
  assert(host, "expected an Anthropic host signal");
  assertEquals(host!.tier, "secondary");
  assertEquals(host!.evidence, "lib/batch_api.ts:2");
});

Deno.test("matchSecondarySignals - flags a claude-* model id", () => {
  const signals = matchSecondarySignals(
    "lib/config.ts",
    'export const MODEL = "claude-opus-4-7";',
  );
  assert(signals.some((s) => s.pattern.includes("Claude model id")));
});

Deno.test("matchSecondarySignals - prose mention does not match", () => {
  // Plain prose / naming must not flag: no host, endpoint, or model id.
  const signals = matchSecondarySignals(
    "README.md",
    "This project is similar to OpenAI Gym and to Anthropic's research.",
  );
  assertEquals(signals.length, 0);
});

// --- classifyLlmUsage ---

Deno.test("classifyLlmUsage - secondary-only signal still identifies (no SDK dep)", () => {
  // VibeCoder's real profile: it uses the Claude CLI via subprocess and
  // declares NO LLM SDK dependency, but references the API host in source.
  const verdict = classifyLlmUsage([], [
    {
      path: "worker/deno/lib/batch_api.ts",
      content: '"https://api.anthropic.com/v1/messages/batches";',
    },
  ]);
  assertEquals(verdict.isLlmUsing, true);
  assertEquals(verdict.signals[0]!.tier, "secondary");
});

Deno.test("classifyLlmUsage - no signal anywhere → not LLM-using (skip on absence)", () => {
  const verdict = classifyLlmUsage(["gym", "numpy"], [
    { path: "src/cart_pole.py", content: "import gym\nenv = gym.make('x')" },
  ]);
  assertEquals(verdict.isLlmUsing, false);
  assertEquals(verdict.signals.length, 0);
});

// --- detectLlmUsage (filesystem fixtures) ---

Deno.test("detectLlmUsage - fixture with an SDK manifest is flagged", async () => {
  const dir = await Deno.makeTempDir({ prefix: "llm_detect_pos_" });
  try {
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^1.0.0" } }),
    );
    const verdict = await detectLlmUsage(dir);
    assertEquals(verdict.isLlmUsing, true);
    assert(verdict.signals.some((s) => s.tier === "primary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "detectLlmUsage - fixture with only a docs mention is NOT flagged",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "llm_detect_neg_" });
    try {
      await Deno.writeTextFile(
        `${dir}/package.json`,
        JSON.stringify({ dependencies: { gym: "^1.0.0", lodash: "^4" } }),
      );
      await Deno.mkdir(`${dir}/docs`, { recursive: true });
      // A model id buried in docs/ must be ignored (prose, not code).
      await Deno.writeTextFile(
        `${dir}/docs/compare.md`,
        "We compared against claude-opus and gpt-4 in the paper.",
      );
      await Deno.mkdir(`${dir}/src`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/src/cart_pole.py`,
        "import gym\nenv = gym.make('CartPole-v1')",
      );
      const verdict = await detectLlmUsage(dir);
      assertEquals(verdict.isLlmUsing, false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// --- Primary dep ecosystems (each manifest type) ---

async function fixtureWith(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "llm_eco_" });
  for (const [rel, content] of Object.entries(files)) {
    const slash = rel.lastIndexOf("/");
    if (slash >= 0) {
      await Deno.mkdir(`${dir}/${rel.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${dir}/${rel}`, content);
  }
  return dir;
}

Deno.test("detectLlmUsage - npm package.json primary dep flags", async () => {
  const dir = await fixtureWith({
    "package.json": JSON.stringify({ dependencies: { openai: "^4.0.0" } }),
  });
  try {
    const verdict = await detectLlmUsage(dir);
    assertEquals(verdict.isLlmUsing, true);
    assert(verdict.signals.some((s) => s.tier === "primary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectLlmUsage - deno.json import-map primary dep flags", async () => {
  const dir = await fixtureWith({
    "deno.json": JSON.stringify({
      imports: { anthropic: "npm:@anthropic-ai/sdk@^0.30.0" },
    }),
  });
  try {
    const verdict = await detectLlmUsage(dir);
    assertEquals(verdict.isLlmUsing, true);
    assert(verdict.signals.some((s) => s.tier === "primary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectLlmUsage - requirements.txt primary dep flags", async () => {
  const dir = await fixtureWith({
    "requirements.txt": "numpy==1.26.0\nanthropic>=0.39.0\n",
  });
  try {
    const verdict = await detectLlmUsage(dir);
    assertEquals(verdict.isLlmUsing, true);
    assert(verdict.signals.some((s) => s.tier === "primary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectLlmUsage - pyproject.toml primary dep flags", async () => {
  const dir = await fixtureWith({
    "pyproject.toml": '[project]\ndependencies = [\n  "litellm>=1.0",\n]\n',
  });
  try {
    const verdict = await detectLlmUsage(dir);
    assertEquals(verdict.isLlmUsing, true);
    assert(verdict.signals.some((s) => s.tier === "primary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Agentic-workflow signal (Issue #3313) ---

Deno.test("matchAgenticWorkflowSignals - flags an AI agent action uses: line", () => {
  const signals = matchAgenticWorkflowSignals([
    {
      path: ".github/workflows/agent.yml",
      rawText: [
        "on: issues",
        "jobs:",
        "  triage:",
        "    steps:",
        "      - uses: anthropics/claude-code-action@beta",
      ].join("\n"),
    },
  ]);
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.tier, "primary");
  assert(signals[0]!.pattern.includes("anthropics/claude-code-action"));
  assertEquals(signals[0]!.evidence, ".github/workflows/agent.yml:5");
});

Deno.test("matchAgenticWorkflowSignals - a plain workflow yields nothing", () => {
  const signals = matchAgenticWorkflowSignals([
    {
      path: ".github/workflows/ci.yml",
      rawText: "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4",
    },
  ]);
  assertEquals(signals.length, 0);
});

Deno.test("matchAgenticWorkflowSignals - one signal per (file, agent) pair", () => {
  const signals = matchAgenticWorkflowSignals([
    {
      path: ".github/workflows/agent.yml",
      rawText: [
        "jobs:",
        "  a:",
        "    steps:",
        "      - uses: anthropics/claude-code-action@beta",
        "  b:",
        "    steps:",
        "      - uses: anthropics/claude-code-action@beta",
      ].join("\n"),
    },
  ]);
  assertEquals(signals.length, 1);
});

Deno.test(
  "detectLlmUsage - agent-only repo (issue-triggered agent action) is LLM-using",
  async () => {
    // The load-bearing #3313 acceptance criterion: a repo whose ONLY LLM
    // surface is an issue-triggered agent action must classify LLM-using,
    // so the OWASP LLM01 prompt-injection check is no longer skipped.
    const dir = await fixtureWith({
      // A non-LLM dependency set — absent the workflow this repo is NOT
      // LLM-using.
      "package.json": JSON.stringify({ dependencies: { lodash: "^4" } }),
      ".github/workflows/agent.yml": [
        "name: Agent",
        "on:",
        "  issues:",
        "    types: [opened]",
        "jobs:",
        "  triage:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: anthropics/claude-code-action@beta",
        "        with:",
        "          prompt: ${{ github.event.issue.body }}",
      ].join("\n"),
    });
    try {
      const verdict = await detectLlmUsage(dir);
      assertEquals(
        verdict.isLlmUsing,
        true,
        "agent-only repo must be LLM-using",
      );
      assert(
        verdict.signals.some((s) =>
          s.tier === "primary" && s.pattern.includes("Agentic")
        ),
        "verdict must rest on the agentic-workflow signal",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "detectLlmUsage - repo with a plain CI workflow and no LLM stays NOT LLM-using",
  async () => {
    const dir = await fixtureWith({
      "package.json": JSON.stringify({ dependencies: { lodash: "^4" } }),
      ".github/workflows/ci.yml": [
        "name: CI",
        "on: push",
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
      ].join("\n"),
    });
    try {
      const verdict = await detectLlmUsage(dir);
      assertEquals(verdict.isLlmUsing, false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// --- Always-on allowlist floor (Issue #3014) ---

Deno.test("isLlmAuditAllowlisted - VibeCoder matches case-insensitively", () => {
  assert(isLlmAuditAllowlisted("stSoftwareAU/VibeCoder"));
  assert(isLlmAuditAllowlisted("  stsoftwareau/vibecoder  "));
  assertEquals(isLlmAuditAllowlisted("stSoftwareAU/SomeOtherRepo"), false);
});

Deno.test(
  "detectLlmUsageForRepo - allowlist floor forces LLM-using on a signal-free repo",
  async () => {
    // A repo with no LLM signal at all: absent the floor it would be NOT
    // LLM-using, but the allowlist forces YES.
    const dir = await fixtureWith({
      "package.json": JSON.stringify({ dependencies: { lodash: "^4" } }),
    });
    try {
      const bare = await detectLlmUsage(dir);
      assertEquals(bare.isLlmUsing, false);

      const verdict = await detectLlmUsageForRepo(
        "stSoftwareAU/VibeCoder",
        dir,
      );
      assertEquals(verdict.isLlmUsing, true);
      assertEquals(verdict.signals[0]!.pattern, "Always-on allowlist floor");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "detectLlmUsageForRepo - non-allowlisted repo follows the signal rule (private-repo-14 stays false)",
  async () => {
    // Regression: private-repo-14 declares no LLM SDK and references "openai" only
    // as the OpenAI Gym RL package and "anthropic" only in docs prose.
    const dir = await fixtureWith({
      "package.json": JSON.stringify({
        dependencies: { gym: "^1", numpy: "^1" },
      }),
      "docs/config/model.md": "We discuss Anthropic's research and gpt-4 here.",
      "src/agent.py": "import gym\nenv = gym.make('CartPole-v1')",
    });
    try {
      const verdict = await detectLlmUsageForRepo(
        "someorg/private-repo-14",
        dir,
      );
      assertEquals(verdict.isLlmUsing, false);
      assertEquals(verdict.signals.length, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "detectLlmUsageForRepo - allowlisted repo keeps genuine signals after the floor",
  async () => {
    const dir = await fixtureWith({
      "package.json": JSON.stringify({
        dependencies: { "@anthropic-ai/sdk": "^0.30.0" },
      }),
    });
    try {
      const verdict = await detectLlmUsageForRepo(
        "stSoftwareAU/VibeCoder",
        dir,
      );
      assertEquals(verdict.isLlmUsing, true);
      assertEquals(verdict.signals[0]!.pattern, "Always-on allowlist floor");
      assert(
        verdict.signals.some((s) => s.pattern.includes("@anthropic-ai/sdk")),
        "genuine primary signal must survive alongside the floor",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// --- Acceptance criterion: VibeCoder self-identifies as LLM-using ---

Deno.test(
  "detectLlmUsage - VibeCoder is identified as LLM-using by the shared rule",
  async () => {
    // tests/ → worker/deno/ → worker/ → repo root
    const moduleDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
    const repoRoot = `${moduleDir}/../../..`;

    const verdict = await detectLlmUsage(repoRoot);

    assertEquals(
      verdict.isLlmUsing,
      true,
      "VibeCoder must self-identify as LLM-using",
    );
    // The verdict must rest on a genuine source signal in worker code —
    // not the detection module itself (skipped) nor a test fixture.
    const genuine = verdict.signals.some((s) =>
      s.tier === "secondary" &&
      s.evidence.startsWith("worker/deno/lib/") &&
      !s.evidence.includes("_test.ts") &&
      !s.evidence.includes("llm_usage_detection.ts")
    );
    assert(
      genuine,
      "VibeCoder identification must rest on a real worker/deno/lib source signal; " +
        `got: ${verdict.signals.map((s) => s.evidence).join(", ")}`,
    );
  },
);

Deno.test(
  "LLM classes apply to VibeCoder's scan (identified + gated section present)",
  async () => {
    const moduleDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
    const repoRoot = `${moduleDir}/../../..`;
    const promptsDir = `${repoRoot}/prompts`;

    // 1. VibeCoder is identified as LLM-using.
    const verdict = await detectLlmUsage(repoRoot);
    assertEquals(verdict.isLlmUsing, true);

    // 2. The v17 prompt carries the gated LLM taxonomy that therefore
    //    applies to VibeCoder's scan.
    const prompt = await loadPrompt("security_scan", "v17", promptsDir);
    assert(prompt.ok);
    if (!prompt.ok) return;
    assert(
      prompt.value.includes("OWASP GenAI / LLM Top 10"),
      "v17 must carry the LLM Top 10 taxonomy",
    );
    assert(
      prompt.value.includes("LLM01:2025") &&
        prompt.value.includes("LLM10:2025"),
      "v17 must cover the full LLM01..LLM10 range",
    );
  },
);
