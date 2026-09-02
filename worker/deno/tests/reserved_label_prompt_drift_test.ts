/**
 * One reserved-workflow-label list, and one true `needs-human` rule
 * (Issue #780).
 *
 * Seven templates published the list under the same heading, in four
 * different memberships, and the shared `coding_guidelines` block lands in the
 * same rendered prompt as three of them. Worse, the reason they gave was
 * wrong: they told the agent that a `needs-human` it applied would be
 * "silently stripped by the `label_security` check", while
 * `label_security.ts` trusts exactly that label from this worker — the escape
 * hatch the same guidelines prescribe was documented as disarmed.
 *
 * Two rules, both true, and every template now states the one that applies:
 *
 *   - **On an issue that already exists** the nine reserved labels are never
 *     self-applied; `needs-human` is the exception and survives, because it is
 *     the worker's own escalation signal.
 *   - **On an issue the agent just filed** every reserved label — including
 *     `needs-human` — is removed after creation, so it is mentioned in the
 *     hand-off message instead.
 *
 * These cases pin the membership across all seven templates, prove the
 * `needs-human` carve-out against the real `verifyOperationalLabels` rather
 * than against a comment, and fail if any template reintroduces the claim the
 * code contradicts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import {
  OPERATIONAL_LABEL_NAMES,
  verifyOperationalLabels,
} from "../lib/label_security.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "../lib/worker_label_guard.ts";
import { RESERVED_LABEL_PROHIBITION } from "../lib/planning_processor.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/**
 * The canonical never-self-apply list, in the order every template states it.
 *
 * `needs-human` is deliberately absent: it is the worker's own escalation
 * label, and the code trusts it (asserted below).
 */
const CANONICAL_RESERVED = [
  "top-priority",
  "work-on",
  "low-priority",
  "failed",
  "failed-once",
  "refine-issue",
  "planning",
  "question",
  "best-model",
] as const;

/** Every template that publishes the list. */
const TEMPLATES = [
  "coding_guidelines",
  "issue",
  "ci_fix",
  "pr_feedback",
  "grill-me",
  "planning",
  "planning_critique",
] as const;

/** The latest text of one prompt, and the version it came from. */
async function latestText(
  prompt: string,
): Promise<{ version: string; text: string }> {
  const latest = await getLatestVersion(prompt, PROMPTS_DIR);
  assertEquals(latest.ok, true, `no latest version for ${prompt}`);
  if (!latest.ok) throw new Error(latest.error.message);
  const loaded = await loadPrompt(prompt, latest.value, PROMPTS_DIR);
  assertEquals(loaded.ok, true, `cannot load ${prompt} ${latest.value}`);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { version: latest.value, text: loaded.value };
}

/**
 * The passages that publish the list, each as the text from the phrase
 * "reserved workflow label" to the end of that list.
 *
 * Two shapes are in use — an inline parenthesised list and a bulleted one —
 * so the window runs to the first blank line that is not immediately followed
 * by a list item, which covers both.
 */
function listPassages(text: string): string[] {
  const passages: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/reserved workflow label/i.test(lines[i]!)) continue;
    const collected: string[] = [];
    for (let j = i; j < Math.min(lines.length, i + 25); j++) {
      const line = lines[j]!;
      if (line.trim() === "") {
        const next = lines[j + 1]?.trimStart() ?? "";
        if (!next.startsWith("- ")) break;
        continue;
      }
      collected.push(line);
    }
    passages.push(collected.join("\n"));
  }
  return passages;
}

/**
 * Whether a passage actually *publishes the list*, rather than mentioning
 * reserved labels in passing ("never a reserved workflow label"). A published
 * list names several of them; a mention names none.
 */
function publishesList(passage: string): boolean {
  const listed = labelsIn(passage);
  return CANONICAL_RESERVED.filter((label) => listed.has(label)).length >= 3;
}

/** The backticked label names a passage lists. */
function labelsIn(passage: string): Set<string> {
  const found = new Set<string>();
  for (const match of passage.matchAll(/`([a-z][a-z-]*)`/g)) {
    found.add(match[1]!);
  }
  return found;
}

Deno.test("reserved labels - the in-code prohibition publishes the same membership (Issue #780)", () => {
  // `planning_processor.ts` restates the list for the in-code fallback publish
  // path, so it is an eighth surface and drifts like any other.
  const listed = labelsIn(RESERVED_LABEL_PROHIBITION);
  for (const label of CANONICAL_RESERVED) {
    assert(
      listed.has(label),
      `RESERVED_LABEL_PROHIBITION omits \`${label}\``,
    );
  }
  const parenthesised =
    RESERVED_LABEL_PROHIBITION.match(/\(([^)]*`[^)]*)\)/g) ??
      [];
  for (const group of parenthesised) {
    assertEquals(
      labelsIn(group).has("needs-human"),
      false,
      `RESERVED_LABEL_PROHIBITION lists \`needs-human\` among the labels the ` +
        `code says are stripped by label_security, which it is not:\n${group}`,
    );
  }
});

