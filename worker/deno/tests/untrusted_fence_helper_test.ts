/** Strict fence-helper regressions and historical leak controls (Issue #4203). */
import {
  assertEquals,
  AssertionError,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  createPromptDelimiters,
  fenceUntrustedIssueText,
  scrubUntrustedText,
} from "../lib/prompt_delimiter.ts";
import {
  assertFenceCoverageRow,
  assertOnlyInsideUntrustedFence,
  knownLeakRow,
  makeCanary,
  runFenceCoverageRows,
} from "./support/untrusted_fence.ts";

const ID = "012345abcdef";
const OTHER_ID = "fedcba543210";
const canary = "FENCECANARYtitleQ7";
const delimiters = createPromptDelimiters(ID);
const other = createPromptDelimiters(OTHER_ID);
const fenced = (value = canary) =>
  fenceUntrustedIssueText(value, "Issue text", ID).join("\n");

Deno.test("untrusted fence helper - accepts the production fence and repeated fenced occurrences", () => {
  assertOnlyInsideUntrustedFence(fenced(), canary);
  assertOnlyInsideUntrustedFence(
    `${fenced(`${canary} ${canary}`)}\n${
      fenceUntrustedIssueText(canary, "More text", OTHER_ID).join("\r\n")
    }`,
    canary,
  );
  assertOnlyInsideUntrustedFence(
    `${delimiters.untrustedStart}\n${other.untrustedStart}\n${canary}\n${other.untrustedEnd}\n${delimiters.untrustedEnd}`,
    canary,
  );
});

for (
  const [name, prompt, reason] of [
    ["canary before the fence", `Context: ${canary}\n${fenced()}`, "outside"],
    ["unfenced duplicate", `${fenced()}\nContext: ${canary}`, "outside"],
    ["missing canary", fenced("a different value"), "missing"],
    [
      "mismatched ids",
      `${delimiters.untrustedStart}\n${canary}\n${other.untrustedEnd}`,
      "mismatched",
    ],
    ["unclosed BEGIN", `${delimiters.untrustedStart}\n${canary}`, "unclosed"],
    ["stray END", `${canary}\n${delimiters.untrustedEnd}`, "stray"],
    [
      "invalid boundary id",
      "---BEGIN UNTRUSTED USER CONTENT BOUNDARY_INVALID---\n" + canary +
      "\n---END UNTRUSTED USER CONTENT BOUNDARY_INVALID---",
      "invalid boundary id",
    ],
    [
      "inline marker lookalikes",
      `quoted ${delimiters.untrustedStart}\n${canary}\nquoted ${delimiters.untrustedEnd}`,
      "outside",
    ],
    [
      "crossed nested ids",
      `${delimiters.untrustedStart}\n${other.untrustedStart}\n${canary}\n${delimiters.untrustedEnd}\n${other.untrustedEnd}`,
      "mismatched",
    ],
  ]
) {
  Deno.test(`untrusted fence helper - rejects ${name}`, () => {
    const error = assertThrows(
      () => assertOnlyInsideUntrustedFence(prompt!, canary),
      AssertionError,
      reason,
    );
    assertStringIncludes(error.message, canary);
    assertStringIncludes(error.message, "context:");
  });
}

Deno.test("untrusted fence helper - catches the unfenced title context from #3584", () => {
  assertThrows(
    () =>
      assertOnlyInsideUntrustedFence(
        `${fenced()}\nPlease resolve the issue titled ${canary}.`,
        canary,
      ),
    AssertionError,
    "outside",
  );
});

Deno.test("untrusted fence helper - catches the criteria after END from #3890", () => {
  assertThrows(
    () =>
      assertOnlyInsideUntrustedFence(
        `${fenced("An issue body")}\nAcceptance criteria:\n1. ${canary}`,
        canary,
      ),
    AssertionError,
    "outside",
  );
});

Deno.test("untrusted fence helper - checks overlapping occurrences and reports nearby context", () => {
  const prompt = `${fenced("AAA")}\n${"x".repeat(100)}AAA tail`;
  const error = assertThrows(
    () => assertOnlyInsideUntrustedFence(prompt, "AA"),
    AssertionError,
  );
  assertStringIncludes(error.message, "AAA tail");
});

