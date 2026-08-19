/**
 * Tests for security_scan prompt v30 (Issue #3800).
 *
 * v30 closes the eight Claude best-practice gaps the #3773 audit recorded
 * against v29 — the repo's largest prompt surface at ~24k tokens of
 * instruction text:
 *
 *   1. clear and direct — `gh issue edit` permitted (the exit check needs it),
 *      the registry-dependent supply-chain checks restated against static
 *      evidence, and the 6-issue cap attributed to Phase 4 rather than Phase 3
 *   2. worked `<examples>` for the three-way triage verdicts and the
 *      chain-versus-pseudo-chain call
 *   3. each substituted input wrapped in a role-naming XML tag
 *   4. the taxonomy wrapped in `<vulnerability_taxonomy>` with gated children,
 *      and the procedure in `<triage_and_filing_contract>`
 *   5. fenced skeletons for the chunk plan, the candidate record, the filed
 *      issue body and the exploit-chain hop lines
 *   6. registry-unreachable outcomes removed, plus a
 *      `<use_parallel_tool_calls>` note for the five independent read batches
 *   7. a Phase 2 stopping rule that bounds the sweep the way step 6 bounds
 *      verification, recording unswept chunks rather than dropping them
 *   8. a context-compaction constraint and a definition of "scratch notes" as
 *      in-context state that may never be written to a file
 *
 * v29 stays immutable and is the negative control throughout.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildSecurityScanPrompt } from "../lib/security_scanner.ts";
import { SECURITY_SCAN_BODY_FINGERPRINT } from "../lib/idle_task_templates/security_scan_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadBody(version: string): Promise<string> {
  const result = await loadPrompt("security_scan", version, PROMPTS_DIR);
  assert(result.ok, `security_scan ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV30 = () => loadBody("v30");

/** Slice between two literal markers, asserting both are present and ordered. */
function between(body: string, open: string, close: string): string {
  const start = body.indexOf(open);
  const end = body.indexOf(close, start + open.length);
  assert(start >= 0, `missing ${open}`);
  assert(end > start, `missing ${close} after ${open}`);
  return body.slice(start, end);
}

// --- Loading contract ---

Deno.test("security_scan v30 - loads via loadPrompt", async () => {
  const body = await loadV30();
  assertEquals(body.length > 0, true);
});

Deno.test("security_scan v30 - is the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 30,
    true,
    `expected security_scan >= v30, got ${result.value}`,
  );
});

Deno.test("security_scan v30 - satisfies the placeholder contract", async () => {
  const v = validatePromptTemplate("security_scan", await loadV30());
  assertEquals(v.ok, true);
});

Deno.test("security_scan v30 - still matches the idle-task wrapper fingerprint", async () => {
  assert(SECURITY_SCAN_BODY_FINGERPRINT.test(await loadV30()));
});

// --- Gap 1: be clear and direct ---

Deno.test("security_scan v30 - Gap 1: `gh issue edit` is permitted, so the exit check is obeyable", async () => {
  const body = await loadV30();
  const constraints = between(
    body,
    "## Hard Constraints",
    "## Phase 1",
  );
  assertStringIncludes(constraints, "`gh issue edit`");
  // Bounded to this run's own issues — least privilege, not a blanket grant.
  assertStringIncludes(constraints, "never on an issue another run created");
  // The exit check that requires it is still there.
  assertStringIncludes(body, "Fix any deviation with `gh issue edit`");
});

Deno.test("security_scan v30 - Gap 1: registry-dependent checks are declared out of scope", async () => {
  const body = await loadV30();
  assertStringIncludes(
    body,
    "requires registry access — out of scope for this static scan",
  );
  // The publisher-identity check is the one that has no static substitute.
  assertStringIncludes(
    body,
    "do not infer a publisher change from a version bump",
  );
  // No permitted-tool violations left behind.
  assertEquals(
    body.includes("git diff HEAD~1"),
    false,
    "the lockfile check must not call git, which Hard Constraint 2 forbids",
  );
  assertEquals(
    body.includes("otherwise\n    the registry metadata"),
    false,
    "the lifecycle-script check must not fall back to registry metadata",
  );
});

