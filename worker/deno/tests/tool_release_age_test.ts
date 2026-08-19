/**
 * Tests for the toolchain release-age quarantine (Issue #3655).
 *
 * Every dependency is injected — no network access and no real `gh` process —
 * so the age gate is deterministic and fast.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_CLI_NPM_PACKAGE,
  createReleaseAgeGate,
  DEFAULT_TOOL_QUARANTINE_HOURS,
  DENO_RELEASE_REPO,
  describeChannel,
  evaluateReleaseAge,
  GH_CLI_RELEASE_REPO,
  isBinaryExtensionAsset,
  normaliseQuarantineHours,
  npmRegistryUrl,
  parseGhCommitLine,
  parseGhDefaultBranch,
  parseGhExtensionList,
  parseGhExtensionRelease,
  parseGhReleaseLine,
  parseNpmLatest,
} from "../lib/tool_release_age.ts";
import type { Result } from "../types.ts";

const NOW = new Date("2026-08-02T12:00:00Z");

/** Build a fake `runFn` returning canned output for each command. */
function fakeRunner(
  responses: Record<string, { exitCode: number; output: string }>,
  calls: string[][] = [],
): (
  cmd: string[],
  timeoutSeconds: number,
) => Promise<Result<{ exitCode: number; output: string }>> {
  return (cmd: string[]) => {
    calls.push(cmd);
    const key = cmd.join(" ");
    const match = Object.entries(responses).find(([k]) => key.includes(k));
    return Promise.resolve({
      ok: true,
      value: match ? match[1] : { exitCode: 1, output: "not found" },
    } as Result<{ exitCode: number; output: string }>);
  };
}

// ---------- Constants ----------

Deno.test("tool_release_age - default quarantine window is 24h", () => {
  assertEquals(DEFAULT_TOOL_QUARANTINE_HOURS, 24);
});

Deno.test("tool_release_age - channels describe their upstream source", () => {
  assertEquals(
    describeChannel({ kind: "npm", pkg: CLAUDE_CLI_NPM_PACKAGE }),
    "npm:@anthropic-ai/claude-code",
  );
  assertEquals(
    describeChannel({ kind: "github", repo: GH_CLI_RELEASE_REPO }),
    "github:cli/cli",
  );
  assertEquals(DENO_RELEASE_REPO, "denoland/deno");
});

// ---------- normaliseQuarantineHours ----------

Deno.test("normaliseQuarantineHours - accepts a positive whole number", () => {
  assertEquals(normaliseQuarantineHours(72), 72);
  assertEquals(normaliseQuarantineHours("48"), 48);
});

Deno.test("normaliseQuarantineHours - unset falls back to the default", () => {
  assertEquals(normaliseQuarantineHours(undefined), 24);
  assertEquals(normaliseQuarantineHours(""), 24);
});

Deno.test("normaliseQuarantineHours - zero cannot disable the embargo", () => {
  const warnings: string[] = [];
  assertEquals(normaliseQuarantineHours(0, (m) => warnings.push(m)), 24);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "not silently disabled");
});

Deno.test("normaliseQuarantineHours - negatives and fractions are rejected", () => {
  assertEquals(normaliseQuarantineHours(-5), 24);
  assertEquals(normaliseQuarantineHours("0.5"), 24);
  assertEquals(normaliseQuarantineHours("0abc"), 24);
  assertEquals(normaliseQuarantineHours("rubbish"), 24);
});

// ---------- evaluateReleaseAge ----------

Deno.test("evaluateReleaseAge - a release older than the window is eligible", () => {
  const verdict = evaluateReleaseAge(
    "github:denoland/deno",
    { version: "2.9.0", publishedAt: "2026-07-30T12:00:00Z" },
    24,
    NOW,
  );
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.indeterminate, false);
  assertEquals(verdict.ageHours, 72);
  assertEquals(verdict.version, "2.9.0");
});

