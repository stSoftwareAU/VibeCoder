/**
 * Tests for documentation_audit prompt v4 (Issue #3606).
 *
 * v4 adopts the docs-guard organising principle the nine v3 checks never
 * stated: **documentation is a set of claims about a codebase, and every
 * claim is checkable.** Where v3's checks are drift-shaped — they find
 * docs that disagree with other docs — v4 adds three claim-verification
 * checks that test a doc's claims against the source:
 *
 *   - **check 10** — a referenced symbol (function, CLI flag, endpoint,
 *     config key, env var, label, file path) that does not exist in the
 *     source (high severity; findings collapse per document);
 *   - **check 11** — a fenced code sample presented as runnable that
 *     cannot run: a removed flag, an unresolvable path, a hardcoded
 *     machine-local path, unstated prior state (high severity);
 *   - **check 12** — an unverifiable claim: a performance number,
 *     compatibility matrix, scale limit or timeout default with no
 *     source in the repository (medium severity).
 *
 * v4 also extends **check 4** (duplicate / redundant content) to cover
 * prose that paraphrases an external tool's documentation instead of
 * linking to it.
 *
 * The load-bearing worker contracts are unchanged: the `Documentation
 * Audit` H1 body fingerprint, the `{{SUPPRESSED_IDS}}` /
 * `{{KNOWN_OPEN_FINDING_IDS}}` / `{{ATTRIBUTION_FOOTER}}` placeholders,
 * the `BP-<12 hex>` id recipe with the `"documentation-audit"`
 * discriminator, the `documentation-audit` / `severity:*` labels, the
 * `BP- in:body` dedup search, the hidden `<!-- finding-id:` marker, and
 * the 6-issue cap.
 *
 * Also guards immutability of v3 (Issue #235 — prompt versions are
 * immutable once shipped): v3 must NOT carry the v4 content.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { DOCUMENTATION_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/documentation_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/**
 * Match a phrase across the prompt's hard wrapping — every run of
 * whitespace in `phrase` matches a line break just as happily as a space.
 */
function mentions(body: string, phrase: string): boolean {
  const pattern = phrase
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(pattern, "i").test(body);
}

async function loadV4(): Promise<string> {
  const result = await loadPrompt("documentation_audit", "v4", PROMPTS_DIR);
  assert(result.ok, "documentation_audit v4 must load");
  return result.ok ? result.value : "";
}