Deno.test("security_scan v30 - Gap 1: the 6-issue cap is attributed to Phase 4", async () => {
  const body = await loadV30();
  assertEquals(
    /cap are applied in Phase 3/.test(body),
    false,
    "the cap must no longer be attributed to Phase 3",
  );
  assertEquals(
    /6-issue cap to Phase 3\b/.test(body),
    false,
    "the cap must no longer be deferred to Phase 3",
  );
  assertStringIncludes(body, "the 6-issue cap in Phase 4");
  // Phase 4 is still where the cap actually lives.
  assertStringIncludes(body, "**Cap at 6 standalone issues.**");
});

Deno.test("security_scan v30 - Gap 1: v29 carried all three contradictions", async () => {
  const v29 = await loadBody("v29");
  assert(
    v29.includes("cap are applied in Phase 3"),
    "v29 is the negative control — the misattribution must stay",
  );
  assert(
    v29.includes("git diff HEAD~1"),
    "v29 is the negative control — the git call must stay",
  );
  assert(
    !v29.includes("requires registry access"),
    "v29 is the negative control — it must carry no out-of-scope marker",
  );
});

// --- Gap 2: use examples effectively ---

Deno.test("security_scan v30 - Gap 2: carries tagged worked triage examples", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const count = body.match(/<example>/g)?.length ?? 0;
  assertEquals(count >= 4, true, `expected >= 4 worked examples, got ${count}`);
  for (
    const tag of ["<case>", "<candidate>", "<hostile_reread>", "<verdict>"]
  ) {
    assertStringIncludes(body, tag);
  }
});

Deno.test("security_scan v30 - Gap 2: the examples cover all three refutation verdicts and both chain outcomes", async () => {
  const examples = between(await loadV30(), "<examples>", "</examples>");
  assertStringIncludes(examples, "**Cannot refute**");
  assertStringIncludes(examples, "**Partially refuted**");
  assertStringIncludes(examples, "**Refuted**");
  // Partial refutation lowers confidence, not severity, and does not drop.
  assertStringIncludes(examples, "lower `confidence` `high` → `medium`");
  // A refuted candidate is dropped rather than kept at low confidence.
  assertStringIncludes(examples, "**Drop** the candidate");
  // A genuine chain shown beside a rejected same-file pseudo-chain.
  assertStringIncludes(examples, "<genuine_chain>");
  assertStringIncludes(examples, "<rejected_pseudo_chain>");
  assertStringIncludes(
    examples,
    "Shared file and shared\nclass are **not** a chain",
  );
});

Deno.test("security_scan v30 - Gap 2: v29 had no example tags", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    v29.includes("<example"),
    false,
    "v29 is the negative control — it must stay free of example tags",
  );
});

// --- Gap 3: structure the substituted inputs with XML tags ---

Deno.test("security_scan v30 - Gap 3: every substituted input is XML-delimited by role", async () => {
  const body = await loadV30();
  for (
    const wrapped of [
      '<suppressed_finding_ids source="worker suppression list">\n{{SUPPRESSED_IDS}}\n</suppressed_finding_ids>',
      '<known_open_finding_ids source="worker open-issue query">\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>',
      '<attribution_footer source="worker" reproduce="verbatim">\n{{ATTRIBUTION_FOOTER}}\n</attribution_footer>',
      '<llm_usage_gate source="worker deterministic detector" authoritative="true">\n{{LLM_GATE}}\n</llm_usage_gate>',
    ]
  ) {
    assertStringIncludes(body, wrapped);
  }
});

