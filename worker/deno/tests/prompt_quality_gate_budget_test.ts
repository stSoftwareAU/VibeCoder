/**
 * The quality gate is not the agent's pre-push ritual (Issue #1138).
 *
 * Across three hosts in one day, 407 worker-log observations caught an agent
 * sitting in `./quality.sh` as its most recent tool call: median 17 minutes,
 * and still inside the gate at 49, 52, 58, 60, 63, 66 and 68 minutes elapsed
 * against a run budget of roughly 60. A run killed at the deadline is
 * recorded a failure and the issue returns to the claimable pool, so the next
 * host redoes work that was already done.
 *
 * The agents were not being undisciplined. Eight templates told them to run
 * the gate before pushing, `prompts/spelling_fix/` allowed three
 * fix-and-rerun cycles over it, and the injected `{{QUALITY_INSTRUCTIONS}}`
 * block asked for one unconditional foreground run in every prompt the worker
 * builds. Three of those cycles is 45 minutes before any work happens.
 *
 * The information was never scarce. The worker runs a baseline gate before
 * the agent (`lib/phases/baseline_quality_phase.ts`), runs the gate again
 * after it with its own bounded remediation
 * (`lib/phases/quality_gate_remediation_phase.ts`), and CI re-runs the same
 * checks on the pull request in parallel shards on dedicated runners. The
 * agent's own serial copy is the third, and the only one paid for out of the
 * run budget.
 *
 * So the rule these cases pin is not "never run the gate" — it is that no
 * template may make it **unconditional before pushing**, none may grant a
 * numbered rerun allowance over it, and the injected block must say what to
 * do when the remaining budget cannot cover it. Reproducing a finding the
 * gate itself reported stays exactly where it was.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt, PROMPT_FILENAME } from "../lib/prompt_manager.ts";
import { buildQualityInstructions } from "../lib/repo_config.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { flattenAll } from "./support/prompt_prose.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/**
 * How far either side of a gate mention a rule is taken to reach.
 *
 * The templates hard-wrap at about 70 columns, so a sentence pairing the gate
 * with an obligation routinely spans four or five lines. A window narrower
 * than that would let the pairing hide in the wrap.
 */
const WINDOW = 320;

/** Naming the gate as something to run, in prose or in a fenced example. */
const GATE = /\.\/quality\.sh/g;

/**
 * An obligation over the gate that fires on every run, whatever the budget
 * looks like.
 *
 * Only obligations are listed. "`./quality.sh` tells you whether the fix
 * landed before you push it" describes what the tool is good for and stays —
 * a `semgrep` finding really is reproduced by the gate that reported it. What
 * may not survive is a requirement: the gate must have passed, all checks
 * must be green, before a push exists.
 */
const UNCONDITIONAL = new RegExp(
  [
    "ensure\\s+all\\s+checks\\s+pass",
    "all\\s+checks\\s+must\\s+pass",
    "must\\s+pass\\s+before",
    "checks?\\s+pass\\s+before",
    "passed\\s+locally",
    "before\\s+(?:pushing|creating\\s+a\\s+pull\\s+request|pr\\s+creation)",
  ].join("|"),
  "i",
);

/** A numbered allowance to run the gate again, and again. */
const RERUN_ALLOWANCE =
  /fix-and-rerun\s+cycles|\b(?:3|three)\s+attempts\b|\b(?:3|three)\s+cycles\b/i;

/** Every prompt directory that ships a template, in name order. */
async function promptDirectories(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    try {
      await Deno.stat(`${PROMPTS_DIR}/${entry.name}/${PROMPT_FILENAME}`);
      names.push(entry.name);
    } catch (error) {
      // A directory with no template is not a prompt type. Anything other
      // than "not found" would drop a directory out of a gate whose whole
      // property is that it covers every one of them.
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(`cannot read prompts/${entry.name}: ${String(error)}`);
      }
    }
  }
  return names.sort();
}

/** Each directory's shipped template, keyed by directory name. */
async function templates(): Promise<Map<string, string>> {
  const loaded = new Map<string, string>();
  for (const name of await promptDirectories()) {
    const result = await loadPrompt(name, PROMPTS_DIR);
    assert(result.ok, `prompts/${name}/${PROMPT_FILENAME} failed to load`);
    loaded.set(name, result.value);
  }
  return loaded;
}

/**
 * Every place `pattern` sits within {@link WINDOW} characters of a gate
 * mention, reported as the editor addresses it.
 *
 * Fenced examples and code spans are kept: a template that states the rule in
 * prose and then contradicts it inside the pull-request skeleton it dictates
 * has still shipped the contradiction.
 *
 * @param text - The template's full text
 * @param pattern - What may not sit beside the gate
 * @returns One `line N: <phrase>` entry per pairing, in source order
 */
