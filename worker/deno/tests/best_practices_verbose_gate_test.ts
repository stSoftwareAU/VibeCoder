/**
 * The verbose-gate check is stated once, in the orchestrator (Issue #2472).
 *
 * The rule that a green gate prints no per-test pass line shipped as LLM
 * check 19 in the `general` guide plus a near-identical "Test output" section
 * in `typescript`, `rust`, `java` and `react` — five copies of one rule, four
 * of which a run never sees, because the SLOC-weighted draw applies exactly
 * one bucket guide per scan. A repository whose draw landed on `terraform` or
 * `design` was never asked the question at all.
 *
 * The rule now lives in a single `### Cross-bucket: verbose gate output`
 * stanza in the orchestrator, which every bucket run applies, and the guides
 * carry a one-line pointer to it. These cases pin both halves: the stanza
 * states the whole contract, and no guide still carries a full copy that could
 * drift away from it.
 *
 * Prose assertions are the exception the prompt-drift family is for, so each
 * one is paired with its negative control: the same predicate is run against
 * the orchestrator with the new stanza cut out, and must come back false. A
 * predicate that passes on text with the rule removed pins nothing, and is
 * exactly the failure mode a grep-shaped test hides.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  readRepoDoc,
  section,
  withoutSection,
} from "./support/markdown_docs.ts";

/** Repo root, derived from this test file's location. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/** The one heading the rule now lives under. */
const ORCHESTRATOR_HEADING = "### Cross-bucket: verbose gate output";

/** The per-guide heading four buckets used to duplicate the rule under. */
const FOLDED_GUIDE_HEADING =
  "## Test output — quiet when green, complete when red";

/** Every bucket guide the scan ships. */
const BUCKETS: readonly string[] = [
  "general",
  "design",
  "rust",
  "typescript",
  "react",
  "java",
  "html",
  "aws-cloudformation",
  "terraform",
];

/** The guides whose copy folded into the orchestrator stanza. */
const FOLDED_BUCKETS: readonly string[] = [
  "general",
  "typescript",
  "rust",
  "java",
  "react",
];

