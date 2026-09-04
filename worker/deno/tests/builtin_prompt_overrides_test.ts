/**
 * Tests for overriding a built-in phase's prompt template (Issue #849, part of
 * #843) — the config-load half.
 *
 * The contract that separates an override from a new custom label (#848) is
 * *validation*: a new label runs the implementation phase and answers to the
 * `issue` placeholders, whereas an override must satisfy whatever its target
 * phase requires. This suite pins that contract and every rejection the issue
 * names:
 *
 *   1. a mapping naming a built-in label resolves to the phase it overrides,
 *      through the **configured** label name rather than a hard-coded literal;
 *   2. an override is validated against its own phase's placeholders;
 *   3. `planning` and `planning_critique` are separate entries — neither is
 *      inferred from the other;
 *   4. `refine-issue` is rejected by name, with the reason;
 *   5. two entries claiming one phase fail config load; and
 *   6. an override never joins the custom-label dispatch scan, which belongs
 *      to new labels only.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertCustomLabelPrompts,
  customDispatchMappings,
  parseCustomLabelPrompts,
  promptOverrideMappings,
} from "../lib/custom_label_prompts_config.ts";
import {
  type BuiltInLabelNames,
  DEFAULT_BUILTIN_LABEL_NAMES,
  overridablePhases,
  resolveOverridePhase,
  validateOverrideTemplate,
} from "../lib/builtin_prompt_overrides.ts";
import { loadConfig } from "../lib/config.ts";

/** A template body carrying the given placeholders. */
function templateWith(...placeholders: string[]): string {
  return `Do the thing.\n${
    placeholders.map((name) => `{{${name}}}`).join("\n")
  }\n`;
}

/** Placeholder sets that satisfy each phase's required contract. */
const VALID = {
  issue: templateWith("ISSUE_NUMBER", "QUALITY_INSTRUCTIONS"),
  planning: templateWith("REPO", "ISSUE_NUMBER", "PLANNING_LABEL"),
  planning_critique: templateWith("REPO", "ISSUE_NUMBER", "PLANNING_LABEL"),
  question: templateWith("REPO", "ISSUE_NUMBER", "QUESTION_LABEL"),
  "grill-me": templateWith(
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_BODY",
    "COMMENT_HISTORY",
    "ROUND_NUMBER",
    "MAX_ROUNDS",
    "BOUNDARY_INTEGRITY_INSTRUCTION",
  ),
  quorum: templateWith(
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_LABELS",
    "ISSUE_BODY",
    "ISSUE_COMMENTS",
    "BOUNDARY_INTEGRITY_INSTRUCTION",
  ),
} as const;

/** Write a template file and return its absolute path. */
async function writeTemplate(
  dir: string,
  name: string,
  contents: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, contents);
  return path;
}

/** Run `fn` with a scratch directory, cleaning up afterwards. */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "builtin-prompt-override-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Assert the parse failed and the message names each fragment. */
function assertRejected(
  raw: unknown,
  names: BuiltInLabelNames | undefined,
  ...fragments: string[]
): string {
  const result = parseCustomLabelPrompts(raw, names);
  assertEquals(
    result.ok,
    false,
    `expected rejection, got ${JSON.stringify(result)}`,
  );
  const message = result.ok ? "" : result.error;
  for (const fragment of fragments) {
    assert(
      message.includes(fragment),
      `expected error to mention "${fragment}", got: ${message}`,
    );
  }
  return message;
}

// ---------------------------------------------------------------------------
// Label → phase resolution
// ---------------------------------------------------------------------------

Deno.test("resolveOverridePhase - maps each built-in label to its phase", () => {
  const cases: [string, string][] = [
    ["work-on", "issue"],
    ["planning", "planning"],
    ["question", "question"],
    ["grill-me", "grill-me"],
    ["quorum", "quorum"],
  ];
  for (const [label, phase] of cases) {
    const result = resolveOverridePhase(label, undefined);
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value, phase, `for label ${label}`);
  }
  // Case-insensitive, matching GitHub's own label comparison.
  const upper = resolveOverridePhase("Planning", undefined);
  assert(upper.ok);
  assertEquals(upper.value, "planning");
});

