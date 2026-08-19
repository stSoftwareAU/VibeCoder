/**
 * Tests for Issue #4113 — the operator documentation must describe Quorum mode
 * and the multi-provider container image.
 *
 * The assertions are tied back to the code that owns each fact rather than to
 * hand-written prose: the label and timeouts come from `config_defaults.ts`,
 * the outcomes and degradations from `quorum_orchestrator.ts` (exhaustively,
 * via `Record<Union, …>` maps the type checker forces to be complete), the
 * comment headings from `quorum_processor.ts`, the provider set from
 * `container/tools.json`, and the per-vendor credential layout from the
 * `agent_provider.ts` descriptors. A change that adds an outcome, a
 * degradation, a config key or a provider therefore fails the documentation
 * tests too.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  defaultQuorumJudge,
  defaultQuorumPlanners,
  LABEL_DEFAULTS,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";
import {
  QUORUM_DEGRADED_MARKER,
  QUORUM_WINNER_MARKER,
} from "../lib/quorum_processor.ts";
import {
  QUORUM_DRAFT_PHASE,
  QUORUM_JUDGE_PHASE,
  type QuorumDegradationKind,
  type QuorumOutcome,
} from "../lib/quorum_orchestrator.ts";
import {
  type AgentProviderDescriptor,
  agentProviderIds,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";

// tests/ → worker/deno/ → worker/ → repo root
function read(relative: string): string {
  return Deno.readTextFileSync(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

const QUORUM_DOC = read("docs/QUORUM.md");
const CONTAINER_DOC = read("docs/CONTAINER.md");
const CONFIGURATION_DOC = read("docs/CONFIGURATION.md");
const PROMPTS_DOC = read("docs/PROMPTS.md");
const DEPLOYMENT_DOC = read("docs/DEPLOYMENT.md");
const OVERVIEW_DOC = read("docs/OVERVIEW.md");
const README_DOC = read("README.md");

const MANIFEST: ContainerManifest = parseContainerManifest(
  read("container/tools.json"),
);

const PROVIDERS: AgentProviderDescriptor[] = agentProviderIds().map((id) =>
  resolveAgentProvider(id)
);

/** Assert `doc` mentions `needle`, naming the document in the failure. */
function assertMentions(doc: string, name: string, needle: string): void {
  assert(
    doc.includes(needle),
    `${name} must document "${needle}"`,
  );
}

/**
 * Assert `doc` states `value`, ignoring the whitespace a Markdown author may
 * put inside a JSON array — `["claude","claude"]` and `["claude", "claude"]`
 * are the same default.
 */
function assertStatesValue(doc: string, name: string, value: string): void {
  const pattern = new RegExp(
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(",", ",\\s*"),
  );
  assert(
    pattern.test(doc),
    `${name} must state the default ${value}`,
  );
}

// ---------------------------------------------------------------------------
// docs/QUORUM.md — trigger, sequence, output and degradation paths
// ---------------------------------------------------------------------------

Deno.test("docs/QUORUM.md - names the trigger label and the hand-back label", () => {
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", LABEL_DEFAULTS.quorumLabel);
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", LABEL_DEFAULTS.needsHumanLabel);
  // The human — not the worker — picks what happens after a Quorum run.
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", LABEL_DEFAULTS.planningLabel);
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", LABEL_DEFAULTS.workOnLabel);
});

Deno.test("docs/QUORUM.md - documents both Quorum prompt phases", () => {
  assertMentions(
    QUORUM_DOC,
    "docs/QUORUM.md",
    `prompts/${QUORUM_DRAFT_PHASE}/`,
  );
  assertMentions(
    QUORUM_DOC,
    "docs/QUORUM.md",
    `prompts/${QUORUM_JUDGE_PHASE}/`,
  );
});

