/**
 * Tests for best_practices prompt v7 (Issue 3552).
 *
 * v7 relaxes the blanket "no code execution" constraint by exactly one
 * step: a bucket guide may nominate a **read-only language analyser**
 * (for the `rust` bucket, `cargo clippy` / `cargo check`) that the scan
 * MAY run to corroborate a candidate when the checkout builds offline.
 * Repo logic (`cargo run`, `npm test`, `bash`, …) stays forbidden, every
 * finding still needs its own file/line citation, and a failed analyser
 * run must fall back to static evidence rather than read as "clean".
 *
 * Everything else is carried over from v6 unchanged: the H1 body
 * fingerprint, the four placeholders, the `BP-<12 hex>` id recipe, the
 * label set, the dedup search, and the 6-issue cap.
 *
 * Also guards immutability of v6 (Issue 235 — prompt versions are
 * immutable once shipped): v6 must NOT carry the v7 analyser carve-out.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { BEST_PRACTICES_BODY_FINGERPRINT } from "../lib/idle_task_templates/best_practices_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadV7(): Promise<string> {
  const result = await loadPrompt("best_practices", "v7", PROMPTS_DIR);
  assert(result.ok, "best_practices v7 must load");
  return result.ok ? result.value : "";
}

Deno.test("best_practices prompt v7 - loads via loadPrompt", async () => {
  const result = await loadPrompt("best_practices", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("best_practices prompt v7 - latest version is v7 or later", async () => {
  const result = await getLatestVersion("best_practices", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 7,
      true,
      `Expected best_practices prompt >= v7, got ${result.value}`,
    );
  }
});

Deno.test(
  "best_practices prompt v7 - satisfies the placeholder contract",
  async () => {
    const v = validatePromptTemplate("best_practices", await loadV7());
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "best_practices prompt v7 - keeps the Best-Practices Review H1 body fingerprint",
  async () => {
    assert(
      BEST_PRACTICES_BODY_FINGERPRINT.test(await loadV7()),
      "v7 must keep the 'Best-Practices Review' H1 fingerprint",
    );
  },
);

Deno.test(
  "best_practices prompt v7 - retains the load-bearing worker contracts",
  async () => {
    const body = await loadV7();
    for (
      const contract of [
        "{{BUCKET}}",
        "{{SUPPRESSED_IDS}}",
        "{{KNOWN_OPEN_FINDING_IDS}}",
        "{{ATTRIBUTION_FOOTER}}",
        "BP-<12 hex>",
        "<!-- finding-id:",
        "BP- in:body",
        "--label best-practices",
        "best-practice-ignore",
        "lang:{{BUCKET}}",
        "severity:high|severity:medium|severity:low",
      ]
    ) {
      assert(
        body.includes(contract),
        `v7 must retain the contract string '${contract}'`,
      );
    }
  },
);

Deno.test(
  "best_practices prompt v7 - permits a bucket-nominated read-only analyser",
  async () => {
    const body = await loadV7();
    assert(
      body.includes("cargo clippy") && body.includes("cargo check"),
      "v7 must name the read-only Rust analysers a bucket guide may nominate",
    );
    // The relaxation is bounded: repo logic stays forbidden.
    assert(
      body.includes("cargo run") && body.includes("npm test"),
      "v7 must keep repo-logic execution forbidden",
    );
  },
);

Deno.test(
  "best_practices prompt v7 - a failed analyser run is not a clean result",
  async () => {
    const body = await loadV7().then((s) => s.toLowerCase());
    assert(
      body.includes("fall back"),
      "v7 must state the static-evidence fallback when the analyser cannot run",
    );
    assert(
      /never.{0,120}clean/is.test(body),
      "v7 must forbid reporting a failed analyser run as a clean result",
    );
  },
);

Deno.test(
  "best_practices prompt v6 - immutable: does NOT carry the v7 analyser carve-out (Issue 235)",
  async () => {
    const result = await loadPrompt("best_practices", "v6", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      !result.value.includes("cargo clippy"),
      "v6 must remain the pre-relaxation prompt",
    );
  },
);