Deno.test("resolveOverridePhase - reads the configured label names, not literals", () => {
  const renamed: BuiltInLabelNames = {
    ...DEFAULT_BUILTIN_LABEL_NAMES,
    planningLabel: "plan-it",
  };
  const configured = resolveOverridePhase("plan-it", undefined, renamed);
  assert(configured.ok, configured.ok ? "" : configured.error);
  assertEquals(configured.value, "planning");

  // The stock name is no longer a built-in label on this fleet.
  const stock = resolveOverridePhase("planning", undefined, renamed);
  assert(stock.ok, stock.ok ? "" : stock.error);
  assertEquals(stock.value, undefined);
});

Deno.test("resolveOverridePhase - a label that is not built-in overrides nothing", () => {
  const result = resolveOverridePhase("my-custom-label", undefined);
  assert(result.ok, result.ok ? "" : result.error);
  assertEquals(result.value, undefined);
});

Deno.test("resolveOverridePhase - the second turn needs an explicit phase", () => {
  // `planning` alone never resolves to the critique template.
  const first = resolveOverridePhase("planning", undefined);
  assert(first.ok);
  assertEquals(first.value, "planning");

  const second = resolveOverridePhase("planning", "planning_critique");
  assert(second.ok, second.ok ? "" : second.error);
  assertEquals(second.value, "planning_critique");

  const judge = resolveOverridePhase("quorum", "quorum_judge");
  assert(judge.ok, judge.ok ? "" : judge.error);
  assertEquals(judge.value, "quorum_judge");
});

Deno.test("resolveOverridePhase - rejects a phase the label does not own", () => {
  const wrong = resolveOverridePhase("question", "planning");
  assertEquals(wrong.ok, false);
  assert(!wrong.ok && wrong.error.includes("question"));

  const notBuiltIn = resolveOverridePhase("my-custom-label", "planning");
  assertEquals(notBuiltIn.ok, false);
  assert(!notBuiltIn.ok && notBuiltIn.error.includes("phase"));
});

Deno.test("resolveOverridePhase - rejects refine-issue, with the reason", () => {
  const result = resolveOverridePhase("refine-issue", undefined);
  assertEquals(result.ok, false);
  assert(
    !result.ok && result.error.includes("refinement_processor.ts"),
    `expected the inline-prompt reason, got: ${result.ok ? "" : result.error}`,
  );
});

Deno.test("overridablePhases - lists every phase a mapping may replace", () => {
  assertEquals(overridablePhases(), [
    "issue",
    "planning",
    "planning_critique",
    "question",
    "grill-me",
    "quorum",
    "quorum_judge",
  ]);
});

// ---------------------------------------------------------------------------
// Per-phase placeholder validation
// ---------------------------------------------------------------------------

Deno.test("validateOverrideTemplate - holds a template to its own phase's contract", () => {
  const asIssue = validateOverrideTemplate("issue", VALID.issue);
  assert(asIssue.ok, asIssue.ok ? "" : asIssue.error);

  // The same file would pass as an `issue` override but is short of what
  // `planning` requires — the distinction this sub-issue exists for.
  const asPlanning = validateOverrideTemplate("planning", VALID.issue);
  assertEquals(asPlanning.ok, false);
  assert(!asPlanning.ok && asPlanning.error.includes("planning"));
  assert(!asPlanning.ok && asPlanning.error.includes("{{PLANNING_LABEL}}"));
});

Deno.test("validateOverrideTemplate - a quorum override must keep the fencing instruction", () => {
  const withoutFence = templateWith(
    "REPO",
    "ISSUE_NUMBER",
    "ISSUE_TITLE",
    "ISSUE_LABELS",
    "ISSUE_BODY",
    "ISSUE_COMMENTS",
  );
  const result = validateOverrideTemplate("quorum", withoutFence);
  assertEquals(result.ok, false);
  assert(
    !result.ok && result.error.includes("{{BOUNDARY_INTEGRITY_INSTRUCTION}}"),
    `expected the boundary instruction named, got: ${
      result.ok ? "" : result.error
    }`,
  );
});

