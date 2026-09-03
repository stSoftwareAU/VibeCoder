/**
 * Tests for the workflow_setup prompt's canonical gitleaks example
 * (Issue #596, parent #566).
 *
 * Two paths produce a repository's `gitleaks.yml`: the deterministic
 * template in `worker/deno/lib/workflow_definitions.ts`, and the
 * LLM-authored setup run driven by `prompts/workflow_setup/`. The prompt
 * once taught the pre-#594 pattern — `gitleaks-action@v2`, no
 * `pull_request` branch filter and an optional licence fallback — so an
 * LLM-authored copy reintroduced the milestone-PR gap #594 closed in the
 * template.
 *
 * The prompt now reproduces the refreshed canonical template verbatim, so the
 * two paths cannot disagree. The tests below parse the prompt's canonical
 * example as YAML and assert against the *behaviour* it declares (branch
 * matching via the fleet's own matcher, both scan paths, SHA pins) rather
 * than grepping prose.
 *
 * Australian English throughout (behaviour, organisation, licence).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import { anyBranchMatches } from "../lib/workflow_branch_glob.ts";
import { PINNED_ACTIONS } from "../lib/pinned_actions.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Representative milestone branch (Issue #1300: `milestone/<slug>`). */
const MILESTONE_SAMPLE_BRANCH = "milestone/example";

/** The five placeholders `workflow_setup` declares as required. */
const REQUIRED_PLACEHOLDERS = [
  "REPO",
  "LANGUAGES",
  "MISSING_WORKFLOWS",
  "DEFAULT_BRANCH",
  "EXISTING_WORKFLOWS",
];

async function loadWorkflowSetup(): Promise<string> {
  const result = await loadPrompt("workflow_setup", PROMPTS_DIR);
  assert(result.ok, "workflow_setup failed to load");
  if (!result.ok) throw new Error("workflow_setup failed to load");
  return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The canonical gitleaks template the deterministic path emits. */
function gitleaksTemplate(): string {
  const spec = WORKFLOW_SPECS.find((s) => s.id === "gitleaks");
  assert(spec !== undefined, "gitleaks spec missing");
  return spec!.template;
}

/**
 * Extract the YAML inside the prompt's `gitleaks-canonical` example.
 *
 * The prompt is the LLM's copy-source, so what it actually teaches is this
 * block — not the prose around it.
 */
function canonicalGitleaksExample(prompt: string): string {
  const example = /<example name="gitleaks-canonical">([\s\S]*?)<\/example>/
    .exec(prompt)?.[1];
  assert(
    example !== undefined,
    "the prompt must keep a `gitleaks-canonical` worked example",
  );
  const fence = /```ya?ml\n([\s\S]*?)```/.exec(example)?.[1];
  assert(
    fence !== undefined,
    "the gitleaks example must contain a YAML fence",
  );
  return fence;
}

/** Read `on.pull_request.branches` from a rendered workflow. */
function pullRequestBranches(workflow: string): unknown {
  const parsed = parseYaml(workflow);
  assert(isRecord(parsed), "example did not parse as a YAML mapping");
  // `@std/yaml` keeps `on` as a string key (YAML 1.2); a 1.1 parser would
  // coerce it to the boolean `true`, so both spellings are read.
  const onBlock = "on" in parsed ? parsed["on"] : parsed["true"];
  assert(isRecord(onBlock), "example has no `on:` mapping");
  const pullRequest = onBlock["pull_request"];
  assert(isRecord(pullRequest), "example has no `on.pull_request:` mapping");
  return pullRequest["branches"];
}

// --- Loading contract ---

Deno.test("workflow_setup - carries every required placeholder", async () => {
  const body = await loadWorkflowSetup();
  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    assertStringIncludes(
      body,
      `{{${placeholder}}}`,
      `the template must substitute {{${placeholder}}} or prompt-manager ` +
        "validation rejects it",
    );
  }
});

// --- Gap 1: the branch filter must reach milestone PRs ---

Deno.test("workflow_setup - the canonical example filters on milestone branches", async () => {
  const branches = pullRequestBranches(
    canonicalGitleaksExample(await loadWorkflowSetup()),
  );
  assert(
    Array.isArray(branches),
    "the example must declare an explicit pull_request branch filter",
  );
  for (const branch of [MILESTONE_SAMPLE_BRANCH, "Develop", "main"]) {
    assert(
      anyBranchMatches(branches, branch),
      `example branch filter ${JSON.stringify(branches)} never matches ` +
        `${branch} — an LLM-authored copy would skip those PRs (Issue #596)`,
    );
  }
  assertNotEquals(
    JSON.stringify(branches),
    JSON.stringify(["*"]),
    'the example must not use `branches: ["*"]` — a GitHub `*` never ' +
      "matches a `/`, so milestone PRs go unscanned",
  );
});