Deno.test("untrusted fence helper - canaries are distinct alphanumeric scrub survivors", () => {
  const fields = ["title", "body", "a-b", "ab", "a_b", "", "\u{1f680}"];
  const values = fields.map(makeCanary);
  assertEquals(new Set(values).size, fields.length);
  for (const value of values) {
    assertMatch(value, /^[A-Za-z0-9]+$/);
    assertEquals(scrubUntrustedText(value), value);
  }
  assertEquals(makeCanary("title"), makeCanary("title"));
});

Deno.test("untrusted fence helper - clean known-leak rows must be promoted", async () => {
  await assertRejects(
    () =>
      assertFenceCoverageRow(knownLeakRow({
        name: "buildCleanPrompt",
        canaries: [canary],
        knownLeak: "#4203",
        render: () => fenced(),
      })),
    AssertionError,
    "promote",
  );
});

Deno.test("untrusted fence helper - a known leak must name a real follow-up issue number", () => {
  for (const knownLeak of ["#0", "#-1"] as const) {
    assertThrows(
      () =>
        knownLeakRow({
          name: "buildLeakingPrompt",
          canaries: [canary],
          knownLeak,
          render: () => canary,
        }),
      AssertionError,
      "follow-up issue",
    );
  }
});

Deno.test("untrusted fence helper - a known leak cannot hide dropped input or renderer errors", async () => {
  for (
    const render of [
      () => "unrelated text",
      () => {
        throw new Error("renderer failed");
      },
      () => {
        throw new AssertionError("protected canary leaked in renderer");
      },
    ]
  ) {
    await assertRejects(
      () =>
        assertFenceCoverageRow(knownLeakRow({
          name: "buildBrokenPrompt",
          canaries: [canary],
          knownLeak: "#4203",
          render,
        })),
    );
  }
});

Deno.test("untrusted fence helper - rejects empty canaries and rows without canaries", async () => {
  assertThrows(
    () => assertOnlyInsideUntrustedFence(fenced(), ""),
    AssertionError,
    "empty canary",
  );
  await assertRejects(
    () =>
      assertFenceCoverageRow({
        name: "buildEmptyPrompt",
        canaries: [],
        render: () => "text",
      }),
    AssertionError,
    "canary",
  );
});

Deno.test("untrusted fence helper - runner registers and executes normal and tracked rows", async () => {
  const registrations: Array<{ name: string; test: () => Promise<void> }> = [];
  const register = (name: string, test: () => Promise<void>) => {
    registrations.push({ name, test });
  };
  runFenceCoverageRows([], register);
  assertEquals(registrations, []);
  runFenceCoverageRows([
    { name: "buildNormalPrompt", canaries: [canary], render: () => fenced() },
    knownLeakRow({
      name: "buildTrackedPrompt",
      canaries: [canary],
      knownLeak: "#4203",
      render: () => canary,
    }),
  ], register);
  assertEquals(registrations.map(({ name }) => name), [
    "fence coverage - buildNormalPrompt",
    "fence coverage - buildTrackedPrompt (known leak #4203)",
  ]);
  for (const registration of registrations) await registration.test();
});

runFenceCoverageRows([
  {
    name: "buildSynchronousHelperControlPrompt",
    canaries: [canary],
    render: () => fenced(),
  },
  {
    name: "buildAsynchronousHelperControlPrompt",
    canaries: [canary],
    render: () => Promise.resolve(fenced()),
  },
  knownLeakRow({
    name: "buildKnownLeakHelperControlPrompt",
    canaries: [canary, "FENCECANARYleakQ7"],
    knownLeak: "#4203",
    render: () => `${fenced()}\nFENCECANARYleakQ7`,
  }),
  knownLeakRow({
    name: "buildMalformedHelperControlPrompt",
    canaries: [canary],
    knownLeak: "#4203",
    render: () => `${delimiters.untrustedStart}\n${canary}`,
  }),
]);
