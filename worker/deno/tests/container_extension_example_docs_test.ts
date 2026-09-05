/**
 * Tests for the container-extension page and its worked example (Issue #984,
 * closing slice of parent #933).
 *
 * `docs/CONTAINER-EXTENSION.md` is what an operator copies into `.config.json`
 * before syncing their own private repository to the configured host path, so
 * it is checked the way a deployment would meet it rather than by re-reading
 * the prose — the precedent `container_tools_example_docs_test.ts` set:
 *
 *   - the fenced `container_extension` block really parses, through the same
 *     validator config load uses, so an operator's first attempt cannot fail
 *     at config load on an example this repository published;
 *   - the fenced `container_tools` block of the same example parses through
 *     the real tool validator, since the example's Java and Maven half rides
 *     that mechanism rather than the extension layer;
 *   - the contract values the page quotes — the in-image prefix, the base
 *     image build argument, the start environment variable, the abort exit
 *     status and the refusal prefix — are the ones the implementation states;
 *   - the example is genericised: every download it shows resolves to a
 *     reserved documentation domain (RFC 2606), the property Issue #986
 *     established for the sibling page;
 *   - every cross-link Issue #984 asks for is actually present.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_EXTENSION_CONTAINERFILE,
  parseContainerExtension,
} from "../lib/container_extension_config.ts";
import {
  CONTAINER_TOOL_PREFIX_ROOT,
  containerToolPrefix,
  parseContainerTools,
} from "../lib/container_tools_config.ts";
import {
  BASE_IMAGE_BUILD_ARG,
  EXTENSION_START_BUILD_ARG,
} from "../lib/container_extension_build.ts";
import {
  EXTENSION_PREFIX,
  EXTENSION_START_ABORT_EXIT_STATUS,
  EXTENSION_START_ENV,
} from "../lib/container_extension_start.ts";
import type { ContainerExtensionSpec } from "../types.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

function read(relative: string): string {
  return Deno.readTextFileSync(`${REPO_ROOT}/${relative}`);
}

const PAGE = "docs/CONTAINER-EXTENSION.md";

/** The fenced ```json blocks of a document, in order. */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1] ?? "");
  return blocks;
}

/** The first fenced json block of the page declaring `key`. */
function documentedBlock(key: string): Record<string, unknown> {
  const block = jsonBlocks(read(PAGE)).find((body) =>
    body.includes(`"${key}"`)
  );
  assert(block !== undefined, `${PAGE} must carry a fenced json ${key} block`);
  return JSON.parse(block) as Record<string, unknown>;
}

/**
 * The declaration the page shows, through the real validator.
 *
 * The home directory is injected rather than read from the environment: the
 * containment rule the validator enforces is about the *operator's* home, and
 * the suite must reach the same verdict on every host it runs on.
 */
function validatedExtension(): ContainerExtensionSpec {
  const raw = documentedBlock("container_extension")["container_extension"];
  const result = parseContainerExtension(raw, {
    env: (name) => (name === "HOME" ? "/home/operator" : undefined),
  });
  assert(
    result.ok,
    `the documented declaration must pass validation: ${
      result.ok ? "" : result.error
    }`,
  );
  assert(result.value !== undefined, "the example must declare an extension");
  return result.value;
}

// ---------------------------------------------------------------------------
// The example itself
// ---------------------------------------------------------------------------

Deno.test("container_extension example - the documented declaration passes the real validator", () => {
  const spec = validatedExtension();
  assert(
    spec.path.startsWith("/"),
    `the example must declare an absolute host path, got ${spec.path}`,
  );
  assertStringIncludes(
    read(PAGE),
    spec.path,
    "the page's prose must name the same path its example declares",
  );
});

Deno.test("container_extension example - the declaration names both files the layer needs", () => {
  const spec = validatedExtension();
  assert(
    spec.containerfile.length > 0,
    "the example must resolve a Containerfile, defaulted or declared",
  );
  assert(
    spec.start !== undefined,
    "the worked example brings services up, so it must declare a start script",
  );
  // Both are relative to the extension directory — the confinement rule the
  // validator enforces and the page states.
  for (const relative of [spec.containerfile, spec.start]) {
    assert(
      !relative.startsWith("/"),
      `${relative} must be relative to the extension directory`,
    );
  }
});

Deno.test("container_extension example - the Containerfile default is the documented one", () => {
  assertStringIncludes(read(PAGE), DEFAULT_EXTENSION_CONTAINERFILE);
});

Deno.test("container_extension example - the documented tool set passes the real tool validator", () => {
  const raw = documentedBlock("container_tools")["container_tools"];
  const result = parseContainerTools(raw);
  assert(
    result.ok,
    `the documented tool set must pass validation: ${
      result.ok ? "" : result.error
    }`,
  );

  // Three toolchains, one prefix each: the two JDKs and the build tool the
  // worked example installs through container_tools rather than the layer.
  assertEquals(result.value.length, 3);
  const ids = result.value.map((tool) => tool.id);
  assertEquals(new Set(ids).size, 3, "each toolchain gets its own tool id");

  for (const tool of result.value) {
    assertEquals(
      Object.keys(tool.url).sort(),
      Object.keys(tool.sha256).sort(),
      `tool ${tool.id} must pin a digest for every architecture it declares`,
    );
    assertStringIncludes(
      read(PAGE),
      containerToolPrefix(tool.id),
      `the page must state where ${tool.id} lands`,
    );
  }
  assertStringIncludes(read(PAGE), CONTAINER_TOOL_PREFIX_ROOT);
});

