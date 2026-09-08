/**
 * Tests for container/install-toolchains.sh — installing a *set* of
 * monitored-repository toolchains from manifest-driven fragments
 * (Issue #1594, parent #1574).
 *
 * The fetch-verify-extract toolchains moved out of the Containerfile so the
 * comment-stripped definition stays under Apple container's size cap, so the
 * build now selects them the way it selects coding-agent providers: one
 * fragment per id, the whole set validated before anything is installed.
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

/** The script the Containerfile runs to install the requested toolchain set. */
const INSTALLER = `${REPO_ROOT}/container/install-toolchains.sh`;

interface InstallerRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Toolchain ids whose fragment actually ran, in the order they ran. */
  installed: string[];
}

/**
 * Written by each stub fragment so the manifest hand-off is observable: the
 * Containerfile passes the manifest path in the environment and every
 * fragment reads its pins from it.
 */
const TOOLCHAIN_MANIFEST_MARKER = "${TOOLCHAIN_MANIFEST:-unset}";

/**
 * A fragment directory holding a stub fragment per given id, beside a
 * manifest that pins each id the caller asks to be pinned.
 *
 * `pinned` defaults to the fragment ids, so the common case is a directory
 * whose fragments the manifest agrees with; the cases below vary one half at
 * a time.
 */
async function fragmentDir(
  ids: string[],
  options: { failing?: string; pinned?: string[] } = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-toolchains-" });
  for (const id of ids) {
    const body = options.failing === id
      ? `echo "[${id}] download failed" >&2\nexit 7\n`
      : `printf '%s\\n' "${id} ${TOOLCHAIN_MANIFEST_MARKER}" ` +
        `>> "\${ORDER_LOG}"\n`;
    await Deno.writeTextFile(
      `${dir}/${id}.sh`,
      `#!/usr/bin/env bash\nset -euo pipefail\n${body}`,
    );
  }
  await Deno.writeTextFile(
    `${dir}/tools.json`,
    JSON.stringify({
      toolchains: (options.pinned ?? ids).map((id) => ({
        id,
        version: "1.0.0",
        fragment: `toolchains/${id}.sh`,
      })),
    }),
  );
  return dir;
}