Deno.test("evaluateReleaseAge - a release inside the window is deferred", () => {
  const verdict = evaluateReleaseAge(
    "npm:@anthropic-ai/claude-code",
    { version: "2.1.220", publishedAt: "2026-08-02T06:00:00Z" },
    24,
    NOW,
  );
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, false);
  assertEquals(verdict.ageHours, 6);
  assertStringIncludes(verdict.reason, "deferring the upgrade");
});

Deno.test("evaluateReleaseAge - exactly at the boundary is eligible", () => {
  const verdict = evaluateReleaseAge(
    "github:cli/cli",
    { version: "2.97.0", publishedAt: "2026-08-01T12:00:00Z" },
    24,
    NOW,
  );
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.ageHours, 24);
});

Deno.test("evaluateReleaseAge - unknown version is indeterminate, not eligible", () => {
  const verdict = evaluateReleaseAge(
    "github:cli/cli",
    { version: null, publishedAt: null },
    24,
    NOW,
  );
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
  assertStringIncludes(verdict.reason, "upgrade is skipped");
});

Deno.test("evaluateReleaseAge - unparseable timestamp is indeterminate", () => {
  const verdict = evaluateReleaseAge(
    "github:cli/cli",
    { version: "2.97.0", publishedAt: "not-a-date" },
    24,
    NOW,
  );
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
  assertStringIncludes(verdict.reason, "Unparseable publish timestamp");
});

Deno.test("evaluateReleaseAge - a zero window still enforces the default", () => {
  const verdict = evaluateReleaseAge(
    "github:denoland/deno",
    { version: "2.9.1", publishedAt: "2026-08-02T06:00:00Z" },
    0,
    NOW,
  );
  assertEquals(verdict.eligible, false);
  assertStringIncludes(verdict.reason, "< 24h quarantine");
});

// ---------- parseGhExtensionList ----------

Deno.test("parseGhExtensionList - extracts name and repo from tabular output", () => {
  const output = [
    "gh dash\tdlvhdr/gh-dash\tv4.6.0",
    "gh poi\tseachicken/gh-poi\tv0.11.1",
  ].join("\n");
  assertEquals(parseGhExtensionList(output), [
    { name: "dash", repo: "dlvhdr/gh-dash" },
    { name: "poi", repo: "seachicken/gh-poi" },
  ]);
});

Deno.test("parseGhExtensionList - ignores header and notice lines", () => {
  const output = [
    "NAME  REPO  VERSION",
    "showing 1 of 1 extension",
    "gh dash   dlvhdr/gh-dash   v4.6.0",
  ].join("\n");
  assertEquals(parseGhExtensionList(output), [
    { name: "dash", repo: "dlvhdr/gh-dash" },
  ]);
});

Deno.test("parseGhExtensionList - empty output yields no extensions", () => {
  assertEquals(parseGhExtensionList(""), []);
  assertEquals(parseGhExtensionList("\n  \n"), []);
});

Deno.test("parseGhExtensionList - repo without a gh- prefix keeps its name", () => {
  assertEquals(parseGhExtensionList("acme   acme/copilot   v1.0.0"), [
    { name: "copilot", repo: "acme/copilot" },
  ]);
});

Deno.test("parseGhExtensionList - duplicate rows are de-duplicated", () => {
  const output =
    "gh dash\tdlvhdr/gh-dash\tv4.6.0\ngh dash\tdlvhdr/gh-dash\tv4.6.0";
  assertEquals(parseGhExtensionList(output).length, 1);
});

// ---------- parseGhReleaseLine ----------

Deno.test("parseGhReleaseLine - parses tag and publish time, stripping v", () => {
  assertEquals(parseGhReleaseLine("v2.97.0 2026-07-31T02:04:00Z"), {
    version: "2.97.0",
    publishedAt: "2026-07-31T02:04:00Z",
  });
});

Deno.test("parseGhReleaseLine - skips stderr noise before the data line", () => {
  const output = "gh: some diagnostic\nv2.9.0 2026-07-30T12:00:00Z\n";
  assertEquals(parseGhReleaseLine(output).version, "2.9.0");
});

