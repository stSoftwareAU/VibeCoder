/**
 * Tests for workflow_setup prompt v8 (Issue #596, parent #566).
 *
 * Two paths produce a repository's `gitleaks.yml`: the deterministic
 * template in `worker/deno/lib/workflow_definitions.ts`, and the
 * LLM-authored setup run driven by `prompts/workflow_setup/`. v7 still
 * taught the pre-#594 pattern — `gitleaks-action@v2`, no `pull_request`
 * branch filter and an optional licence fallback — so an LLM-authored copy
 * reintroduced the milestone-PR gap #594 closed in the template.
 *
 * v8 reproduces the refreshed canonical template verbatim, so the two
 * paths cannot disagree. The tests below parse the prompt's canonical
 * example as YAML and assert against the *behaviour* it declares (branch
 * matching via the fleet's own matcher, both scan paths, SHA pins) rather
 * than grepping prose.
 *
 * v7 is frozen (Issue #235) and is used as the negative control: each gap
 * test asserts the defect is present in v7 and absent in v8, so the suite
 * fails against the unfixed prompt set.
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
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
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

async function loadWorkflowSetup(version: string): Promise<string> {
  const result = await loadPrompt("workflow_setup", version, PROMPTS_DIR);
  assert(result.ok, `workflow_setup ${version} failed to load`);
  if (!result.ok) throw new Error(`workflow_setup ${version} failed to load`);
  return result.value;
}

const loadV8 = () => loadWorkflowSetup("v8");
const loadV7 = () => loadWorkflowSetup("v7");

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

Deno.test("workflow_setup v8 - is the version the loader selects", async () => {
  const latest = await getLatestVersion("workflow_setup", PROMPTS_DIR);
  assert(latest.ok, "getLatestVersion(workflow_setup) failed");
  if (!latest.ok) return;
  assertEquals(
    latest.value,
    "v8",
    "v8 must be the highest version on disk — the loader takes the latest",
  );
});

Deno.test("workflow_setup v8 - carries every required placeholder", async () => {
  const body = await loadV8();
  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    assertStringIncludes(
      body,
      `{{${placeholder}}}`,
      `v8 must substitute {{${placeholder}}} or prompt-manager validation ` +
        "rejects the template",
    );
  }
});

// --- Gap 1: the branch filter must reach milestone PRs ---

Deno.test("workflow_setup v8 - the canonical example filters on milestone branches", async () => {
  const branches = pullRequestBranches(canonicalGitleaksExample(await loadV8()));
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

Deno.test("workflow_setup v8 - the prose forbids the bare star filter", async () => {
  const body = await loadV8();
  assertStringIncludes(
    body,
    '`["*"]`',
    "v8 must name the forbidden bare-star filter explicitly",
  );
  assertStringIncludes(body, "milestone/*");
});

// Negative control: v7's example declares no triggers at all, so nothing
// constrains the branch filter an LLM invents.
Deno.test("workflow_setup v7 - the frozen example declares no branch filter", async () => {
  const example = canonicalGitleaksExample(await loadV7());
  const parsed = parseYaml(example);
  assert(isRecord(parsed), "v7 example did not parse as a YAML mapping");
  assertFalse(
    "on" in parsed || "true" in parsed,
    "v7 is frozen (Issue #235): it is the gap v8 closes, not a template " +
      "to edit",
  );
});

// --- Gap 2: gitleaks-action v3, pinned to this repository's SHA ---

Deno.test("workflow_setup v8 - pins the gitleaks action to the repository's v3 pin", async () => {
  const example = canonicalGitleaksExample(await loadV8());
  const pin = PINNED_ACTIONS["gitleaks/gitleaks-action"];
  assert(pin !== undefined, "gitleaks-action is not pinned");
  assertStringIncludes(
    example,
    `gitleaks/gitleaks-action@${pin.sha}`,
    "the example must reuse the SHA pinned in pinned_actions.ts",
  );
  assertStringIncludes(
    await loadV8(),
    pin.version,
    `v8 prose must name the pinned action version (${pin.version})`,
  );
});

Deno.test("workflow_setup v8 - stops teaching gitleaks-action v2", async () => {
  const v8 = await loadV8();
  assertFalse(
    v8.includes("gitleaks-action@v2"),
    "v8 must not name the superseded v2 action",
  );
  // Negative control: v7 does, which is the defect being fixed.
  assert(
    (await loadV7()).includes("gitleaks-action@v2"),
    "v7 is the frozen negative control and must still name v2",
  );
});

Deno.test("workflow_setup v8 - every uses: in the example is SHA-pinned", async () => {
  const usesLines = canonicalGitleaksExample(await loadV8())
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

Deno.test("workflow_setup v8 - the example keeps both scan paths", async () => {
  const example = canonicalGitleaksExample(await loadV8());
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

Deno.test("workflow_setup v8 - never triggers on pull_request_target", async () => {
  const v8 = await loadV8();
  assertFalse(
    canonicalGitleaksExample(v8).includes("pull_request_target"),
    "the canonical example must not use pull_request_target",
  );
  assertStringIncludes(
    v8,
    "pull_request_target",
    "v8 must still tell the agent to avoid pull_request_target",
  );
});

// --- The two provisioning paths must not disagree ---

Deno.test("workflow_setup v8 - the example is the canonical template", async () => {
  const fromPrompt = parseYaml(canonicalGitleaksExample(await loadV8()));
  const fromTemplate = parseYaml(gitleaksTemplate());
  assertEquals(
    fromPrompt,
    fromTemplate,
    "the LLM setup path and the deterministic template must emit the same " +
      "gitleaks workflow — refresh the template and add a new " +
      "workflow_setup version together (Issue #596)",
  );
});
