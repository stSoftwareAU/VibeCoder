/**
 * The repository's declared `quality_credentials` reach the milestone gates
 * from every production caller (PR #4703 review): the pre-cut sync, the sweep
 * and the sweep's rebuild gate.
 *
 * Each case runs the production caller with a config that mints
 * `WIRING_TOKEN`, takes the gate the caller hands out, and runs it over a Deno
 * tree whose `check` task fails unless the child holds that token. The same
 * caller with no declared credentials is the control: its gate must fail, so
 * a green result can only come from the credential reaching the child.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type IssueRunPresyncArgs,
  presyncMilestoneBranchForIssueRun,
} from "../lib/milestone_presync.ts";
import {
  rebuildGateForSweep,
  syncMilestoneBranchForSweep,
} from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  checkMergedTree,
  type MergeGateFn,
} from "../lib/milestone_merge_gate.ts";
import type { RepoCredentialSpec } from "../lib/repo_credentials.ts";
import type { Logger, WorkerConfig } from "../types.ts";

const REPO = "owner/repo";
const MILESTONE = "milestone/4703-credential-wiring";
const MINT: RepoCredentialSpec = {
  mint: "printf 'WIRING_TOKEN=minted-4703\\n'",
};

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

/** A work directory holding `repo`, a Deno tree whose check needs the token. */
async function workDirWithTree(): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "pr-4703-wiring-" });
  // The gates run as the untrusted account, which must be able to read this.
  await Deno.chmod(workDir, 0o755);
  const tree = `${workDir}/repo`;
  await Deno.mkdir(tree);
  await Deno.chmod(tree, 0o755);
  const task = `${Deno.execPath()} run --allow-env check.ts`;
  await Deno.writeTextFile(
    `${tree}/deno.json`,
    JSON.stringify({ tasks: { check: task } }),
  );
  await Deno.writeTextFile(
    `${tree}/check.ts`,
    'if (Deno.env.get("WIRING_TOKEN") !== "minted-4703") {\n' +
      '  throw new Error("declared credential missing");\n}\n',
  );
  return workDir;
}

function configFor(
  workDir: string,
  qualityCredentials: RepoCredentialSpec | undefined,
): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir,
    repoConfig: qualityCredentials === undefined
      ? {}
      : { [REPO]: { qualityCredentials } },
  } as WorkerConfig;
}

/**
 * The merge gate the production sweep hands its sync for this config. With no
 * declared credentials it hands none, and the sync falls back to the default
 * gate, `checkMergedTree`.
 */
async function sweepGate(
  workDir: string,
  config: WorkerConfig,
): Promise<MergeGateFn> {
  let gate: MergeGateFn | undefined;
  await syncMilestoneBranchForSweep({
    repo: REPO,
    milestoneBranch: MILESTONE,
    defaultBranch: "main",
    syncOptions: { agentAllowed: false },
    workDir,
    config,
    logger: silentLogger,
    syncFn: ((...args: unknown[]) => {
      gate = args[4] as MergeGateFn | undefined;
      return Promise.resolve({ ok: true as const, value: { message: "" } });
    }) as unknown as NonNullable<
      Parameters<typeof syncMilestoneBranchForSweep>[0]["syncFn"]
    >,
  });
  return gate ?? ((dir) => checkMergedTree(dir));
}

/** The merge gate the production pre-cut sync hands its sync for this config. */
async function presyncGate(
  workDir: string,
  config: WorkerConfig,
): Promise<MergeGateFn> {
  let gate: MergeGateFn | undefined;
  await presyncMilestoneBranchForIssueRun(
    {
      repo: REPO,
      milestoneTitle: "#4703 credential wiring",
      milestoneBranch: MILESTONE,
      defaultBranch: "main",
      cwd: `${workDir}/repo`,
      workDir,
      config,
      logger: silentLogger,
      countCommitsAheadFn: () =>
        Promise.resolve({ ok: true as const, value: 2 }),
      heavyBuildAdmissionFn: () => Promise.resolve({ mode: "build" as const }),
      syncMilestoneBranchFn: ((...args: unknown[]) => {
        gate = args[4] as MergeGateFn | undefined;
        return Promise.resolve({ ok: true as const, value: { message: "" } });
      }) as unknown as IssueRunPresyncArgs["syncMilestoneBranchFn"],
      runAgentFn: (() =>
        Promise.resolve({
          ok: false as const,
          error: new Error("stub agent run"),
        })) as unknown as IssueRunPresyncArgs["runAgentFn"],
      runGitCommandFn: () =>
        Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout: "a".repeat(40), stderr: "" },
        }),
    } satisfies IssueRunPresyncArgs,
  );
  return gate ?? ((dir) => checkMergedTree(dir));
}

const CALLERS: Array<{
  name: string;
  gate: (workDir: string, config: WorkerConfig) => Promise<MergeGateFn>;
}> = [
  { name: "sweep sync", gate: sweepGate },
  { name: "pre-cut presync", gate: presyncGate },
  {
    name: "sweep rebuild gate",
    gate: (workDir, config) => {
      const rebuild = rebuildGateForSweep(workDir, config);
      return Promise.resolve(() => rebuild(REPO));
    },
  },
];

for (const caller of CALLERS) {
  Deno.test(`${caller.name} - the configured quality_credentials reach the gate, and without them it fails`, async () => {
    const workDir = await workDirWithTree();
    try {
      const tree = `${workDir}/repo`;
      const withCredentials = await caller.gate(
        workDir,
        configFor(workDir, MINT),
      );
      const passed = await withCredentials(tree);
      assertEquals(passed.status, "passed", passed.output);

      // Control: the same tree with nothing declared fails the same check, so
      // the pass above came from the credential and not from a lenient gate.
      const without = await caller.gate(workDir, configFor(workDir, undefined));
      const failed = await without(tree);
      assertEquals(failed.status, "failed", failed.output);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}

Deno.test("sweep rebuild gate - a mint failure refuses the rebuilt tree instead of checking it bare", async () => {
  const workDir = await workDirWithTree();
  try {
    const gate = rebuildGateForSweep(
      workDir,
      configFor(workDir, { mint: "exit 23" }),
    );
    const outcome = await gate(REPO);
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.detail, "repository credential resolution failed");
    assertEquals(outcome.output.includes("Minting credentials"), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
