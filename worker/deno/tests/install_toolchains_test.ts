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
 * The machine name the fragments would see inside the Linux build container.
 *
 * The fragments run `uname -m` and accept only `x86_64` and `aarch64`, the
 * Linux names. A developer Mac on Apple silicon reports `arm64` for the same
 * architecture, so every fragment test aborted there with "Unsupported build
 * architecture: arm64" before reaching the behaviour it asserts — the suite
 * passed on the Linux CI runner and failed on the laptop.
 */
async function containerMachine(): Promise<string> {
  const arch = new Deno.Command("uname", { args: ["-m"], stdout: "piped" });
  const machine = new TextDecoder().decode((await arch.output()).stdout).trim();
  return machine === "arm64" ? "aarch64" : machine;
}

/**
 * The PATH a fragment runs under: the test's `${dir}/bin` stubs first, with a
 * `uname` that reports {@link containerMachine} unless the test wrote its own
 * (the unsupported-architecture test stubs `mips64` deliberately).
 */
async function containerPath(dir: string): Promise<string> {
  await Deno.mkdir(`${dir}/bin`, { recursive: true });
  const stub = `${dir}/bin/uname`;
  try {
    await Deno.stat(stub);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.writeTextFile(
      stub,
      `#!/bin/sh
if [ "$1" = "-m" ]; then echo ${await containerMachine()}; else exec /usr/bin/uname "$@"; fi
`,
    );
    await Deno.chmod(stub, 0o755);
  }
  return `${dir}/bin:${Deno.env.get("PATH") ?? ""}`;
}

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
  const machine = await containerMachine();
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
        PATH: await containerPath(dir),
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

/**
 * Run a fragment against a manifest the caller has doctored, with a `curl`
 * stub that records being called (Issue #1595).
 *
 * "Did it download?" is then observable rather than assumed: the stub exits
 * 0, so only the fragment's own guard can stop the run.
 */
