/**
 * Tests for the release check library (Issue #689, part of #674).
 *
 * Everything here runs against injected deps — no `gh`, no git, no network —
 * because this code runs on the launch path where a failed check must degrade
 * to a warning rather than an exception. The properties under test are the
 * release series definition (numeric order, pre-releases and moving names
 * ignored), a pin comparison that refuses to guess for a commit SHA, and a
 * manifest lookup that tells "this release predates the manifest" apart from
 * "GitHub could not be reached".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareToPin,
  latestRelease,
  type ReleaseCheckDeps,
  releaseToolVersions,
} from "../lib/release_check.ts";
import { formatReleaseManifest } from "../lib/release_manifest.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import type { Result } from "../types.ts";

/** A successful `gh` invocation carrying `stdout`. */
function ghOk(stdout: string): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: true, code: 0, stdout, stderr: "", timedOut: false },
  };
}

/** A `gh` invocation that exited non-zero. */
function ghFailed(stderr: string, code = 1): Result<SubprocessResult> {
  return {
    ok: true,
    value: { success: false, code, stdout: "", stderr, timedOut: false },
  };
}

/** A `gh` invocation the timeout helper killed. */
function ghTimedOut(): Result<SubprocessResult> {
  return {
    ok: true,
    value: {
      success: false,
      code: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    },
  };
}

/** Deps whose `gh` responses are keyed by the sub-command being run. */
function deps(
  responses: Record<string, Result<SubprocessResult>>,
  options?: { repo?: Result<string>; calls?: string[][] },
): ReleaseCheckDeps {
  return {
    resolveRepo: () =>
      Promise.resolve(options?.repo ?? { ok: true, value: "stSoftwareAU/Vc" }),
    runGh: (args) => {
      options?.calls?.push([...args]);
      const key = args[0] ?? "";
      const response = responses[key];
      if (!response) throw new Error(`no canned response for gh ${key}`);
      return Promise.resolve(response);
    },
  };
}

/** `gh release list --json` output for the tags given. */
function releaseList(
  tags: readonly (string | Record<string, unknown>)[],
): string {
  return JSON.stringify(
    tags.map((tag) =>
      typeof tag === "string"
        ? { tagName: tag, isDraft: false, isPrerelease: false }
        : tag
    ),
  );
}

Deno.test("latestRelease - newest by numeric segment order, not lexical", async () => {
  const result = await latestRelease(
    deps({ release: ghOk(releaseList(["1.0.9", "1.0.10", "1.0.2"])) }),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value?.tag, "1.0.10");
  assertEquals(result.value?.version, [1, 0, 10]);
});

Deno.test("latestRelease - ignores pre-releases, build metadata and moving names", async () => {
  const result = await latestRelease(
    deps({
      release: ghOk(
        releaseList([
          "1.0.7",
          "2.0.0-rc1",
          "2.0.0+build.5",
          "latest",
          "nightly",
          "v1.0.8",
        ]),
      ),
    }),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value?.tag, "v1.0.8");
  assertEquals(result.value?.version, [1, 0, 8]);
});

Deno.test("latestRelease - skips draft and pre-release marked releases", async () => {
  const result = await latestRelease(
    deps({
      release: ghOk(
        releaseList([
          { tagName: "2.0.0", isDraft: true, isPrerelease: false },
          { tagName: "1.9.0", isDraft: false, isPrerelease: true },
          { tagName: "1.0.8", isDraft: false, isPrerelease: false },
        ]),
      ),
    }),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value?.tag, "1.0.8");
});

Deno.test("latestRelease - no releases yet is a clean empty outcome", async () => {
  const empty = await latestRelease(deps({ release: ghOk("[]") }));
  assert(empty.ok, empty.ok ? "" : empty.error.message);
  assertEquals(empty.value, null);

  const onlyMoving = await latestRelease(
    deps({ release: ghOk(releaseList(["latest", "1.0.0-rc1"])) }),
  );
  assert(onlyMoving.ok, onlyMoving.ok ? "" : onlyMoving.error.message);
  assertEquals(onlyMoving.value, null);
});

