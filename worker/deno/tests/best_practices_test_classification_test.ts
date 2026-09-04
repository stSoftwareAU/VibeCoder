/**
 * The best-practices scan states the test-classification rules (Issue #942).
 *
 * The gate ran the Deno suite sequentially at 42+ minutes against a 45-minute
 * phase budget, while the same suite under `--parallel` took 2m23s — an 18x
 * win blocked by the test files that set an environment variable or change
 * the working directory of the shared process
 * (`tests/parallel_safety_cap_test.ts`, Issue #880). Neither
 * `prompts/best_practices/prompt.md` nor its bucket guides said anything
 * about parallel-safety, a unit-test time budget, or the host a benchmark
 * needs, so the scan that exists to surface exactly this class of problem
 * could not see it.
 *
 * Three practices now sit in the scan: a unit test is behavioural and
 * parallel-safe, a unit test finishes within 10 seconds, and a benchmark runs
 * on demand on a quiet machine. These cases pin them where a later reword
 * cannot quietly drop one.
 *
 * Prose assertions are the exception the prompt-drift family is for, so each
 * one is paired with its negative control: the same predicate is run against
 * the surface with the new section cut out, and must come back false. A
 * predicate that passes on text with the practice removed pins nothing, and
 * is exactly the failure mode a grep-shaped test hides.
 *
 * The worked example is checked against the code rather than trusted: the
 * guide points a reader at real injected seams, so the cases below open those
 * modules and fail if the seam the guide promises is no longer there.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

/** Repo root, derived from this test file's location. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/** Heading each surface files the new practices under. */
const ORCHESTRATOR_HEADING = "### Cross-bucket: test classification";
const GUIDE_HEADING = "## Test classification — unit, integration, benchmark";