async function runFragmentWithBrokenManifest(
  fragment: string,
  doctor: (manifest: {
    toolchains: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
  }) => void,
): Promise<{ code: number; stderr: string; downloaded: boolean }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
    );
    doctor(manifest);
    await Deno.writeTextFile(
      `${dir}/tools.json`,
      JSON.stringify(manifest, null, 2),
    );

    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\necho called >> "${dir}/curl.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/${fragment}`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${dir}/tools.json`,
        CURL_RETRY: "",
        PIP_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    let downloaded = true;
    try {
      await Deno.stat(`${dir}/curl.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      downloaded = false;
    }

    return {
      code: result.code,
      stderr: new TextDecoder().decode(result.stderr),
      downloaded,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("container/toolchains/bats-core.sh - a missing pin aborts before downloading", async () => {
  // The runner ships as one architecture-independent source tarball, so the
  // fragment resolves a single `noarch` digest. Drop it and the fragment must
  // stop at the lookup rather than fetching bytes it cannot verify.
  const run = await runFragmentWithBrokenManifest(
    "bats-core.sh",
    (manifest) => {
      const bats = manifest.toolchains.find((t) => t.id === "bats-core");
      assert(bats !== undefined, "container/tools.json must pin bats-core");
      delete (bats.sha256 as Record<string, string>).noarch;
    },
  );

  assert(run.code !== 0, "an unpinned checksum must fail the build");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its pin — a missing digest " +
      "must stop it at the lookup",
  );
});

Deno.test("container/toolchains/bats-core.sh - a missing manifest aborts, naming the path", async () => {
  const result = await new Deno.Command("bash", {
    args: [`${REPO_ROOT}/container/toolchains/bats-core.sh`],
    env: { TOOLCHAIN_MANIFEST: "/nonexistent/tools.json", CURL_RETRY: "" },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  assertEquals(result.code, 1);
  assertStringIncludes(
    new TextDecoder().decode(result.stderr),
    "/nonexistent/tools.json",
  );
});

/** The manifest digest key for the architecture the tests run on. */
async function currentDigestKey(): Promise<"amd64" | "arm64"> {
  return (await containerMachine()) === "aarch64" ? "arm64" : "amd64";
}

Deno.test("container/toolchains/pyyaml.sh - a missing pin aborts before downloading", async () => {
  // PyYAML ships a compiled extension, so the wheel — and its digest — are
  // per-architecture (Issue #1628). Drop the one this architecture needs and
  // the fragment must stop at the lookup rather than fetching bytes no
  // committed digest can verify.
  const key = await currentDigestKey();
  const run = await runFragmentWithBrokenManifest("pyyaml.sh", (manifest) => {
    const pyyaml = manifest.toolchains.find((t) => t.id === "pyyaml");
    assert(pyyaml !== undefined, "container/tools.json must pin pyyaml");
    const sha256 = pyyaml.sha256 as Record<string, string>;
    assert(key in sha256, `pyyaml must pin ${key} before it is removed`);
    delete sha256[key];
  });

  assert(run.code !== 0, "an unpinned checksum must fail the build");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its pin — a missing digest " +
      "must stop it at the lookup",
  );
});

Deno.test("container/toolchains/pyyaml.sh - an unpinned pip installer aborts before downloading", async () => {
  // The wheel needs two pins: its own, and the pip that installs it. Remove
  // pip and the fragment must stop before fetching either wheel rather than
  // reaching for an unpinned installer.
  const run = await runFragmentWithBrokenManifest("pyyaml.sh", (manifest) => {
    const index = manifest.tools.findIndex((t) => t.name === "pip");
    assert(index >= 0, "container/tools.json must pin pip");
    manifest.tools.splice(index, 1);
  });

  assert(run.code !== 0, "an unpinned pip must fail the build");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving the pip pin — an unpinned " +
      "installer must stop it at the lookup",
  );
});

Deno.test("container/toolchains/pyyaml.sh - a module name python could not import aborts", async () => {
  // The module names reach a `python3 -c` interpolation, so a manifest that
  // named anything but an importable module must stop the fragment rather
  // than handing the interpreter whatever it says.
  const run = await runFragmentWithBrokenManifest("pyyaml.sh", (manifest) => {
    const pyyaml = manifest.toolchains.find((t) => t.id === "pyyaml");
    assert(pyyaml !== undefined, "container/tools.json must pin pyyaml");
    pyyaml.modules = ["yaml; import os"];
    pyyaml.versionModule = "yaml; import os";
  });

  assert(run.code !== 0, "a module name python3 cannot import must fail");
  assertStringIncludes(run.stderr, "is not a module name python3 can import");
  assert(
    !run.downloaded,
    "the fragment downloaded before validating the module names",
  );
});

Deno.test("container/toolchains/pyyaml.sh - a manifest naming no module aborts before downloading", async () => {
  // The module list drives both the install verification and the version
  // check, so an empty one would leave the fragment verifying nothing and
  // reporting success. It must stop, naming the manifest.
  const run = await runFragmentWithBrokenManifest("pyyaml.sh", (manifest) => {
    const pyyaml = manifest.toolchains.find((t) => t.id === "pyyaml");
    assert(pyyaml !== undefined, "container/tools.json must pin pyyaml");
    pyyaml.modules = [];
  });

  assert(run.code !== 0, "a toolchain that installs nothing must fail loud");
  assertStringIncludes(run.stderr, "names no module for this toolchain");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving what it installs",
  );
});

Deno.test("container/toolchains/pyyaml.sh - a tampered download aborts before installing", async () => {
  // The digest is what makes fetching by pinned URL safe: bytes that do not
  // match must never reach pip. The stub curl writes files no manifest digest
  // can match, so the fragment has to stop at the first `sha256sum -c -` and
  // install nothing into the interpreter's site directory.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    // curl -fsSL <retry> -o <path> <url>: write tampered bytes to the -o path.
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n` +
        `  if [ "$1" = "-o" ]; then printf 'tampered\\n' > "$2"; fi\n` +
        `  shift\ndone\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);
    // A python3 that records its arguments. The fragment asks the interpreter
    // for its own tag and site directory before downloading, so the assertion
    // is not "python3 was never run" but "nothing was installed".
    await Deno.writeTextFile(
      `${dir}/bin/python3`,
      `#!/bin/sh\necho "$@" >> "${dir}/python.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/python3`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/pyyaml.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
        PIP_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "a checksum mismatch must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "did NOT match",
    );

    let invocations = "";
    try {
      invocations = await Deno.readTextFile(`${dir}/python.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    assert(
      !invocations.includes("install"),
      "the fragment installed from bytes that failed verification: " +
        invocations,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/codespell.sh - an unpinned pip installer aborts before downloading", async () => {
  // codespell is a wheel, so the fragment needs two pins: its own, and the
  // pip that installs it — which lives in the manifest's tools[], beside
  // semgrep's. Remove pip and the fragment must stop before fetching either
  // wheel rather than reaching for an unpinned installer.
  const run = await runFragmentWithBrokenManifest(
    "codespell.sh",
    (manifest) => {
      const index = manifest.tools.findIndex((t) => t.name === "pip");
      assert(index >= 0, "container/tools.json must pin pip");
      manifest.tools.splice(index, 1);
    },
  );

  assert(run.code !== 0, "an unpinned pip must fail the build");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving the pip pin — an unpinned " +
      "installer must stop it at the lookup",
  );
});

Deno.test("container/toolchains/codespell.sh - a tampered download aborts before installing", async () => {
  // The whole point of fetching by pinned URL is that the digest is what
  // makes it safe: bytes that do not match must never reach pip. The stub
  // curl writes files no manifest digest can match, so the fragment has to
  // stop at the first `sha256sum -c -` and build no virtualenv.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    // curl -fsSL <retry> -o <path> <url>: write tampered bytes to the -o path.
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n` +
        `  if [ "$1" = "-o" ]; then printf 'tampered\\n' > "$2"; fi\n` +
        `  shift\ndone\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);
    // A python3 that records being called: nothing may be installed from
    // bytes that failed verification.
    await Deno.writeTextFile(
      `${dir}/bin/python3`,
      `#!/bin/sh\necho called >> "${dir}/python.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/python3`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/codespell.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
        PIP_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "a checksum mismatch must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "did NOT match",
    );

    let installed = true;
    try {
      await Deno.stat(`${dir}/python.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      installed = false;
    }
    assert(
      !installed,
      "the fragment built the virtualenv from bytes that failed verification",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/codegraph.sh - a missing pin aborts before downloading", async () => {
  // CodeGraph ships one tarball per architecture, so the fragment resolves a
  // per-architecture digest. Drop both and it must stop at the lookup rather
  // than fetching a 60 MB bundle it cannot verify.
  const run = await runFragmentWithBrokenManifest(
    "codegraph.sh",
    (manifest) => {
      const codegraph = manifest.toolchains.find((t) => t.id === "codegraph");
      assert(
        codegraph !== undefined,
        "container/tools.json must pin codegraph",
      );
      codegraph.sha256 = {};
    },
  );

  assert(run.code !== 0, "an unpinned checksum must fail the build");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its pin — a missing digest " +
      "must stop it at the lookup",
  );
});

Deno.test("container/toolchains/codegraph.sh - an unsupported architecture aborts, naming it", async () => {
  // The asset name is derived from the build architecture, so an
  // architecture the release does not publish must fail loud rather than
  // guessing a URL — the manifest pins no digest for it either.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/uname`,
      `#!/bin/sh\necho mips64\n`,
    );
    await Deno.chmod(`${dir}/bin/uname`, 0o755);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\necho called >> "${dir}/curl.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/codegraph.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(
      result.code !== 0,
      "an unsupported architecture must fail the build",
    );
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "Unsupported build architecture: mips64",
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
      "the fragment fetched an asset for an architecture " +
        "the manifest pins no digest for",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/codegraph.sh - a tampered download aborts before extracting", async () => {
  // The digest is what makes fetching by pinned URL safe. The stub curl
  // writes bytes no manifest digest can match, so the fragment must stop at
  // `sha256sum -c -` and never unpack them into /opt.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    // curl -fsSL <retry> -o <path> <url>: write tampered bytes to the -o path.
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n` +
        `  if [ "$1" = "-o" ]; then printf 'tampered\\n' > "$2"; fi\n` +
        `  shift\ndone\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);
    // A tar that records being called: the assertion is "nothing was
    // unpacked", not "the archive was absent".
    await Deno.writeTextFile(
      `${dir}/bin/tar`,
      `#!/bin/sh\necho "$@" >> "${dir}/tar.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/tar`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/codegraph.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "a checksum mismatch must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "did NOT match",
    );

    let extracted = true;
    try {
      await Deno.stat(`${dir}/tar.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      extracted = false;
    }
    assert(
      !extracted,
      "the fragment unpacked bytes that failed verification",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/rtk.sh - a missing pin aborts before downloading", async () => {
  // RTK ships one tarball per architecture, so the fragment resolves a
  // per-architecture digest. Drop both and it must stop at the lookup rather
  // than fetching bytes it cannot verify.
  const run = await runFragmentWithBrokenManifest(
    "rtk.sh",
    (manifest) => {
      const rtk = manifest.toolchains.find((t) => t.id === "rtk");
      assert(rtk !== undefined, "container/tools.json must pin rtk");
      rtk.sha256 = {};
    },
  );

  assert(run.code !== 0, "an unpinned checksum must fail the build");
  assertStringIncludes(run.stderr, "the sha256 pin for");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its pin — a missing digest " +
      "must stop it at the lookup",
  );
});

Deno.test("container/toolchains/rtk.sh - a missing version pin aborts, naming it", async () => {
  // The version resolves before the architecture does, so its own absence has
  // to be reported by name rather than by a bare jq exit code.
  const run = await runFragmentWithBrokenManifest("rtk.sh", (manifest) => {
    const rtk = manifest.toolchains.find((t) => t.id === "rtk");
    assert(rtk !== undefined, "container/tools.json must pin rtk");
    delete rtk.version;
  });

  assert(run.code !== 0, "an unpinned version must fail the build");
  assertStringIncludes(run.stderr, "the version pin is missing from");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its version",
  );
});

Deno.test("container/toolchains/rtk.sh - an unsupported architecture aborts, naming it", async () => {
  // Each architecture names a different release triple (musl on x86_64, gnu
  // on aarch64), so an architecture the release does not publish must fail
  // loud rather than guessing a URL the manifest pins no digest for.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(`${dir}/bin/uname`, `#!/bin/sh\necho mips64\n`);
    await Deno.chmod(`${dir}/bin/uname`, 0o755);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\necho called >> "${dir}/curl.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/rtk.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(
      result.code !== 0,
      "an unsupported architecture must fail the build",
    );
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "Unsupported build architecture: mips64",
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
      "the fragment fetched an asset for an architecture " +
        "the manifest pins no digest for",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/rtk.sh - a tampered download aborts before extracting", async () => {
  // The digest is what makes fetching by pinned URL safe. The stub curl
  // writes bytes no manifest digest can match, so the fragment must stop at
  // `sha256sum -c -` and never unpack them onto the PATH.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n` +
        `  case "$1" in -o) shift; out="$1" ;; esac\n  shift\ndone\n` +
        `printf 'tampered\\n' > "\${out}"\n`,
    );
    await Deno.chmod(`${dir}/bin/curl`, 0o755);
    // A stub tar, so a failure reads "the fragment unpacked what it should not
    // have unpacked", not "the archive was absent".
    await Deno.writeTextFile(
      `${dir}/bin/tar`,
      `#!/bin/sh\necho "$@" >> "${dir}/tar.log"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/tar`, 0o755);

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/rtk.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "a checksum mismatch must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "did NOT match",
    );

    let extracted = true;
    try {
      await Deno.stat(`${dir}/tar.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      extracted = false;
    }
    assert(!extracted, "the fragment unpacked bytes that failed verification");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/rtk.sh - an archive without rtk at its top level aborts", async () => {
  // The RTK-specific risk: the release carries a bare binary rather than
  // codegraph's bundle, so a layout that changes upstream must abort rather
  // than install whatever else the archive happened to hold. Verified bytes
  // are stubbed past so the check under test is the layout one.
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do\n` +
        `  case "$1" in -o) shift; out="$1" ;; esac\n  shift\ndone\n` +
        `printf 'archive\\n' > "\${out}"\n`,
    );
    await Deno.writeTextFile(`${dir}/bin/sha256sum`, `#!/bin/sh\nexit 0\n`);
    // An archive whose top level is a directory rather than the bare binary.
    await Deno.writeTextFile(
      `${dir}/bin/tar`,
      `#!/bin/sh\ndest=""\nwhile [ $# -gt 0 ]; do\n` +
        `  case "$1" in -C) shift; dest="$1" ;; esac\n  shift\ndone\n` +
        `mkdir -p "\${dest}/rtk-bundle"\n`,
    );
    await Deno.writeTextFile(
      `${dir}/bin/install`,
      `#!/bin/sh\necho called >> "${dir}/install.log"\nexit 0\n`,
    );
    for (const stub of ["curl", "sha256sum", "tar", "install"]) {
      await Deno.chmod(`${dir}/bin/${stub}`, 0o755);
    }

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/rtk.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "an unexpected layout must fail the build");
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "Archive does not carry rtk at its top level",
    );

    let installed = true;
    try {
      await Deno.stat(`${dir}/install.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      installed = false;
    }
    assert(!installed, "the fragment installed from an unexpected layout");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Run container/toolchains/brief.sh past its download (Issue #2601): a stub
 * `curl` writes placeholder bytes, `sha256sum` and `install` are stubbed as
 * given, `tar` unpacks a bare `brief` unless `layout` says otherwise, and a
 * stub `brief` on the PATH reports `reported` as the installed binary would.
 */
async function runBriefFragment(options: {
  version?: string;
  reported?: string;
  verified?: boolean;
  layout?: "bare" | "directory";
}): Promise<
  { code: number; stderr: string; extracted: boolean; installed: boolean }
> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
    );
    const brief = manifest.toolchains.find((t: { id: string }) =>
      t.id === "brief"
    );
    assert(brief !== undefined, "container/tools.json must pin brief");
    if (options.version !== undefined) brief.version = options.version;
    await Deno.writeTextFile(`${dir}/tools.json`, JSON.stringify(manifest));

    await Deno.mkdir(`${dir}/bin`);
    const stubs: Record<string, string> = {
      curl: `out=""\nwhile [ $# -gt 0 ]; do\n` +
        `  case "$1" in -o) shift; out="$1" ;; esac\n  shift\ndone\n` +
        `printf 'archive\\n' > "\${out}"\n`,
      tar: `echo "$@" >> "${dir}/tar.log"\ndest=""\n` +
        `while [ $# -gt 0 ]; do\n` +
        `  case "$1" in -C) shift; dest="$1" ;; esac\n  shift\ndone\n` +
        (options.layout === "directory"
          ? `mkdir -p "\${dest}/brief-bundle"\n`
          : `printf 'binary\\n' > "\${dest}/brief"\n`),
      install: `echo "$@" >> "${dir}/install.log"\n`,
      brief: `echo "${options.reported ?? "brief 0.13.0"}"\n`,
    };
    // Unverified runs keep the real sha256sum, so the bytes fail the pin.
    if (options.verified !== false) stubs.sha256sum = `exit 0\n`;
    for (const [name, body] of Object.entries(stubs)) {
      await Deno.writeTextFile(`${dir}/bin/${name}`, `#!/bin/sh\n${body}`);
      await Deno.chmod(`${dir}/bin/${name}`, 0o755);
    }

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/brief.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${dir}/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    const exists = async (path: string): Promise<boolean> => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        return false;
      }
    };
    return {
      code: result.code,
      stderr: new TextDecoder().decode(result.stderr),
      extracted: await exists(`${dir}/tar.log`),
      installed: await exists(`${dir}/install.log`),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("container/toolchains/brief.sh - a verified archive reporting the pinned version installs", async () => {
  const run = await runBriefFragment({});

  assertEquals(run.code, 0, run.stderr);
  assert(run.extracted, "the fragment never unpacked the verified archive");
  assert(run.installed, "the fragment never installed brief onto the PATH");
});

Deno.test("container/toolchains/brief.sh - a missing pin aborts before downloading", async () => {
  const run = await runFragmentWithBrokenManifest("brief.sh", (manifest) => {
    const brief = manifest.toolchains.find((t) => t.id === "brief");
    assert(brief !== undefined, "container/tools.json must pin brief");
    brief.sha256 = {};
  });

  assert(run.code !== 0, "an unpinned checksum must fail the build");
  assertStringIncludes(run.stderr, "[brief] the sha256 pin for");
  assert(!run.downloaded, "the fragment downloaded before resolving its pin");
});

Deno.test("container/toolchains/brief.sh - a missing version pin aborts, naming it", async () => {
  const run = await runFragmentWithBrokenManifest("brief.sh", (manifest) => {
    const brief = manifest.toolchains.find((t) => t.id === "brief");
    assert(brief !== undefined, "container/tools.json must pin brief");
    delete brief.version;
  });

  assert(run.code !== 0, "an unpinned version must fail the build");
  assertStringIncludes(run.stderr, "[brief] the version pin is missing from");
  assert(
    !run.downloaded,
    "the fragment downloaded before resolving its version",
  );
});

Deno.test("container/toolchains/brief.sh - an unsupported architecture aborts, naming it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-fragment-" });
  try {
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(`${dir}/bin/uname`, `#!/bin/sh\necho mips64\n`);
    await Deno.writeTextFile(
      `${dir}/bin/curl`,
      `#!/bin/sh\necho called >> "${dir}/curl.log"\nexit 0\n`,
    );
    for (const stub of ["uname", "curl"]) {
      await Deno.chmod(`${dir}/bin/${stub}`, 0o755);
    }

    const result = await new Deno.Command("bash", {
      args: [`${REPO_ROOT}/container/toolchains/brief.sh`],
      env: {
        PATH: await containerPath(dir),
        TOOLCHAIN_MANIFEST: `${REPO_ROOT}/container/tools.json`,
        CURL_RETRY: "",
      },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(
      result.code !== 0,
      "an unsupported architecture must fail the build",
    );
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "[brief] Unsupported build architecture: mips64",
    );
    let downloaded = true;
    try {
      await Deno.stat(`${dir}/curl.log`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      downloaded = false;
    }
    assert(!downloaded, "the fragment fetched an asset with no pinned digest");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("container/toolchains/brief.sh - a checksum mismatch aborts before extracting, naming brief", async () => {
  // The real sha256sum checks placeholder bytes against the committed pin,
  // exactly as an altered pin would fail against the real release asset.
  const run = await runBriefFragment({ verified: false });

  assert(run.code !== 0, "a checksum mismatch must fail the build");
  assertStringIncludes(run.stderr, "did NOT match");
  assertStringIncludes(run.stderr, "[brief] Checksum mismatch");
  assert(
    !run.extracted,
    "the fragment unpacked bytes that failed verification",
  );
  assert(
    !run.installed,
    "the fragment installed bytes that failed verification",
  );
});

Deno.test("container/toolchains/brief.sh - an archive without brief at its top level aborts", async () => {
  const run = await runBriefFragment({ layout: "directory" });

  assert(run.code !== 0, "an unexpected layout must fail the build");
  assertStringIncludes(
    run.stderr,
    "[brief] Archive does not carry brief at its top level",
  );
  assert(!run.installed, "the fragment installed from an unexpected layout");
});

Deno.test("container/toolchains/brief.sh - an altered version pin fails the post-install assertion", async () => {
  // The release binary reports 0.13.0; a manifest pinning anything else must
  // fail the build rather than ship a binary the pin does not describe.
  const run = await runBriefFragment({ version: "0.12.0" });

  assert(run.code !== 0, "a version mismatch must fail the build");
  assertStringIncludes(
    run.stderr,
    '[brief] Installed binary reports "brief 0.13.0", expected 0.12.0',
  );
});

Deno.test("container/toolchains/brief.sh - a pin matching only part of the reported version fails", async () => {
  // "3.0" is a substring of "0.13.0" but not the version: the assertion
  // compares whole tokens, as the start-up self-check does.
  const run = await runBriefFragment({ version: "3.0" });

  assert(run.code !== 0, "a partial version match must fail the build");
  assertStringIncludes(run.stderr, "expected 3.0");
});