Deno.test("latestRelease - asks gh for the checkout's own repository", async () => {
  const calls: string[][] = [];
  const result = await latestRelease(
    deps({ release: ghOk(releaseList(["1.0.1"])) }, {
      calls,
      repo: { ok: true, value: "stSoftwareAU/VibeCoder" },
    }),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(calls.length, 1);
  assert(
    calls[0]!.includes("stSoftwareAU/VibeCoder"),
    `repository not passed to gh: ${calls[0]!.join(" ")}`,
  );
});

Deno.test("latestRelease - an unresolvable origin is a failed Result", async () => {
  const result = await latestRelease(
    deps({}, { repo: { ok: false, error: new Error("no origin remote") } }),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "no origin remote");
});

Deno.test("latestRelease - a non-zero gh exit reports the stderr", async () => {
  const result = await latestRelease(
    deps({ release: ghFailed("HTTP 401: Bad credentials") }),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "Bad credentials");
  assertStringIncludes(result.error.message, "exit code 1");
});

Deno.test("latestRelease - a timeout says so rather than looking like a parse failure", async () => {
  const result = await latestRelease(deps({ release: ghTimedOut() }));
  assert(!result.ok);
  assertStringIncludes(result.error.message, "timed out");
});

Deno.test("latestRelease - a network failure is a failed Result, not a throw", async () => {
  const result = await latestRelease({
    resolveRepo: () => Promise.resolve({ ok: true, value: "stSoftwareAU/Vc" }),
    runGh: () =>
      Promise.resolve({ ok: false, error: new Error("dns lookup failed") }),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "dns lookup failed");
});

Deno.test("latestRelease - unreadable gh output is a failed Result", async () => {
  const result = await latestRelease(deps({ release: ghOk("not json") }));
  assert(!result.ok);
  assertStringIncludes(result.error.message, "gh release list");
});

Deno.test("latestRelease - a thrown dependency is caught, never propagated", async () => {
  const result = await latestRelease({
    resolveRepo: () => Promise.resolve({ ok: true, value: "stSoftwareAU/Vc" }),
    runGh: () => {
      throw new Error("subprocess exploded");
    },
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "subprocess exploded");
});

Deno.test("compareToPin - a pin behind the newest release reports newer", () => {
  const result = compareToPin("1.0.7", "1.0.10");
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value, {
    comparable: true,
    current: "1.0.7",
    latest: "1.0.10",
    newer: true,
  });
});

Deno.test("compareToPin - an equal pin is not newer", () => {
  const result = compareToPin("v1.0.8", "1.0.8");
  assert(result.ok, result.ok ? "" : result.error.message);
  assert(result.value.comparable);
  assertEquals(result.value.newer, false);
});

Deno.test("compareToPin - a pin ahead of the newest release is not newer", () => {
  const result = compareToPin("1.1.0", "1.0.10");
  assert(result.ok, result.ok ? "" : result.error.message);
  assert(result.value.comparable);
  assertEquals(result.value.newer, false);
});

Deno.test("compareToPin - a commit SHA is not orderable and never reports newer", () => {
  const sha = "3f2a1b9c4d5e6f708192a3b4c5d6e7f809a1b2c3";
  const result = compareToPin(sha, "1.0.10");
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.comparable, false);
  assertEquals(result.value.newer, undefined);
  assertEquals(result.value.current, sha);
  assertEquals(result.value.latest, "1.0.10");
  assert(!result.value.comparable);
  assertStringIncludes(result.value.reason, "commit SHA");
  assertStringIncludes(result.value.reason, "1.0.10");
});

Deno.test("compareToPin - a short commit SHA is treated the same way", () => {
  const result = compareToPin("3f2a1b9", "1.0.10");
  assert(result.ok, result.ok ? "" : result.error.message);
  assert(!result.value.comparable);
  assertStringIncludes(result.value.reason, "commit SHA");
});

Deno.test("compareToPin - a ref that is neither a tag nor a SHA says so", () => {
  const result = compareToPin("main", "1.0.10");
  assert(result.ok, result.ok ? "" : result.error.message);
  assert(!result.value.comparable);
  assertEquals(result.value.newer, undefined);
  assertStringIncludes(result.value.reason, "release tag");
});

Deno.test("compareToPin - a blank pin or a non-release latest fails loudly", () => {
  const blank = compareToPin("  ", "1.0.10");
  assert(!blank.ok);
  assertStringIncludes(blank.error.message, "pinned_ref");

  const latest = compareToPin("1.0.7", "latest");
  assert(!latest.ok);
  assertStringIncludes(latest.error.message, "latest");
});

/** `gh release view --json assets` output naming the assets given. */
function assetList(names: readonly string[]): string {
  return JSON.stringify({ assets: names.map((name) => ({ name })) });
}

/** The bytes a release with a manifest serves. */
const MANIFEST_TEXT = formatReleaseManifest({
  release: "1.0.8",
  tools: { claude: "2.0.76", gh: "2.62.0", deno: "2.5.4" },
});

Deno.test("releaseToolVersions - returns all three recorded versions", async () => {
  const calls: string[][] = [];
  const result = await releaseToolVersions(
    "1.0.8",
    sequenceDeps(
      [ghOk(assetList(["tool-versions.json"])), ghOk(MANIFEST_TEXT)],
      calls,
    ),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assertEquals(result.value.kind, "manifest");
  assert(result.value.kind === "manifest");
  assertEquals(result.value.tools, {
    claude: "2.0.76",
    gh: "2.62.0",
    deno: "2.5.4",
  });
  assertEquals(result.value.tag, "1.0.8");
  assertEquals(calls.length, 2);
  assert(
    calls[1]!.includes("tool-versions.json"),
    `the asset was not downloaded by name: ${calls[1]!.join(" ")}`,
  );
});

Deno.test("releaseToolVersions - a release without the asset is a distinct no-manifest outcome", async () => {
  const result = await releaseToolVersions(
    "1.0.3",
    deps({ release: ghOk(assetList(["source.tar.gz"])) }),
  );
  assert(result.ok, result.ok ? "" : result.error.message);
  assert(result.value.kind === "no-manifest");
  assertEquals(result.value.tag, "1.0.3");
  assertStringIncludes(result.value.reason, "1.0.3");
  assertStringIncludes(result.value.reason, "tool-versions.json");
});

Deno.test("releaseToolVersions - a partial manifest is rejected naming the field", async () => {
  const result = await releaseToolVersions(
    "1.0.8",
    sequenceDeps([
      ghOk(assetList(["tool-versions.json"])),
      ghOk(
        JSON.stringify({
          release: "1.0.8",
          tools: { claude: "2.0.76", gh: "2.62.0" },
        }),
      ),
    ]),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "tools.deno");
});

Deno.test("releaseToolVersions - a malformed manifest is an error, not a partial read", async () => {
  const result = await releaseToolVersions(
    "1.0.8",
    sequenceDeps([
      ghOk(assetList(["tool-versions.json"])),
      ghOk("{ not json"),
    ]),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "tool-versions.json");
});

Deno.test("releaseToolVersions - a missing release is a failed Result naming the tag", async () => {
  const result = await releaseToolVersions(
    "9.9.9",
    deps({ release: ghFailed("release not found") }),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "9.9.9");
  assertStringIncludes(result.error.message, "release not found");
});

Deno.test("releaseToolVersions - a timed-out download is a failed Result", async () => {
  const result = await releaseToolVersions(
    "1.0.8",
    sequenceDeps([ghOk(assetList(["tool-versions.json"])), ghTimedOut()]),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "timed out");
});

Deno.test("releaseToolVersions - a tag outside the release series never reaches gh", async () => {
  const calls: string[][] = [];
  const result = await releaseToolVersions(
    "--repo=evil/repo",
    deps({ release: ghOk(assetList([])) }, { calls }),
  );
  assert(!result.ok);
  assertStringIncludes(result.error.message, "release tag");
  assertEquals(calls.length, 0);
});

/** Deps serving one canned `gh` response per call, in order. */
function sequenceDeps(
  responses: readonly Result<SubprocessResult>[],
  calls?: string[][],
): ReleaseCheckDeps {
  let call = 0;
  return {
    resolveRepo: () => Promise.resolve({ ok: true, value: "stSoftwareAU/Vc" }),
    runGh: (args) => {
      calls?.push([...args]);
      const response = responses[call++];
      if (!response) throw new Error(`unexpected gh call ${call}`);
      return Promise.resolve(response);
    },
  };
}
