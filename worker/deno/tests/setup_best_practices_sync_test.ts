/**
 * Tests for setup/best_practices_sync.ts — best-practice synchronisation.
 *
 * Issue #2102: setup.sh best-practice sync. Part of #2094.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  BEST_PRACTICES_CATEGORY_LABEL,
  BEST_PRACTICES_ISSUE_TITLE,
  BEST_PRACTICES_MARKER,
  buildIssueBody,
  buildMermaidDiagram,
  buildUpdateCommentBody,
  type CommandOutput,
  deriveBestPracticeLabels,
  type GhCommandFn,
  syncBestPracticesForAllRepos,
  syncBestPracticesForRepo,
} from "../setup/best_practices_sync.ts";
import type { BestPracticeFinding } from "../lib/workflow_best_practices.ts";

// ---------------------------------------------------------------------------
// Workflow fixtures (anti-pattern detected by pr-creator-token check)
// ---------------------------------------------------------------------------

const badWorkflowGithubToken = `name: Bad - GITHUB_TOKEN
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v7
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          commit-message: "chore: update"
          title: "chore: update"
          branch: chore/update
`;

const goodWorkflowActionsPush = `name: Good - ACTIONS_PUSH
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  upgrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peter-evans/create-pull-request@v7
        with:
          token: \${{ secrets.ACTIONS_PUSH || secrets.GITHUB_TOKEN }}
          commit-message: "chore: update"
          title: "chore: update"
          branch: chore/update
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeWorkflows(
  baseDir: string,
  files: Record<string, string>,
): Promise<void> {
  const workflowDir = `${baseDir}/.github/workflows`;
  await Deno.mkdir(workflowDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${workflowDir}/${name}`, content);
  }
}

async function withTempRepo(
  files: Record<string, string>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "best_practices_sync_" });
  try {
    if (Object.keys(files).length > 0) await writeWorkflows(tmp, files);
    await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Collect every `--label` value from a create command. */
function collectLabels(cmd: string[]): string[] {
  const labels: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === "--label" && i + 1 < cmd.length) labels.push(cmd[i + 1]!);
  }
  return labels;
}

/** Captured calls + per-test issue-state simulation. */
interface MockState {
  searches: { repo: string; query: string }[];
  creates: {
    repo: string;
    title: string;
    body: string;
    label: string | null;
    labels: string[];
  }[];
  comments: { repo: string; issue: string; body: string }[];
  /** Labels created via `gh api`/`gh label create`. */
  labelsCreated: string[];
  /** Labels added to an existing issue via `gh api`/`gh issue edit`. */
  labelsAdded: string[];
  /** Labels the repo already has (returned by `gh label list`). */
  existingLabels: string[];
  /** Issue number to return for search; null means none exists. */
  existingIssue: number | null;
  /** When true, `gh issue create` with any `--label` fails first attempt. */
  failLabelledCreate?: boolean;
  /** When true, label creation (`gh api .../labels`, `gh label create`) fails. */
  failLabelCreate?: boolean;
}

