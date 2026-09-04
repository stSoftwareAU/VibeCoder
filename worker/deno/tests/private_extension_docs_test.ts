/**
 * Tests for the private-extension documentation (Issue #985).
 *
 * `docs/PRIVATE-EXTENSIONS.md` is a procedure an operator follows to stand up
 * an extension for software this repository has never heard of. A procedure
 * that has drifted from the code is worse than no procedure — the reader loses
 * an afternoon before discovering the step does not work — so the claims that
 * can be checked mechanically are checked here rather than by re-reading the
 * prose:
 *
 *   - the worked `container_tools` example really parses, through the same
 *     validator the build uses, so the block a reader copies is known-good;
 *   - the install prefix, the archive extensions and the `repo_config` keys
 *     the page names are the real ones;
 *   - the two documented gaps are still gaps. If someone exports the CI-log
 *     registry or adds a loader, these fail and the page must be rewritten
 *     rather than left promising a limitation that no longer exists;
 *   - the boundary #985 asks for is actually stated in `EXTENDING.md`;
 *   - no third-party software is named anywhere in the extension surface,
 *     which is the property the whole issue turns on.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONTAINER_TOOL_PREFIX_ROOT,
  containerToolPrefix,
  parseContainerTools,
} from "../lib/container_tools_config.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

function read(relative: string): string {
  return Deno.readTextFileSync(`${REPO_ROOT}/${relative}`);
}

const PAGE = "docs/PRIVATE-EXTENSIONS.md";

/** The fenced ```json blocks of a document, in order. */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1] ?? "");
  return blocks;
}

// ---------------------------------------------------------------------------
// The worked example is real
// ---------------------------------------------------------------------------

Deno.test("private extensions - the documented container_tools example passes the real validator (Issue #985)", () => {
  const block = jsonBlocks(read(PAGE)).find((body) =>
    body.includes('"container_tools"')
  );
  assert(block !== undefined, `no container_tools JSON block in ${PAGE}`);

  const parsed = JSON.parse(block) as { container_tools: unknown };
  const result = parseContainerTools(parsed.container_tools);
  assert(
    result.ok,
    `the documented example must parse; validator said: ${
      result.ok ? "" : result.error
    }`,
  );

  // Two entries, one per-architecture and one noarch, so the example shows
  // both shapes a deployment meets.
  assertEquals(result.value.length, 2);
  const [first, second] = result.value;
  assertEquals(Object.keys(first!.url).sort(), ["amd64", "arm64"]);
  assertEquals(Object.keys(second!.url), ["noarch"]);

  // Every entry pins a digest for every URL it declares — the property the
  // page tells the reader is mandatory.
  for (const tool of result.value) {
    assertEquals(
      Object.keys(tool.url).sort(),
      Object.keys(tool.sha256).sort(),
      `tool ${tool.id} must pin a digest for every architecture`,
    );
  }
});

Deno.test("private extensions - the documented install prefix is the real one (Issue #985)", () => {
  const page = read(PAGE);
  assertStringIncludes(page, CONTAINER_TOOL_PREFIX_ROOT);
  // The page tells the reader where `tool-a` lands; that must be what the
  // code computes.
  assertStringIncludes(page, containerToolPrefix("tool-a"));
});

Deno.test("private extensions - the documented archive extensions match the installer (Issue #985)", () => {
  const installer = read("container/install-tools.sh");
  const page = read(PAGE);
  for (const extension of [".tar.gz", ".tar.xz", ".zip"]) {
    assertStringIncludes(
      installer,
      extension,
      `installer must still accept ${extension}`,
    );
    assertStringIncludes(
      page,
      extension,
      `page must still name ${extension}`,
    );
  }
});

Deno.test("private extensions - the documented repo_config keys are real (Issue #985)", () => {
  const config = read("worker/deno/lib/config.ts");
  const page = read(PAGE);
  for (const key of ["pre_setup_command", "custom_instructions"]) {
    assertStringIncludes(
      config,
      `${key}:`,
      `${key} must still be a recognised repo_config key`,
    );
    assertStringIncludes(page, key);
  }
});

// ---------------------------------------------------------------------------
// The documented gaps are still gaps
// ---------------------------------------------------------------------------

Deno.test("private extensions - the CI-log registry is still unexported, as documented (Issue #985)", () => {
  const mod = read("worker/deno/mod.ts");
  assert(
    !mod.includes("ci_log_provider.ts"),
    "mod.ts now exports something from ci_log_provider.ts — the documented " +
      "gap in docs/PRIVATE-EXTENSIONS.md is stale and must be rewritten",
  );
  assertStringIncludes(read(PAGE), "The registry is not exported");
});

Deno.test("private extensions - the installer still sends no credentials, as documented (Issue #985)", () => {
  const installer = read("container/install-tools.sh");
  for (const credentialFlag of ["--netrc", "Authorization", "--user "]) {
    assert(
      !installer.includes(credentialFlag),
      `install-tools.sh now uses ${credentialFlag} — the credentialed-source ` +
        "gap in docs/PRIVATE-EXTENSIONS.md is stale and must be rewritten",
    );
  }
  assertStringIncludes(read(PAGE), "No credentialed download");
});

// ---------------------------------------------------------------------------
// The boundary, and the incuriosity property
// ---------------------------------------------------------------------------

Deno.test("private extensions - EXTENDING.md states the boundary and links the page (Issue #985)", () => {
  const extending = read("docs/EXTENDING.md");
  assertStringIncludes(extending, "PRIVATE-EXTENSIONS.md");
  assertStringIncludes(extending, "this project itself runs on");
  assert(
    !extending.includes("simply the first one"),
    "EXTENDING.md must not frame a vendor provider as the model to copy",
  );
});

Deno.test("private extensions - the page is reachable from the README (Issue #985)", () => {
  assertStringIncludes(read("README.md"), "docs/PRIVATE-EXTENSIONS.md");
});

Deno.test("private extensions - the extension surface names no third-party software (Issue #985)", () => {
  // The property #985 turns on: core provides extension points and never
  // learns what is plugged into them. GitHub Actions is exempt — it is the CI
  // this project itself runs on, not an offered integration.
  const named = /\b(jenkins|maven|temurin|adoptium)\b/i;
  const surfaces = [
    PAGE,
    "worker/deno/lib/container_tools_config.ts",
    "container/install-tools.sh",
  ];
  for (const surface of surfaces) {
    const offenders = read(surface)
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => named.test(line));
    assertEquals(
      offenders.map(({ n, line }) => `${surface}:${n}: ${line.trim()}`),
      [],
      `${surface} must not name third-party software`,
    );
  }
});
