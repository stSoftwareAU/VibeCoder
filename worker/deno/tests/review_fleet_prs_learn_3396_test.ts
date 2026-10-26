/**
 * The review-fleet-prs learning step (SKILL.md step 3) serves the Vibe
 * Coder's one goal: completing the issues it is assigned (Issue #4291). It
 * files worker defects and proposes removing or rewording guidance that
 * causes mistakes. It never invents a new gate, check or rule, and never
 * anything that holds back auto-merge. The guidance ledger (Issue #3539)
 * still retires guidance that keeps recurring.
 */
import { assert } from "@std/assert";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const SKILL = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/SKILL.md",
    import.meta.url,
  ),
);

/** The text from `heading` up to the next Markdown heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert(start >= 0, `SKILL.md has no "${heading}" section`);
  const next = markdown.indexOf("\n#", start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next);
}

/** Step 3 with its hard-wrapped lines joined, so a phrase may span a wrap. */
async function learnStep(): Promise<string> {
  const markdown = await Deno.readTextFile(SKILL);
  return section(markdown, "### 3. Learn from recurring findings")
    .replace(/\s+/g, " ");
}

Deno.test("review-fleet-prs step 3 states the goal and that auto-merge is never held back (Issue #4291)", async () => {
  const learn = await learnStep();
  assert(
    learn.includes("complete the issues it is assigned"),
    "step 3 must state the goal it serves",
  );
  assert(
    /armed for auto-merge when it is raised/.test(learn),
    "step 3 must say every PR is armed when raised",
  );
  assert(
    /Never propose anything that withholds, disarms or delays auto-merge/
      .test(learn),
    "step 3 must forbid proposals that hold back auto-merge",
  );
});

Deno.test("review-fleet-prs step 3 never proposes a new gate, check or rule (Issue #4291)", async () => {
  const learn = await learnStep();
  assert(
    /Never propose adding a gate, check, lint rule, Semgrep rule, deno task/
      .test(learn),
    "step 3 must forbid inventing new gates and checks",
  );
  assert(
    /removing it, simplifying it or rewording it/.test(learn),
    "guidance proposals must only remove, simplify or reword",
  );
  for (
    const invented of [
      "a worker gate (the worker refuses the PR or the push)",
      "`## Deterministic check assessment`",
    ]
  ) {
    assert(
      !learn.includes(invented),
      `step 3 must not ask for ${invented}`,
    );
  }
});

Deno.test("review-fleet-prs step 3 tracks filed guidance in the ledger and retires guidance that keeps recurring (Issue #3539)", async () => {
  const learn = await learnStep();
  for (
    const needle of [
      "`## Target pattern`",
      "guidance.ts track",
      "guidance.ts hit",
      "guidance.ts due",
      "guidance.ts retire",
      "references/guidance-ledger.md",
    ]
  ) {
    assert(learn.includes(needle), `step 3 must mention ${needle}`);
  }
  assert(
    /removal or a rewrite[^.]*never an extension/i.test(learn),
    "a recurring entry is answered by removing or rewriting the guidance, never extending it",
  );
});

Deno.test("review-fleet-prs step 4 reports recurring guidance, and a due failure never changes a review outcome (Issue #3539)", async () => {
  const markdown = await Deno.readTextFile(SKILL);
  const report = section(markdown, "### 4. Report").replace(/\s+/g, " ");
  assert(
    /`recurring`/.test(report),
    "the round report lists recurring entries",
  );
  assert(
    /`due` fail[^.]*never changes? (a|the) (PR )?review outcome/i.test(report),
    "a due failure is named in the report and never changes a review outcome",
  );
});
