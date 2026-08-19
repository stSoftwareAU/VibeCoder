/**
 * Tests for the governed in-source suppression instruction in the scan
 * prompts (Issue #3737).
 *
 * Issue #3712 hardened the deterministic path
 * (`worker/deno/lib/suppression_comments.ts`): a marker only suppresses
 * when it carries `author=<login>`, a well-formed `expires=<YYYY-MM-DD>`
 * that has not passed, and non-empty reason text. The LLM triage path —
 * the versioned scan prompts — still told Claude to drop any candidate
 * whose file carried a matching marker, with no mention of author,
 * expiry, or reason. An ungoverned marker was therefore refused by
 * `isSuppressed()` but still silenced the same finding when the LLM did
 * the triage.
 *
 * Prompt versions are immutable, so each affected family gained a new
 * `vN+1.md`. These tests assert the invariant that closes the gap and
 * keeps it closed: the latest version of every scan prompt family that
 * carries an in-source suppression instruction must state all three
 * governance requirements, must say an ungoverned marker is reported
 * rather than honoured, and must point at the shared module so the two
 * paths cannot drift again.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Scan prompt families carrying an in-source suppression instruction. */
interface Family {
  /** Prompt directory under `prompts/`. */
  type: string;
  /** Version added by Issue #3737. */
  version: number;
  /** Predecessor that must stay ungoverned (immutability guard). */
  previous: number;
}

const FAMILIES: readonly Family[] = [
  { type: "bash_syntax_audit", version: 3, previous: 2 },
  { type: "best_practices", version: 9, previous: 8 },
  { type: "dead_code", version: 4, previous: 3 },
  { type: "deprecated_api", version: 3, previous: 2 },
  { type: "doc_coverage", version: 5, previous: 4 },
  { type: "documentation_audit", version: 6, previous: 5 },
  { type: "duplicated_knowledge", version: 2, previous: 1 },
  { type: "format_drift", version: 4, previous: 3 },
  { type: "github_actions_audit", version: 15, previous: 14 },
  { type: "orphan_deps", version: 4, previous: 3 },
  { type: "private_repo_reference_audit", version: 2, previous: 1 },
  { type: "security_scan", version: 29, previous: 28 },
  { type: "supply_chain_detection", version: 3, previous: 2 },
  { type: "supply_chain_readiness", version: 6, previous: 5 },
  { type: "test_audit", version: 9, previous: 8 },
];

async function loadBody(type: string, version: string): Promise<string> {
  const result = await loadPrompt(type, version, PROMPTS_DIR);
  assert(result.ok, `${type}/${version} must load`);
  return result.ok ? result.value : "";
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

for (const family of FAMILIES) {
  const version = `v${family.version}`;

  Deno.test(
    `${family.type} ${version} - is the latest version and loads`,
    async () => {
      const latest = await getLatestVersion(family.type, PROMPTS_DIR);
      assert(latest.ok, `${family.type} must have a latest version`);
      if (latest.ok) {
        const num = parseInt(latest.value.replace("v", ""), 10);
        assertEquals(
          num >= family.version,
          true,
          `Expected ${family.type} >= ${version}, got ${latest.value}`,
        );
      }
      const body = await loadBody(family.type, version);
      assert(body.length > 0, `${family.type}/${version} must not be empty`);
    },
  );

  Deno.test(
    `${family.type} ${version} - keeps its predecessor's placeholder contract`,
    async () => {
      const body = await loadBody(family.type, version);
      const before = await loadBody(family.type, `v${family.previous}`);
      assertEquals(
        placeholders(body),
        placeholders(before),
        `${family.type}/${version} must substitute exactly what v${family.previous} did`,
      );

      // Families registered with the prompt manager must also satisfy its
      // declared required-placeholder set.
      const validation = validatePromptTemplate(family.type, body);
      if (
        !validation.ok &&
        !validation.error.message.startsWith("Unknown template type")
      ) {
        throw validation.error;
      }
    },
  );

  Deno.test(
    `${family.type} ${version} - requires author, expiry and reason before a marker suppresses`,
    async () => {
      const flat = flatten(await loadBody(family.type, version));

      assert(
        flat.includes("author=<github-login>"),
        `${family.type}/${version} must require the author= field`,
      );
      assert(
        flat.includes("expires=<YYYY-MM-DD>"),
        `${family.type}/${version} must require the expires= field`,
      );
      assert(
        /reason text/i.test(flat),
        `${family.type}/${version} must require non-empty reason text`,
      );
      assert(
        /calendar date/i.test(flat) && /today or later/i.test(flat),
        `${family.type}/${version} must reject a malformed or past expiry`,
      );
    },
  );

  Deno.test(
    `${family.type} ${version} - reports rather than silently honours an ungoverned marker`,
    async () => {
      const flat = flatten(await loadBody(family.type, version));

      assert(
        /does not suppress|never honoured/i.test(flat),
        `${family.type}/${version} must state that an ungoverned marker does not suppress`,
      );
      assert(
        flat.includes("Rejected suppression:"),
        `${family.type}/${version} must ask for a Rejected suppression report line`,
      );
    },
  );

  Deno.test(
    `${family.type} ${version} - anchors the wording to the deterministic path`,
    async () => {
      const body = await loadBody(family.type, version);
      const flat = flatten(body);
      assert(
        flat.includes("the deterministic suppression check applies"),
        `${family.type}/${version} must state that it applies the deterministic path's rule`,
      );
      // Issue #3509: these bodies are filed verbatim into other repos, so
      // the anchor must be described, never cited as a VibeCoder path.
      assertEquals(
        /worker\/deno\//.test(body),
        false,
        `${family.type}/${version} must not cite a VibeCoder-internal path`,
      );
    },
  );

  Deno.test(
    `${family.type} v${family.previous} - stays frozen without the governance rule`,
    async () => {
      const flat = flatten(await loadBody(family.type, `v${family.previous}`));
      assertEquals(
        flat.includes("expires=<YYYY-MM-DD>"),
        false,
        `v${family.previous} of ${family.type} is immutable and must not gain the rule`,
      );
    },
  );
}

Deno.test(
  "every scan prompt carrying an in-source suppression instruction is governed",
  async () => {
    // Drift guard: a family that teaches in-source suppression but whose
    // latest version omits the governance grammar would silently diverge
    // from isSuppressed() again. Enumerate the live prompts rather than
    // trusting the table above.
    const ungoverned: string[] = [];

    for await (const entry of Deno.readDir(PROMPTS_DIR)) {
      if (!entry.isDirectory) continue;
      const latest = await getLatestVersion(entry.name, PROMPTS_DIR);
      if (!latest.ok) continue;
      const loaded = await loadPrompt(entry.name, latest.value, PROMPTS_DIR);
      if (!loaded.ok) continue;
      const body = loaded.value;

      const teachesSuppression =
        /(best-practice-ignore|security-scan-ignore|orphan-deps-ignore|noqa):/
          .test(body);
      if (!teachesSuppression) continue;

      if (!body.includes("expires=<YYYY-MM-DD>")) {
        ungoverned.push(`${entry.name}/${latest.value}`);
      }
    }

    assertEquals(
      ungoverned,
      [],
      `these prompts honour ungoverned suppression markers: ${
        ungoverned.join(", ")
      }`,
    );
  },
);