/** Run the installer for a requested set against a fragment directory. */
async function runInstaller(
  requested: string | undefined,
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<InstallerRun> {
  const log = `${dir}/installed.log`;
  const result = await new Deno.Command("bash", {
    args: requested === undefined ? [INSTALLER] : [INSTALLER, requested],
    env: {
      TOOLCHAIN_DIR: dir,
      TOOLCHAIN_MANIFEST: `${dir}/tools.json`,
      ORDER_LOG: log,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  // No log means no fragment ran, which is what the error cases assert on.
  // Only that one cause may be read as "nothing ran": any other read failure
  // would otherwise make those assertions pass for the wrong reason.
  let installed: string[] = [];
  try {
    installed = (await Deno.readTextFile(log)).split("\n").filter((l) =>
      l !== ""
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    installed,
  };
}

/** Toolchain ids from the installed log, dropping the manifest marker. */
function idsOf(installed: string[]): string[] {
  return installed.map((line) => line.split(" ")[0]!);
}

// ---------------------------------------------------------------------------
// A set of toolchains, installed in a stable order
// ---------------------------------------------------------------------------

Deno.test("install-toolchains - installs every requested toolchain in the requested order", async () => {
  const dir = await fragmentDir(["shellcheck", "actionlint", "cargo-deny"]);
  try {
    const run = await runInstaller("shellcheck,actionlint,cargo-deny", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), [
      "shellcheck",
      "actionlint",
      "cargo-deny",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - a single-toolchain set installs only that toolchain", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"]);
  try {
    const run = await runInstaller("rust", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), ["rust"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - surrounding whitespace in the set is tolerated", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"]);
  try {
    const run = await runInstaller(" shellcheck , rust ", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(idsOf(run.installed), ["shellcheck", "rust"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - each fragment receives the manifest path", async () => {
  const dir = await fragmentDir(["shellcheck"]);
  try {
    const run = await runInstaller("shellcheck", dir);
    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.installed, [`shellcheck ${dir}/tools.json`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Every malformed set fails loud, naming the fragments that do exist
// ---------------------------------------------------------------------------

Deno.test("install-toolchains - an unknown id aborts naming the available fragments", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"]);
  try {
    const run = await runInstaller("shellcheck,actionlint", dir);
    assert(run.code !== 0, "an unknown toolchain id must abort the build");
    assertStringIncludes(run.stderr, "actionlint");
    assertStringIncludes(run.stderr, "Supported toolchains");
    assertStringIncludes(run.stderr, "shellcheck");
    assertStringIncludes(run.stderr, "rust");
    assertEquals(
      run.installed,
      [],
      "the whole set is rejected before anything is installed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - an id the manifest does not pin aborts", async () => {
  // The fragment exists, but nothing pins its version: installing it would
  // put an unpinned toolchain in the image.
  const dir = await fragmentDir(["shellcheck", "rust"], {
    pinned: ["shellcheck"],
  });
  try {
    const run = await runInstaller("shellcheck,rust", dir);
    assert(run.code !== 0, "an unpinned toolchain id must abort the build");
    assertStringIncludes(run.stderr, "rust");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - an unreadable manifest is reported as such, not as an unpinned id", async () => {
  // Invalid JSON reaching the per-id query would be reported as "not pinned
  // with a fragment", sending the reader to container/tools.json's toolchains
  // list rather than to the file that is actually broken.
  const dir = await fragmentDir(["rust"]);
  try {
    await Deno.writeTextFile(`${dir}/tools.json`, "{ this is not json");
    const run = await runInstaller("rust", dir);
    assert(run.code !== 0, "an unreadable manifest must abort the build");
    assertStringIncludes(run.stderr, "not readable JSON");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - a missing manifest aborts rather than installing unpinned", async () => {
  const dir = await fragmentDir(["shellcheck"]);
  try {
    const run = await runInstaller("shellcheck", dir, {
      TOOLCHAIN_MANIFEST: `${dir}/absent.json`,
    });
    assert(run.code !== 0, "an absent manifest must abort the build");
    assertStringIncludes(run.stderr, "absent.json");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - a duplicate id aborts rather than installing twice", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"]);
  try {
    const run = await runInstaller("shellcheck,rust,shellcheck", dir);
    assert(run.code !== 0, "a duplicate toolchain id must abort the build");
    assertStringIncludes(run.stderr, "shellcheck");
    assertStringIncludes(run.stderr.toLowerCase(), "duplicate");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - an empty set aborts rather than installing nothing silently", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"]);
  try {
    for (const empty of ["", "   ", ",", "shellcheck,,rust"]) {
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

Deno.test("install-toolchains - a missing argument aborts", async () => {
  const dir = await fragmentDir(["shellcheck"]);
  try {
    const run = await runInstaller(undefined, dir);
    assert(run.code !== 0, "no toolchain set at all must abort the build");
    assertStringIncludes(run.stderr.toLowerCase(), "toolchain");
    assertEquals(run.installed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - a malformed id is rejected before any fragment path is built", async () => {
  const dir = await fragmentDir(["shellcheck"]);
  try {
    for (const bad of ["Rust", "cargo deny", "../rust", "rust.sh"]) {
      const run = await runInstaller(bad, dir);
      assert(run.code !== 0, `${bad} must be rejected as a toolchain id`);
      assertStringIncludes(run.stderr, "lower-case");
      assertEquals(run.installed, []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("install-toolchains - a fragment that fails aborts, naming the toolchain", async () => {
  const dir = await fragmentDir(["shellcheck", "rust"], { failing: "rust" });
  try {
    const run = await runInstaller("shellcheck,rust", dir);
    assert(run.code !== 0, "a failing fragment must abort the build");
    assertStringIncludes(run.stderr, "rust");
    assertEquals(
      idsOf(run.installed),
      ["shellcheck"],
      "the fragments before the failure still ran",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/rust.sh - a missing component pin aborts before downloading", async () => {
  // rust.sh is the one fragment needing several checksums (rustc/cargo,
  // rustfmt and clippy are separate packages). Resolving a pin in *argument*
  // position would not trip `set -e`: jq's literal "null" would reach the
  // installer and only surface later as an unformatted-checksum error naming
  // no pin. Drop the checksum this architecture needs and the fragment must
  // stop at the lookup instead.
  const arch = new Deno.Command("uname", { args: ["-m"], stdout: "piped" });
  const machine = new TextDecoder().decode((await arch.output()).stdout).trim();
  const key = machine === "aarch64" ? "clippy_arm64" : "clippy_amd64";

  const dir = await Deno.makeTempDir();
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
    );
    const rust = manifest.toolchains.find((t: { id: string }) =>
      t.id === "rust"
    );
    assert(rust !== undefined, "container/tools.json must pin rust");
    assert(key in rust.sha256, `rust must pin ${key} before it is removed`);
    delete rust.sha256[key];
    await Deno.writeTextFile(
      `${dir}/tools.json`,
      JSON.stringify(manifest, null, 2),
    );

    // A curl that records being called, so "did it download?" is observable
    // rather than assumed. It exits 0, so only the fragment's own guard can
    // stop the run.
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\necho called >> "${dir}/curl.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/rust.sh`],
      env: {
        PATH: `${dir}/bin:${Deno.env.get("PATH") ?? ""}`,
        TOOLCHAIN_MANIFEST: `${dir}/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assertEquals(result.code, 1, "an unpinned component must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      `pins no sha256 for "${key}"`,
    );

    let downloaded = true;
    try {
      await Deno.stat(`${dir}/curl.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      downloaded = false;
    }
    assert(
      !downloaded,
      "the fragment downloaded before resolving its pins — a missing pin must " +
        "stop it at the lookup, naming the key",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