/** The scan orchestrator, as shipped. */
async function orchestratorPrompt(): Promise<string> {
  const loaded = await loadPrompt("best_practices", PROMPTS_DIR);
  assertEquals(loaded.ok, true, "best_practices failed to load");
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

/** A bucket guide, as shipped. */
function bucketGuide(bucket: string): Promise<string> {
  return Deno.readTextFile(
    `${PROMPTS_DIR}/best_practices/buckets/${bucket}.md`,
  );
}

/** Index of the line that is exactly `heading`. */
function headingIndex(lines: readonly string[], heading: string): number {
  const at = lines.findIndex((line) => line.trim() === heading);
  assert(at >= 0, `heading not found: ${heading}`);
  return at;
}

/** Index of the first heading at or above `heading`'s level after `from`. */
function sectionEnd(
  lines: readonly string[],
  heading: string,
  from: number,
): number {
  const level = heading.match(/^#+/)![0].length;
  for (let i = from; i < lines.length; i++) {
    const opened = /^(#{1,6}) /.exec(lines[i]!);
    if (opened && opened[1]!.length <= level) return i;
  }
  return lines.length;
}

/** Just the section `heading` opens. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = headingIndex(lines, heading);
  return lines.slice(start, sectionEnd(lines, heading, start + 1)).join("\n");
}

/** Everything but the section `heading` opens — the negative control. */
function withoutSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = headingIndex(lines, heading);
  const end = sectionEnd(lines, heading, start + 1);
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/**
 * The parallel-safety practice: the anti-pattern named (mutating state the
 * whole process shares) together with the remedy this repo actually uses (a
 * parameter or an injected seam). Naming only one of the two is advice
 * nobody can act on, so both are required.
 */
function statesParallelSafety(text: string): boolean {
  return /parallel-safe/i.test(text) &&
    /process-wide/i.test(text) &&
    /injected\s+seam/i.test(text);
}

/** The unit-test time budget, stated as a number a reader can apply. */
function statesTenSecondBudget(text: string): boolean {
  return /within\s+10\s+seconds/i.test(text);
}

/** The benchmark host rule: on demand, and on a machine that is not busy. */
function statesQuietMachineBenchmark(text: string): boolean {
  return /quiet[\s-]+(machine|host)/i.test(text) && /on\s+demand/i.test(text);
}

/** The section defers to the standard rather than restating the taxonomy. */
function citesCodingStandards(text: string): boolean {
  return /CODING-STANDARDS\.md/.test(text);
}

/** Every surface that must carry the practices, with its own heading. */
const SURFACES: readonly {
  readonly name: string;
  readonly heading: string;
  readonly read: () => Promise<string>;
}[] = [
  {
    name: "prompts/best_practices/prompt.md",
    heading: ORCHESTRATOR_HEADING,
    read: orchestratorPrompt,
  },
  {
    name: "prompts/best_practices/buckets/typescript.md",
    heading: GUIDE_HEADING,
    read: () => bucketGuide("typescript"),
  },
  {
    name: "prompts/best_practices/buckets/general.md",
    heading: GUIDE_HEADING,
    read: () => bucketGuide("general"),
  },
];

/** The three practices, each with the predicate that recognises it. */
const PRACTICES: readonly {
  readonly name: string;
  readonly holds: (text: string) => boolean;
}[] = [
  { name: "parallel-safety", holds: statesParallelSafety },
  { name: "10-second unit-test budget", holds: statesTenSecondBudget },
  { name: "quiet-machine benchmark", holds: statesQuietMachineBenchmark },
];

for (const surface of SURFACES) {
  for (const practice of PRACTICES) {
    Deno.test(
      `${surface.name} states the ${practice.name} practice (Issue #942)`,
      async () => {
        const stated = section(await surface.read(), surface.heading);
        assert(
          practice.holds(stated),
          `${surface.name} does not state the ${practice.name} practice`,
        );
      },
    );

    Deno.test(
      `${practice.name} is absent from ${surface.name} without its section (Issue #942)`,
      async () => {
        // The negative control. Without it, a predicate satisfied by
        // unrelated text elsewhere in the file would pass for ever while
        // pinning nothing.
        const rest = withoutSection(await surface.read(), surface.heading);
        assert(
          !practice.holds(rest),
          `the ${practice.name} predicate fires on ${surface.name} with its ` +
            `test-classification section removed, so it pins nothing`,
        );
      },
    );
  }

  Deno.test(
    `${surface.name} defers to CODING-STANDARDS.md for the taxonomy (Issue #942)`,
    async () => {
      assert(
        citesCodingStandards(section(await surface.read(), surface.heading)),
        `${surface.name} must cite CODING-STANDARDS.md as the definition`,
      );
    },
  );
}

Deno.test(
  "CODING-STANDARDS.md is a live citation, not a dangling one (Issue #942)",
  async () => {
    // The scan tells a reviewer to read the standard before filing, so the
    // standard must actually define the categories and the budget it is
    // credited with. A citation to a section that no longer says this is
    // worse than no citation at all.
    const standards = await Deno.readTextFile(
      `${REPO_ROOT}CODING-STANDARDS.md`,
    );
    for (const term of ["Unit test", "Benchmark", "10 second"]) {
      assert(
        new RegExp(term, "i").test(standards),
        `CODING-STANDARDS.md no longer mentions '${term}'`,
      );
    }
  },
);

/**
 * The injected seams the TypeScript guide points a reader at, and the
 * evidence in the source that each one is really there.
 */
const WORKED_EXAMPLES: readonly {
  readonly symbol: string;
  readonly file: string;
  readonly seam: string;
}[] = [
  {
    symbol: "resolveDiskFloors",
    file: "worker/deno/lib/host_disk.ts",
    seam: "env: (name: string) => string | undefined",
  },
  {
    symbol: "HostDiskMonitor",
    file: "worker/deno/lib/host_disk.ts",
    seam: "env: (name: string) => string | undefined",
  },
  {
    symbol: "findIssuesByLabel",
    file: "worker/deno/lib/find_issues_by_label.ts",
    seam: "ghCommandFn",
  },
];

for (const example of WORKED_EXAMPLES) {
  Deno.test(
    `the typescript guide's ${example.symbol} example still holds (Issue #942)`,
    async () => {
      const guide = section(await bucketGuide("typescript"), GUIDE_HEADING);
      assert(
        guide.includes(example.symbol),
        `the guide no longer names the ${example.symbol} worked example`,
      );
      assert(
        guide.includes(example.file),
        `the guide no longer cites ${example.file}`,
      );

      // The claim is that the reader can go and read a real seam. If the
      // module stopped taking one, the guide is advertising a remedy that
      // is not there.
      const source = await Deno.readTextFile(`${REPO_ROOT}${example.file}`);
      assert(
        source.includes(example.symbol),
        `${example.file} no longer declares ${example.symbol}`,
      );
      assert(
        source.includes(example.seam),
        `${example.file} no longer takes the '${example.seam}' seam the ` +
          `guide promises`,
      );
    },
  );
}

Deno.test(
  "the typescript guide keeps assertion shape with test_audit (Issue #942)",
  async () => {
    // #786 made an absolute wall-clock threshold a test-audit finding. If
    // this guide claimed it too, the same test would be filed twice by two
    // scans, so the guide hands that shape back explicitly.
    const guide = section(await bucketGuide("typescript"), GUIDE_HEADING);
    assert(
      /test-audit/i.test(guide) && /do not\s+file both/i.test(guide),
      "the guide must hand assertion shape to test-audit and say so",
    );
  },
);

Deno.test(
  "the scan does not re-file already-tracked test debt (Issue #942)",
  async () => {
    // The 98 files in this repo's parallel-safety cap and the 13 in its
    // integration manifest are accepted, bounded debt. A scan that filed
    // each of them would spend its six-issue cap reporting what the repo
    // already knows, so both surfaces carve the tracked lists out.
    const prompt = section(await orchestratorPrompt(), ORCHESTRATOR_HEADING);
    const guide = section(await bucketGuide("typescript"), GUIDE_HEADING);
    for (const stated of [prompt, guide]) {
      assert(
        /already\s+accepted\s+and\s+bounded/i.test(stated) &&
          /re-file/i.test(stated),
        "the carve-out for already-tracked debt must be stated",
      );
    }

    // The practice is grounded in two real mechanisms. They are described
    // generically in the prompt — it is filed verbatim into other
    // repositories — but they must still exist here, or the rule is
    // asserting something this repo does not do.
    for (
      const path of [
        "worker/deno/tests/parallel_safety_cap_test.ts",
        "worker/deno/lib/integration_test_manifest.ts",
      ]
    ) {
      await Deno.stat(`${REPO_ROOT}${path}`);
    }
  },
);

Deno.test(
  "the added sections stay portable across repositories (Issue #942)",
  async () => {
    // The best-practices body — the orchestrator plus every bucket guide —
    // is filed verbatim as an issue in the *target* repository, where a bare
    // `#NNN` auto-links to that repo's unrelated issue. The repo-wide guard
    // in `idle_task_cross_repo_body_refs_test.ts` owns that rule; this case
    // states it for the new sections specifically, because a measurement
    // this well evidenced invites an issue citation next to it.
    for (const surface of SURFACES) {
      const stated = section(await surface.read(), surface.heading);
      const bare = stated.match(/(?<!\w)#\d+/g) ?? [];
      assertEquals(
        bare,
        [],
        `${surface.name}'s test-classification section carries a bare issue ` +
          `reference, which mislinks once the body is filed cross-repo`,
      );
    }

    // The orchestrator additionally carries no path from this repo's own
    // tree: it is prose a reviewer of any repository reads.
    const prompt = section(await orchestratorPrompt(), ORCHESTRATOR_HEADING);
    assert(
      !prompt.includes("worker/deno/"),
      "the orchestrator section must describe the mechanism generically",
    );
  },
);
