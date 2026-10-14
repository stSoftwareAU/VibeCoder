/**
 * The review-fleet-prs learning step (SKILL.md step 3) must assess a
 * deterministic check before it proposes prose guidance, and the issue it
 * files must record that assessment (Issue #3537, part of #3396). Prose rules
 * alone keep being broken, so each one added grows the guidance without
 * reducing the mistake.
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

Deno.test("review-fleet-prs step 3 assesses deterministic checks, in order, before any prose proposal (Issue #3537)", async () => {
  const learn = await learnStep();
  const assess = learn.indexOf("deterministic check");
  const prose = learn.indexOf("concrete change to VibeCoder's prompt");
  assert(assess >= 0, "step 3 must name the deterministic-check assessment");
  assert(prose >= 0, "step 3 must still describe the prose proposal");
  assert(
    assess < prose,
    "the deterministic-check assessment must come before the prose proposal",
  );

  const order = [
    "a worker gate",
    "a test or lint rule",
    "a Semgrep rule",
    "a script or deno task",
  ].map((kind) => {
    const at = learn.indexOf(kind, assess);
    assert(at >= 0, `the assessment must consider ${kind}`);
    return at;
  });
  assert(
    order.every((at, i) => i === 0 || order[i - 1]! < at),
    "the check kinds must be considered in the order the issue sets",
  );
});

Deno.test("review-fleet-prs step 3 proposes prose only when no check is feasible, rewording before adding (Issue #3537)", async () => {
  const learn = await learnStep();
  assert(
    /only when none of these checks is feasible/i.test(learn),
    "prose guidance must be limited to findings no check can catch",
  );
  assert(
    /reword(ing)?, mov(e|ing) or replac(e|ing) an existing rule/i.test(learn) &&
      learn.includes("#3425"),
    "a prose proposal must prefer changing an existing rule and point at #3425",
  );
});

Deno.test("review-fleet-prs filed improvement issues carry a Deterministic check assessment section (Issue #3537)", async () => {
  const learn = await learnStep();
  assert(
    learn.includes("`## Deterministic check assessment`"),
    "the filed issue's required contents must include the assessment heading",
  );
  const contents = learn.slice(
    learn.indexOf("`## Deterministic check assessment`"),
  );
  assert(
    /checks considered/.test(contents) &&
      /why none is feasible/.test(contents),
    "the section must name the checks considered and the proposal or why none is feasible",
  );
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