function buildMockRunner(state: MockState): GhCommandFn {
  return (cmd: string[]): Promise<CommandOutput> => {
    const ok = (stdout = ""): Promise<CommandOutput> =>
      Promise.resolve({ success: true, stdout, stderr: "" });
    const fail = (stderr: string): Promise<CommandOutput> =>
      Promise.resolve({ success: false, stdout: "", stderr });

    // --- label list (ensureLabelExists → getCachedLabels) ---
    if (cmd[0] === "gh" && cmd[1] === "label" && cmd[2] === "list") {
      return ok(state.existingLabels.join("\n"));
    }

    // --- label create via REST: gh api -X POST repos/<repo>/labels ---
    if (
      cmd[0] === "gh" && cmd[1] === "api" &&
      cmd.some((a) => /^repos\/[^/]+\/[^/]+\/labels$/.test(a))
    ) {
      if (state.failLabelCreate) return fail("permission denied");
      const nameArg = cmd.find((a) => a.startsWith("name="));
      if (nameArg) state.labelsCreated.push(nameArg.slice("name=".length));
      return ok();
    }

    // --- label create via CLI fallback: gh label create <name> ---
    if (cmd[0] === "gh" && cmd[1] === "label" && cmd[2] === "create") {
      if (state.failLabelCreate) return fail("permission denied");
      state.labelsCreated.push(cmd[3] ?? "");
      return ok();
    }

    // --- add label to issue via REST: gh api .../issues/<n>/labels ---
    if (
      cmd[0] === "gh" && cmd[1] === "api" &&
      cmd.some((a) => /\/issues\/\d+\/labels$/.test(a))
    ) {
      const arg = cmd.find((a) => a.startsWith("labels[]="));
      if (arg) state.labelsAdded.push(arg.slice("labels[]=".length));
      return ok();
    }

    // --- add label via CLI fallback: gh issue edit <n> --add-label ---
    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "edit") {
      const addIdx = cmd.indexOf("--add-label");
      if (addIdx >= 0) state.labelsAdded.push(cmd[addIdx + 1]!);
      return ok();
    }

    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "list") {
      const repoIdx = cmd.indexOf("--repo");
      const searchIdx = cmd.indexOf("--search");
      state.searches.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        query: searchIdx >= 0 ? cmd[searchIdx + 1]! : "",
      });
      const payload = state.existingIssue !== null
        ? JSON.stringify([{ number: state.existingIssue }])
        : "[]";
      return ok(payload);
    }

    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "create") {
      const repoIdx = cmd.indexOf("--repo");
      const titleIdx = cmd.indexOf("--title");
      const bodyIdx = cmd.indexOf("--body");
      const labels = collectLabels(cmd);
      if (state.failLabelledCreate && labels.length > 0) {
        return fail("label not found");
      }
      state.creates.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        title: titleIdx >= 0 ? cmd[titleIdx + 1]! : "",
        body: bodyIdx >= 0 ? cmd[bodyIdx + 1]! : "",
        label: labels[0] ?? null,
        labels,
      });
      return ok("https://github.com/owner/repo/issues/99");
    }

    if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "comment") {
      const repoIdx = cmd.indexOf("--repo");
      const bodyIdx = cmd.indexOf("--body");
      state.comments.push({
        repo: repoIdx >= 0 ? cmd[repoIdx + 1]! : "",
        issue: cmd[3] ?? "",
        body: bodyIdx >= 0 ? cmd[bodyIdx + 1]! : "",
      });
      return ok();
    }

    return fail("unhandled");
  };
}

function newState(): MockState {
  return {
    searches: [],
    creates: [],
    comments: [],
    labelsCreated: [],
    labelsAdded: [],
    existingLabels: [],
    existingIssue: null,
  };
}

/** Fresh temp dir for the label cache so tests stay hermetic. */
async function withLabelCacheDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bps_labelcache_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// syncBestPracticesForRepo — single-repo behaviour
// ---------------------------------------------------------------------------

Deno.test(
  "syncBestPracticesForRepo - one anti-pattern produces one filed issue",
  async () => {
    await withTempRepo({ "bad.yml": badWorkflowGithubToken }, async (tmp) => {
      await withLabelCacheDir(async (cacheDir) => {
        const state = newState();
        const result = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state),
          labelCacheDir: cacheDir,
        });

        assertEquals(result.ok, true);
        assertEquals(result.findings, 1);
        assertEquals(result.issueCreated, true);
        assertEquals(result.issueUpdated, false);
        assertEquals(state.creates.length, 1);
        assertEquals(state.comments.length, 0);
        assertEquals(state.creates[0]!.title, BEST_PRACTICES_ISSUE_TITLE);
        assertEquals(state.creates[0]!.repo, "owner/repo");
        // Body carries the dedup marker so a second run can detect it.
        assertStringIncludes(state.creates[0]!.body, BEST_PRACTICES_MARKER);
        // Body reports the finding details
        assertStringIncludes(state.creates[0]!.body, "pr-creator-token");
        assertStringIncludes(state.creates[0]!.body, "bad.yml");
        // Filed with enhancement + derived severity + category labels (#2335).
        // pr-creator-token is severity:high.
        assertEquals(state.creates[0]!.labels, [
          "enhancement",
          "severity:high",
          BEST_PRACTICES_CATEGORY_LABEL,
        ]);
        // The derived labels were created in the repo before being applied.
        assertEquals(state.labelsCreated.includes("severity:high"), true);
        assertEquals(
          state.labelsCreated.includes(BEST_PRACTICES_CATEGORY_LABEL),
          true,
        );
      });
    });
  },
);

