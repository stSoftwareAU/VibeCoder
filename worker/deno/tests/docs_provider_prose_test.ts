/**
 * The provider lists restated in prose (Issue #418, parent #396).
 *
 * `docs/MODEL-AND-CACHING.md`, `README.md` and `docs/SETUP.md` already have
 * tests derived from `agentProviderIds()`. Three further restatements had
 * none: the `agent_provider` row in `docs/CONFIGURATION.md`, and the
 * `AGENT_PROVIDERS` build-arg examples in `docs/CONTAINER.md` and
 * `docs/QUORUM.md` (which also names the enabled set in an `agent_providers`
 * example). Prose-only, they went stale for `gemini` before Issue #367 and
 * would have gone stale again for `deepseek`.
 *
 * Every assertion is derived from `agent_provider.ts`, so registering the next
 * provider fails here until these three documents name it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import {
  AGENT_PROVIDER_CONFIG_KEY,
  agentProviderIds,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
} from "../lib/agent_provider.ts";

// tests/ → worker/deno/ → worker/ → repo root
function read(relative: string): string {
  return Deno.readTextFileSync(
    new URL(`../../../${relative}`, import.meta.url),
  );
}

const CONFIGURATION_DOC = "docs/CONFIGURATION.md";
const CONTAINER_DOC = "docs/CONTAINER.md";
const QUORUM_DOC = "docs/QUORUM.md";

/** The build argument that decides which agent CLIs an image carries. */
const BUILD_ARG = "AGENT_PROVIDERS";

/**
 * Assert some candidate line names every registered provider id.
 *
 * @param candidates - Lines of one kind (a table row, a build-arg example).
 *   One of them must name every id; several examples may coexist, and only
 *   the fullest has to be complete.
 * @param what - What the candidates are, for the failure message.
 * @param doc - Document the candidates came from, for the failure message.
 * @param quoted - Whether an id is expected inside backticks.
 */
function assertNamesEveryProvider(
  candidates: string[],
  what: string,
  doc: string,
  quoted: boolean,
): void {
  const ids = agentProviderIds();
  assert(ids.length > 0, "at least one provider must be registered");
  assert(
    candidates.length > 0,
    `${doc} must carry ${what}`,
  );
  const complete = candidates.find((candidate) =>
    ids.every((id) => candidate.includes(quoted ? `\`${id}\`` : id))
  );
  assert(
    complete,
    `${what} in ${doc} must name every registered provider ` +
      `(${ids.join(", ")}) — got:\n${candidates.join("\n")}`,
  );
}

/**
 * Markdown table rows whose first cell is the given key in backticks.
 *
 * @param doc - Whole Markdown document.
 * @param key - Configuration key naming the row.
 * @returns Matching rows, in document order.
 */
function configRows(doc: string, key: string): string[] {
  return doc
    .split("\n")
    .filter((line) => new RegExp(`^\\|\\s*\`${key}\`\\s*\\|`).test(line));
}

/**
 * Lines carrying a `--build-arg AGENT_PROVIDERS="…"` example.
 *
 * @param doc - Whole Markdown document.
 * @returns Matching lines, in document order.
 */
function buildArgExamples(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) => line.includes(`--build-arg ${BUILD_ARG}=`));
}

/**
 * Lines carrying a JSON `"agent_providers": [...]` example.
 *
 * @param doc - Whole Markdown document.
 * @returns Matching lines, in document order.
 */
function enabledSetExamples(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) =>
      new RegExp(`"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}"\\s*:\\s*\\[`)
        .test(line)
    );
}

Deno.test("docs/CONFIGURATION.md - the agent_provider row names every registered provider", () => {
  assertNamesEveryProvider(
    configRows(read(CONFIGURATION_DOC), AGENT_PROVIDER_CONFIG_KEY),
    `the \`${AGENT_PROVIDER_CONFIG_KEY}\` row`,
    CONFIGURATION_DOC,
    true,
  );
});

Deno.test("docs/CONTAINER.md - an AGENT_PROVIDERS build-arg example names every registered provider", () => {
  assertNamesEveryProvider(
    buildArgExamples(read(CONTAINER_DOC)),
    `a \`--build-arg ${BUILD_ARG}\` example`,
    CONTAINER_DOC,
    false,
  );
});

Deno.test("docs/QUORUM.md - an AGENT_PROVIDERS build-arg example names every registered provider", () => {
  assertNamesEveryProvider(
    buildArgExamples(read(QUORUM_DOC)),
    `a \`--build-arg ${BUILD_ARG}\` example`,
    QUORUM_DOC,
    false,
  );
});

Deno.test("docs/QUORUM.md - the agent_providers example names every registered provider", () => {
  assertNamesEveryProvider(
    enabledSetExamples(read(QUORUM_DOC)),
    `an \`${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}\` example`,
    QUORUM_DOC,
    false,
  );
});
