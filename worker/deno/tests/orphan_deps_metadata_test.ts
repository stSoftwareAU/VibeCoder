/**
 * Tests for the sanctioned orphan-deps metadata gate (Issue #2906,
 * parent #2902).
 *
 * The orphan-deps scan is the single sanctioned exception to the
 * static-evidence-only discipline: it may read registry / source-host
 * metadata within a fixed allow-list to decide what is orphaned. These
 * tests exercise the real helper functions — they assert that:
 *
 *   - the allow-list rejects every host / URL outside the sanctioned set
 *     (SSRF guard), using a STUBBED fetch (no real network);
 *   - a registry / repo URL taken verbatim from an untrusted manifest is
 *     validated before it is dereferenced;
 *   - the gate issues only read-only GET requests and never installs a
 *     package or runs a lifecycle script;
 *   - the sibling prompts (`security_scan`, `supply_chain_readiness`,
 *     `supply_chain_detection`) retain their static-evidence-only /
 *     no-network prohibition, so the sanction stays scoped.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertAllowedMetadataUrl,
  cratesMetadataUrl,
  endoflifeUrl,
  fetchAllowedMetadata,
  githubRepoApiArgs,
  isAllowedMetadataHost,
  isAllowedMetadataUrl,
  isForbiddenScanOperation,
  jsrMetadataUrl,
  npmMetadataUrl,
  ORPHAN_DEPS_FORBIDDEN_OPERATIONS,
  ORPHAN_DEPS_METADATA_HOSTS,
  validateSourceRepoUrl,
} from "../lib/orphan_deps_metadata.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** A recording stub `fetch` that returns a fixed JSON body for every call. */
function recordingFetch(
  body: unknown,
  status = 200,
): {
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    fetchFn: (url, init) => {
      calls.push({ url, method: String(init.method ?? "GET") });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Allow-list enforcement
// ---------------------------------------------------------------------------

Deno.test("isAllowedMetadataHost - accepts every sanctioned host", () => {
  for (const host of ORPHAN_DEPS_METADATA_HOSTS) {
    assert(isAllowedMetadataHost(host), `${host} should be allow-listed`);
  }
});

Deno.test("isAllowedMetadataHost - is case-insensitive", () => {
  assert(isAllowedMetadataHost("Registry.NpmJS.org"));
});

Deno.test("isAllowedMetadataHost - rejects unsanctioned hosts", () => {
  for (
    const host of [
      "evil.example.com",
      "registry.npmjs.org.evil.com",
      "api.github.com", // gh api path, NOT the fetch allow-list
      "localhost",
      "169.254.169.254", // cloud metadata endpoint (SSRF classic)
    ]
  ) {
    assertEquals(
      isAllowedMetadataHost(host),
      false,
      `${host} must not be allow-listed`,
    );
  }
});

Deno.test("assertAllowedMetadataUrl - accepts a sanctioned https URL", () => {
  const r = assertAllowedMetadataUrl("https://registry.npmjs.org/left-pad");
  assert(r.ok);
  if (r.ok) assertEquals(r.value.hostname, "registry.npmjs.org");
});

Deno.test("assertAllowedMetadataUrl - rejects non-https schemes", () => {
  for (
    const url of [
      "http://registry.npmjs.org/left-pad",
      "file:///etc/passwd",
      "ftp://crates.io/x",
    ]
  ) {
    assertEquals(assertAllowedMetadataUrl(url).ok, false, url);
  }
});

Deno.test("assertAllowedMetadataUrl - rejects off-allow-list hosts", () => {
  const r = assertAllowedMetadataUrl("https://evil.example.com/x");
  assertEquals(r.ok, false);
});

Deno.test("assertAllowedMetadataUrl - rejects embedded credentials", () => {
  const r = assertAllowedMetadataUrl(
    "https://user:pass@registry.npmjs.org/left-pad",
  );
  assertEquals(r.ok, false);
});

Deno.test("assertAllowedMetadataUrl - rejects an explicit port", () => {
  const r = assertAllowedMetadataUrl(
    "https://registry.npmjs.org:8080/left-pad",
  );
  assertEquals(r.ok, false);
});

Deno.test("assertAllowedMetadataUrl - rejects unparseable input", () => {
  assertEquals(assertAllowedMetadataUrl("not a url").ok, false);
});

Deno.test("isAllowedMetadataUrl - boolean convenience form", () => {
  assert(isAllowedMetadataUrl("https://jsr.io/@std/assert/meta.json"));
  assertEquals(isAllowedMetadataUrl("https://evil.example.com"), false);
});

// ---------------------------------------------------------------------------
// Untrusted-manifest source-repo URL validation
// ---------------------------------------------------------------------------

Deno.test("validateSourceRepoUrl - parses a clean GitHub https URL", () => {
  const r = validateSourceRepoUrl("https://github.com/denoland/std");
  assert(r.ok);
  if (r.ok) assertEquals(r.value, { owner: "denoland", repo: "std" });
});

Deno.test("validateSourceRepoUrl - strips a .git suffix", () => {
  const r = validateSourceRepoUrl("https://github.com/denoland/std.git");
  assert(r.ok);
  if (r.ok) assertEquals(r.value.repo, "std");
});

Deno.test("validateSourceRepoUrl - normalises git+ and scp forms", () => {
  for (
    const url of [
      "git+https://github.com/denoland/std.git",
      "git@github.com:denoland/std.git",
      "git://github.com/denoland/std.git",
    ]
  ) {
    const r = validateSourceRepoUrl(url);
    assert(r.ok, `should parse ${url}`);
    if (r.ok) assertEquals(r.value, { owner: "denoland", repo: "std" });
  }
});

Deno.test("validateSourceRepoUrl - rejects a non-GitHub host (SSRF guard)", () => {
  for (
    const url of [
      "https://evil.example.com/denoland/std",
      "https://gitlab.com/denoland/std",
      "http://github.com/denoland/std", // non-https
    ]
  ) {
    assertEquals(validateSourceRepoUrl(url).ok, false, url);
  }
});

Deno.test("validateSourceRepoUrl - rejects path traversal / extra segments", () => {
  for (
    const url of [
      "https://github.com/denoland/std/../../secrets",
      "https://github.com/denoland",
      "https://github.com/denoland/std/extra",
      "https://github.com/../etc",
    ]
  ) {
    assertEquals(validateSourceRepoUrl(url).ok, false, url);
  }
});

// ---------------------------------------------------------------------------
// URL builders + gh api args
// ---------------------------------------------------------------------------

Deno.test("npmMetadataUrl - encodes scoped names and stays on the registry", () => {
  assertEquals(
    npmMetadataUrl("left-pad"),
    "https://registry.npmjs.org/left-pad",
  );
  assertEquals(
    npmMetadataUrl("@types/node"),
    "https://registry.npmjs.org/@types%2Fnode",
  );
  // Every builder output must clear the allow-list.
  assert(isAllowedMetadataUrl(npmMetadataUrl("@types/node")));
});

Deno.test("jsr / crates / endoflife builders stay on the allow-list", () => {
  assert(isAllowedMetadataUrl(jsrMetadataUrl("@std", "assert")));
  assert(isAllowedMetadataUrl(cratesMetadataUrl("serde")));
  assert(isAllowedMetadataUrl(endoflifeUrl("nodejs")));
});

Deno.test("githubRepoApiArgs - builds a read-only gh api argv for a valid slug", () => {
  const r = githubRepoApiArgs("denoland", "std");
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value[0], "api");
    assertEquals(r.value[1], "repos/denoland/std");
  }
});