Deno.test(
  "syncBestPracticesForRepo - no findings raises no issue",
  async () => {
    await withTempRepo(
      { "good.yml": goodWorkflowActionsPush },
      async (tmp) => {
        const state = newState();
        const result = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state),
        });

        assertEquals(result.ok, true);
        assertEquals(result.findings, 0);
        assertEquals(result.issueCreated, false);
        assertEquals(result.issueUpdated, false);
        // No search / create / comment when there are no findings.
        assertEquals(state.searches.length, 0);
        assertEquals(state.creates.length, 0);
        assertEquals(state.comments.length, 0);
      },
    );
  },
);

Deno.test(
  "syncBestPracticesForRepo - second run updates existing issue, no duplicate",
  async () => {
    await withTempRepo({ "bad.yml": badWorkflowGithubToken }, async (tmp) => {
      await withLabelCacheDir(async (cacheDir) => {
        // First run: no existing issue → creates one.
        const state1 = newState();
        const r1 = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state1),
          labelCacheDir: cacheDir,
        });
        assertEquals(r1.issueCreated, true);
        assertEquals(state1.creates.length, 1);

        // Second run: existing issue #99 is returned → posts a comment.
        const state2 = newState();
        state2.existingIssue = 99;
        const r2 = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state2),
          labelCacheDir: cacheDir,
        });
        assertEquals(r2.ok, true);
        assertEquals(r2.issueCreated, false);
        assertEquals(r2.issueUpdated, true);
        assertEquals(state2.creates.length, 0);
        assertEquals(state2.comments.length, 1);
        assertEquals(state2.comments[0]!.issue, "99");
        assertEquals(state2.comments[0]!.repo, "owner/repo");
        // Comment carries the marker so future runs find it too.
        assertStringIncludes(state2.comments[0]!.body, BEST_PRACTICES_MARKER);
        assertStringIncludes(state2.comments[0]!.body, "pr-creator-token");
        // Update path reconciles the derived labels onto the existing issue.
        assertEquals(state2.labelsAdded.includes("severity:high"), true);
        assertEquals(
          state2.labelsAdded.includes(BEST_PRACTICES_CATEGORY_LABEL),
          true,
        );
      });
    });
  },
);

Deno.test(
  "syncBestPracticesForRepo - dry-run reports findings without filing",
  async () => {
    await withTempRepo({ "bad.yml": badWorkflowGithubToken }, async (tmp) => {
      const state = newState();
      const result = await syncBestPracticesForRepo("owner/repo", {
        localRepoPath: tmp,
        ghCommandFn: buildMockRunner(state),
        dryRun: true,
      });

      assertEquals(result.ok, true);
      assertEquals(result.findings, 1);
      assertEquals(result.issueCreated, false);
      assertEquals(result.issueUpdated, false);
      // Dry-run skips all gh mutations.
      assertEquals(state.searches.length, 0);
      assertEquals(state.creates.length, 0);
      assertEquals(state.comments.length, 0);
    });
  },
);

Deno.test(
  "syncBestPracticesForRepo - falls back to filing without label when labelled create fails",
  async () => {
    await withTempRepo({ "bad.yml": badWorkflowGithubToken }, async (tmp) => {
      await withLabelCacheDir(async (cacheDir) => {
        const state = newState();
        state.failLabelledCreate = true;
        const result = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state),
          labelCacheDir: cacheDir,
        });

        assertEquals(result.ok, true);
        assertEquals(result.issueCreated, true);
        // One successful create without label was recorded.
        assertEquals(state.creates.length, 1);
        assertEquals(state.creates[0]!.label, null);
        assertEquals(state.creates[0]!.labels, []);
      });
    });
  },
);