// ---------------------------------------------------------------------------
// The contract values the page quotes are the implemented ones
// ---------------------------------------------------------------------------

Deno.test("container_extension example - the page quotes the implemented contract values", () => {
  const page = read(PAGE);
  for (
    const value of [
      EXTENSION_PREFIX,
      EXTENSION_START_ENV,
      BASE_IMAGE_BUILD_ARG,
      EXTENSION_START_BUILD_ARG,
      String(EXTENSION_START_ABORT_EXIT_STATUS),
    ]
  ) {
    assertStringIncludes(
      page,
      value,
      `${PAGE} must state the implemented value ${value}`,
    );
  }
});

Deno.test("container_extension example - the quoted failure symptoms are the implemented ones", () => {
  const page = read(PAGE);

  // The launch preflight's shared refusal prefix, and the config-load one.
  const preflight = read("worker/deno/lib/container_extension_preflight.ts");
  assertStringIncludes(preflight, "Cannot launch: the container_extension");
  assertStringIncludes(page, "Cannot launch: the container_extension");

  const config = read("worker/deno/lib/container_extension_config.ts");
  assertStringIncludes(config, "Invalid container_extension in .config.json");
  assertStringIncludes(page, "Invalid container_extension in .config.json");

  // The build's refusal of a Containerfile that does not layer on the base.
  const build = read("worker/deno/lib/container_extension_build.ts");
  assertStringIncludes(
    build,
    "Refusing to launch: the container_extension Containerfile",
  );
  assertStringIncludes(
    page,
    "Refusing to launch: the container_extension Containerfile",
  );

  // The entrypoint's abort, which the run is reported as a failure by.
  assertStringIncludes(
    read("container/entrypoint.sh"),
    "aborting the sandbox start; the worker driver was not launched",
  );
  assertStringIncludes(
    page,
    "aborting the sandbox start; the worker driver was not launched",
  );
});

// ---------------------------------------------------------------------------
// The example is genericised
// ---------------------------------------------------------------------------

/**
 * Hosts the page may point at.
 *
 * The worked example has to show a download to be worth copying. Naming a
 * real one would pin a vendor's artefact in this repository and go stale the
 * day it is re-published, so every URL resolves to a reserved documentation
 * domain (RFC 2606) — the rule Issue #986 established for the sibling page,
 * and one that is checkable without listing a single real host.
 */
const EXAMPLE_HOST = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/i;

/**
 * The loopback address, which the example's readiness probes use.
 *
 * It names no host at all: a service an extension starts is reachable inside
 * the container and nowhere else, which is the containment property the page
 * states, so a probe against it is the opposite of a leak.
 */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]|localhost)$/i;

Deno.test("container_extension example - every download points at a placeholder host (Issue #986)", () => {
  const offenders = [...read(PAGE).matchAll(/https?:\/\/[^\s)"'`<>\]]+/gi)]
    .map((match) => match[0])
    .filter((url) => {
      try {
        const { hostname } = new URL(url);
        return !EXAMPLE_HOST.test(hostname) && !LOOPBACK_HOST.test(hostname);
      } catch {
        return true;
      }
    });

  assertEquals(
    offenders,
    [],
    "the page points at a real host. The worked example must use a reserved " +
      "documentation domain so no operator's deployment, and no vendor's " +
      "artefact, is recorded here:\n" + offenders.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// The cross-links Issue #984 asks for
// ---------------------------------------------------------------------------

Deno.test("container_extension example - EXTENDING.md lists the page as an extension point", () => {
  const extending = read("docs/EXTENDING.md");
  const links = extending.split("CONTAINER-EXTENSION.md").length - 1;
  assert(
    links >= 2,
    "EXTENDING.md must link the page from both its table of contents and " +
      `its extension-point list, found ${links} link(s)`,
  );
});

Deno.test("container_extension example - CONFIGURATION.md carries a container_extension row", () => {
  const configuration = read("docs/CONFIGURATION.md");
  const row = configuration
    .split("\n")
    .find((line) =>
      line.startsWith("| `container_extension`") && line.includes("|", 1)
    );
  assert(
    row !== undefined,
    "docs/CONFIGURATION.md must carry a `container_extension` table row " +
      "beside the `container_tools` one",
  );
  assertStringIncludes(row, "CONTAINER-EXTENSION.md");
});

Deno.test("container_extension example - the image and container manuals reference the page", () => {
  for (const doc of ["docs/CONTAINER-IMAGE.md", "docs/CONTAINER.md"]) {
    assertStringIncludes(
      read(doc),
      "CONTAINER-EXTENSION.md",
      `${doc} must reference the container-extension page`,
    );
  }
  // The second build is what CONTAINER-IMAGE.md owes the reader.
  assertStringIncludes(read("docs/CONTAINER-IMAGE.md"), "container_extension");
});

Deno.test("container_extension example - the page cross-links containment", () => {
  assertStringIncludes(read(PAGE), "CONTAINMENT.md");
});

Deno.test("container_extension example - the page has a published title", () => {
  assertStringIncludes(read("_data/page_titles.yml"), `${PAGE}:`);
});
