/**
 * Tests for commands/provider_feasibility.ts — the `provider-feasibility`
 * command (Issue #3647).
 *
 * The command is driven through `runProviderFeasibility` with fake
 * `runVersion` and `readCodexQuota` seams, so no real CLI runs and no quota is
 * read. Credential files, `auth.json`, and the script the version probe runs
 * are real files in throwaway directories, so the billing and child-environment
 * checks see what production would see.
 *
 * The probes must never leak a credential value, so every test that carries
 * one asserts it is absent from the message.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type FeasibilityProbeDeps,
  gatherProviderHostFacts,
  providerFeasibilityCommand,
  readCodexQuotaVisibility,
  readOptionalTextFile,
  runCliVersion,
  runProviderFeasibility,
} from "../commands/provider_feasibility.ts";
import type { FeasibilityRow } from "../lib/provider_feasibility.ts";
import type { CommandResult } from "../types.ts";

/** A throwaway OpenAI-shaped key that must never reach the output. */
const OPENAI_KEY = "sk-test-feasibility-0123456789abcdefghijklmnop";

/** A throwaway Claude OAuth token that must never reach the output. */
const CLAUDE_TOKEN = "sk-ant-oat01-feasibility-test-token";

/** What the fake probes recorded. */
interface Recorder {
  readonly versionBinaries: string[];
  readonly quotaHomes: string[];
}