/** The scan orchestrator, as shipped. */
async function orchestratorPrompt(): Promise<string> {
  const loaded = await loadPrompt("best_practices", PROMPTS_DIR);
  assertEquals(loaded.ok, true, "best_practices failed to load");
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

/** A bucket guide, as shipped. */
function bucketGuide(bucket: string): Promise<string> {
  return readRepoDoc(`prompts/best_practices/buckets/${bucket}.md`);
}

/**
 * The quiet flag each ecosystem offers. A stanza that folds five guides has
 * to keep every remedy those guides named, or the fold lost advice a reviewer
 * of that ecosystem needed.
 */
const ECOSYSTEM_FLAGS: readonly string[] = [
  "--reporter=dot",
  "jest --silent",
  "cargo test -q",
  "--status-level=fail",
  "mvn -q",
  "statelessTestsetInfoReporter",
  "testLogging",
  "bats",
];

/**
 * The contract the stanza must state, each clause with the predicate that
 * recognises it. Every predicate is checked against the stanza (it must hold)
 * and against the orchestrator with the stanza removed (it must not).
 */
const CLAUSES: readonly {
  readonly name: string;
  readonly holds: (text: string) => boolean;
}[] = [
  {
    // The #2430 definition of quiet, as a rule a reviewer can apply without
    // counting lines: nothing per passing test, one summary line per stage.
    name: "quiet-when-green contract",
    holds: (t) =>
      /no per-test pass line/i.test(t) && /at most one summary line/i.test(t),
  },
  {
    // The other half. A reporter that buys silence by dropping the failure
    // detail trades a token bill for a debugging one.
    name: "complete-when-red contract",
    holds: (t) => /assertion message/i.test(t) && /stack trace/i.test(t),
  },
  {
    // Hard Constraint 2. The finding is the invocation line, read as text.
    name: "static-evidence-only rule",
    holds: (t) => /never run the suite/i.test(t),
  },
  {
    name: "the three surfaces it reads",
    holds: (t) =>
      /quality-gate script/i.test(t) && /default test task/i.test(t) &&
      /pull[\s-]request/i.test(t),
  },
  {
    // An explicitly loud invocation is as much a finding as a missing flag.
    name: "explicit-verbosity detections",
    holds: (t) => t.includes("--verbose") && t.includes("set -x"),
  },
  {
    name: "per-ecosystem quiet flags",
    holds: (t) => ECOSYSTEM_FLAGS.every((flag) => t.includes(flag)),
  },
  {
    // A bucket-independent finding hashed by `{repo, bucket, slug, file}`
    // would file once per bucket the draw ever lands on, so this one departs
    // from the recipe with a fixed id, as the linter pre-filer already does.
    name: "fixed finding id, one issue per repository",
    holds: (t) =>
      t.includes("BP-VERBOSE-GATE") && /one issue per repository/i.test(t),
  },
  {
    name: "severity band",
    holds: (t) =>
      t.includes("BP-VERBOSE-GATE") && t.includes("severity:medium"),
  },
  {
    // Phase 3 rule 4 governs the waiver; the stanza names its own id so a
    // reviewer can write the marker without reading Phase 3 first.
    name: "fail-closed governed suppression",
    holds: (t) =>
      t.includes("best-practice-ignore: BP-VERBOSE-GATE") &&
      /fails? closed/i.test(t),
  },
  {
    // A person running tests by hand is deliberately reading the output.
    name: "on-demand carve-out",
    holds: (t) => /an on-demand test task/i.test(t),
  },
  {
    // The scan files; the repository's own `work-on` PR fixes.
    name: "no-pull-request boundary",
    holds: (t) => /never opens a pull request/i.test(t),
  },
  {
    // The whole point of the fold: the draw must not decide whether the
    // question gets asked.
    name: "runs on every scan regardless of the draw",
    holds: (t) => /every scan/i.test(t) && /whichever bucket/i.test(t),
  },
];

for (const clause of CLAUSES) {
  Deno.test(
    `the verbose-gate stanza states the ${clause.name} (Issue #2472)`,
    async () => {
      const stated = section(await orchestratorPrompt(), ORCHESTRATOR_HEADING);
      assert(
        clause.holds(stated),
        `the orchestrator's verbose-gate stanza does not state the ${clause.name}`,
      );
    },
  );

  Deno.test(
    `the ${clause.name} is absent from the orchestrator without the stanza (Issue #2472)`,
    async () => {
      // The negative control. Without it, a predicate satisfied by unrelated
      // text elsewhere in the prompt would pass for ever while pinning
      // nothing.
      const rest = withoutSection(
        await orchestratorPrompt(),
        ORCHESTRATOR_HEADING,
      );
      assert(
        !clause.holds(rest),
        `the ${clause.name} predicate fires on the orchestrator with the ` +
          `verbose-gate stanza removed, so it pins nothing`,
      );
    },
  );
}

Deno.test(
  "no bucket guide keeps a duplicate Test output section (Issue #2472)",
  async () => {
    // Five copies of one rule is five things to keep in step, and four of
    // them are invisible on any given run.
    for (const bucket of BUCKETS) {
      const lines = (await bucketGuide(bucket)).split("\n");
      assert(
        !lines.some((line) => line.trim() === FOLDED_GUIDE_HEADING),
        `${bucket}.md still opens its own '${FOLDED_GUIDE_HEADING}' section; ` +
          `the rule belongs in the orchestrator stanza only`,
      );
    }
  },
);

Deno.test(
  "no bucket guide keeps a copy of the quiet-flag table (Issue #2472)",
  async () => {
    // The flags are the substance of the rule. While a guide still names one,
    // there are two tables to maintain and one of them will drift.
    for (const bucket of BUCKETS) {
      const guide = await bucketGuide(bucket);
      for (const flag of ECOSYSTEM_FLAGS) {
        assert(
          !guide.includes(flag),
          `${bucket}.md still names the quiet flag '${flag}', which belongs ` +
            `in the orchestrator's single ecosystem table`,
        );
      }
    }
  },
);

Deno.test(
  "every folded guide points at the orchestrator stanza (Issue #2472)",
  async () => {
    // Deleting the copy without leaving a pointer would lose the rule for a
    // reviewer reading only the bucket guide they were handed.
    for (const bucket of FOLDED_BUCKETS) {
      const guide = await bucketGuide(bucket);
      assert(
        guide.includes("Cross-bucket: verbose gate output"),
        `${bucket}.md dropped its verbose-gate copy without pointing at the ` +
          `orchestrator stanza that replaced it`,
      );
    }
  },
);

Deno.test(
  "every bucket guide is still non-empty after the fold (Issue #2472)",
  async () => {
    for (const bucket of BUCKETS) {
      const guide = await bucketGuide(bucket);
      assert(
        guide.trim().length > 0,
        `${bucket}.md is empty after the fold`,
      );
    }
  },
);

Deno.test(
  "the scan documentation records the stanza and its fixed id (Issue #2472)",
  async () => {
    // A code change owes a docs change: the operator manual is where the
    // fixed ids and the cap arithmetic are explained.
    const doc = await readRepoDoc("docs/BEST-PRACTICES-SCAN.md");
    assert(
      doc.includes("BP-VERBOSE-GATE"),
      "docs/BEST-PRACTICES-SCAN.md does not document the BP-VERBOSE-GATE id",
    );
    assert(
      doc.includes("Cross-bucket: verbose gate output"),
      "docs/BEST-PRACTICES-SCAN.md does not name the verbose-gate stanza",
    );
  },
);

Deno.test(
  "the verbose-gate stanza stays portable across repositories (Issue #2472)",
  async () => {
    // The best-practices body is filed verbatim as an issue in the *target*
    // repository, where a bare `#NNN` auto-links to that repo's unrelated
    // issue, and a path from this tree means nothing to its reviewer.
    const stated = section(await orchestratorPrompt(), ORCHESTRATOR_HEADING);
    assertEquals(
      stated.match(/(?<!\w)#\d+/g) ?? [],
      [],
      "the verbose-gate stanza carries a bare issue reference, which " +
        "mislinks once the body is filed cross-repo",
    );
    assert(
      !stated.includes("worker/deno/"),
      "the verbose-gate stanza must describe the mechanism generically",
    );
  },
);