Deno.test("validateOverrideTemplate - rejects an empty template", () => {
  const result = validateOverrideTemplate("planning", "   \n");
  assertEquals(result.ok, false);
  assert(!result.ok && /empty/.test(result.error));
});

// ---------------------------------------------------------------------------
// Parsing an override entry
// ---------------------------------------------------------------------------

Deno.test("parseCustomLabelPrompts - a built-in label becomes a phase override", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "plan.md", VALID.planning);
    const result = parseCustomLabelPrompts([
      { label: "planning", prompt_path: promptPath },
    ]);
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value, [
      { label: "planning", promptPath, overridesPhase: "planning" },
    ]);
  });
});

Deno.test("parseCustomLabelPrompts - overriding planning leaves planning_critique alone", async () => {
  await withDir(async (dir) => {
    const planning = await writeTemplate(dir, "plan.md", VALID.planning);
    const critique = await writeTemplate(
      dir,
      "critique.md",
      VALID.planning_critique,
    );

    const single = parseCustomLabelPrompts([
      { label: "planning", prompt_path: planning },
    ]);
    assert(single.ok, single.ok ? "" : single.error);
    assertEquals(
      single.value.some((m) => m.overridesPhase === "planning_critique"),
      false,
      "overriding planning must not imply an override of the critique turn",
    );

    const both = parseCustomLabelPrompts([
      { label: "planning", prompt_path: planning },
      {
        label: "planning",
        prompt_path: critique,
        phase: "planning_critique",
      },
    ]);
    assert(both.ok, both.ok ? "" : both.error);
    assertEquals(both.value.map((m) => m.overridesPhase), [
      "planning",
      "planning_critique",
    ]);
  });
});

Deno.test("parseCustomLabelPrompts - validates an override against its own phase", async () => {
  await withDir(async (dir) => {
    // A perfectly valid `issue` template, mapped to `planning`.
    const promptPath = await writeTemplate(dir, "wrong.md", VALID.issue);
    const message = assertRejected(
      [{ label: "planning", prompt_path: promptPath }],
      undefined,
      "custom_label_prompts[0].prompt_path",
      "planning",
      "{{PLANNING_LABEL}}",
    );
    assert(
      !message.includes("QUALITY_INSTRUCTIONS"),
      `the issue contract must not be applied to a planning override: ${message}`,
    );
  });
});

Deno.test("parseCustomLabelPrompts - rejects a refine-issue mapping by name", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "refine.md", VALID.issue);
    assertRejected(
      [{ label: "refine-issue", prompt_path: promptPath }],
      undefined,
      "custom_label_prompts[0].label",
      "refinement_processor.ts",
    );
  });
});

Deno.test("parseCustomLabelPrompts - rejects two entries claiming one phase", async () => {
  await withDir(async (dir) => {
    const first = await writeTemplate(dir, "a.md", VALID.planning);
    const second = await writeTemplate(dir, "b.md", VALID.planning);
    const message = assertRejected(
      [
        { label: "planning", prompt_path: first },
        { label: "Planning", prompt_path: second },
      ],
      undefined,
      "custom_label_prompts[1]",
    );
    assert(
      /already overridden|duplicate/i.test(message),
      `expected an ambiguity message, got: ${message}`,
    );
  });
});

Deno.test("parseCustomLabelPrompts - rejects phase on a label that is not built-in", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "a.md", VALID.planning);
    assertRejected(
      [{
        label: "my-custom-label",
        prompt_path: promptPath,
        phase: "planning",
      }],
      undefined,
      "custom_label_prompts[0].phase",
    );
  });
});