Deno.test(
  "syncBestPracticesForRepo - label-create failure: issue still filed, labels omitted",
  async () => {
    await withTempRepo({ "bad.yml": badWorkflowGithubToken }, async (tmp) => {
      await withLabelCacheDir(async (cacheDir) => {
        const state = newState();
        // Simulate transient/label failure: ensureLabelExists cannot create
        // the derived labels. The issue must still be filed (with enhancement
        // only), with no exception and no error-level log.
        state.failLabelCreate = true;
        const result = await syncBestPracticesForRepo("owner/repo", {
          localRepoPath: tmp,
          ghCommandFn: buildMockRunner(state),
          labelCacheDir: cacheDir,
        });

        assertEquals(result.ok, true);
        assertEquals(result.issueCreated, true);
        assertEquals(state.creates.length, 1);
        // Derived labels were omitted; only enhancement survives.
        assertEquals(state.creates[0]!.labels, ["enhancement"]);
        assertEquals(state.labelsCreated.length, 0);
      });
    });
  },
);

Deno.test(
  "syncBestPracticesForRepo - mixed severities pick the highest",
  async () => {
    await withTempRepo(
      {
        "bad.yml": badWorkflowGithubToken,
        "bad2.yml": badWorkflowGithubToken,
      },
      async (tmp) => {
        await withLabelCacheDir(async (cacheDir) => {
          const state = newState();
          const result = await syncBestPracticesForRepo("owner/repo", {
            localRepoPath: tmp,
            ghCommandFn: buildMockRunner(state),
            labelCacheDir: cacheDir,
          });
          assertEquals(result.issueCreated, true);
          // pr-creator-token findings are high; highest is high.
          assertEquals(
            state.creates[0]!.labels.includes("severity:high"),
            true,
          );
        });
      },
    );
  },
);

// ---------------------------------------------------------------------------
// syncBestPracticesForAllRepos — orchestration
// ---------------------------------------------------------------------------

