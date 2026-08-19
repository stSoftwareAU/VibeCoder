/**
 * Tests for lib/default_branch_ruleset_audit.ts — the read-only sweep of the
 * default-branch ruleset decision (Issue #4356).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  auditDefaultBranchRulesets,
  formatAuditTable,
  isValidOrgLogin,
  listOrgRepos,
  summariseAudit,
} from "../lib/default_branch_ruleset_audit.ts";
import type { CommandOutput } from "../setup/branch_protection_sync.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";
import { VIBE_RULESET_NAME } from "../lib/default_branch_ruleset.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Metadata reads (`gh api repos/<repo> --jq …`): every repo is private/main. */
function runCommand(cmd: string[]): Promise<CommandOutput> {
  const jq = cmd[cmd.length - 1] ?? "";
  if ((cmd[2] ?? "").includes("missing")) {
    return Promise.resolve({ success: false, stdout: "", stderr: "404" });
  }
  return Promise.resolve({
    success: true,
    stdout: jq === ".visibility" ? "private" : "main",
    stderr: "",
  });
}

interface FakeRepo {
  /** True when the default branch takes direct pushes. */
  direct?: boolean;
  /** True when the worker's ruleset already exists. */
  own?: boolean;
  /** True when a human-managed ruleset covers the branch. */
  foreign?: boolean;
  /** Names the repo reports (default: gitleaks). */
  reports?: string[];
  topics?: string[];
}

function makeGh(repos: Record<string, FakeRepo>): {
  gh: GhExec;
  writes: string[][];
} {
  const writes: string[][] = [];
  const gh: GhExec = (args) => {
    const isVerb = args[1] === "-X";
    if (isVerb) {
      writes.push(args);
      return Promise.resolve("");
    }
    const endpoint = String(args[1]);
    const slug = endpoint.replace(/^repos\//, "").split("/").slice(0, 2)
      .join("/");
    const repo = repos[slug] ?? {};

    if (/\/rulesets$/.test(endpoint)) {
      const list = [];
      if (repo.own) list.push({ id: 1, name: VIBE_RULESET_NAME });
      if (repo.foreign) list.push({ id: 2, name: "Develop" });
      return Promise.resolve(JSON.stringify(list));
    }
    if (/\/rules\/branches\//.test(endpoint)) {
      const rules = [];
      if (repo.own) {
        rules.push({
          type: "required_status_checks",
          ruleset_id: 1,
          parameters: { required_status_checks: [{ context: "gitleaks" }] },
        });
      }
      if (repo.foreign) {
        rules.push({
          type: "required_status_checks",
          ruleset_id: 2,
          parameters: { required_status_checks: [{ context: "quality" }] },
        });
      }
      return Promise.resolve(JSON.stringify(rules));
    }
    if (/\/protection$/.test(endpoint)) {
      return Promise.reject(new Error("Not Found (HTTP 404)"));
    }
    if (/\/topics$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ names: repo.topics ?? [] }));
    }
    if (endpoint.includes("/contents/")) {
      return Promise.reject(new Error("Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify([{
          sha: "abc1234",
          commit: { message: repo.direct ? "Refresh" : "feat (#1)" },
        }]),
      );
    }
    if (/\/commits\/[^/]+\/pulls$/.test(endpoint)) return Promise.resolve("[]");
    if (/\/pulls\?/.test(endpoint)) return Promise.resolve("[]");
    if (/check-runs/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify({
          check_runs: (repo.reports ?? ["gitleaks"]).map((name) => ({ name })),
        }),
      );
    }
    if (/\/status$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ statuses: [] }));
    }
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  };
  return { gh, writes };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

Deno.test("audit - classifies every repo and never writes", async () => {
  const { gh, writes } = makeGh({
    "org/code": {},
    "org/code-owned": { own: true, reports: ["gitleaks", "markdownlint"] },
    "org/data": { direct: true },
    "org/data-owned": { direct: true, own: true },
    "org/opted": { topics: ["direct-push"] },
    "org/human": { foreign: true },
    "org/quiet": { reports: ["unrelated"] },
  });

  const rows = await auditDefaultBranchRulesets({
    repos: [
      "org/code",
      "org/code-owned",
      "org/data",
      "org/data-owned",
      "org/opted",
      "org/human",
      "org/quiet",
      "org/missing",
    ],
    runCommand,
    ghFn: gh,
  });

  const decisions = Object.fromEntries(rows.map((r) => [r.repo, r.decision]));
  assertEquals(decisions, {
    "org/code": "create",
    "org/code-owned": "update",
    "org/data": "direct-push-branch",
    "org/data-owned": "delete",
    "org/opted": "opted-out",
    "org/human": "existing-ruleset",
    "org/quiet": "no-reported-checks",
    "org/missing": "error",
  });
  assertEquals(writes.length, 0, "the sweep is read-only");

  const owned = rows.find((r) => r.repo === "org/code-owned")!;
  assertEquals(owned.contexts, ["gitleaks", "markdownlint"]);
  const deleted = rows.find((r) => r.repo === "org/data-owned")!;
  assert(deleted.detail.includes("would delete own ruleset"));
  assert(deleted.detail.includes("direct-push-branch"));
  const missing = rows.find((r) => r.repo === "org/missing")!;
  assert(missing.detail.includes("org/missing"), missing.detail);
});

Deno.test("audit - the table renders one row per repo and escapes pipes", () => {
  const table = formatAuditTable([
    {
      repo: "org/a",
      branch: "main",
      visibility: "private",
      decision: "create",
      contexts: ["gitleaks", "markdownlint"],
      detail: "",
    },
    {
      repo: "org/b",
      decision: "error",
      contexts: [],
      detail: "boom | with pipe",
    },
  ]);
  const lines = table.split("\n");
  assertEquals(lines.length, 4);
  assertEquals(
    lines[2],
    "| org/a | main | private | create | gitleaks, markdownlint | - |",
  );
  assertEquals(lines[3], "| org/b | - | - | error | - | boom \\| with pipe |");
});

Deno.test("audit - the summary tallies decisions", () => {
  const summary = summariseAudit([
    { repo: "a", decision: "create", contexts: [], detail: "" },
    { repo: "b", decision: "direct-push-branch", contexts: [], detail: "" },
    { repo: "c", decision: "direct-push-branch", contexts: [], detail: "" },
  ]);
  assertEquals(summary, "create 1, direct-push-branch 2");
});

// ---------------------------------------------------------------------------
// Org discovery
// ---------------------------------------------------------------------------

Deno.test("audit - listOrgRepos pages the org and returns slugs", async () => {
  let seen: string[] = [];
  const gh: GhExec = (args) => {
    seen = args;
    return Promise.resolve(
      "stSoftwareAU/private-repo-1\nstSoftwareAU/VibeCoder\n\n",
    );
  };
  const repos = await listOrgRepos("stSoftwareAU", gh);
  assertEquals(repos, [
    "stSoftwareAU/private-repo-1",
    "stSoftwareAU/VibeCoder",
  ]);
  assert(seen.includes("--paginate"));
  assert(seen.some((a) => a.startsWith("orgs/stSoftwareAU/repos")));
});

Deno.test("audit - listOrgRepos rejects an invalid organisation without a gh call", async () => {
  let called = false;
  const gh: GhExec = () => {
    called = true;
    return Promise.resolve("");
  };
  await assertRejects(() => listOrgRepos("bad org; rm -rf /", gh));
  assertEquals(called, false);
  assert(isValidOrgLogin("stSoftwareAU"));
  assertEquals(isValidOrgLogin("-leading"), false);
});