/** Throwaway directories, removed in `finally`. */
async function withDirs(
  run: (dirs: { workDir: string; credentialDir: string }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "provider-feasibility-" });
  try {
    const workDir = `${root}/work`;
    const credentialDir = `${root}/credentials`;
    await Deno.mkdir(workDir, { recursive: true });
    await Deno.mkdir(credentialDir, { recursive: true });
    await run({ workDir, credentialDir });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Probe seams: real file reads, fake CLI and quota probes that record calls. */
function fakeDeps(
  dirs: { workDir: string; credentialDir: string },
  env: Record<string, string>,
  recorder: Recorder,
): FeasibilityProbeDeps {
  return {
    env,
    workDir: dirs.workDir,
    credentialDir: dirs.credentialDir,
    readTextFile: (path) => {
      try {
        return Deno.readTextFileSync(path);
      } catch {
        return null;
      }
    },
    runVersion: (binary) => {
      recorder.versionBinaries.push(binary);
      return Promise.resolve({
        ok: true,
        version: `${binary} 1.0`,
        detail: "ok",
      });
    },
    readCodexQuota: (codexHome) => {
      recorder.quotaHomes.push(codexHome);
      return Promise.resolve({ visible: false, detail: "fake quota" });
    },
  };
}

/** A fresh recorder. */
function newRecorder(): Recorder {
  return { versionBinaries: [], quotaHomes: [] };
}

/** The rows of a successful run, asserting that there are some. */
function rowsOf(
  result: CommandResult<{ rows: FeasibilityRow[] }>,
): FeasibilityRow[] {
  assert(result.success, `expected success, got: ${result.message}`);
  assert(result.data, "expected data");
  return result.data.rows;
}

Deno.test("an unknown provider fails and names it", async () => {
  await withDirs(async (dirs) => {
    const result = await runProviderFeasibility(
      { providers: "nope" },
      fakeDeps(dirs, {}, newRecorder()),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "nope");
  });
});

Deno.test("a malformed model spec fails and names it", async () => {
  await withDirs(async (dirs) => {
    const result = await runProviderFeasibility(
      { providers: "claude", models: "claude:" },
      fakeDeps(dirs, {}, newRecorder()),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "claude:");
  });
});

Deno.test("a model for an unselected provider fails and names the provider", async () => {
  await withDirs(async (dirs) => {
    const result = await runProviderFeasibility(
      { providers: "claude", models: "codex:gpt-5" },
      fakeDeps(dirs, {}, newRecorder()),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "codex");
  });
});

Deno.test("a hostile model spec is rejected quickly without backtracking", async () => {
  await withDirs(async (dirs) => {
    const hostile = "a".repeat(5000) + "!";
    const started = performance.now();
    const bare = await runProviderFeasibility(
      { providers: "claude", models: hostile },
      fakeDeps(dirs, {}, newRecorder()),
    );
    const prefixed = await runProviderFeasibility(
      { providers: "claude", models: `claude:${hostile}` },
      fakeDeps(dirs, {}, newRecorder()),
    );
    assertEquals(bare.success, false);
    assertEquals(prefixed.success, false);
    assert(performance.now() - started < 1000, "spec validation was slow");
  });
});

Deno.test("codex with a metered key in the environment is blocked and the key stays out", async () => {
  await withDirs(async (dirs) => {
    const result = await runProviderFeasibility(
      { providers: "codex" },
      fakeDeps(dirs, { OPENAI_API_KEY: OPENAI_KEY }, newRecorder()),
    );
    const rows = rowsOf(result);
    assert(rows.length > 0);
    for (const row of rows.filter((entry) => entry.provider === "codex")) {
      assert(row.blockers.includes("billing-metered (OPENAI_API_KEY)"));
      assert(
        row.blockers.includes(
          "metered-credential-reaches-child (OPENAI_API_KEY)",
        ),
      );
    }
    assertEquals(result.message.includes(OPENAI_KEY), false);
  });
});

Deno.test("codex with a persisted ChatGPT login withholds the metered key from the child", async () => {
  await withDirs(async (dirs) => {
    const codexHome = `${dirs.workDir}/codex-home`;
    await Deno.mkdir(codexHome, { recursive: true });
    await Deno.writeTextFile(
      `${codexHome}/auth.json`,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { id_token: "x", access_token: "y", refresh_token: "z" },
      }),
    );
    const recorder = newRecorder();
    const result = await runProviderFeasibility(
      { providers: "codex", "codex-home": codexHome },
      fakeDeps(dirs, { OPENAI_API_KEY: OPENAI_KEY }, recorder),
    );
    const rows = rowsOf(result);
    const codexRows = rows.filter((entry) => entry.provider === "codex");
    assert(codexRows.length > 0);
    for (const row of codexRows) {
      assertEquals(
        row.blockers.some((blocker) => blocker.startsWith("billing-")),
        false,
      );
      assertEquals(
        row.blockers.some((blocker) =>
          blocker.startsWith("metered-credential-reaches-child")
        ),
        false,
      );
    }
    assertEquals(recorder.quotaHomes, [codexHome]);
    assertEquals(result.message.includes(OPENAI_KEY), false);
  });
});

Deno.test("claude credentials read from provider.env clear the billing blocker", async () => {
  await withDirs(async (dirs) => {
    await Deno.mkdir(`${dirs.credentialDir}/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dirs.credentialDir}/claude/provider.env`,
      `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n`,
    );
    const result = await runProviderFeasibility(
      { providers: "claude" },
      fakeDeps(dirs, {}, newRecorder()),
    );
    const rows = rowsOf(result);
    assert(rows.length > 0);
    for (const row of rows) {
      assertEquals(
        row.blockers.some((blocker) => blocker.startsWith("billing-")),
        false,
      );
    }
    assertEquals(result.message.includes(CLAUDE_TOKEN), false);
  });
});

Deno.test("claude with no credential file and an empty environment is billing-unknown", async () => {
  await withDirs(async (dirs) => {
    const result = await runProviderFeasibility(
      { providers: "claude" },
      fakeDeps(dirs, {}, newRecorder()),
    );
    const rows = rowsOf(result);
    const claudeRows = rows.filter((entry) => entry.provider === "claude");
    assert(claudeRows.length > 0);
    for (const row of claudeRows) {
      assert(
        row.blockers.includes(
          "billing-unknown (subscription-credential-missing)",
        ),
      );
    }
  });
});