Deno.test(
  "syncBestPracticesForAllRepos - derives per-repo path from workDir",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "bps_workdir_" });
    try {
      // Two repos: one with anti-pattern, one clean.
      await writeWorkflows(`${workDir}/repo1`, {
        "bad.yml": badWorkflowGithubToken,
      });
      await writeWorkflows(`${workDir}/repo2`, {
        "good.yml": goodWorkflowActionsPush,
      });

      const state = newState();
      const results = await syncBestPracticesForAllRepos({
        repos: ["owner/repo1", "owner/repo2"],
        workDir,
        ghCommandFn: buildMockRunner(state),
        labelCacheDir: `${workDir}/.labelcache`,
      });

      assertEquals(results.length, 2);
      const repo1 = results.find((r) => r.repo === "owner/repo1")!;
      const repo2 = results.find((r) => r.repo === "owner/repo2")!;
      assertEquals(repo1.findings, 1);
      assertEquals(repo1.issueCreated, true);
      assertEquals(repo2.findings, 0);
      assertEquals(repo2.issueCreated, false);
      assertEquals(state.creates.length, 1);
      assertEquals(state.creates[0]!.repo, "owner/repo1");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "syncBestPracticesForAllRepos - one repo failure does not abort the loop",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "bps_workdir_fail_" });
    try {
      // repo1 has a bad workflow; repo2 directory does not exist (audit
      // treats missing .github/workflows as "no findings", so the loop
      // simply continues to the next repo — the contract is that one
      // repo never aborts another).
      await writeWorkflows(`${workDir}/repo1`, {
        "bad.yml": badWorkflowGithubToken,
      });

      const state = newState();
      const results = await syncBestPracticesForAllRepos({
        repos: ["owner/repo1", "owner/missing-repo"],
        workDir,
        ghCommandFn: buildMockRunner(state),
        labelCacheDir: `${workDir}/.labelcache`,
      });

      assertEquals(results.length, 2);
      assertEquals(results[0]!.repo, "owner/repo1");
      assertEquals(results[0]!.issueCreated, true);
      // Missing repo: no workflows → no findings → no error filed.
      assertEquals(results[1]!.repo, "owner/missing-repo");
      assertEquals(results[1]!.findings, 0);
      assertEquals(results[1]!.issueCreated, false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Issue-body shaping
// ---------------------------------------------------------------------------

function fakeFinding(file: string, idx: number): BestPracticeFinding {
  return {
    checkId: "pr-creator-token",
    workflowFile: file,
    lineNumber: idx + 10,
    severity: "high",
    suggestedFix: "Use ACTIONS_PUSH fallback.",
  };
}

function findingWith(
  severity: BestPracticeFinding["severity"],
): BestPracticeFinding {
  return {
    checkId: "pr-creator-token",
    workflowFile: "ci.yml",
    lineNumber: 1,
    severity,
    suggestedFix: "fix",
  };
}

// ---------------------------------------------------------------------------
// deriveBestPracticeLabels — pure label derivation (Issue #2335)
// ---------------------------------------------------------------------------

Deno.test("deriveBestPracticeLabels - single high finding", () => {
  assertEquals(deriveBestPracticeLabels([findingWith("high")]), [
    "severity:high",
    BEST_PRACTICES_CATEGORY_LABEL,
  ]);
});

Deno.test("deriveBestPracticeLabels - mixed severities select highest", () => {
  // low + high + medium → highest is high.
  assertEquals(
    deriveBestPracticeLabels([
      findingWith("low"),
      findingWith("high"),
      findingWith("medium"),
    ]),
    ["severity:high", BEST_PRACTICES_CATEGORY_LABEL],
  );
  // medium + low → highest is medium.
  assertEquals(
    deriveBestPracticeLabels([findingWith("medium"), findingWith("low")]),
    ["severity:medium", BEST_PRACTICES_CATEGORY_LABEL],
  );
});

Deno.test("deriveBestPracticeLabels - empty findings yields category only", () => {
  assertEquals(deriveBestPracticeLabels([]), [BEST_PRACTICES_CATEGORY_LABEL]);
});

Deno.test("buildIssueBody - includes title, marker, and finding details", () => {
  const findings = [fakeFinding("ci.yml", 0)];
  const body = buildIssueBody("owner/repo", findings);
  assertStringIncludes(body, "Workflow best-practice findings");
  assertStringIncludes(body, "owner/repo");
  assertStringIncludes(body, "pr-creator-token");
  assertStringIncludes(body, "ci.yml");
  assertStringIncludes(body, "Line:** 10");
  assertStringIncludes(body, "Use ACTIONS_PUSH fallback.");
  assertStringIncludes(body, BEST_PRACTICES_MARKER);
});

Deno.test(
  "buildIssueBody - includes Mermaid diagram when there are 3+ findings",
  () => {
    const findings = [
      fakeFinding("a.yml", 0),
      fakeFinding("b.yml", 1),
      fakeFinding("c.yml", 2),
    ];
    const body = buildIssueBody("owner/repo", findings);
    assertStringIncludes(body, "```mermaid");
    assertStringIncludes(body, "flowchart LR");
    assertStringIncludes(body, "a.yml");
    assertStringIncludes(body, "b.yml");
    assertStringIncludes(body, "c.yml");
  },
);

Deno.test(
  "buildIssueBody - omits Mermaid diagram when there are fewer than 3 findings",
  () => {
    const findings = [fakeFinding("a.yml", 0), fakeFinding("b.yml", 1)];
    const body = buildIssueBody("owner/repo", findings);
    assertEquals(body.includes("```mermaid"), false);
  },
);

Deno.test("buildMermaidDiagram - deduplicates affected workflow filenames", () => {
  const findings = [
    fakeFinding("ci.yml", 0),
    fakeFinding("ci.yml", 1),
    fakeFinding("release.yml", 2),
  ];
  const diagram = buildMermaidDiagram(findings);
  // ci.yml appears as a single node (deduplicated), release.yml once.
  const ciMatches = diagram.match(/"ci\.yml"/g) ?? [];
  const relMatches = diagram.match(/"release\.yml"/g) ?? [];
  assertEquals(ciMatches.length, 1);
  assertEquals(relMatches.length, 1);
});

Deno.test("buildUpdateCommentBody - includes finding count and marker", () => {
  const body = buildUpdateCommentBody([fakeFinding("ci.yml", 0)]);
  assertStringIncludes(body, "1 finding");
  assertStringIncludes(body, "pr-creator-token");
  assertStringIncludes(body, BEST_PRACTICES_MARKER);
});