function pairedWithGate(text: string, pattern: RegExp): string[] {
  const { flat, lineAt } = flattenAll(text);
  const found: string[] = [];
  for (const gate of flat.matchAll(GATE)) {
    const at = gate.index ?? 0;
    const from = Math.max(0, at - WINDOW);
    const window = flat.slice(from, at + WINDOW);
    const hit = window.match(pattern);
    if (!hit) continue;
    found.push(
      `line ${lineAt(at)}: ${
        window.slice(
          Math.max(0, (hit.index ?? 0) - 40),
          (hit.index ?? 0) + hit[0].length + 40,
        ).replace(/\s+/g, " ").trim()
      }`,
    );
  }
  return found;
}

Deno.test("gate budget - no template requires the gate before pushing (Issue #1138)", async () => {
  const offenders: string[] = [];
  for (const [name, text] of await templates()) {
    for (const hit of pairedWithGate(text, UNCONDITIONAL)) {
      offenders.push(`prompts/${name}/${PROMPT_FILENAME} ${hit}`);
    }
  }
  offenders.sort();
  assertEquals(
    offenders,
    [],
    "a template still makes the quality gate an unconditional pre-push " +
      "step. The worker runs the gate itself after the execute phase and CI " +
      "re-runs it on the pull request, so this copy is the only one paid " +
      "for out of the run budget — point the run at the repository's fast " +
      "checks instead:\n" + offenders.join("\n"),
  );
});

Deno.test("gate budget - no template grants a numbered rerun allowance over the gate (Issue #1138)", async () => {
  const offenders: string[] = [];
  for (const [name, text] of await templates()) {
    for (const hit of pairedWithGate(text, RERUN_ALLOWANCE)) {
      offenders.push(`prompts/${name}/${PROMPT_FILENAME} ${hit}`);
    }
  }
  offenders.sort();
  assertEquals(
    offenders,
    [],
    "a template still budgets several runs of the quality gate. A gate that " +
      "failed twice does not pass on the third run inside a 60-minute " +
      "budget; the run should push and let CI report, or hand off " +
      "honestly:\n" + offenders.join("\n"),
  );
});

Deno.test("gate budget - the templates that changed point the run at the fast checks (Issue #1138)", async () => {
  // Removing the instruction without replacing it leaves the run with no
  // stated way to check its own work, which is how "let CI decide" becomes
  // "push whatever compiles".
  const loaded = await templates();
  for (const name of ["issue", "spelling_fix", "pr_feedback", "ci_fix"]) {
    const text = loaded.get(name);
    assert(text, `prompts/${name}/${PROMPT_FILENAME} is missing`);
    assert(
      /fast\s+checks/i.test(text),
      `prompts/${name}/${PROMPT_FILENAME} no longer names the fast checks ` +
        "as what the run validates on before pushing",
    );
  }
});

Deno.test("gate budget - the standards do not require the gate before every PR (Issue #1138)", async () => {
  // The prompts are not the only surface a run reads: `AGENTS.md` points
  // every agent at `CODING-STANDARDS.md`, and its Quality Gates section
  // carried the same blanket instruction. Fixing one and leaving the other
  // is how a run gets told both things at once.
  const standards = await Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);
  const gates = standards.match(/## Quality Gates[\s\S]*?\n## /);
  assert(gates, "CODING-STANDARDS.md lost its Quality Gates section");
  const section = gates[0].replace(/\s+/g, " ");
  assertEquals(
    /All\s+quality\s+checks\s+MUST\s+pass\s+before\s+creating\s+a\s+PR/i
      .test(section),
    false,
    `the standards still make the full gate a step every PR takes:\n${section}`,
  );
  assert(
    /is\s+\*\*not\*\*\s+a\s+step\s+every\s+change\s+takes/.test(section),
    "the standards must say the gate is not a routine pre-PR step",
  );
  assert(
    /skip\s+it\s+and\s+say\s+so\s+in\s+the\s+PR\s+body/.test(section),
    "the standards must name skipping-and-disclosing as the budget answer",
  );
});

Deno.test("gate budget - the injected quality block is budget-aware (Issue #1138)", () => {
  const block = buildQualityInstructions(undefined, "org/any-repo")
    .toLowerCase();
  assert(
    block.includes("budget"),
    `the injected block must say what to do when the remaining run budget ` +
      `cannot cover the gate:\n${block}`,
  );
  assert(
    /skip\s+it/.test(block),
    `the injected block must name skipping as the answer to a short ` +
      `budget, rather than starting something that cannot finish:\n${block}`,
  );
  assertEquals(
    UNCONDITIONAL.test(block),
    false,
    `the injected block still makes the gate an unconditional pre-push ` +
      `step:\n${block}`,
  );
});
