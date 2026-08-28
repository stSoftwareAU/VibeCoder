/**
 * Tests for Issue #355 — the front-door documentation must show that the
 * coding agent is selectable, not fixed to Claude Code.
 *
 * An evaluator reads `README.md` (and, when installing, `docs/SETUP.md`)
 * before anything under `docs/`. The provider seam has existed since
 * Issue #4067, but was documented only in `docs/CONTAINER.md`, so the project
 * read as Claude-only.
 *
 * Every assertion is derived from `agent_provider.ts` — the registered ids and
 * the selection keys — rather than from hand-written prose, so registering a
 * fourth provider or renaming a key fails these tests until the front-door
 * documentation is updated with it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import {
  AGENT_PROVIDER_CONFIG_KEY,
  AGENT_PROVIDER_ENV,
  agentProviderIds,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  ENABLED_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

// tests/ → worker/deno/ → worker/ → repo root
function read(relative: string): string {
  return Deno.readTextFileSync(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

const README = read("README.md");
const SETUP_DOC = read("docs/SETUP.md");

/**
 * The body of the first section whose heading names the coding-agent choice.
 *
 * @param doc - Whole Markdown document.
 * @returns Heading plus body, up to the next heading of the same or higher
 *   level; the empty string when no such section exists.
 */
function agentProviderSection(doc: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => /^#{2,4} .*coding agent/i.test(line));
  if (start < 0) return "";
  const level = (lines[start] ?? "").replace(/[^#].*$/, "").length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+) /.exec(line);
    if (heading && (heading[1] ?? "").length <= level) break;
    body.push(line);
  }
  return [lines[start] ?? "", ...body].join("\n");
}

/** Assert `haystack` mentions `needle`, naming the document in the failure. */
function assertMentions(haystack: string, name: string, needle: string): void {
  assert(
    haystack.includes(needle),
    `${name} must document "${needle}"`,
  );
}

Deno.test("README.md - names every registered provider id and display name", () => {
  const section = agentProviderSection(README);
  const ids = agentProviderIds();
  assert(ids.length > 0, "at least one provider must be registered");
  for (const id of ids) {
    assertMentions(section, "README.md provider section", `\`${id}\``);
    assertMentions(
      section,
      "README.md provider section",
      resolveAgentProvider(id).displayName,
    );
  }
});

Deno.test("README.md - names both ways to select a provider", () => {
  const section = agentProviderSection(README);
  assertMentions(
    section,
    "README.md provider section",
    `\`${AGENT_PROVIDER_CONFIG_KEY}\``,
  );
  assertMentions(
    section,
    "README.md provider section",
    `\`${AGENT_PROVIDER_ENV}\``,
  );
});

Deno.test("README.md - the introduction does not present the worker as Claude-only", () => {
  // The opening paragraphs are what an evaluator reads first: they must name
  // the choice rather than a single vendor.
  const intro = README.split("\n").slice(0, 40).join("\n");
  for (const id of agentProviderIds()) {
    assertMentions(intro, "README.md introduction", id);
  }
});

Deno.test("docs/SETUP.md - documents provider selection in the config section", () => {
  const section = agentProviderSection(SETUP_DOC);
  assert(
    section !== "",
    "docs/SETUP.md must carry a section on choosing the coding agent",
  );
  for (const id of agentProviderIds()) {
    assertMentions(section, "docs/SETUP.md provider section", `\`${id}\``);
  }
  for (
    const key of [
      AGENT_PROVIDER_CONFIG_KEY,
      ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
      AGENT_PROVIDER_ENV,
      ENABLED_AGENT_PROVIDERS_ENV,
    ]
  ) {
    assertMentions(section, "docs/SETUP.md provider section", `\`${key}\``);
  }
  assertMentions(section, "docs/SETUP.md provider section", "CONTAINER.md");
});