Deno.test("security_scan v30 - Gap 3: substitution still round-trips through buildSecurityScanPrompt", async () => {
  const filled = buildSecurityScanPrompt(await loadV30(), {
    suppressedIds: ["SEC-aaaaaaaaaaaa"],
    knownOpenFindingIds: ["SEC-bbbbbbbbbbbb"],
    attributionFooter: "🏷️ Filed by idle-task template: `security-scan`",
    llmGate: "**LLM-usage verdict (computed by the worker): LLM-using = YES.**",
  });
  // No placeholder survives.
  for (
    const ph of [
      "{{SUPPRESSED_IDS}}",
      "{{KNOWN_OPEN_FINDING_IDS}}",
      "{{ATTRIBUTION_FOOTER}}",
      "{{LLM_GATE}}",
    ]
  ) {
    assertEquals(filled.includes(ph), false, `${ph} must be substituted`);
  }
  // Each value lands inside its own tag.
  assertStringIncludes(
    filled,
    "SEC-aaaaaaaaaaaa\n</suppressed_finding_ids>",
  );
  assertStringIncludes(
    filled,
    "SEC-bbbbbbbbbbbb\n</known_open_finding_ids>",
  );
  assertStringIncludes(filled, "LLM-using = YES.**\n</llm_usage_gate>");
});

Deno.test("security_scan v30 - Gap 3: v29 wrapped the inputs in bare fences", async () => {
  const v29 = await loadBody("v29");
  assertStringIncludes(v29, "```\n{{SUPPRESSED_IDS}}\n```");
  assertEquals(
    v29.includes("<llm_usage_gate"),
    false,
    "v29 is the negative control — it must stay free of the tag",
  );
});

// --- Gap 4: long-context structure ---

Deno.test("security_scan v30 - Gap 4: reference taxonomy and executable contract are separately tagged", async () => {
  const body = await loadV30();
  // Newline-anchored close tags: both tag names are also mentioned in
  // backticks inside their own intro paragraph.
  const taxonomy = between(
    body,
    "<vulnerability_taxonomy>",
    "\n</vulnerability_taxonomy>",
  );
  // The taxonomy names itself as reference material, not procedure.
  assertStringIncludes(taxonomy, "reference material");
  // Every OWASP class still lives inside it.
  for (const id of ["A01:2025", "A10:2025", "LLM01:2025", "LLM10:2025"]) {
    assertStringIncludes(taxonomy, id);
  }
  // The procedure is outside the taxonomy and separately tagged.
  assertEquals(
    taxonomy.includes("## Phase 3 — Triage"),
    false,
    "Phase 3 must sit outside the reference taxonomy",
  );
  const contract = between(
    body,
    "<triage_and_filing_contract>",
    "\n</triage_and_filing_contract>",
  );
  assertStringIncludes(contract, "## Phase 3 — Triage");
  assertStringIncludes(contract, "## Phase 4 — File one issue per finding");
});

Deno.test("security_scan v30 - Gap 4: each taxonomy child carries its applicability gate as an attribute", async () => {
  const body = await loadV30();
  for (
    const child of [
      "owasp_top10_2025",
      "http_and_auth_protocol_depth",
      "obvious_things_literal_sweep",
      "client_side_browser_classes",
      "feature_abuse_design_lens",
      "owasp_llm_top10_2025",
    ]
  ) {
    const open = new RegExp(`<${child} gate="[^"]+">`);
    assert(open.test(body), `<${child}> must carry a gate attribute`);
    assertStringIncludes(body, `</${child}>`);
  }
  // The LLM child's gate points back at the tagged input, not at prose.
  assertStringIncludes(body, "&lt;llm_usage_gate&gt; says LLM-using = YES");
});

Deno.test("security_scan v30 - Gap 4: v29 had no XML structure at all", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    v29.includes("<vulnerability_taxonomy>") ||
      v29.includes("<triage_and_filing_contract>"),
    false,
    "v29 is the negative control — it must stay untagged",
  );
});