Deno.test("the read-only line is present and runVersion runs once per provider", async () => {
  await withDirs(async (dirs) => {
    const recorder = newRecorder();
    const result = await runProviderFeasibility(
      { providers: "claude,codex" },
      fakeDeps(dirs, {}, recorder),
    );
    rowsOf(result);
    assertEquals(recorder.versionBinaries, ["claude", "codex"]);
    assertStringIncludes(
      result.message,
      "[feasibility] read-only: ran `claude --version`, `codex --version` per provider; no model turn, no GitHub call, no file written",
    );
  });
});

Deno.test("runCliVersion reports a nonexistent binary as not on PATH", async () => {
  await withDirs(async (dirs) => {
    const result = await runCliVersion(
      `${dirs.workDir}/does-not-exist`,
      { PATH: "/usr/bin:/bin" },
    );
    assertEquals(result, { ok: false, detail: "not on PATH" });
  });
});

Deno.test("runCliVersion returns the first line of a real executable's output", async () => {
  await withDirs(async (dirs) => {
    const script = `${dirs.workDir}/fake-cli`;
    await Deno.writeTextFile(
      script,
      '#!/bin/sh\necho "codex-cli 0.147.0"\n',
    );
    await Deno.chmod(script, 0o755);
    const result = await runCliVersion(script, { PATH: "/usr/bin:/bin" });
    assertEquals(result, {
      ok: true,
      version: "codex-cli 0.147.0",
      detail: "ok",
    });
  });
});

Deno.test("runCliVersion reports a non-zero exit with its code", async () => {
  await withDirs(async (dirs) => {
    const script = `${dirs.workDir}/failing-cli`;
    await Deno.writeTextFile(script, "#!/bin/sh\nexit 3\n");
    await Deno.chmod(script, 0o755);
    const result = await runCliVersion(script, { PATH: "/usr/bin:/bin" });
    assertEquals(result, { ok: false, detail: "exit 3" });
  });
});

Deno.test("readCodexQuotaVisibility with no CODEX_HOME reports not visible", async () => {
  const result = await readCodexQuotaVisibility("");
  assertEquals(result, { visible: false, detail: "no CODEX_HOME" });
});

Deno.test("readCodexQuotaVisibility on an empty CODEX_HOME reports the adapter's reason", async () => {
  const home = await Deno.makeTempDir({ prefix: "provider-feasibility-home-" });
  try {
    const result = await readCodexQuotaVisibility(home);
    assertEquals(result.visible, false);
    assert(result.detail.length > 0, "expected the adapter's reason");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("gatherProviderHostFacts throws for an unregistered provider", async () => {
  await withDirs(async (dirs) => {
    let thrown: unknown;
    try {
      await gatherProviderHostFacts("nope", fakeDeps(dirs, {}, newRecorder()));
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error);
    assertStringIncludes(thrown.message, "nope");
  });
});

Deno.test("the command is registered under provider-feasibility", () => {
  assertEquals(providerFeasibilityCommand.name, "provider-feasibility");
});

Deno.test("readOptionalTextFile returns null for a missing path", async () => {
  const dir = await Deno.makeTempDir({
    prefix: "provider-feasibility-absent-",
  });
  try {
    assertEquals(readOptionalTextFile(`${dir}/absent.env`), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readOptionalTextFile throws naming the path when it is a directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "provider-feasibility-dir-" });
  try {
    let thrown: unknown;
    try {
      readOptionalTextFile(dir);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, "expected a thrown Error");
    assertStringIncludes(thrown.message, "is unreadable");
    assertStringIncludes(thrown.message, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readOptionalTextFile returns the content of a real file", async () => {
  await withDirs(async ({ workDir }) => {
    const path = `${workDir}/provider.env`;
    await Deno.writeTextFile(path, "CLAUDE_CODE_OAUTH_TOKEN=abc\n");
    assertEquals(readOptionalTextFile(path), "CLAUDE_CODE_OAUTH_TOKEN=abc\n");
  });
});
