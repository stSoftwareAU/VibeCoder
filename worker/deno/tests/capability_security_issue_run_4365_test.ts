/**
 * A real issue run inspects the checkout and passes that set into
 * `buildIssuePrompt` (Issue #4365). Selection is not the issue title, body
 * and labels alone. A later signal renders the capability it matches.
 * A docs-only task that names no matching signal stays free of the bundle.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

interface Inspection {
  entryPoints?: string[];
  imports?: string[];
  callers?: string[];
  sinks?: string[];
}

async function runPhase(options: {
  workDir: string;
  title: string;
  body: string;
}): Promise<Inspection | undefined> {
  let seen: Inspection | undefined;
  const deps = {
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: {
          exitCode: 0,
          output: "Implementation complete.",
          timedOut: false,
        },
      }),
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "system", prompt: "prompt" },
      }),
    buildCachedIssuePrompt: (opts) => {
      seen = opts.capabilityInspection as Inspection | undefined;
      return Promise.resolve({
        ok: true,
        value: {
          systemPrompt: "system",
          prompt: "prompt",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      });
    },
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: (args) => {
      if (args[0] === "status") {
        return Promise.resolve({ ok: true, value: "M src/worker.ts" });
      }
      if (args[0] === "log") {
        return Promise.resolve({ ok: true, value: "abc1234" });
      }
      return Promise.resolve({ ok: true, value: "" });
    },
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: () => {},
  } as ExecuteClaudePhaseDeps;
  const phase: ExecuteClaudePhaseOptions = {
    repo: "owner/widget",
    issueNumber: 4365,
    issueTitle: options.title,
    issueBody: options.body,
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-4365-widget",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: options.workDir,
    includeRecentActivity: false,
    includeCodebaseMap: false,
    codegraphContextEnabled: false,
    rtkOutputEnabled: false,
  };
  const result = await runExecuteClaudePhase(phase, deps);
  assertEquals(result.action, "success");
  return seen;
}

async function rendered(inspection: Inspection | undefined): Promise<string> {
  const result = await buildIssuePrompt({
    repo: "owner/widget",
    issueNumber: "4365",
    issueTitle: "Correct a spelling in the readme",
    issueBody: "The word colour was misspelled.",
    issueLabels: "",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
    capabilityInspection: inspection,
  });
  if (!result.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : result.error.message,
    );
  }
  return result.value.prompt;
}

Deno.test("an issue run inspects entry points, imports, config and callers, and a later signal is rendered", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "capsec-issue-" });
  const repoDir = `${workDir}/widget/src`;
  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.writeTextFile(
    `${repoDir}/worker.ts`,
    'export const name = "worker";\n',
  );
  await Deno.writeTextFile(
    `${repoDir}/deno.json`,
    JSON.stringify({ imports: { child: "node:child_process" } }) + "\n",
  );
  await Deno.writeTextFile(
    `${repoDir}/main.ts`,
    'import { name } from "./worker.ts";\nexport const used = name;\n',
  );
  try {
    const first = await runPhase({
      workDir,
      title: "Correct a spelling in the readme",
      body: "Touch src/worker.ts only to keep the name.",
    });
    assert(first, "the issue run did not pass an inspection");
    assert(
      first.entryPoints?.includes("src/worker.ts"),
      `entry points: ${JSON.stringify(first.entryPoints)}`,
    );
    assert(
      first.imports?.some((item) => item.includes("node:child_process")),
      `imports: ${JSON.stringify(first.imports)}`,
    );
    assert(
      first.callers?.some((item) => item.endsWith("src/main.ts")),
      `callers: ${JSON.stringify(first.callers)}`,
    );
    const before = await rendered(first);
    assertStringIncludes(before, "capsec-safe-execution");
    assertStringIncludes(
      before,
      "Pass arguments as a list to the platform process API",
    );
    assertEquals(before.includes("### capsec-outbound-url"), false);
    assertEquals(before.includes("explicit host allowlist"), false);

    await Deno.writeTextFile(
      `${repoDir}/net.ts`,
      "export function load(url: string) {\n  return fetch(url);\n}\n",
    );
    const second = await runPhase({
      workDir,
      title: "Correct a spelling in the readme",
      body: "Touch src/worker.ts and src/net.ts.",
    });
    const after = await rendered(second);
    assertStringIncludes(after, "capsec-outbound-url");
    assertStringIncludes(after, "explicit host allowlist");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("a docs-only issue run with no matching signal stays free of the bundle and still says to re-evaluate", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "capsec-docs-" });
  const repoDir = `${workDir}/widget/src`;
  await Deno.mkdir(repoDir, { recursive: true });
  await Deno.writeTextFile(
    `${repoDir}/worker.ts`,
    'import { spawn } from "node:child_process";\nexport const name = spawn;\n',
  );
  try {
    const inspection = await runPhase({
      workDir,
      title: "Correct a spelling in the readme",
      body: "The word colour was misspelled in the readme.",
    });
    const prompt = await rendered(inspection);
    assertEquals(prompt.includes("capsec-"), false);
    assertEquals(prompt.includes("Capability-scoped"), false);
    assertStringIncludes(prompt, "Re-evaluate applicability");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