Deno.test("parseCustomLabelPrompts - honours a renamed built-in label", async () => {
  await withDir(async (dir) => {
    const names: BuiltInLabelNames = {
      ...DEFAULT_BUILTIN_LABEL_NAMES,
      grillMeLabel: "interrogate",
    };
    const promptPath = await writeTemplate(dir, "grill.md", VALID["grill-me"]);
    const result = parseCustomLabelPrompts(
      [{ label: "interrogate", prompt_path: promptPath }],
      names,
    );
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value[0]?.overridesPhase, "grill-me");
  });
});

Deno.test("assertCustomLabelPrompts - throws naming the phase and the missing placeholders", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "a.md", "Nothing useful.\n");
    let thrown = "";
    try {
      assertCustomLabelPrompts([{
        label: "question",
        prompt_path: promptPath,
      }]);
    } catch (error) {
      thrown = (error as Error).message;
    }
    assert(thrown.includes("question"), thrown);
    assert(thrown.includes("{{QUESTION_LABEL}}"), thrown);
  });
});

// ---------------------------------------------------------------------------
// Partitioning: overrides never join the custom-label dispatch scan
// ---------------------------------------------------------------------------

Deno.test("customDispatchMappings - keeps overrides out of the label scan", () => {
  const config = {
    customLabelPrompts: [
      { label: "my-custom-label", promptPath: "/opt/a.md" },
      {
        label: "planning",
        promptPath: "/opt/b.md",
        overridesPhase: "planning",
      },
    ],
  };
  assertEquals(customDispatchMappings(config).map((m) => m.label), [
    "my-custom-label",
  ]);
  assertEquals(promptOverrideMappings(config).map((m) => m.label), [
    "planning",
  ]);
});

// ---------------------------------------------------------------------------
// End-to-end through loadConfig
// ---------------------------------------------------------------------------

/** Write a `.config.json` in `dir` and load it. */
async function loadWith(
  dir: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const path = `${dir}/.config.json`;
  await Deno.writeTextFile(path, JSON.stringify(body));
  return await loadConfig(path);
}

Deno.test("loadConfig - a built-in override loads and is marked with its phase", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "grill.md", VALID["grill-me"]);
    const config = await loadWith(dir, {
      repos: ["stSoftwareAU/VibeCoder"],
      custom_label_prompts: [{ label: "grill-me", prompt_path: promptPath }],
    });
    assertEquals(config.customLabelPrompts, [
      { label: "grill-me", promptPath, overridesPhase: "grill-me" },
    ]);
  });
});

Deno.test("loadConfig - an override short of its phase's placeholders fails loud", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "plan.md", VALID.issue);
    const error = await assertRejects(
      () =>
        loadWith(dir, {
          repos: ["stSoftwareAU/VibeCoder"],
          custom_label_prompts: [{
            label: "planning",
            prompt_path: promptPath,
          }],
        }),
      Error,
      "planning",
    );
    assert(error.message.includes("{{PLANNING_LABEL}}"), error.message);
  });
});

Deno.test("loadConfig - a refine-issue mapping fails loud with the reason", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "a.md", VALID.issue);
    const error = await assertRejects(
      () =>
        loadWith(dir, {
          repos: ["stSoftwareAU/VibeCoder"],
          custom_label_prompts: [{
            label: "refine-issue",
            prompt_path: promptPath,
          }],
        }),
      Error,
      "refine-issue",
    );
    assert(error.message.includes("refinement_processor.ts"), error.message);
  });
});

Deno.test("loadConfig - a mapping on a renamed planning label overrides planning", async () => {
  await withDir(async (dir) => {
    const promptPath = await writeTemplate(dir, "plan.md", VALID.planning);
    const config = await loadWith(dir, {
      repos: ["stSoftwareAU/VibeCoder"],
      planning_label: "plan-it",
      custom_label_prompts: [{ label: "plan-it", prompt_path: promptPath }],
    });
    assertEquals(config.customLabelPrompts[0]?.overridesPhase, "planning");
  });
});