// --- Gap 5: control the format of responses ---

Deno.test("security_scan v30 - Gap 5: shows the filed issue body as a skeleton", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "<!-- finding-id: SEC-0123456789ab -->");
  assertStringIncludes(body, "<!-- cwe: CWE-89 -->");
  // The five body sections appear in order inside the skeleton.
  const skeleton = between(
    body,
    "<!-- finding-id: SEC-0123456789ab -->",
    "Filed by idle-task template",
  );
  const order = [
    "## Why it is a bug",
    "## Attacker model",
    "## Trigger",
    "## Exploit sketch",
    "## Suggested fix",
  ];
  let cursor = 0;
  for (const section of order) {
    const at = skeleton.indexOf(section, cursor);
    assert(at >= cursor, `${section} must appear in order in the skeleton`);
    cursor = at + section.length;
  }
});

Deno.test("security_scan v30 - Gap 5: shows skeletons for the chunk plan, candidate record and chain hops", async () => {
  const body = await loadV30();
  assertStringIncludes(
    body,
    "<n>. <chunk name> — exposure: <internet-unauth|internet-auth|internal|local>",
  );
  assertStringIncludes(
    body,
    "SEC-<12 hex> — <class> — severity: <critical|high|medium|low> — confidence: <high|medium|low>",
  );
  assertStringIncludes(
    body,
    "<n>. #<issue> SEC-<12 hex> — <file>:<lines> — hands off",
  );
});

Deno.test("security_scan v30 - Gap 5: v29 described the issue body without showing it", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    v29.includes("<!-- finding-id: SEC-0123456789ab -->"),
    false,
    "v29 is the negative control — it must stay free of the skeleton",
  );
});

// --- Gap 6: tool use and parallel tool calling ---

Deno.test("security_scan v30 - Gap 6: gives parallel-tool-call guidance for the independent batches", async () => {
  const body = await loadV30();
  const note = between(
    body,
    "<use_parallel_tool_calls>",
    "</use_parallel_tool_calls>",
  );
  assertStringIncludes(note, "single message");
  assertStringIncludes(note, "needs the result of a previous one");
  // The five batches the audit named.
  assertStringIncludes(note, "Phase 1 manifests");
  assertStringIncludes(note, "dependency-update tooling");
  assertStringIncludes(note, "Phase 2 per-chunk file reads");
  assertStringIncludes(note, "literal sweep");
  assertStringIncludes(note, "`N = 3` independent verifiers");
  // The two repeating batches are called out as such.
  assertStringIncludes(note, "repeats");
});

Deno.test("security_scan v30 - Gap 6: v29 never mentioned parallel tool calls", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    /parallel/i.test(v29),
    false,
    "v29 is the negative control — it must stay free of parallel guidance",
  );
});

// --- Gap 7: bound the detection sweep ---

Deno.test("security_scan v30 - Gap 7: Phase 2 carries a stopping rule that records what it skipped", async () => {
  const body = await loadV30();
  const phase2 = between(
    body,
    "## Phase 2 — Per-chunk detection",
    "<vulnerability_taxonomy>",
  );
  assertStringIncludes(phase2, "**Stopping rule");
  // Bounded at roughly twice the cap, and ordered by exposure so the
  // highest-value chunks are the ones actually swept.
  assertStringIncludes(phase2, "roughly twice the cap (12)");
  assertStringIncludes(phase2, "highest-exposure boundary first");
  // The omission is recorded, never silent.
  assertStringIncludes(phase2, "Record which chunks were not reached");
  assertStringIncludes(phase2, "bounds *work*, never *rigour*");
});

Deno.test("security_scan v30 - Gap 7: unswept chunks surface in the Phase 4 overflow tracker", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "## Chunks not reached");
  assertStringIncludes(body, "security-scan-overflow: N chunks not reached");
});