Deno.test("parseGhReleaseLine - unparseable output yields an unknown candidate", () => {
  assertEquals(parseGhReleaseLine("nothing useful here"), {
    version: null,
    publishedAt: null,
  });
});

// ---------- parseNpmLatest ----------

Deno.test("parseNpmLatest - reads dist-tags.latest and its publish time", () => {
  const body = {
    "dist-tags": { latest: "2.1.220", next: "2.1.221" },
    time: { "2.1.220": "2026-07-24T23:11:21.821Z" },
  };
  assertEquals(parseNpmLatest(body), {
    version: "2.1.220",
    publishedAt: "2026-07-24T23:11:21.821Z",
  });
});

Deno.test("parseNpmLatest - missing metadata yields an unknown candidate", () => {
  assertEquals(parseNpmLatest(undefined), { version: null, publishedAt: null });
  assertEquals(parseNpmLatest({}), { version: null, publishedAt: null });
});

Deno.test("parseNpmLatest - a latest without a time entry has no publish time", () => {
  assertEquals(parseNpmLatest({ "dist-tags": { latest: "1.0.0" }, time: {} }), {
    version: "1.0.0",
    publishedAt: null,
  });
});

Deno.test("npmRegistryUrl - percent-encodes the scope separator", () => {
  assertEquals(
    npmRegistryUrl("@anthropic-ai/claude-code"),
    "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code",
  );
});

// ---------- createReleaseAgeGate ----------

Deno.test("createReleaseAgeGate - GitHub release older than the window passes", async () => {
  const calls: string[][] = [];
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/denoland/deno/releases/latest": {
        exitCode: 0,
        output: "v2.9.0 2026-07-25T12:00:00Z",
      },
    }, calls),
    now: () => NOW,
  });
  const verdict = await gate.check({ kind: "github", repo: DENO_RELEASE_REPO });
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.version, "2.9.0");
  assertEquals(calls[0]?.slice(0, 3), [
    "gh",
    "api",
    "repos/denoland/deno/releases/latest",
  ]);
});

Deno.test("createReleaseAgeGate - fresh GitHub release is blocked", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/cli/cli/releases/latest": {
        exitCode: 0,
        output: "v2.97.0 2026-08-02T11:00:00Z",
      },
    }),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "github",
    repo: GH_CLI_RELEASE_REPO,
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, false);
});

Deno.test("createReleaseAgeGate - failed gh api lookup fails closed", async () => {
  const gate = createReleaseAgeGate({
    runFn: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 1, output: "HTTP 404" },
      } as Result<{ exitCode: number; output: string }>),
    now: () => NOW,
  });
  const verdict = await gate.check({ kind: "github", repo: "acme/gh-thing" });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
});

Deno.test("createReleaseAgeGate - a spawn error fails closed rather than throwing", async () => {
  const gate = createReleaseAgeGate({
    runFn: () => Promise.reject(new Error("spawn failed")),
    now: () => NOW,
  });
  const verdict = await gate.check({ kind: "github", repo: "acme/gh-thing" });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
});

Deno.test("createReleaseAgeGate - malformed repo never reaches the API", async () => {
  const calls: string[][] = [];
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({}, calls),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "github",
    repo: "../../users/victim",
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
  assertEquals(calls.length, 0);
});

Deno.test("createReleaseAgeGate - npm release older than the window passes", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({}),
    now: () => NOW,
    fetchNpmMetadata: () =>
      Promise.resolve({
        "dist-tags": { latest: "2.1.220" },
        time: { "2.1.220": "2026-07-24T23:11:21.821Z" },
      }),
  });
  const verdict = await gate.check({
    kind: "npm",
    pkg: CLAUDE_CLI_NPM_PACKAGE,
  });
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.version, "2.1.220");
});

Deno.test("createReleaseAgeGate - unreachable npm registry fails closed", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({}),
    now: () => NOW,
    fetchNpmMetadata: () => Promise.reject(new Error("offline")),
  });
  const verdict = await gate.check({
    kind: "npm",
    pkg: CLAUDE_CLI_NPM_PACKAGE,
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
});