Deno.test("documentation_audit prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("documentation_audit", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test(
  "documentation_audit prompt v4 - latest version is v4 or later",
  async () => {
    const result = await getLatestVersion("documentation_audit", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected documentation_audit prompt >= v4, got ${result.value}`,
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - satisfies the placeholder contract",
  async () => {
    const v = validatePromptTemplate("documentation_audit", await loadV4());
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "documentation_audit prompt v4 - keeps the Documentation Audit H1 body fingerprint",
  async () => {
    // Dispatch routes wrapper issues by matching the prompt's H1 against
    // DOCUMENTATION_AUDIT_BODY_FINGERPRINT — the heading must stay intact.
    assert(
      DOCUMENTATION_AUDIT_BODY_FINGERPRINT.test(await loadV4()),
      "v4 must keep the 'Documentation Audit' H1 fingerprint",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - keeps the three worker placeholders",
  async () => {
    const body = await loadV4();
    for (
      const placeholder of [
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{ATTRIBUTION_FOOTER}}",
      ]
    ) {
      assert(
        body.includes(placeholder),
        `v4 must keep the ${placeholder} placeholder`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v4 - states the claims-are-checkable principle",
  async () => {
    const body = await loadV4();
    assert(
      /set of claims about (the|a) codebase/i.test(body),
      "v4 must state that documentation is a set of claims about the codebase",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 10 verifies referenced symbols exist",
  async () => {
    const body = await loadV4();
    assert(
      /###\s*10\.\s*.*(symbol|reference)/i.test(body),
      "v4 must add check 10 for referenced symbols that do not exist",
    );
    // The reference surface the sweep must cover.
    for (
      const phrase of [
        "CLI command",
        "flag",
        "endpoint",
        "config key",
        "environment variable",
        "file path",
      ]
    ) {
      assert(mentions(body, phrase), `check 10 must name '${phrase}'`);
    }
    // Verification is by reading the source, never by recall.
    assert(
      /by reading it, not (by )?recalling it/i.test(body),
      "check 10 must require reading the source rather than recalling it",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 10 collapses per document",
  async () => {
    const body = await loadV4();
    // Three verification checks over a large docs tree would otherwise
    // consume the whole six-issue cap one dead symbol at a time.
    assert(
      mentions(body, "one finding per document"),
      "check 10 must collapse a cluster of dead references into one " +
        "finding per document",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 11 verifies runnable code samples",
  async () => {
    const body = await loadV4();
    assert(
      /###\s*11\.\s*.*(code sample|code block)/i.test(body),
      "v4 must add check 11 for code samples that do not run",
    );
    for (
      const phrase of [
        "fenced", // the sample surface
        "hardcoded", // machine-local path smell
        "credential", // real secrets in a sample
        "prior state", // unstated setup the sample depends on
      ]
    ) {
      assert(mentions(body, phrase), `check 11 must mention '${phrase}'`);
    }
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 11 verifies statically, never by execution",
  async () => {
    const body = await loadV4();
    // Hard constraint 2 forbids executing repo logic, so a sample is
    // verified by reading the flag's definition — not by running it.
    assert(
      /never (by )?run(ning)? (the|a) (sample|command)/i.test(body),
      "check 11 must forbid running the sample to verify it",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 12 flags unverifiable claims",
  async () => {
    const body = await loadV4();
    assert(
      /###\s*12\.\s*.*(unverifiable|claim)/i.test(body),
      "v4 must add check 12 for unverifiable claims",
    );
    for (
      const phrase of [
        "performance number",
        "compatibility matrix",
        "scale limit",
        "timeout default",
        "production-ready",
        "benchmark",
      ]
    ) {
      assert(mentions(body, phrase), `check 12 must mention '${phrase}'`);
    }
    // The finding must say what evidence would settle the claim.
    assert(
      mentions(body, "what would have to exist"),
      "check 12 must require stating what would back the claim",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - check 4 covers paraphrased upstream docs",
  async () => {
    const body = await loadV4();
    const checkFour = body.slice(
      body.indexOf("### 4."),
      body.indexOf("### 5."),
    );
    assert(checkFour.length > 0, "v4 must retain check 4");
    for (
      const phrase of [
        "upstream",
        "link",
      ]
    ) {
      assert(
        mentions(checkFour, phrase),
        `check 4 must extend to paraphrased upstream docs ('${phrase}')`,
      );
    }
    assert(
      mentions(checkFour, "link, do not restate"),
      "check 4 must carry the link-do-not-restate convention",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - counts twelve checks throughout",
  async () => {
    const body = await loadV4();
    assert(
      body.includes("twelve-check"),
      "v4 must describe the catalogue as the twelve-check catalogue",
    );
    assert(
      !body.includes("nine-check"),
      "v4 must not still describe a nine-check catalogue",
    );
  },
);

Deno.test(
  "documentation_audit prompt v4 - retains the load-bearing worker contracts",
  async () => {
    const body = await loadV4();
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe shape
        '"documentation-audit"', // id discriminator
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label documentation-audit", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "severity:high|severity:medium|severity:low",
        "6 findings", // hard cap
      ]
    ) {
      assert(
        body.includes(contract),
        `v4 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "documentation_audit prompt v3 - immutable: does NOT carry the v4 checks (Issue #235)",
  async () => {
    const result = await loadPrompt("documentation_audit", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const phrase of [
        "twelve-check",
        "set of claims about the codebase",
        "### 10.",
        "### 11.",
        "### 12.",
      ]
    ) {
      assert(
        !result.value.includes(phrase),
        `v3 must remain the pre-v4 prompt (found '${phrase}')`,
      );
    }
  },
);
