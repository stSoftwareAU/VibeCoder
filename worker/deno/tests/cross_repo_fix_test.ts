/**
 * Tests for cross_repo_fix.ts — cross-repo PR capability (Issue #2941).
 *
 * Covers the three building blocks the worker needs to fix a root cause in an
 * internal `stSoftwareAU/*` dependency's own repo, in a single run:
 *
 *   1. `classifyDependencySpec` — internal/external classification reusing the
 *      #1613 `@stsoftware` scope rule.
 *   2. `probeCrossRepoAccess` / `resolveCrossRepoTarget` — reachability +
 *      "can access" (clone + push) probe via an injected gh mock.
 *   3. `authoriseCrossRepoTarget` — the consuming repo's own dependency
 *      manifest, not shared ownership, decides which repos a run may write to
 *      (Issue #1382).
 *   4. `openCrossRepoFixPr` — end-to-end orchestration (clone → branch → fix →
 *      commit → push → PR) driven by a scripted command runner, asserting an
 *      actual PR is opened against a *different* repo and its URL is surfaced.
 *
 * All tests use injected command runners — no real network or git.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  authoriseCrossRepoTarget,
  classifyDependencySpec,
  type CommandOutput,
  type CrossRepoFixRequest,
  openCrossRepoFixPr,
  probeCrossRepoAccess,
  resolveCrossRepoTarget,
  type RunCommand,
} from "../lib/cross_repo_fix.ts";

function ok(stdout = ""): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

// ---------------------------------------------------------------------------
// classifyDependencySpec
// ---------------------------------------------------------------------------

Deno.test("classifyDependencySpec - jsr internal scope maps to stSoftwareAU repo", () => {
  const result = classifyDependencySpec("jsr:@stsoftware/private-repo-14");
  assertEquals(result.kind, "internal");
  if (result.kind === "internal") {
    assertEquals(result.name, "private-repo-14");
    assertEquals(result.candidateRepo, "stSoftwareAU/private-repo-14");
  }
});

Deno.test("classifyDependencySpec - npm internal scope with version suffix", () => {
  const result = classifyDependencySpec(
    "npm:@stsoftware/private-repo-14@^5.6.0",
  );
  assertEquals(result.kind, "internal");
  if (result.kind === "internal") {
    assertEquals(result.name, "private-repo-14");
    assertEquals(result.candidateRepo, "stSoftwareAU/private-repo-14");
  }
});

Deno.test("classifyDependencySpec - bare scoped spec (no registry prefix)", () => {
  const result = classifyDependencySpec("@stsoftware/widgets");
  assertEquals(result.kind, "internal");
  if (result.kind === "internal") {
    assertEquals(result.candidateRepo, "stSoftwareAU/widgets");
  }
});

Deno.test("classifyDependencySpec - scope match is case-insensitive", () => {
  const result = classifyDependencySpec("jsr:@StSoftware/private-repo-14");
  assertEquals(result.kind, "internal");
  if (result.kind === "internal") {
    // Repo name preserves the package name casing; probe canonicalises.
    assertEquals(result.candidateRepo, "stSoftwareAU/private-repo-14");
  }
});

Deno.test("classifyDependencySpec - external scope is external", () => {
  const result = classifyDependencySpec("jsr:@std/assert");
  assertEquals(result.kind, "external");
});

Deno.test("classifyDependencySpec - unscoped npm package is external", () => {
  const result = classifyDependencySpec("npm:lodash");
  assertEquals(result.kind, "external");
});

Deno.test("classifyDependencySpec - empty spec is external", () => {
  const result = classifyDependencySpec("   ");
  assertEquals(result.kind, "external");
});

Deno.test("classifyDependencySpec - malformed scoped spec (empty name) is external", () => {
  const result = classifyDependencySpec("@stsoftware/");
  assertEquals(result.kind, "external");
});

Deno.test("classifyDependencySpec - path-traversal name is rejected as external", () => {
  const result = classifyDependencySpec("@stsoftware/..");
  assertEquals(result.kind, "external");
});

// ---------------------------------------------------------------------------
// probeCrossRepoAccess
// ---------------------------------------------------------------------------

Deno.test("probeCrossRepoAccess - clonable with push access is reachable, uses canonical name", async () => {
  const runner: RunCommand = (_cmd) =>
    Promise.resolve(
      ok(JSON.stringify({
        full_name: "stSoftwareAU/private-repo-14",
        permissions: { push: true },
      })),
    );
  const access = await probeCrossRepoAccess(
    "stSoftwareAU/private-repo-14",
    runner,
  );
  assertEquals(access.reachable, true);
  if (access.reachable) {
    assertEquals(access.repo, "stSoftwareAU/private-repo-14");
  }
});

Deno.test("probeCrossRepoAccess - repo not found is unreachable", async () => {
  const runner: RunCommand = (_cmd) => Promise.resolve(fail("HTTP 404"));
  const access = await probeCrossRepoAccess("stSoftwareAU/ghost", runner);
  assertEquals(access.reachable, false);
});

Deno.test("probeCrossRepoAccess - no push access is unreachable", async () => {
  const runner: RunCommand = (_cmd) =>
    Promise.resolve(
      ok(JSON.stringify({
        full_name: "stSoftwareAU/readonly",
        permissions: { push: false, pull: true },
      })),
    );
  const access = await probeCrossRepoAccess("stSoftwareAU/readonly", runner);
  assertEquals(access.reachable, false);
  if (!access.reachable) assertStringIncludes(access.reason, "push");
});

// ---------------------------------------------------------------------------
// resolveCrossRepoTarget
// ---------------------------------------------------------------------------

Deno.test("resolveCrossRepoTarget - internal + reachable yields internal-reachable", async () => {
  const runner: RunCommand = (_cmd) =>
    Promise.resolve(
      ok(JSON.stringify({
        full_name: "stSoftwareAU/private-repo-14",
        permissions: { push: true },
      })),
    );
  const target = await resolveCrossRepoTarget(
    "jsr:@stsoftware/private-repo-14",
    runner,
  );
  assertEquals(target.kind, "internal-reachable");
  if (target.kind === "internal-reachable") {
    assertEquals(target.repo, "stSoftwareAU/private-repo-14");
  }
});

Deno.test("resolveCrossRepoTarget - external scope never probes, classified external", async () => {
  let probed = false;
  const runner: RunCommand = (_cmd) => {
    probed = true;
    return Promise.resolve(ok("{}"));
  };
  const target = await resolveCrossRepoTarget("jsr:@std/assert", runner);
  assertEquals(target.kind, "external");
  assertEquals(probed, false);
});

Deno.test("resolveCrossRepoTarget - internal but unreachable falls back to external", async () => {
  const runner: RunCommand = (_cmd) => Promise.resolve(fail("HTTP 404"));
  const target = await resolveCrossRepoTarget(
    "jsr:@stsoftware/private-thing",
    runner,
  );
  assertEquals(target.kind, "external");
});

// ---------------------------------------------------------------------------
// openCrossRepoFixPr — end-to-end orchestration
// ---------------------------------------------------------------------------

/** Scripted runner recording each command and returning step-keyed output. */
function scriptedRunner(
  overrides: Record<string, CommandOutput> = {},
): { runner: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RunCommand = (cmd) => {
    calls.push(cmd);
    const joined = cmd.join(" ");
    for (const [key, output] of Object.entries(overrides)) {
      if (joined.includes(key)) return Promise.resolve(output);
    }
    // Default: PR-create returns a URL; everything else succeeds quietly.
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "create") {
      return Promise.resolve(
        ok("https://github.com/stSoftwareAU/private-repo-14/pull/42"),
      );
    }
    if (cmd.includes("symbolic-ref")) {
      return Promise.resolve(ok("refs/remotes/origin/main"));
    }
    return Promise.resolve(ok());
  };
  return { runner, calls };
}