Deno.test("docs/QUORUM.md - documents every run outcome", () => {
  // The type checker forces this map to list every QuorumOutcome, so a new
  // outcome cannot be added without a documentation row.
  const outcomes: Record<QuorumOutcome, true> = {
    "judged": true,
    "unjudged-single": true,
    "unjudged-both": true,
    "failed": true,
  };
  for (const outcome of Object.keys(outcomes)) {
    assertMentions(QUORUM_DOC, "docs/QUORUM.md", `\`${outcome}\``);
  }
});

Deno.test("docs/QUORUM.md - documents every degradation path", () => {
  const kinds: Record<QuorumDegradationKind, true> = {
    "drafter-failed": true,
    "both-drafters-failed": true,
    "judge-failed": true,
    "judge-verdict-unreadable": true,
  };
  for (const kind of Object.keys(kinds)) {
    assertMentions(QUORUM_DOC, "docs/QUORUM.md", `\`${kind}\``);
  }
});

Deno.test("docs/QUORUM.md - documents both result comment headings", () => {
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", QUORUM_WINNER_MARKER);
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", QUORUM_DEGRADED_MARKER);
});

Deno.test("docs/QUORUM.md - documents the judging anonymity property", () => {
  assert(
    /Plan A/.test(QUORUM_DOC) && /Plan B/.test(QUORUM_DOC),
    "docs/QUORUM.md must name the anonymised positions the judge sees",
  );
  assert(
    /never (?:sees|learns|told)[^.]*\b(?:vendor|provider)\b/i.test(QUORUM_DOC),
    "docs/QUORUM.md must state that the judge never sees a vendor identity",
  );
});

Deno.test("docs/QUORUM.md - states the per-run cost", () => {
  assert(
    /three agent invocations/i.test(QUORUM_DOC),
    "docs/QUORUM.md must state that one Quorum run spends roughly three agent invocations",
  );
});

Deno.test("docs/QUORUM.md - cross-references rather than restates the neighbouring docs", () => {
  for (const link of ["CONTAINMENT.md", "CONTAINER.md", "CONFIGURATION.md"]) {
    assertMentions(QUORUM_DOC, "docs/QUORUM.md", link);
  }
  // Issue #4070 owns the sandboxed-environment guidance; link it, do not copy it.
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", "#4070");
});

// ---------------------------------------------------------------------------
// Configuration keys and their defaults
// ---------------------------------------------------------------------------

/** Every Quorum / provider config key with the default the worker applies. */
function configuredDefaults(): Array<[string, string]> {
  return [
    ["quorum_label", LABEL_DEFAULTS.quorumLabel],
    ["quorum_timeout", String(OPERATIONAL_DEFAULTS.quorumTimeout)],
    ["quorum_kill_after", String(OPERATIONAL_DEFAULTS.quorumKillAfter)],
    ["quorum_planners", JSON.stringify(defaultQuorumPlanners())],
    ["quorum_judge", JSON.stringify(defaultQuorumJudge())],
  ];
}

Deno.test("docs/CONFIGURATION.md - lists every Quorum key with its default", () => {
  for (const [key, value] of configuredDefaults()) {
    assertMentions(CONFIGURATION_DOC, "docs/CONFIGURATION.md", `\`${key}\``);
    assertStatesValue(
      CONFIGURATION_DOC,
      `docs/CONFIGURATION.md (${key})`,
      value,
    );
  }
});

Deno.test("docs/CONFIGURATION.md - documents the enabled provider set key", () => {
  assertMentions(
    CONFIGURATION_DOC,
    "docs/CONFIGURATION.md",
    "`agent_provider`",
  );
  assertMentions(
    CONFIGURATION_DOC,
    "docs/CONFIGURATION.md",
    "`agent_providers`",
  );
});

Deno.test("docs/QUORUM.md - lists every Quorum key with its default", () => {
  for (const [key, value] of configuredDefaults()) {
    assertMentions(QUORUM_DOC, "docs/QUORUM.md", `\`${key}\``);
    assertStatesValue(QUORUM_DOC, `docs/QUORUM.md (${key})`, value);
  }
});

