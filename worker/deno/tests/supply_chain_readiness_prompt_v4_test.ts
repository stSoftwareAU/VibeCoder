/**
 * Tests for supply_chain_readiness prompt v4 (Issue #3023, milestone
 * #3009 — OWASP Top 10 2025 alignment).
 *
 * v4 adds the `SCR-SEC-ALERTING` readiness check, tagged to OWASP
 * A09:2025 (Security Logging and Alerting Failures). It audits the
 * **alerting / monitoring readiness posture** — whether the repo has an
 * alerting path for security-relevant signals (advisory / Dependabot-alert
 * notifications, alerting on security-relevant CI failures, a documented
 * escalation path) — and explicitly cross-references `security-scan`'s
 * code-level A09 detection so the two do not duplicate.
 *
 * The load-bearing worker contracts are unchanged from v3: the H1
 * fingerprint, the two placeholders, the `BP-<12 hex>` id recipe with the
 * `"supply-chain-readiness"` discriminator, the `SCR-*` check prefixes,
 * the labels, the dedup search, the hidden marker, the suppression
 * grammar, and the 6-issue cap.
 *
 * Also guards immutability of v3 (Issue #235): v3 must NOT carry the new
 * check.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("supply_chain_readiness prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("supply_chain_readiness", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("supply_chain_readiness prompt v4 - latest version is v4 or later", async () => {
  const result = await getLatestVersion("supply_chain_readiness", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected supply_chain_readiness prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test(
  "supply_chain_readiness prompt v4 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v4",
      PROMPTS_DIR,
    );
    assert(result.ok);
    const v = validatePromptTemplate(
      "supply_chain_readiness",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "supply_chain_readiness prompt v4 - keeps the H1 body fingerprint",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v4",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      SUPPLY_CHAIN_READINESS_BODY_FINGERPRINT.test(result.value),
      "v4 must keep the 'Supply-chain readiness' H1 fingerprint",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v4 - retains the load-bearing worker contracts",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v4",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    for (
      const contract of [
        "BP-<12 hex>", // stable id recipe
        '"supply-chain-readiness"', // id discriminator
        "SCR-VULN-SCAN", // catalogue prefix
        "SCR-DEP-REVIEW",
        "SCR-IGNORE-SCRIPTS",
        "<!-- finding-id:", // hidden dedup marker
        "BP- in:body", // live dedup search
        "--label supply-chain-readiness", // dedup search scope
        "best-practice-ignore", // suppression grammar
        "suppression_comments.ts",
        "severity:high|severity:medium|severity:low",
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
  "supply_chain_readiness prompt v4 - adds the SCR-SEC-ALERTING A09 readiness check",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v4",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // The new check id, its OWASP tag, and an evidence anchor must all be
    // present so the catalogue row and the per-check evidence rule both land.
    assert(
      body.includes("SCR-SEC-ALERTING"),
      "v4 must add the SCR-SEC-ALERTING check id",
    );
    assert(
      body.includes("A09:2025"),
      "v4 must tag the new check to OWASP A09:2025",
    );
    assert(
      body.includes("Dependabot") && body.includes("escalation"),
      "v4 must cite concrete static alerting-path evidence",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v4 - cross-references security-scan's code-level A09 detection",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v4",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    // The check must defer the code-level logging half to security-scan
    // (#1) and not re-file it — the anti-duplication contract.
    assert(
      body.includes("code-level"),
      "v4 must distinguish the code-level A09 logging half it does not own",
    );
    assert(
      body.includes("security-scan"),
      "v4 must cross-reference the security-scan template (#1)",
    );
  },
);

Deno.test(
  "supply_chain_readiness prompt v3 - immutable: does NOT carry the SCR-SEC-ALERTING check (Issue #235)",
  async () => {
    const result = await loadPrompt(
      "supply_chain_readiness",
      "v3",
      PROMPTS_DIR,
    );
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("SCR-SEC-ALERTING"),
      "v3 must remain the pre-A09-readiness prompt",
    );
  },
);