function baseRequest(
  overrides: Partial<CrossRepoFixRequest> = {},
): CrossRepoFixRequest {
  return {
    repo: "stSoftwareAU/private-repo-14",
    branch: "fix/issue-2941-root-cause",
    title: "Fix the root cause",
    body: "Closes the upstream defect.",
    commitMessage: "fix: correct the root cause",
    workDir: "/tmp/work",
    applyFix: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("openCrossRepoFixPr - opens a PR in a different repo and surfaces the URL", async () => {
  const { runner, calls } = scriptedRunner();
  let fixApplied = false;
  const result = await openCrossRepoFixPr(
    baseRequest({ applyFix: () => Promise.resolve(void (fixApplied = true)) }),
    runner,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prUrl,
      "https://github.com/stSoftwareAU/private-repo-14/pull/42",
    );
    assertEquals(result.value.repo, "stSoftwareAU/private-repo-14");
  }
  assertEquals(fixApplied, true);

  // The PR is created against the dep repo, not the run's starting repo.
  const prCreate = calls.find(
    (c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create",
  );
  assertEquals(prCreate?.includes("stSoftwareAU/private-repo-14"), true);
  assertEquals(prCreate?.includes("--repo"), true);

  // A clone happened before the branch/commit/push sequence.
  const cloned = calls.find((c) =>
    c[0] === "gh" && c[1] === "repo" && c[2] === "clone"
  );
  assertEquals(cloned?.includes("stSoftwareAU/private-repo-14"), true);

  // A feature branch was created and pushed (never a direct default push).
  const pushed = calls.find((c) => c[0] === "git" && c.includes("push"));
  assertEquals(pushed?.includes("fix/issue-2941-root-cause"), true);
});

Deno.test("openCrossRepoFixPr - refuses to push to the default branch", async () => {
  const { runner } = scriptedRunner();
  const result = await openCrossRepoFixPr(
    baseRequest({ branch: "main" }),
    runner,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "default branch");
});

Deno.test("openCrossRepoFixPr - clone failure returns an error result", async () => {
  const { runner } = scriptedRunner({
    "repo clone": fail("could not clone: repository not found"),
  });
  const result = await openCrossRepoFixPr(baseRequest(), runner);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "clone");
});

Deno.test("openCrossRepoFixPr - push failure returns an error result", async () => {
  const { runner } = scriptedRunner({
    "push": fail("permission denied"),
  });
  const result = await openCrossRepoFixPr(baseRequest(), runner);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "push");
});