Deno.test("githubRepoApiArgs - refuses a crafted slug (injection guard)", () => {
  const crafted: Array<[string, string]> = [
    ["denoland", "std/../../secrets"],
    ["denoland", "std --paginate"],
    ["..", "etc"],
    ["denoland", "std`whoami`"],
  ];
  for (const [owner, repo] of crafted) {
    assertEquals(githubRepoApiArgs(owner, repo).ok, false, `${owner}/${repo}`);
  }
});

// ---------------------------------------------------------------------------
// The GET-only fetch primitive (stubbed — no real network)
// ---------------------------------------------------------------------------

Deno.test("fetchAllowedMetadata - reads a sanctioned URL via GET only", async () => {
  const stub = recordingFetch({ deprecated: "use padStart" });
  const r = await fetchAllowedMetadata(
    npmMetadataUrl("left-pad"),
    { fetchFn: stub.fetchFn },
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(
      (r.value as { deprecated: string }).deprecated,
      "use padStart",
    );
  }
  // Exactly one request, and it was a read-only GET on the registry.
  assertEquals(stub.calls.length, 1);
  assertEquals(stub.calls[0]?.method, "GET");
  assertEquals(stub.calls[0]?.url, "https://registry.npmjs.org/left-pad");
});

Deno.test("fetchAllowedMetadata - rejects an off-allow-list URL WITHOUT fetching", async () => {
  const stub = recordingFetch({ ok: true });
  const r = await fetchAllowedMetadata(
    "https://evil.example.com/steal",
    { fetchFn: stub.fetchFn },
  );
  assertEquals(r.ok, false);
  // The SSRF guard fires before any request is made.
  assertEquals(stub.calls.length, 0);
});

Deno.test("fetchAllowedMetadata - surfaces a non-2xx status as an error", async () => {
  const stub = recordingFetch({}, 404);
  const r = await fetchAllowedMetadata(
    npmMetadataUrl("does-not-exist"),
    { fetchFn: stub.fetchFn },
  );
  assertEquals(r.ok, false);
});