// ---------------------------------------------------------------------------
// The multi-provider container image
// ---------------------------------------------------------------------------

Deno.test("docs/CONTAINER.md - describes the provider set build argument and every pinned fragment", () => {
  assertMentions(CONTAINER_DOC, "docs/CONTAINER.md", "AGENT_PROVIDERS");
  assertMentions(CONTAINER_DOC, "docs/CONTAINER.md", "container/tools.json");
  for (const provider of MANIFEST.providers) {
    assertMentions(CONTAINER_DOC, "docs/CONTAINER.md", `\`${provider.id}\``);
    assertMentions(
      CONTAINER_DOC,
      "docs/CONTAINER.md",
      `container/${provider.fragment}`,
    );
  }
});

Deno.test("docs/CONTAINER.md - documents how to add a further provider", () => {
  assert(
    /^#+ .*adding a (?:fourth|further|new) provider/im.test(CONTAINER_DOC),
    "docs/CONTAINER.md must carry a section on adding a further provider",
  );
});

// ---------------------------------------------------------------------------
// Per-vendor credential layout
// ---------------------------------------------------------------------------

Deno.test("docs/DEPLOYMENT.md - documents each vendor's credential file and provisioning variable", () => {
  assert(PROVIDERS.length > 0, "at least one provider must be registered");
  for (const provider of PROVIDERS) {
    assertMentions(
      DEPLOYMENT_DOC,
      "docs/DEPLOYMENT.md",
      provider.credentials.provisionEnvVar,
    );
    assertMentions(
      DEPLOYMENT_DOC,
      "docs/DEPLOYMENT.md",
      `${provider.credentials.subdir}/provider.env`,
    );
  }
});

Deno.test("docs/QUORUM.md - documents the no-credential-sharing rule and links the layout", () => {
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", "provider.env");
  assertMentions(QUORUM_DOC, "docs/QUORUM.md", "DEPLOYMENT.md");
  assert(
    /no vendor'?s? credential[^.]*another/i.test(QUORUM_DOC),
    "docs/QUORUM.md must state that no vendor's credential reaches another vendor's subprocess",
  );
});

// ---------------------------------------------------------------------------
// Quorum listed alongside the existing phases
// ---------------------------------------------------------------------------

Deno.test("README.md - lists Quorum and links the manual", () => {
  assertMentions(README_DOC, "README.md", "docs/QUORUM.md");
  assertMentions(README_DOC, "README.md", `\`${LABEL_DEFAULTS.quorumLabel}\``);
});

Deno.test("docs/OVERVIEW.md - lists Quorum among the workflow modes", () => {
  assertMentions(OVERVIEW_DOC, "docs/OVERVIEW.md", "QUORUM.md");
  assertMentions(
    OVERVIEW_DOC,
    "docs/OVERVIEW.md",
    `\`${LABEL_DEFAULTS.quorumLabel}\``,
  );
});

Deno.test("docs/PROMPTS.md - lists both Quorum prompts and links the manual", () => {
  assertMentions(
    PROMPTS_DOC,
    "docs/PROMPTS.md",
    `prompts/${QUORUM_DRAFT_PHASE}/`,
  );
  assertMentions(
    PROMPTS_DOC,
    "docs/PROMPTS.md",
    `prompts/${QUORUM_JUDGE_PHASE}/`,
  );
  assertMentions(PROMPTS_DOC, "docs/PROMPTS.md", "QUORUM.md");
});

// ---------------------------------------------------------------------------
// The documented provider trio matches the registry
// ---------------------------------------------------------------------------

Deno.test("docs/QUORUM.md - the documented default trio is the one the worker uses", () => {
  const planners = defaultQuorumPlanners();
  assertEquals(planners.length, 2, "a Quorum run drafts exactly two plans");
  for (const id of [...planners, defaultQuorumJudge()]) {
    assertMentions(QUORUM_DOC, "docs/QUORUM.md", `\`${id}\``);
  }
});
