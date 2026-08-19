/**
 * Tests for doc_coverage prompt v3 (Issue #3607).
 *
 * v3 adopts docs-guard rule 7 ("no filler, no slop"): documentation is
 * measured by **content**, not presence.
 *
 *   - **`DOC-PARAPHRASE`** (new, severity low) — a module or
 *     exported-symbol doc comment whose content is derivable from the
 *     identifier and signature alone, with the guard rails that keep it
 *     quiet (public surface only, silent on any added contract, silent
 *     on trivial surface, clusters collapse to one finding);
 *   - **tightened `DOC-MODULE-DOC`** — a paraphrase block no longer
 *     counts as a passing doc comment, so the two checks agree on what
 *     "documented" means;
 *   - **precedence in triage** — at most one of the two fires per file,
 *     so a paraphrase is never double-filed.
 *
 * The load-bearing worker contracts are unchanged: the "Module-doc &
 * README coverage" H1 body fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders,
 * the `BP-<12 hex>` id shape with the `"doc-coverage"` discriminator,
 * the `doc-coverage` / `severity:*` labels, the `BP- in:body` dedup
 * search, the hidden `<!-- finding-id:` marker, and the 6-issue cap.
 *
 * Also guards immutability of v2 (Issue #235 — prompt versions are
 * immutable once shipped): v2 must NOT carry the v3 check.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { DOC_COVERAGE_BODY_FINGERPRINT } from "../lib/idle_task_templates/doc_coverage_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadV3(): Promise<string> {
  const result = await loadPrompt("doc_coverage", "v3", PROMPTS_DIR);
  assert(result.ok, "doc_coverage v3 must load");
  return result.ok ? result.value : "";
}

Deno.test("doc_coverage prompt v3 - loads via loadPrompt", async () => {
  const result = await loadPrompt("doc_coverage", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("doc_coverage prompt v3 - latest version is v3 or later", async () => {
  const result = await getLatestVersion("doc_coverage", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 3,
    true,
    `Expected doc_coverage prompt >= v3, got ${result.value}`,
  );
});

Deno.test(
  "doc_coverage prompt v3 - keeps the coverage H1 body fingerprint",
  async () => {
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // DOC_COVERAGE_BODY_FINGERPRINT — the heading must remain intact.
    assert(
      DOC_COVERAGE_BODY_FINGERPRINT.test(await loadV3()),
      "v3 must keep the 'Module-doc & README coverage' H1 fingerprint",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - carries every substituted placeholder",
  async () => {
    const body = await loadV3();
    for (
      const placeholder of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(
        body.includes(placeholder),
        `v3 must keep the ${placeholder} placeholder`,
      );
    }
  },
);

Deno.test(
  "doc_coverage prompt v3 - adds DOC-PARAPHRASE to the check catalogue",
  async () => {
    const body = await loadV3();
    // Catalogue row: id prefix, scope, low severity.
    assert(
      /\|\s*`DOC-PARAPHRASE`\s*\|[^|]*\|\s*low\s*\|/.test(body),
      "v3 must add a DOC-PARAPHRASE catalogue row at severity low",
    );
    // The definition the issue specifies — derivable from identifier and
    // signature, adds no contract.
    assert(
      /derivable from the identifier and signature alone/i.test(body),
      "DOC-PARAPHRASE must define a paraphrase as derivable from the " +
        "identifier and signature alone",
    );
    for (
      const phrase of [
        "names the symbol back",
        "restates the parameter list",
        "repeats the heading",
      ]
    ) {
      assert(body.includes(phrase), `DOC-PARAPHRASE must name '${phrase}'`);
    }
  },
);

Deno.test(
  "doc_coverage prompt v3 - DOC-PARAPHRASE cites the comment's line range",
  async () => {
    const body = await loadV3();
    assert(
      /line range/i.test(body),
      "DOC-PARAPHRASE evidence must require the comment's line range",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - DOC-PARAPHRASE carries its four guard rails",
  async () => {
    const body = await loadV3();
    // 1. public surface only — same gate as DOC-MODULE-DOC.
    assert(
      /Fires on \*\*public\*\* surface\s+only/i.test(body),
      "guard rail 1: DOC-PARAPHRASE must fire on public surface only",
    );
    // 2. silent when the comment adds any non-derivable contract.
    assert(
      /Silent on any added contract/i.test(body),
      "guard rail 2: DOC-PARAPHRASE must stay silent on any added contract",
    );
    for (
      const contract of [
        "units",
        "ranges",
        "error conditions",
        "side effects",
        "ordering",
      ]
    ) {
      assert(
        body.includes(contract),
        `guard rail 2 must name '${contract}' as a non-derivable contract`,
      );
    }
    // 3. silent on genuinely trivial surface.
    assert(
      /Silent on genuinely trivial surface/i.test(body),
      "guard rail 3: DOC-PARAPHRASE must stay silent on trivial surface",
    );
    // 4. a cluster in one package collapses to a single finding.
    assert(
      /Collapse clusters/i.test(body),
      "guard rail 4: a cluster of paraphrase docstrings must collapse to " +
        "one finding",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - tightens DOC-MODULE-DOC against paraphrase blocks",
  async () => {
    const body = await loadV3();
    // v2's loophole: "A file whose first non-blank, non-import line is
    // already a doc comment passes."
    assert(
      !/non-import line is already a doc\s+comment passes/i.test(body),
      "v3 must drop v2's presence-only DOC-MODULE-DOC pass rule",
    );
    assert(
      /adds a contract the\s+signature cannot express/i.test(body),
      "v3's DOC-MODULE-DOC must require a contract the signature cannot " +
        "express before a doc comment passes",
    );
    assert(
      /reported under\s+`DOC-PARAPHRASE` instead/i.test(body),
      "a paraphrase block must be redirected to DOC-PARAPHRASE",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - triage gives the two checks a precedence rule",
  async () => {
    const body = await loadV3();
    assert(
      /at\s+most one may fire per file/i.test(body),
      "triage must state that at most one of the two checks fires per file",
    );
    assert(
      /drop the\s+`DOC-MODULE-DOC` one/i.test(body),
      "triage must drop the DOC-MODULE-DOC candidate when both were drafted",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - severity guidance covers DOC-PARAPHRASE",
  async () => {
    const body = await loadV3();
    const lowGuidance = body.slice(body.indexOf("- **`severity:low`**"));
    assert(
      lowGuidance.slice(0, 400).includes("DOC-PARAPHRASE"),
      "severity guidance must place DOC-PARAPHRASE at severity low",
    );
    // Documentation gaps stay hygiene-level.
    assert(
      body.includes("There is **no `severity:high`**"),
      "v3 must keep the no-high/no-critical severity floor",
    );
  },
);

Deno.test(
  "doc_coverage prompt v3 - retains the load-bearing worker contracts",
  async () => {
    const body = await loadV3();
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe shape
        '"doc-coverage"', // id discriminator
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label doc-coverage", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "severity:medium` | `severity:low", // permitted severities
        "6 findings", // hard cap
      ]
    ) {
      assert(
        body.includes(contract),
        `v3 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "doc_coverage prompt v2 - immutable: does NOT carry the v3 check (Issue #235)",
  async () => {
    const result = await loadPrompt("doc_coverage", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const phrase of [
        "DOC-PARAPHRASE",
        "derivable from the identifier and signature alone",
      ]
    ) {
      assert(
        !result.value.includes(phrase),
        `v2 must remain the pre-v3 prompt (found '${phrase}')`,
      );
    }
  },
);