Deno.test("workflow_setup - the prose forbids the bare star filter", async () => {
  const body = await loadWorkflowSetup();
  assertStringIncludes(
    body,
    '`["*"]`',
    "the template must name the forbidden bare-star filter explicitly",
  );
  assertStringIncludes(body, "milestone/*");
});

// --- Gap 2: gitleaks-action v3, pinned to this repository's SHA ---

Deno.test("workflow_setup - pins the gitleaks action to the repository's v3 pin", async () => {
  const body = await loadWorkflowSetup();
  const example = canonicalGitleaksExample(body);
  const pin = PINNED_ACTIONS["gitleaks/gitleaks-action"];
  assert(pin !== undefined, "gitleaks-action is not pinned");
  assertStringIncludes(
    example,
    `gitleaks/gitleaks-action@${pin.sha}`,
    "the example must reuse the SHA pinned in pinned_actions.ts",
  );
  assertStringIncludes(
    body,
    pin.version,
    `the prose must name the pinned action version (${pin.version})`,
  );
});

Deno.test("workflow_setup - does not teach gitleaks-action v2", async () => {
  assertFalse(
    (await loadWorkflowSetup()).includes("gitleaks-action@v2"),
    "the template must not name the superseded v2 action",
  );
});

Deno.test("workflow_setup - every uses: in the example is SHA-pinned", async () => {
  const usesLines = canonicalGitleaksExample(await loadWorkflowSetup())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- uses:") || line.startsWith("uses:"));
  assertNotEquals(usesLines.length, 0, "expected at least one uses: line");
  for (const line of usesLines) {
    assertNotEquals(
      /uses:\s+\S+@([0-9a-f]{40})(\s|$)/i.exec(line),
      null,
      `example uses: line is not pinned to a 40-char SHA: "${line}" — a tag ` +
        "pin is hijackable (Issue #1756)",
    );
  }
});

// --- Gap 3: the licence-less fallback is mandatory, not optional ---

Deno.test("workflow_setup - the example keeps both scan paths", async () => {
  const example = canonicalGitleaksExample(await loadWorkflowSetup());
  const parsed = parseYaml(example);
  assert(isRecord(parsed), "example did not parse as a YAML mapping");
  const jobs = parsed["jobs"];
  assert(isRecord(jobs), "example has no jobs");

  let licensed = 0;
  let fallback = 0;
  let checkouts = 0;
  for (const job of Object.values(jobs)) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) continue;
    for (const step of job["steps"]) {
      if (!isRecord(step)) continue;
      const uses = typeof step["uses"] === "string" ? step["uses"] : "";
      const guard = typeof step["if"] === "string" ? step["if"] : "";
      const run = typeof step["run"] === "string" ? step["run"] : "";
      if (uses.startsWith("actions/checkout@")) {
        checkouts++;
        const withBlock = step["with"];
        assert(isRecord(withBlock), "checkout step has no `with:` block");
        assertEquals(
          withBlock["fetch-depth"],
          0,
          "checkout must use `fetch-depth: 0` so the diff range resolves",
        );
      }
      if (
        uses.startsWith("gitleaks/gitleaks-action@") &&
        guard.includes("env.GITLEAKS_LICENSE != ''")
      ) {
        licensed++;
      }
      if (
        guard.includes("env.GITLEAKS_LICENSE == ''") &&
        run.includes("gitleaks git")
      ) {
        fallback++;
        assertStringIncludes(
          run,
          "sha256sum -c -",
          "the CLI fallback must verify the download against a published " +
            "SHA-256 checksum",
        );
        const stepEnv = step["env"];
        assert(isRecord(stepEnv), "the CLI fallback must pin its version");
        assertEquals(
          typeof stepEnv["GITLEAKS_VERSION"],
          "string",
          "the CLI fallback must pin GITLEAKS_VERSION",
        );
      }
    }
  }
  assertNotEquals(checkouts, 0, "example has no checkout step");
  assertEquals(licensed, 1, "example must keep the licensed action path");
  assertEquals(
    fallback,
    1,
    "example must keep the licence-less CLI fallback — Dependabot PRs " +
      "receive no Actions secrets (Issue #2981)",
  );
});

Deno.test("workflow_setup - never triggers on pull_request_target", async () => {
  const body = await loadWorkflowSetup();
  assertFalse(
    canonicalGitleaksExample(body).includes("pull_request_target"),
    "the canonical example must not use pull_request_target",
  );
  assertStringIncludes(
    body,
    "pull_request_target",
    "the template must still tell the agent to avoid pull_request_target",
  );
});

// --- The two provisioning paths must not disagree ---

Deno.test("workflow_setup - the example is the canonical template", async () => {
  const fromPrompt = parseYaml(
    canonicalGitleaksExample(await loadWorkflowSetup()),
  );
  const fromTemplate = parseYaml(gitleaksTemplate());
  assertEquals(
    fromPrompt,
    fromTemplate,
    "the LLM setup path and the deterministic template must emit the same " +
      "gitleaks workflow — refresh the template and the workflow_setup " +
      "prompt together (Issue #596)",
  );
});
