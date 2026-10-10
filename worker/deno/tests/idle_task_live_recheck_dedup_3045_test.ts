/**
 * Regression test for Issue #3045.
 *
 * Every idle-task prompt's Phase 4 "for each surviving finding" step used to
 * re-check dedup against the live `gh issue list ... --json number,body`
 * output and skip a finding whenever some *other* open issue's body carried
 * its `<!-- finding-id: … -->` marker. That body is attacker-writable by
 * anyone who can open an issue on the repo — the author of that issue is
 * not. Dedup must instead rely solely on `{{KNOWN_OPEN_FINDING_IDS}}`, which
 * the worker builds code-side from open issues the fleet account itself
 * authored, so a marker planted by someone else can never suppress a real
 * finding.
 *
 * This test asserts, for every idle-task prompt, that the dedup step no
 * longer performs that live, unfiltered `gh issue list` re-check and instead
 * states that the known-open list is the only *finding-id* dedup source —
 * deliberately scoped to the marker check, since the separate
 * open-issue-titles (Issue #537) semantic check still applies regardless of
 * who filed that issue.
 */

import { assert } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const PROMPT_NAMES = [
  "best_practices",
  "dead_code",
  "deprecated_api",
  "doc_coverage",
  "documentation_audit",
  "duplicated_knowledge",
  "format_drift",
  "github_actions_audit",
  "orphan_deps",
  "private_repo_reference_audit",
  "security_scan",
  "supply_chain_detection",
  "supply_chain_readiness",
  "test_audit",
];

/**
 * Collapse every run of whitespace to a single space, so an assertion about
 * a sentence does not depend on where the Markdown source happens to wrap
 * it.
 */
const flatten = (text: string) => text.replace(/\s+/g, " ");

/**
 * The heading under which each prompt's Phase 4 per-finding step states the
 * dedup rule. `best_practices` words its Phase 4 differently from the other
 * thirteen.
 */
const DEDUP_RULE_HEADING = (name: string): string =>
  name === "best_practices"
    ? "## Phase 4 — File one issue per finding (outcome-only)"
    : "### For each surviving finding (skip silently if its id is in the suppressed or known-open list)";

Deno.test(
  "idle-task prompts dedup only on the fleet-filtered known-open list (Issue #3045)",
  async () => {
    for (const name of PROMPT_NAMES) {
      const result = await loadPrompt(name, PROMPTS_DIR);
      assert(result.ok, `${name} failed to load`);
      if (!result.ok) {
        continue;
      }
      const text = flatten(result.value);

      assert(
        !/--json number,body(?!,author)/.test(text),
        `${name} must not look up issue bodies without filtering by author`,
      );
      assert(
        !text.includes("Re-check the live open-issue list"),
        `${name} must not re-check the live open-issue list for dedup`,
      );
      const rule = flat(section(
        await readRepoDoc(`prompts/${name}/prompt.md`),
        DEDUP_RULE_HEADING(name),
      ));
      assert(
        rule.includes("the only finding-id dedup source"),
        `${name} must state that the known-open list is the only ` +
          `finding-id dedup source (scoped to the marker check, not the ` +
          `separate open-issue-titles check)`,
      );
    }
  },
);
