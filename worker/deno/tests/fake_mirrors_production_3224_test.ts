/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3224 — fleet PRs relied on a property only their in-repo fake had,
 * not the production implementation they stood in for, e.g.
 * GRQ-AutoTrader#2546, #2460 and #2407.
 * CODING-STANDARDS.md and the coding_guidelines prompt must both carry the
 * same "a fake mirrors the production implementation it stands in for" rule,
 * inside the test-coverage section, word for word once wrapping is ignored,
 * sitting after the stub-contract paragraph and before the
 * observe-real-tool paragraph; and the issue prompt's PR Raising
 * Requirements section must require the same in-repo-port discipline for
 * Bugs/Enhancements.
 * Issue #3900 extended the same rule to hand-faked responses from the
 * repository's own server or service, not only in-repo fakes of ports, adding
 * the producer-output fixture and the CORS exposed-headers check; the
 * issue prompt's PR Raising Requirements carries the same checks; and the
 * operator manual's paragraph on the fake-mirrors rule carries them too.
 * Issue #5372 shortened the rule: it dropped the port and wire-format trigger
 * lists, the example-property list, the golden-file remedy and both
 * PR-summary lines. This test pins the phrases that remain and checks that
 * the retired PR-summary and golden obligations stay out of the agent-facing
 * surfaces.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**A fake mirrors the production implementation it stands in for.**";

function fakeMirrorsParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the fake-mirrors rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "this covers the repository's own producers",
  "take it from the producer",
  "call the producer in the test",
  "run one contract test against both the fake and the production adapter",
  "test the behaviour at the production adapter itself",
  "read the production implementation first and confirm it has that property",
  "fix whichever side is wrong",
  "A red run counts only against the base branch",
  "a fake more permissive than its production implementation",
];

const WIRE_FORMAT_PHRASES = [
  "load output that the producer's own tests generate or verify",
  "a CORS exposed-headers list",
  "or a fixture the producer never emits, is a blocking self-review finding",
];

Deno.test("both surfaces carry the fake-mirrors-production rule (Issue #3224)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = fakeMirrorsParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the fake-mirrors rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    fakeMirrorsParagraph(standards, "CODING-STANDARDS.md"),
    fakeMirrorsParagraph(guidelines, "coding_guidelines"),
    "the fake-mirrors-production rule must be identical on both surfaces",
  );
});

Deno.test("both surfaces carry the producer-output fixture and exposed-headers check (Issue #3900)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = fakeMirrorsParagraph(text, surface);
    for (const phrase of WIRE_FORMAT_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the producer-output fixture check: ${paragraph}`,
      );
    }
  }
});

Deno.test("the fake-mirrors-production rule sits between the stub-contract and observe-real-tool paragraphs (Issue #3224)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const stubIndex = text.indexOf(
      "**A stub mirrors the real callee's contract.**",
    );
    const fakeIndex = text.indexOf(PARAGRAPH_START);
    const observeIndex = text.indexOf(
      "**Observe the real tool before you rely on it.**",
    );

    assert(stubIndex >= 0, `${surface} is missing the stub-contract rule`);
    assert(
      fakeIndex >= 0,
      `${surface} is missing the fake-mirrors-production rule`,
    );
    assert(
      observeIndex >= 0,
      `${surface} is missing the observe-real-tool rule`,
    );

    assert(
      stubIndex < fakeIndex,
      `${surface}: fake-mirrors-production rule must come after the stub-contract rule`,
    );
    assert(
      fakeIndex < observeIndex,
      `${surface}: fake-mirrors-production rule must come before the observe-real-tool rule`,
    );
  }
});

Deno.test("issue prompt PR Raising Requirements require production-mirroring fakes for Bugs/Enhancements (Issue #3224)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
  );

  assert(
    text.includes(
      "read the production implementation first and confirm it has that property",
    ),
    `PR Raising Requirements is missing the read-production-first requirement: ${text}`,
  );
  assert(
    text.includes(
      "A fake mirrors the production implementation it stands in for",
    ),
    `PR Raising Requirements is missing the back-reference to the guidelines: ${text}`,
  );
  assert(
    text.includes(
      "a fake more permissive than its production implementation, or a fixture the producer never emits, is a blocking self-review finding",
    ),
    `PR Raising Requirements is missing the blocking self-review finding: ${text}`,
  );
});

const ISSUE_PROMPT_SERVER_RESPONSE_PHRASES = [
  "something one of the repository's own producers returns or writes",
  "take it from the producer",
  "load output that the producer's own tests generate or verify",
  "run one contract test against both the fake and the production adapter",
  "a CORS exposed-headers list",
];

Deno.test("issue prompt PR Raising Requirements carry the producer-output fixture checks (Issues #3900, #5372)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
  );

  for (const phrase of ISSUE_PROMPT_SERVER_RESPONSE_PHRASES) {
    assert(
      text.includes(phrase),
      `PR Raising Requirements is missing "${phrase}" from the producer-output fixture checks: ${text}`,
    );
  }
});

const MANUAL_PARAGRAPH_START =
  "**A fake mirrors the production implementation it stands in for (Issue";
const MANUAL_SECTION_TITLE = "Reproduction status on a bug fix";
const MANUAL_PHRASES = [
  "the test takes it from the producer",
  "the producer's own tests generate or verify",
  "a CORS exposed-headers list",
  "a fixture the producer never emits",
];

Deno.test("operator manual fake-mirrors paragraph carries the server-response fake checks (Issues #3900, #5372)", async () => {
  const manual = section(
    await readRepoDoc("docs/workflows/issue-processing.md"),
    MANUAL_SECTION_TITLE,
  );
  const start = manual.indexOf(MANUAL_PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the fake-mirrors paragraph in docs/workflows/issue-processing.md under "${MANUAL_SECTION_TITLE}"`,
  );
  const end = manual.indexOf("\n\n", start);
  const paragraph = flat(
    excerpt(manual, start, end >= 0 ? end : undefined),
  ).trim();

  for (const phrase of MANUAL_PHRASES) {
    assert(
      paragraph.includes(phrase),
      `docs/workflows/issue-processing.md is missing "${phrase}" from the fake-mirrors paragraph: ${paragraph}`,
    );
  }
});

const RETIRED_PHRASES = [
  "load-bearing fake",
  "where that is set",
  "where that deployed setting is set",
  "the PR adds one",
  "a trait or interface with a production implementation",
  "across processes and languages",
  "which rows a read returns",
];

Deno.test("the retired fake-mirrors obligations stay out of the agent-facing surfaces (Issue #5372)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );
  const issuePrompt = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
  );

  const scoped = [
    [
      "CODING-STANDARDS.md",
      fakeMirrorsParagraph(standards, "CODING-STANDARDS.md"),
    ],
    [
      "coding_guidelines",
      fakeMirrorsParagraph(guidelines, "coding_guidelines"),
    ],
    ["issue prompt PR Raising Requirements", issuePrompt],
  ] as const;

  for (const [surface, text] of scoped) {
    assert(
      text.includes("take it from the producer"),
      `${surface}: the scoped text does not carry the rule, so the absence checks would read the wrong text: ${text}`,
    );
    for (const phrase of RETIRED_PHRASES) {
      assert(
        !text.includes(phrase),
        `${surface} still carries the retired fake-mirrors obligation "${phrase}": ${text}`,
      );
    }
  }
});
