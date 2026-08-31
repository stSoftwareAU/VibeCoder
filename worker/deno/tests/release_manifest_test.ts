/**
 * Tests for the release tool-version manifest (Issue #688, part of #674).
 *
 * The manifest is what a host pinning to a release pins its tools to, so the
 * two properties under test are the all-or-nothing build (a tool that cannot
 * be resolved produces no manifest at all, naming that tool) and a parser
 * strict enough that a partial or malformed manifest is never read as a
 * usable one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReleaseManifest,
  formatReleaseManifest,
  parseReleaseManifest,
  RELEASE_MANIFEST_ASSET,
  type ReleaseManifest,
} from "../lib/release_manifest.ts";
import type { DynamicVersionCandidate } from "../lib/software_updates.ts";

/** An eligible candidate, as the release-age gate reports one. */
function ok(
  tool: DynamicVersionCandidate["tool"],
  version: string,
): DynamicVersionCandidate {
  return {
    tool,
    version,
    eligible: true,
    reason: `${tool} ${version} is old enough`,
  };
}

/** The three eligible candidates a healthy resolution returns. */
function allEligible(): DynamicVersionCandidate[] {
  return [ok("claude", "2.0.76"), ok("gh", "2.62.0"), ok("deno", "2.5.4")];
}

Deno.test("release manifest - the asset name is the documented one", () => {
  assertEquals(RELEASE_MANIFEST_ASSET, "tool-versions.json");
});

Deno.test("buildReleaseManifest - records every resolved tool version", () => {
  const result = buildReleaseManifest("1.0.8", allEligible());
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value, {
    release: "1.0.8",
    tools: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  });
});

Deno.test("buildReleaseManifest - accepts a v-prefixed release tag", () => {
  const result = buildReleaseManifest("v1.0.8", allEligible());
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.release, "v1.0.8");
});

Deno.test("buildReleaseManifest - refuses a release that is not a semver triple", () => {
  for (const release of ["", "latest", "1.0", "1.0.0-rc1", "  1.0.0"]) {
    const result = buildReleaseManifest(release, allEligible());
    assert(!result.ok, `"${release}" must be refused`);
    assertStringIncludes(result.error.message, JSON.stringify(release));
  }
});

Deno.test("buildReleaseManifest - an ineligible tool fails, naming it, with no manifest", () => {
  const candidates = allEligible().map((candidate) =>
    candidate.tool === "gh"
      ? {
        tool: "gh" as const,
        version: null,
        eligible: false,
        reason: "GH CLI 2.63.0 was published 2 hours ago",
      }
      : candidate
  );
  const result = buildReleaseManifest("1.0.8", candidates);
  assert(!result.ok, "an ineligible tool must produce no manifest");
  assertStringIncludes(result.error.message, "gh");
  assertStringIncludes(result.error.message, "published 2 hours ago");
  // Half a manifest is the failure mode this guards: nothing is returned.
  assertEquals("value" in result, false);
});

Deno.test("buildReleaseManifest - a tool the gate never reported fails, naming it", () => {
  const result = buildReleaseManifest(
    "1.0.8",
    allEligible().filter((c) => c.tool !== "deno"),
  );
  assert(!result.ok, "a missing tool must produce no manifest");
  assertStringIncludes(result.error.message, "deno");
});

Deno.test("buildReleaseManifest - names every unresolved tool, not just the first", () => {
  const result = buildReleaseManifest("1.0.8", [ok("claude", "2.0.76")]);
  assert(!result.ok, "two missing tools must produce no manifest");
  assertStringIncludes(result.error.message, "gh");
  assertStringIncludes(result.error.message, "deno");
});

Deno.test("buildReleaseManifest - an eligible candidate carrying junk is refused", () => {
  const candidates = allEligible().map((candidate) =>
    candidate.tool === "claude"
      ? {
        tool: "claude" as const,
        // Eligible but unusable: the value reaches an installer verbatim.
        version: "2.0.76; rm -rf /",
        eligible: true,
        reason: "resolved",
      }
      : candidate
  );
  const result = buildReleaseManifest("1.0.8", candidates);
  assert(!result.ok, "a junk version must produce no manifest");
  assertStringIncludes(result.error.message, "claude");
});

Deno.test("formatReleaseManifest - emits parseable JSON in canonical order", () => {
  const manifest: ReleaseManifest = {
    release: "1.0.8",
    tools: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
  };
  const text = formatReleaseManifest(manifest);
  assert(text.endsWith("\n"), "the asset must end with a newline");
  assertEquals(Object.keys(JSON.parse(text)), ["release", "tools"]);
  assertEquals(Object.keys(JSON.parse(text).tools), ["claude", "gh", "deno"]);

  const reparsed = parseReleaseManifest(text);
  assert(reparsed.ok, reparsed.ok ? "" : reparsed.error.message);
  assertEquals(reparsed.value, manifest);
});

Deno.test("parseReleaseManifest - reads the documented shape", () => {
  const result = parseReleaseManifest(
    '{"release":"1.0.8","tools":{"claude":"2.0.76","gh":"2.62.0","deno":"2.5.4"}}',
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.release, "1.0.8");
  assertEquals(result.value.tools.gh, "2.62.0");
});

Deno.test("parseReleaseManifest - rejects text that is not a JSON object", () => {
  for (const text of ["", "   ", "not json", "[]", "null", '"1.0.8"', "42"]) {
    const result = parseReleaseManifest(text);
    assert(!result.ok, `"${text}" must be rejected`);
    assertStringIncludes(result.error.message, "tool-versions.json");
  }
});

Deno.test("parseReleaseManifest - rejects a partial manifest, naming the missing tool", () => {
  const result = parseReleaseManifest(
    '{"release":"1.0.8","tools":{"claude":"2.0.76","gh":"2.62.0"}}',
  );
  assert(!result.ok, "a manifest missing a tool must be rejected");
  assertStringIncludes(result.error.message, "deno");
});

Deno.test("parseReleaseManifest - rejects malformed field types", () => {
  const cases: Array<[string, string]> = [
    ['{"tools":{"claude":"2.0.76","gh":"2.62.0","deno":"2.5.4"}}', "release"],
    ['{"release":"1.0.8"}', "tools"],
    [
      '{"release":1,"tools":{"claude":"1.0.0","gh":"1.0.0","deno":"1.0.0"}}',
      "release",
    ],
    ['{"release":"1.0.8","tools":"2.0.76"}', "tools"],
    ['{"release":"1.0.8","tools":["2.0.76"]}', "tools"],
    [
      '{"release":"1.0.8","tools":{"claude":2,"gh":"2.62.0","deno":"2.5.4"}}',
      "claude",
    ],
    [
      '{"release":"latest","tools":{"claude":"2.0.76","gh":"2.62.0","deno":"2.5.4"}}',
      "release",
    ],
    [
      '{"release":"1.0.8","tools":{"claude":"latest","gh":"2.62.0","deno":"2.5.4"}}',
      "claude",
    ],
  ];
  for (const [text, named] of cases) {
    const result = parseReleaseManifest(text);
    assert(!result.ok, `${text} must be rejected`);
    assertStringIncludes(result.error.message, named);
  }
});

Deno.test("parseReleaseManifest - rejects a tool the manifest has no business naming", () => {
  const result = parseReleaseManifest(
    '{"release":"1.0.8","tools":{"claude":"2.0.76","gh":"2.62.0","deno":"2.5.4","curl":"8.0.0"}}',
  );
  assert(!result.ok, "an unknown tool key must be rejected");
  assertStringIncludes(result.error.message, "curl");
});
