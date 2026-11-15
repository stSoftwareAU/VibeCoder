/** Real-tool repair probe, launched by the containment suite (Issue #4930). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  productionBabysitterRepairDeps,
  runBabysitterRepair,
} from "../../commands/babysitter_repair.ts";
import { isBabysitterReady } from "../../lib/babysitter_ready.ts";
import { isGateInfrastructureResponse } from "../../lib/babysitter_tree_gate.ts";
import type { WorkerConfig } from "../../types.ts";
import { harness } from "./babysitter_harness.ts";
import { git } from "./babysitter_tree_fixture.ts";

export const BABYSITTER_GATE_PROBE_CASES = [
  "deno-red",
  "deno-green",
  "markdown-red",
  "markdown-green",
  "base-red",
  "invalid-config",
] as const;
type ProbeCase = typeof BABYSITTER_GATE_PROBE_CASES[number];

/** A disposable PR tree, prepared before its .git is mounted read-only. */
export async function prepareBabysitterGateProbe(dir: string, name: ProbeCase) {
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.mkdir(`${dir}/tests`);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Gate Probe");
  await git(dir, "config", "user.email", "probe@example.invalid");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ tasks: { "test:unit": "deno test" } }),
  );
  await Deno.writeTextFile(`${dir}/.markdownlint-cli2.jsonc`, "{}\n");
  await Deno.writeTextFile(`${dir}/lib/foo.ts`, "export const foo = 1;\n");
  await Deno.writeTextFile(
    `${dir}/tests/contract_test.ts`,
    'import { strict as assert } from "node:assert";\n' +
      'import { foo } from "../lib/foo.ts";\n' +
      `Deno.test("foo contract", () => assert.equal(foo, ${
        name === "base-red" ? 2 : 1
      }));\n`,
  );
  await Deno.writeTextFile(`${dir}/README.md`, "# Probe\n\nValid Markdown.\n");
  await git(
    dir,
    "add",
    "deno.json",
    ".markdownlint-cli2.jsonc",
    "lib",
    "tests",
    "README.md",
  );
  await git(dir, "commit", "-qm", "Disposable base");
  await git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (name === "invalid-config") {
    await Deno.writeTextFile(`${dir}/deno.json`, '{"tasks":');
  } else if (name.startsWith("markdown-")) {
    await Deno.writeTextFile(
      `${dir}/README.md`,
      name === "markdown-red" ? "#Probe\n" : "# Probe\n\nCorrected.\n",
    );
  } else {
    await Deno.writeTextFile(
      `${dir}/lib/foo.ts`,
      `export const foo = ${name === "deno-red" ? 2 : 1}; // repair\n`,
    );
  }
}

/** Keep the production gate and process runners; replace only agent services. */
async function verify(dir: string, name: ProbeCase) {
  let readOnly = false;
  try {
    await Deno.writeTextFile(`${dir}/.git/probe-must-not-write`, "refuse");
  } catch (error) {
    readOnly = String(error).includes("Read-only file system");
  }
  assert(readOnly, "the probe requires the production read-only .git mount");
  const root = await Deno.makeTempDir({ prefix: "babysitter-gate-probe-" });
  try {
    const prompt = `${root}/prompt.md`;
    await Deno.writeTextFile(prompt, "Disposable repair probe.\n");
    const result = await runBabysitterRepair({
      dir,
      "prompt-file": prompt,
      "response-file": `${dir}/.babysitter-response`,
      "base-branch": "refs/heads/main",
    }, {
      workDir: root,
      enabledAgentProviders: ["claude"],
    } as WorkerConfig, {
      ...productionBabysitterRepairDeps,
      exportSubscriptionCredentials: async () => [],
      chooseProvider: async () => ({
        providerId: "claude",
        overflow: false,
        env: {},
      }),
      runClaude: async () => ({
        ok: true,
        value: {
          exitCode: 0,
          output: "done\nBABYSITTER_READY\n",
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.success, true, result.message);
    const response = await Deno.readTextFile(`${dir}/.babysitter-response`);
    const ready = name.endsWith("green") || name === "base-red";
    assertEquals(isBabysitterReady(response), ready, response);
    assertEquals(isGateInfrastructureResponse(response), false, response);
    if (name === "deno-red") assertStringIncludes(response, "AssertionError");
    if (name === "markdown-red") assertStringIncludes(response, "MD018");
    if (name === "invalid-config") {
      assertStringIncludes(response, "cannot parse deno.json");
    }
    const host = harness(`${root}/host-state`);
    host.deps.classifyBaseFailure = async () => ({
      kind: "repair",
      reason: "the fixture's CI failure belongs to its PR head",
    });
    host.state.changes = true;
    host.state.agents.push({ response });
    let refused: unknown;
    try {
      await host.attempt();
    } catch (error) {
      refused = error;
    }
    assertEquals(host.state.pushed, ready ? 1 : 0, name);
    if (ready) assertEquals(refused, undefined);
    else assertStringIncludes(String(refused), "refusing to push");
    console.log(`babysitter gate probe ${name}: passed; ready=${ready}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

if (import.meta.main) {
  const [dir, name] = Deno.args;
  assert(dir && BABYSITTER_GATE_PROBE_CASES.includes(name as ProbeCase));
  await verify(dir, name as ProbeCase);
}