Deno.test("createReleaseAgeGate - honours a custom quarantine window", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/denoland/deno/releases/latest": {
        exitCode: 0,
        output: "v2.9.0 2026-07-30T12:00:00Z",
      },
    }),
    quarantineHours: 168,
    now: () => NOW,
  });
  assertEquals(gate.quarantineHours, 168);
  const verdict = await gate.check({ kind: "github", repo: DENO_RELEASE_REPO });
  assertEquals(verdict.eligible, false); // 72h old, 168h window
});

// ---------- gh extension refs (Issue #3952) ----------

Deno.test("isBinaryExtensionAsset - recognises the GOOS-GOARCH suffix gh uses", () => {
  assertEquals(isBinaryExtensionAsset("gh-dash_v4.25.2_darwin-arm64"), true);
  assertEquals(
    isBinaryExtensionAsset("gh-dash_v4.25.2_windows-amd64.exe"),
    true,
  );
  assertEquals(isBinaryExtensionAsset("checksums.txt"), false);
  assertEquals(isBinaryExtensionAsset("gh-dash-source.tar.gz"), false);
});

Deno.test("parseGhExtensionRelease - reads tag, publish time and asset names", () => {
  const output = [
    "release v4.25.2 2026-07-10T10:35:26Z",
    "asset checksums.txt",
    "asset gh-dash_v4.25.2_darwin-arm64",
  ].join("\n");
  assertEquals(parseGhExtensionRelease(output), {
    tag: "v4.25.2",
    publishedAt: "2026-07-10T10:35:26Z",
    assets: ["checksums.txt", "gh-dash_v4.25.2_darwin-arm64"],
  });
});

Deno.test("parseGhExtensionRelease - a release with no assets yields none", () => {
  assertEquals(parseGhExtensionRelease("release v1.0.0 2026-01-01T00:00:00Z"), {
    tag: "v1.0.0",
    publishedAt: "2026-01-01T00:00:00Z",
    assets: [],
  });
});

Deno.test("parseGhExtensionRelease - unparseable output yields no release", () => {
  assertEquals(parseGhExtensionRelease("gh: Not Found (HTTP 404)"), {
    tag: null,
    publishedAt: null,
    assets: [],
  });
});

Deno.test("parseGhCommitLine - reads the sha and its commit date", () => {
  assertEquals(
    parseGhCommitLine(
      "7ed0aff7601dc4162e0cac8835ecd73409d8a009 2026-08-02T11:50:00Z",
    ),
    {
      sha: "7ed0aff7601dc4162e0cac8835ecd73409d8a009",
      committedAt: "2026-08-02T11:50:00Z",
    },
  );
});

Deno.test("parseGhCommitLine - skips noise and rejects a non-sha token", () => {
  assertEquals(
    parseGhCommitLine(
      "gh: diagnostic\nnot-a-sha 2026-08-02T11:50:00Z\n" +
        "7ed0aff7601dc4162e0cac8835ecd73409d8a009 2026-08-02T11:50:00Z",
    ).sha,
    "7ed0aff7601dc4162e0cac8835ecd73409d8a009",
  );
  assertEquals(parseGhCommitLine("nothing useful"), {
    sha: null,
    committedAt: null,
  });
});

Deno.test("parseGhDefaultBranch - takes the branch name, ignoring noise", () => {
  assertEquals(parseGhDefaultBranch("gh: diagnostic line\nmain\n"), "main");
  assertEquals(parseGhDefaultBranch("release/2.x"), "release/2.x");
  assertEquals(parseGhDefaultBranch(""), null);
});

Deno.test("parseGhDefaultBranch - rejects a traversal-shaped branch name", () => {
  assertEquals(parseGhDefaultBranch("../../users/victim"), null);
});