Deno.test("fetchAllowedMetadata - a thrown fetch never propagates", async () => {
  const r = await fetchAllowedMetadata(npmMetadataUrl("x"), {
    fetchFn: () => Promise.reject(new Error("network down")),
  });
  assertEquals(r.ok, false);
});

Deno.test("fetchAllowedMetadata - only ever issues GET (no install method)", async () => {
  // Drive every builder through the primitive and assert no request used a
  // mutating method — the behavioural form of "no install, ever".
  const stub = recordingFetch({ ok: true });
  for (
    const url of [
      npmMetadataUrl("left-pad"),
      jsrMetadataUrl("@std", "assert"),
      cratesMetadataUrl("serde"),
      endoflifeUrl("nodejs"),
    ]
  ) {
    await fetchAllowedMetadata(url, { fetchFn: stub.fetchFn });
  }
  assertEquals(stub.calls.length, 4);
  for (const call of stub.calls) {
    assertEquals(call.method, "GET", `${call.url} must be a GET`);
  }
});

// ---------------------------------------------------------------------------
// Forbidden-operation guard — "no install, ever; no lifecycle scripts"
// ---------------------------------------------------------------------------

Deno.test("isForbiddenScanOperation - flags installs and lifecycle scripts", () => {
  for (
    const cmd of [
      "npm install left-pad",
      "npm ci",
      "pnpm install",
      "yarn add foo",
      "cargo build",
      "cargo fetch",
      "pip install requests",
      "go get example.com/x",
      "mvn package",
      "gradle assemble",
      "deno cache main.ts",
      "node postinstall.js",
      ["npm", "install"],
    ]
  ) {
    assert(
      isForbiddenScanOperation(cmd),
      `${JSON.stringify(cmd)} must be classed forbidden`,
    );
  }
});

Deno.test("isForbiddenScanOperation - permits read-only metadata tooling", () => {
  for (
    const cmd of [
      "cat package.json",
      "grep -n deprecated deno.lock",
      "gh api repos/denoland/std",
      ["rg", "left-pad"],
    ]
  ) {
    assertEquals(
      isForbiddenScanOperation(cmd),
      false,
      `${JSON.stringify(cmd)} should be permitted`,
    );
  }
});

Deno.test("ORPHAN_DEPS_FORBIDDEN_OPERATIONS - enumerates the install / lifecycle set", () => {
  // The catalogue is the documented source of truth; spot-check the
  // load-bearing entries so a future edit cannot silently drop them.
  for (const op of ["npm install", "cargo build", "postinstall", "build.rs"]) {
    assert(
      (ORPHAN_DEPS_FORBIDDEN_OPERATIONS as readonly string[]).includes(op),
      `forbidden catalogue must list '${op}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// Regression: the sibling prompts keep their static-evidence-only rule
// ---------------------------------------------------------------------------

Deno.test(
  "regression - sibling prompts retain the static-evidence-only / no-network prohibition",
  async () => {
    // supply_chain_detection: explicit "do not contact a registry or the
    // network" prohibition.
    const scd = await loadPrompt(
      "supply_chain_detection",
      undefined,
      PROMPTS_DIR,
    );
    assert(scd.ok);
    if (scd.ok) {
      const lower = scd.value.toLowerCase();
      assert(
        lower.includes("static-evidence only") ||
          lower.includes("static-evidence-only"),
        "supply_chain_detection must keep the static-evidence-only rule",
      );
      assert(
        lower.includes("do not contact a registry or the network"),
        "supply_chain_detection must keep the no-network prohibition",
      );
    }

    // supply_chain_readiness: static-evidence only, no package-manager
    // invocation.
    const scr = await loadPrompt(
      "supply_chain_readiness",
      undefined,
      PROMPTS_DIR,
    );
    assert(scr.ok);
    if (scr.ok) {
      const lower = scr.value.toLowerCase();
      assert(
        lower.includes("static-evidence only") ||
          lower.includes("static-evidence-only"),
        "supply_chain_readiness must keep the static-evidence-only rule",
      );
      assert(
        lower.includes("do not invoke package managers"),
        "supply_chain_readiness must keep the no-package-manager prohibition",
      );
    }

    // security_scan: static, evidence-backed audit; no code execution.
    const sec = await loadPrompt("security_scan", undefined, PROMPTS_DIR);
    assert(sec.ok);
    if (sec.ok) {
      const lower = sec.value.toLowerCase();
      assert(
        lower.includes("static, evidence-backed audit"),
        "security_scan must remain a static, evidence-backed audit",
      );
      assert(
        lower.includes("no code execution"),
        "security_scan must keep the no-code-execution rule",
      );
    }
  },
);
