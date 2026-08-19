/**
 * Tests for container/install-providers.sh — installing a *set* of
 * coding-agent providers in one image (Issue #4105, parent #4102).
 *
 * Quorum mode needs Claude, Codex and Gemini resident in the same worker
 * container, so the build takes a comma-separated set rather than one id.
 * Every test executes the real script against a temporary fragment directory
 * and asserts on its exit code, its stderr, and which fragments actually ran —
 * never on the script's source text.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The script the Containerfile runs to install the requested provider set. */
const INSTALLER = `${REPO_ROOT}/container/install-providers.sh`;

interface InstallerRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Provider ids whose fragment actually ran, in the order they ran. */
  installed: string[];
}

/** A fragment directory holding a stub fragment per given id. */
async function fragmentDir(
  ids: string[],
  options: { failing?: string } = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-providers-" });
  for (const id of ids) {
    const body = options.failing === id
      ? `echo "[${id}] download failed" >&2\nexit 7\n`
      : `printf '%s\\n' "${id} ${AGENT_PROVIDER_MANIFEST_MARKER}" ` +
        `>> "\${ORDER_LOG}"\n`;
    await Deno.writeTextFile(
      `${dir}/${id}.sh`,
      `#!/usr/bin/env bash\nset -euo pipefail\n${body}`,
    );
  }
  return dir;
}

/**
 * Written by each stub fragment so the manifest hand-off is observable: the
 * Containerfile passes the manifest path in the environment and every
 * fragment reads its pins from it.
 */
const AGENT_PROVIDER_MANIFEST_MARKER = "${AGENT_PROVIDER_MANIFEST:-unset}";

/** Run the installer for a requested set against a fragment directory. */
async function runInstaller(
  requested: string | undefined,
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<InstallerRun> {
  const log = `${dir}/installed.log`;
  const result = await new Deno.Command("bash", {
    args: requested === undefined ? [INSTALLER] : [INSTALLER, requested],
    env: { PROVIDER_DIR: dir, ORDER_LOG: log, ...extraEnv },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  let installed: string[] = [];
  try {
    installed = (await Deno.readTextFile(log)).split("\n").filter((l) =>
      l !== ""
    );
  } catch {
    installed = [];
  }

  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    installed,
  };
}

/** Provider ids from the installed log, dropping the manifest marker. */
function idsOf(installed: string[]): string[] {
  return installed.map((line) => line.split(" ")[0]!);
}

// ---------------------------------------------------------------------------
// A set of providers, installed in a stable order
// ---------------------------------------------------------------------------

Deno.test("install-providers - installs every requested provider in the requested order", async () => {
  const dir = await fragmentDir(["claude", "codex", "gemini"]);
  try {
    const run = await runInstaller("claude,codex,gemini", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), ["claude", "codex", "gemini"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - a single-provider set installs only that provider", async () => {
  const dir = await fragmentDir(["claude", "codex", "gemini"]);
  try {
    const run = await runInstaller("claude", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), ["claude"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - surrounding whitespace in the set is tolerated", async () => {
  const dir = await fragmentDir(["claude", "codex"]);
  try {
    const run = await runInstaller(" claude , codex ", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), ["claude", "codex"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - each fragment receives the manifest path", async () => {
  const dir = await fragmentDir(["claude"]);
  try {
    const run = await runInstaller("claude", dir, {
      AGENT_PROVIDER_MANIFEST: "/tmp/agent-provider-manifest.json",
    });
    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.installed, [
      "claude /tmp/agent-provider-manifest.json",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Every malformed set fails loud, naming the fragments that do exist
// ---------------------------------------------------------------------------

Deno.test("install-providers - an unknown id aborts naming the available fragments", async () => {
  const dir = await fragmentDir(["claude", "codex"]);
  try {
    const run = await runInstaller("claude,gemini", dir);
    assert(run.code !== 0, "an unknown provider id must abort the build");
    assertStringIncludes(run.stderr, "gemini");
    assertStringIncludes(run.stderr, "Supported providers");
    assertStringIncludes(run.stderr, "claude");
    assertStringIncludes(run.stderr, "codex");
    assertEquals(
      run.installed,
      [],
      "the whole set is rejected before anything is installed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - a duplicate id aborts rather than installing twice", async () => {
  const dir = await fragmentDir(["claude", "codex"]);
  try {
    const run = await runInstaller("claude,codex,claude", dir);
    assert(run.code !== 0, "a duplicate provider id must abort the build");
    assertStringIncludes(run.stderr, "claude");
    assertStringIncludes(run.stderr.toLowerCase(), "duplicate");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - an empty set aborts rather than installing nothing silently", async () => {
  const dir = await fragmentDir(["claude"]);
  try {
    for (const empty of ["", "   ", ",", "claude,,codex"]) {
      const run = await runInstaller(empty, dir);
      assert(
        run.code !== 0,
        `an empty entry in ${JSON.stringify(empty)} must abort the build`,
      );
      assertEquals(run.installed, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - a missing argument aborts", async () => {
  const dir = await fragmentDir(["claude"]);
  try {
    const run = await runInstaller(undefined, dir);
    assert(run.code !== 0, "no provider set at all must abort the build");
    assertStringIncludes(run.stderr, "AGENT_PROVIDERS");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - a malformed id is rejected before any fragment path is built", async () => {
  const dir = await fragmentDir(["claude"]);
  try {
    for (const bad of ["Claude", "claude code", "../claude", "claude.sh"]) {
      const run = await runInstaller(`${bad}`, dir);
      assert(run.code !== 0, `${bad} must be rejected as a provider id`);
      assertStringIncludes(run.stderr, "lower-case");
      assertEquals(run.installed, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-providers - a fragment that fails aborts, naming the provider", async () => {
  const dir = await fragmentDir(["claude", "codex"], { failing: "codex" });
  try {
    const run = await runInstaller("claude,codex", dir);
    assert(run.code !== 0, "a failing fragment must abort the build");
    assertStringIncludes(run.stderr, "codex");
    assertEquals(
      idsOf(run.installed),
      ["claude"],
      "the fragments before the failure still ran",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The committed fragment directory
// ---------------------------------------------------------------------------

Deno.test("container/ - every committed fragment is a selectable provider id", async () => {
  const ids: string[] = [];
  for await (const entry of Deno.readDir(`${REPO_ROOT}/container/providers`)) {
    if (!entry.isFile) continue;
    assert(
      entry.name.endsWith(".sh"),
      `container/providers/${entry.name} is not a fragment — the build lists ` +
        `this directory to report the available provider ids`,
    );
    const id = entry.name.slice(0, -".sh".length);
    assert(
      /^[a-z][a-z0-9-]*$/.test(id),
      `container/providers/${entry.name} is not selectable: "${id}" is not a ` +
        `lower-case provider id`,
    );
    ids.push(id);
  }
  assert(ids.length > 0, "container/providers must ship at least one fragment");
});
