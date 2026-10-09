/**
 * The review-fleet-prs skill files improvement issues for recurring review
 * findings in the public `stSoftwareAU/VibeCoder` repo, while many fleet
 * repos are private. SKILL.md must tell the round to describe a private
 * repo's examples at concept level, never by name, number or link, and to
 * check a repo's visibility before linking it.
 */
import { assert } from "@std/assert";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const SKILL = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/SKILL.md",
    import.meta.url,
  ),
);

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert(start >= 0, `SKILL.md has no "${heading}" section`);
  const next = markdown.indexOf("\n#", start + heading.length);
  return markdown.slice(start, next < 0 ? undefined : next);
}

Deno.test("review-fleet-prs SKILL.md keeps private repo references out of VibeCoder improvement issues", async () => {
  const markdown = await Deno.readTextFile(SKILL);
  const rules = section(markdown, "## Keeping private repos private");
  assert(
    rules.includes("gh api repos/{repo} --jq .visibility"),
    "the rules must check visibility before linking",
  );
  assert(
    /other than `public`[^.]*private/.test(rules),
    "an unknown visibility must count as private",
  );

  const learn = section(markdown, "### 3. Learn from recurring findings");
  assert(
    learn.includes("concept-level description") &&
      learn.includes("Keeping private repos private"),
    "the improvement-issue step must describe private examples at concept level",
  );
  assert(
    !learn.includes("links to at least two"),
    "the improvement-issue step must not ask for links to every example",
  );
});