Deno.test("openCrossRepoFixPr - rejects an invalid repo slug before any command", async () => {
  let ran = false;
  const runner: RunCommand = (_cmd) => {
    ran = true;
    return Promise.resolve(ok());
  };
  const result = await openCrossRepoFixPr(
    baseRequest({ repo: "../escape" }),
    runner,
  );
  assertEquals(result.ok, false);
  assertEquals(ran, false);
});

// ---------------------------------------------------------------------------
// authoriseCrossRepoTarget (Issue #1382)
// ---------------------------------------------------------------------------

const CONSUMER = "stSoftwareAU/GRQ";
const SIBLING = "stSoftwareAU/NEAT-AI-Discovery";

/** A `gh` runner serving repo-relative manifest paths from a fixed map. */
function manifestRunner(
  files: Record<string, string>,
): { runner: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const runner: RunCommand = (cmd) => {
    calls.push([...cmd]);
    for (const [path, body] of Object.entries(files)) {
      if (cmd.join(" ").includes(`/contents/${path}`)) {
        return Promise.resolve(ok(body));
      }
    }
    return Promise.resolve(fail("gh: Not Found (HTTP 404)"));
  };
  return { runner, calls };
}

Deno.test("authoriseCrossRepoTarget - the consuming repo itself needs no manifest", async () => {
  const { runner, calls } = manifestRunner({});
  const decision = await authoriseCrossRepoTarget(CONSUMER, CONSUMER, runner);
  assertEquals(decision.authorised, true);
  assertEquals(calls.length, 0);
});

Deno.test("authoriseCrossRepoTarget - a jsr dependency in deno.json authorises its repo", async () => {
  const { runner } = manifestRunner({
    "deno.json": JSON.stringify({
      imports: { "neat/": "jsr:@stsoftware/NEAT-AI-Discovery@^1.2.0" },
    }),
  });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, true);
  if (!decision.authorised) return;
  assertEquals(decision.via, "dependency");
  assertEquals(decision.manifestPath, "deno.json");
});

Deno.test("authoriseCrossRepoTarget - an npm dependency in package.json authorises its repo", async () => {
  const { runner } = manifestRunner({
    "package.json": JSON.stringify({
      devDependencies: { "@stsoftware/NEAT-AI-Discovery": "^2.0.0" },
    }),
  });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, true);
});

Deno.test("authoriseCrossRepoTarget - repo-name casing does not change the decision", async () => {
  const { runner } = manifestRunner({
    "deno.json": JSON.stringify({
      imports: { neat: "jsr:@stsoftware/neat-ai-discovery" },
    }),
  });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, true);
});

Deno.test("authoriseCrossRepoTarget - a sibling repo under the same owner is refused when undeclared", async () => {
  const { runner } = manifestRunner({
    "deno.json": JSON.stringify({
      imports: { other: "jsr:@stsoftware/private-repo-14" },
    }),
  });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, false);
  if (decision.authorised) return;
  assertStringIncludes(decision.reason, "dependency");
});

Deno.test("authoriseCrossRepoTarget - an external dependency never authorises an internal repo", async () => {
  const { runner } = manifestRunner({
    "deno.json": JSON.stringify({
      imports: { assert: "jsr:@std/assert@^1.0.0" },
    }),
  });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, false);
});

Deno.test("authoriseCrossRepoTarget - no readable manifest fails closed", async () => {
  const { runner } = manifestRunner({});
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, false);
  if (decision.authorised) return;
  assertStringIncludes(decision.reason, "no dependency manifest");
});

Deno.test("authoriseCrossRepoTarget - a malformed manifest is refused, not thrown", async () => {
  const { runner } = manifestRunner({ "deno.json": "{ not json at all" });
  const decision = await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  assertEquals(decision.authorised, false);
});

Deno.test("authoriseCrossRepoTarget - the manifest is read from the default branch, never a caller-chosen ref", async () => {
  const { runner, calls } = manifestRunner({
    "deno.json": JSON.stringify({
      imports: { neat: "jsr:@stsoftware/NEAT-AI-Discovery" },
    }),
  });
  await authoriseCrossRepoTarget(CONSUMER, SIBLING, runner);
  const read = calls.find((c) => c.join(" ").includes("/contents/"));
  assertEquals(read?.[0], "gh");
  assertStringIncludes(
    (read ?? []).join(" "),
    `repos/${CONSUMER}/contents/deno.json`,
  );
  assertEquals((read ?? []).join(" ").includes("ref="), false);
});

Deno.test("authoriseCrossRepoTarget - a malformed slug is refused before any command", async () => {
  const { runner, calls } = manifestRunner({});
  const decision = await authoriseCrossRepoTarget(
    CONSUMER,
    "stSoftwareAU/../escape",
    runner,
  );
  assertEquals(decision.authorised, false);
  assertEquals(calls.length, 0);
});
