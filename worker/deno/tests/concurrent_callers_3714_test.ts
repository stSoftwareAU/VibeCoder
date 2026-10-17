/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3714 — fleet PRs routed a new caller into a shared mutation without
 * serialising it against the callers that could be in that code at the same
 * time: VibeCoder#3065 (a conflict takeover pushed to a PR head with no
 * cross-host PR lock, and later rounds tallied attempts from a read taken
 * before the lock) and #3712 (`ensureRepoClone` handed a corrupt clone to
 * `setupRepo` with no per-repository serialisation, and a repeat-corruption
 * cap checked without re-probing the clone). The "a new caller of a shared
 * mutation names its concurrent callers" paragraph must be on
 * CODING-STANDARDS.md and the coding_guidelines prompt, inside the
 * test-coverage section right after the multi-write finisher rule, identical
 * once wrapping is ignored; and the issue prompt's PR Summary File step must
 * restate it.
 *
 * Uses Australian English spelling (behaviour, serialise, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const LEAD =
  "**A new caller of a shared mutation names its concurrent callers.**";
const PREVIOUS_LEAD =
  "**Every step of a multi-write operation has a named finisher when it fails.**";
const NEXT_STANDARDS = "**A named test must exist.**";
const NEXT_GUIDELINES =
  "**Every changed call site needs a test that goes red without it.**";

/** The rule block from its lead up to the next rule's lead (exclusive). */
function ruleBlock(sectionText: DocSection, next: string): DocSection {
  const start = sectionText.indexOf(LEAD);
  assert(start >= 0, "could not locate the concurrent-callers rule");
  const end = sectionText.indexOf(next, start);
  assert(
    end > start,
    `could not locate the next rule ${next} after the concurrent-callers rule`,
  );
  return excerpt(sectionText, start, end);
}

Deno.test("both surfaces carry the concurrent-callers rule, identical, right after the multi-write finisher rule (Issue #3714)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  const surfaces: [DocSection, string][] = [
    [standards, NEXT_STANDARDS],
    [guidelines, NEXT_GUIDELINES],
  ];
  for (const [text, next] of surfaces) {
    assertPins(text, [LEAD]);
    assertPins(ruleBlock(text, next), [
      "list every caller that can be in that code at the same time",
      "other pool lanes on the same repository, maintenance passes, other hosts",
      "Serialise it:",
      "take the lock the existing callers use, or add one where none exists",
      "`runExclusive` in `worker/deno/lib/ensure_repo_clone.ts`",
      "`acquireBranchUpdateLock` in `worker/deno/lib/pr_branch_lock.ts`",
      "Decide under the lock:",
      "re-read whatever made the action due or needed",
      "stand down if it no longer is",
      "holds the first inside the mutation until the second has started",
      "using a barrier rather than a sleep",
      "asserts the action happens once",
      "drop the lock, and separately move the re-read back before it",
      "List the concurrent callers and the lock each takes in the PR summary",
      "a decision read before the lock, or no two-caller test is a blocking self-review finding",
    ]);

    const previous = text.indexOf(PREVIOUS_LEAD);
    const here = text.indexOf(LEAD);
    const following = text.indexOf(next);
    assert(
      previous >= 0 && previous < here,
      "must follow the multi-write finisher rule",
    );
    assert(following >= 0 && here < following, `must precede ${next}`);
  }

  assertEquals(
    flat(ruleBlock(standards, NEXT_STANDARDS)).trim(),
    flat(ruleBlock(guidelines, NEXT_GUIDELINES)).trim(),
    "the concurrent-callers rule must be identical on both surfaces",
  );
});

Deno.test("issue prompt PR Summary File step restates the concurrent-callers rule (Issue #3714)", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "**A new caller of a shared mutation names its concurrent callers**",
      "re-read under the lock whatever made the action due or needed",
      "goes red when the lock is dropped and again when the re-read is moved before it",
      "list the concurrent callers and the lock each takes in the PR summary",
      "a decision read before the lock, or no two-caller test is a blocking self-review finding",
    ],
  );
});