Deno.test("createReleaseAgeGate - a script extension is dated by branch HEAD, not a stale tag", async () => {
  // The Issue #3952 failure: the tag is months old and clears the window, but
  // `gh extension upgrade` on a script extension pulls the default branch,
  // whose HEAD landed ten minutes ago. The gate must date what is installed.
  const calls: string[][] = [];
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/acme/gh-thing/releases/latest": {
        exitCode: 0,
        // A tagged release with no platform binaries — gh clones instead.
        output: "release v1.0.0 2026-05-01T00:00:00Z\nasset checksums.txt",
      },
      "repos/acme/gh-thing --jq .default_branch": {
        exitCode: 0,
        output: "main",
      },
      "repos/acme/gh-thing/commits/main": {
        exitCode: 0,
        output: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 2026-08-02T11:50:00Z",
      },
    }, calls),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "acme/gh-thing",
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, false);
  assertEquals(verdict.publishedAt, "2026-08-02T11:50:00Z");
  assertEquals(verdict.ref, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  assertStringIncludes(verdict.reason, "0.2h old");
  assertEquals(calls[2]?.[2], "repos/acme/gh-thing/commits/main");
});

Deno.test("createReleaseAgeGate - an aged script extension resolves its HEAD sha", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/acme/gh-thing/releases/latest": {
        exitCode: 1,
        output: "HTTP 404",
      },
      "repos/acme/gh-thing --jq .default_branch": {
        exitCode: 0,
        output: "trunk",
      },
      "repos/acme/gh-thing/commits/trunk": {
        exitCode: 0,
        output: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 2026-07-20T00:00:00Z",
      },
    }),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "acme/gh-thing",
  });
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.ref, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  assertEquals(verdict.version, "a1b2c3d4e5f6");
});

Deno.test("createReleaseAgeGate - a binary extension is dated and pinned by its tag", async () => {
  const calls: string[][] = [];
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/dlvhdr/gh-dash/releases/latest": {
        exitCode: 0,
        output: "release v4.25.2 2026-07-10T10:35:26Z\n" +
          "asset checksums.txt\nasset gh-dash_v4.25.2_darwin-arm64",
      },
    }, calls),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "dlvhdr/gh-dash",
  });
  assertEquals(verdict.eligible, true);
  assertEquals(verdict.version, "4.25.2");
  // The ref keeps the tag verbatim — that is what `--pin` must receive.
  assertEquals(verdict.ref, "v4.25.2");
  // No branch lookup: gh installs the release, so the release date applies.
  assertEquals(calls.length, 1);
});

Deno.test("createReleaseAgeGate - a fresh binary extension release is blocked", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/dlvhdr/gh-dash/releases/latest": {
        exitCode: 0,
        output: "release v4.25.2 2026-08-02T11:00:00Z\n" +
          "asset gh-dash_v4.25.2_linux-amd64",
      },
    }),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "dlvhdr/gh-dash",
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, false);
});

Deno.test("createReleaseAgeGate - an undatable extension HEAD fails closed", async () => {
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({
      "repos/acme/gh-thing/releases/latest": {
        exitCode: 1,
        output: "HTTP 404",
      },
      "repos/acme/gh-thing --jq .default_branch": {
        exitCode: 0,
        output: "main",
      },
      "repos/acme/gh-thing/commits/main": { exitCode: 1, output: "HTTP 500" },
    }),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "acme/gh-thing",
  });
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.indeterminate, true);
  assertEquals(verdict.ref, null);
});

Deno.test("createReleaseAgeGate - a malformed extension repo never reaches the API", async () => {
  const calls: string[][] = [];
  const gate = createReleaseAgeGate({
    runFn: fakeRunner({}, calls),
    now: () => NOW,
  });
  const verdict = await gate.check({
    kind: "gh-extension",
    repo: "../../users/victim",
  });
  assertEquals(verdict.indeterminate, true);
  assertEquals(calls.length, 0);
});

Deno.test("describeChannel - a gh extension names its own channel", () => {
  assertEquals(
    describeChannel({ kind: "gh-extension", repo: "acme/gh-thing" }),
    "gh-extension:acme/gh-thing",
  );
});