Deno.test("reserved labels - every template publishes the same membership (Issue #780)", async () => {
  for (const prompt of TEMPLATES) {
    const { version, text } = await latestText(prompt);
    const passages = listPassages(text);
    assert(
      passages.length > 0,
      `${prompt} ${version} publishes no reserved-label list`,
    );
    const published = passages.filter(publishesList);
    assert(
      published.length > 0,
      `${prompt} ${version} publishes no reserved-label list`,
    );
    for (const passage of published) {
      const listed = labelsIn(passage);
      for (const label of CANONICAL_RESERVED) {
        assert(
          listed.has(label),
          `${prompt} ${version} omits \`${label}\` from a reserved-label ` +
            `list:\n${passage}`,
        );
      }
    }
  }
});

Deno.test("reserved labels - no template lists needs-human among them (Issue #780)", async () => {
  // The list is the never-self-apply set. `needs-human` is the worker's own
  // escalation label and belongs to the sentence beside the list, not to it.
  for (const prompt of TEMPLATES) {
    const { version, text } = await latestText(prompt);
    for (const passage of listPassages(text).filter(publishesList)) {
      // Only the group that *is* the list: a nearby "(`needs-human`)" in the
      // prose beside it is the sentence that grants the exception, not a
      // membership claim.
      const parenthesised = (passage.match(/\(([^)]*`[^)]*)\)/g) ?? [])
        .filter(publishesList);
      for (const group of parenthesised) {
        assertEquals(
          labelsIn(group).has("needs-human"),
          false,
          `${prompt} ${version} lists \`needs-human\` as a reserved label ` +
            `the agent may never apply, which the code contradicts:\n${group}`,
        );
      }
    }
  }
});

Deno.test("reserved labels - no template claims a worker's needs-human is stripped by label_security (Issue #780)", async () => {
  // The specific false statement this issue is about, and it spanned two
  // sentences — "(… `needs-human`). The worker account is not on the
  // trusted-author allowlist, so any reserved label you add is silently
  // stripped by the `label_security` check" — so the unit is the paragraph.
  // A paragraph may still name both, but only while it says which rule
  // applies: the label is trusted on an existing issue, or removed after
  // creation on one the agent filed.
  // Deliberately the exact claims, not the word "trusted": every one of these
  // paragraphs already says "trusted-author allowlist", which is about a
  // different set of people entirely.
  const CORRECTIVE =
    /trusts a `needs-human`|is trusted and does survive|removed after creation/i;
  for (const prompt of TEMPLATES) {
    const { version, text } = await latestText(prompt);
    for (const paragraph of text.split(/\n\s*\n/)) {
      if (!paragraph.includes("needs-human")) continue;
      if (!/label_security/.test(paragraph)) continue;
      assert(
        CORRECTIVE.test(paragraph),
        `${prompt} ${version} names \`needs-human\` beside label_security ` +
          `stripping without saying which rule applies:\n${paragraph}`,
      );
    }
  }
});

Deno.test("reserved labels - the code trusts a needs-human this worker applied (Issue #780)", async () => {
  // The carve-out the prompts now describe, exercised rather than quoted.
  const timeline = JSON.stringify([
    {
      event: "labeled",
      label: { name: "needs-human" },
      actor: { login: "vibe-bot" },
    },
    {
      event: "labeled",
      label: { name: "planning" },
      actor: { login: "vibe-bot" },
    },
  ]);
  const result = await verifyOperationalLabels(
    "org/repo",
    1,
    ["needs-human", "planning"],
    [],
    () => Promise.resolve(timeline),
    "vibe-bot",
  );

  assertEquals(result.trustedLabels, ["needs-human"]);
  assertEquals(
    result.untrustedLabels.map((entry) => entry.label),
    ["planning"],
    "another reserved label the worker applied is still stripped; " +
      "needs-human is not",
  );
});

Deno.test("reserved labels - every canonical label is reserved in the code (Issue #780)", () => {
  // The prompts must not name a label the code does not actually reserve.
  // Three sets withhold a label from the worker, for three reasons: the
  // guard refuses to apply it, the trust check strips it from an existing
  // issue, and the creation filter keeps it off an issue the worker files.
  // A label the prompts publish must appear in at least one of them.
  const withheld = new Set(
    [
      ...WORKER_FORBIDDEN_LABEL_LITERALS,
      ...OPERATIONAL_LABEL_NAMES,
      ...RESERVED_LABELS,
    ].map((label) => label.toLowerCase()),
  );
  for (const label of CANONICAL_RESERVED) {
    assert(
      withheld.has(label),
      `\`${label}\` is published as reserved but the code withholds it ` +
        `nowhere — the prompts would be inventing a rule`,
    );
  }
  // And `needs-human` stays in the issue-creation filter, which is why a
  // filed follow-up still cannot carry it even though the trust check honours
  // it on an issue that already exists.
  assert(
    RESERVED_LABELS.map((label) => label.toLowerCase()).includes("needs-human"),
  );
});