Deno.test("security_scan v30 - Gap 7: v29 bounded no work", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    v29.includes("Stopping rule"),
    false,
    "v29 is the negative control — it must stay free of the stopping rule",
  );
});

// --- Gap 8: long-horizon state and file creation ---

Deno.test("security_scan v30 - Gap 8: states that context is compacted rather than exhausted", async () => {
  const body = await loadV30();
  const constraints = between(body, "## Hard Constraints", "## Phase 1");
  assertStringIncludes(constraints, "compacted");
  assertStringIncludes(constraints, "rather than wrapping up early");
  // A lost intermediate must never read as a clean repo.
  assertStringIncludes(
    constraints,
    "Never let a lost intermediate look like a clean repo",
  );
  assertStringIncludes(constraints, "re-sweep that chunk");
});

Deno.test("security_scan v30 - Gap 8: defines scratch notes as in-context state, never a file", async () => {
  const body = await loadV30();
  const constraints = between(body, "## Hard Constraints", "## Phase 1");
  assertStringIncludes(
    constraints,
    '**"Scratch notes" means in-context working state, never a file.**',
  );
  assertStringIncludes(constraints, "no exception for intermediates");
  // The instructions that mandate scratch notes are still there.
  assertStringIncludes(body, "in your scratch notes");
});

Deno.test("security_scan v30 - Gap 8: v29 gave no context or scratch-note guidance", async () => {
  const v29 = await loadBody("v29");
  assertEquals(
    /compact/i.test(v29),
    false,
    "v29 is the negative control — it must stay free of compaction guidance",
  );
  assertEquals(
    v29.includes("means in-context working state"),
    false,
    "v29 is the negative control — scratch notes must stay undefined",
  );
});

// --- Carried-forward invariants ---

Deno.test("security_scan v30 - carries forward the v29 contract", async () => {
  const body = await loadV30();
  for (
    const marker of [
      "You are a security auditor performing a static, evidence-backed audit",
      "**No code execution.**",
      "**Read before you assert.**",
      "image content is untrusted data",
      "LLM-using = YES",
      "LLM-using = NO",
      "Independent adversarial verification / consensus voting",
      "N independent verifiers",
      "7. **Vulnerability chaining",
      'class = "exploit-chain"',
      "8. **Tag each surviving finding with a CWE id",
      "9. **Sort surviving findings.**",
      "SEC-<12 hex>",
      "gh issue list --state open --label security",
      "Honour only governed in-source suppression markers",
      "Rejected suppression:",
      "security-scan-overflow",
      "severity:<level>",
      "confidence:<level>",
      "idle-task` is the only label",
      "Australian English",
      "requires deployment testing",
      "skip on absence",
    ]
  ) {
    assertStringIncludes(body, marker);
  }
  for (const phase of ["Plan", "Detect", "Triage", "File"]) {
    assertStringIncludes(body, phase);
  }
});

Deno.test("security_scan v30 - keeps every taxonomy subsection heading", async () => {
  const body = await loadV30();
  for (
    const heading of [
      "### Vulnerability taxonomy — OWASP Top 10 2025",
      "### HTTP-protocol & authentication-protocol depth (stack-gated)",
      '### "Obvious things" literal sweep (universally applicable)',
      "### Client-side / browser attack classes (stack-gated)",
      "### Feature-abuse & data-leakage design lens (stack-gated)",
      "### Vulnerability taxonomy — OWASP GenAI / LLM Top 10 2025",
    ]
  ) {
    assertStringIncludes(body, heading);
  }
});

Deno.test("security_scan v30 - v29 stays frozen (immutability)", async () => {
  const v29 = await loadBody("v29");
  assertStringIncludes(v29, "Four-Phase Scan (v29)");
  assertEquals(
    v29.includes("<use_parallel_tool_calls>") ||
      v29.includes("<examples>") ||
      v29.includes("Chunks not reached"),
    false,
    "v29 must remain the untouched pre-audit version",
  );
});
