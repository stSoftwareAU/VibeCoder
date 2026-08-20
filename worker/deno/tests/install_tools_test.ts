/**
 * Tests for container/install-tools.sh — installing the deployer-supplied
 * container build-time tools (Issue #70, parent #5).
 *
 * A deployment declares extra tools (Java, Maven, ...) in `.config.json`;
 * `container/install-tools.sh` is the build step that turns that already
 * validated spec into installed trees under `/opt/vibe-tools/<id>` plus an
 * `environment` file the PATH/env sub-issue consumes.
 *
 * Every test runs the real script against a temporary install prefix and local
 * fixture archives — no network — and asserts on its exit code, its stderr, the
 * tree it produced and the environment file it wrote. Never on its source text.
 *
 * The download is exercised through a `curl` stub on PATH that copies a fixture
 * archive, so the script's own https-only rule, its SHA-256 verification and
 * its extraction all run for real. The stub logs each call, which is how the
 * "validate the whole set before anything is downloaded" discipline is asserted.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The script the container build runs to install the requested tools. */
const INSTALLER = `${REPO_ROOT}/container/install-tools.sh`;

/** Base of every fixture download URL — never resolved, the stub serves it. */
const FIXTURE_HOST = "https://fixtures.invalid";

interface Workspace {
  /** Temporary root holding everything this test needs. */
  root: string;
  /** Archives the curl stub serves, by file name. */
  fixtures: string;
  /** Stand-in for /opt/vibe-tools. */
  prefix: string;
  /** Directory prepended to PATH, holding the curl stub. */
  stubBin: string;
  /** One line per curl invocation, in order. */
  curlLog: string;
}

interface InstallerRun {
  code: number;
  stdout: string;
  stderr: string;
  /** URLs the script actually downloaded, in order. */
  downloaded: string[];
}

/** A curl stub that serves fixture archives and records every call. */
const CURL_STUB = `#!/usr/bin/env bash
# Test double for curl: serves \${FIXTURE_DIR}/<basename of URL>.
set -uo pipefail
out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "\${url}" >> "\${CURL_LOG}"
src="\${FIXTURE_DIR}/\${url##*/}"
if [[ ! -f "\${src}" ]]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cp "\${src}" "\${out}"
`;

async function makeWorkspace(): Promise<Workspace> {
  const root = await Deno.makeTempDir({ prefix: "vibe-install-tools-" });
  const ws: Workspace = {
    root,
    fixtures: `${root}/fixtures`,
    prefix: `${root}/vibe-tools`,
    stubBin: `${root}/stub-bin`,
    curlLog: `${root}/curl.log`,
  };
  await Deno.mkdir(ws.fixtures, { recursive: true });
  await Deno.mkdir(ws.stubBin, { recursive: true });
  await Deno.writeTextFile(`${ws.stubBin}/curl`, CURL_STUB, { mode: 0o755 });
  await Deno.writeTextFile(ws.curlLog, "");
  return ws;
}

/** Run a command, failing the test loudly if it does not exit 0. */
async function run(cmd: string, args: string[]): Promise<void> {
  const result = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  assertEquals(
    result.code,
    0,
    `${cmd} ${args.join(" ")} failed: ${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}

/** Lower-case hex SHA-256 of a file. */
async function sha256Of(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Write a `path -> contents` tree under `dir`. */
async function writeTree(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const path = `${dir}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, contents);
  }
}

/**
 * Build a tar fixture whose single top-level directory is `topLevel`, and
 * return its download URL and digest.
 */
async function tarFixture(
  ws: Workspace,
  archiveName: string,
  topLevel: string,
  files: Record<string, string>,
): Promise<{ url: string; sha256: string }> {
  const src = `${ws.root}/src-${archiveName.replace(/[^a-z0-9]/gi, "-")}`;
  await writeTree(src, files);
  const archive = `${ws.fixtures}/${archiveName}`;
  const flag = archiveName.endsWith(".tar.xz") ? "-cJf" : "-czf";
  await run("tar", [flag, archive, "-C", src, topLevel]);
  return {
    url: `${FIXTURE_HOST}/${archiveName}`,
    sha256: await sha256Of(archive),
  };
}

// --- Minimal ZIP writer ----------------------------------------------------
// Deno has no zip writer and the `zip` binary is not in the container image,
// so the fixture is built here: stored (uncompressed) entries, which `unzip`
// reads exactly like any other archive.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipBytes(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034B50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(12, 0x21, true); // 1980-01-01
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014B50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(10, 0, true); // stored
    entryView.setUint16(14, 0x21, true); // 1980-01-01
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

async function zipFixture(
  ws: Workspace,
  archiveName: string,
  files: Record<string, string>,
): Promise<{ url: string; sha256: string }> {
  const archive = `${ws.fixtures}/${archiveName}`;
  await Deno.writeFile(archive, zipBytes(files));
  return {
    url: `${FIXTURE_HOST}/${archiveName}`,
    sha256: await sha256Of(archive),
  };
}

// --- Running the installer -------------------------------------------------

/** Build architecture the script would detect with no override. */
const HOST_ARCH = Deno.build.arch === "x86_64" ? "amd64" : "arm64";

interface RunOptions {
  /** Value for VIBE_TOOLS_ARCH; `null` leaves it unset (host detection). */
  arch?: string | null;
  /** Raw spec file contents, for the malformed-file cases. */
  specText?: string;
  /** Pass no spec file argument at all. */
  noArgument?: boolean;
}

async function runInstaller(
  ws: Workspace,
  spec: unknown,
  options: RunOptions = {},
): Promise<InstallerRun> {
  const specPath = `${ws.root}/spec.json`;
  await Deno.writeTextFile(
    specPath,
    options.specText ?? JSON.stringify(spec, null, 2),
  );

  const env: Record<string, string> = {
    PATH: `${ws.stubBin}:${Deno.env.get("PATH") ?? ""}`,
    VIBE_TOOLS_PREFIX: ws.prefix,
    FIXTURE_DIR: ws.fixtures,
    CURL_LOG: ws.curlLog,
  };
  const arch = options.arch === undefined ? "amd64" : options.arch;
  if (arch !== null) env.VIBE_TOOLS_ARCH = arch;

  const result = await new Deno.Command("bash", {
    args: options.noArgument ? [INSTALLER] : [INSTALLER, specPath],
    env,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  const downloaded = (await Deno.readTextFile(ws.curlLog))
    .split("\n")
    .filter((line) => line !== "");

  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    downloaded,
  };
}

/** Contents of the environment file, or `null` when it was never written. */
async function environmentFile(ws: Workspace): Promise<string[] | null> {
  try {
    const text = await Deno.readTextFile(`${ws.prefix}/environment`);
    return text.split("\n").filter((line) => line !== "");
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run `body` against a fresh workspace, cleaning up afterwards. */
async function withWorkspace(
  body: (ws: Workspace) => Promise<void>,
): Promise<void> {
  const ws = await makeWorkspace();
  try {
    await body(ws);
  } finally {
    await Deno.remove(ws.root, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// A valid spec installs every tool and records its PATH and env values
// ---------------------------------------------------------------------------

Deno.test("install-tools - a two-tool spec installs both trees and writes the environment file", async () => {
  await withWorkspace(async (ws) => {
    const java = await tarFixture(ws, "java-21.tar.gz", "jdk-21", {
      "jdk-21/bin/java": "#!/bin/sh\necho java 21\n",
      "jdk-21/release": "JAVA_VERSION=21\n",
    });
    const maven = await tarFixture(ws, "maven-3.tar.xz", "apache-maven", {
      "apache-maven/bin/mvn": "#!/bin/sh\necho mvn\n",
    });

    const run = await runInstaller(ws, [
      {
        id: "java",
        version: "21.0.5+11",
        url: { amd64: java.url },
        sha256: { amd64: java.sha256 },
        stripComponents: 1,
        bin: ["bin"],
        env: { JAVA_HOME: "" },
      },
      {
        id: "maven",
        version: "3.9.9",
        url: { amd64: maven.url },
        sha256: { amd64: maven.sha256 },
        stripComponents: 1,
        bin: ["bin"],
        env: { MAVEN_HOME: "" },
      },
    ]);

    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.downloaded, [java.url, maven.url]);

    assertEquals(
      await Deno.readTextFile(`${ws.prefix}/java/bin/java`),
      "#!/bin/sh\necho java 21\n",
    );
    assertEquals(
      await Deno.readTextFile(`${ws.prefix}/java/release`),
      "JAVA_VERSION=21\n",
    );
    assert(
      await exists(`${ws.prefix}/maven/bin/mvn`),
      "the second tool is installed under its own id",
    );

    assertEquals(await environmentFile(ws), [
      `PATH=${ws.prefix}/java/bin`,
      `JAVA_HOME=${ws.prefix}/java`,
      `PATH=${ws.prefix}/maven/bin`,
      `MAVEN_HOME=${ws.prefix}/maven`,
    ]);
  });
});

Deno.test("install-tools - the downloaded archive is removed once extracted", async () => {
  await withWorkspace(async (ws) => {
    const java = await tarFixture(ws, "java-21.tar.gz", "jdk-21", {
      "jdk-21/bin/java": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: java.url },
      sha256: { amd64: java.sha256 },
      stripComponents: 1,
      bin: ["bin"],
    }]);

    assertEquals(run.code, 0, run.stderr);
    for await (const entry of Deno.readDir(ws.prefix)) {
      assert(
        entry.name === "java" || entry.name === "environment",
        `the install prefix must hold only the tools and the environment ` +
          `file, found ${entry.name}`,
      );
    }
    // Nothing archive-shaped survives anywhere under the prefix.
    assert(!await exists(`${ws.prefix}/java/java-21.tar.gz`));
  });
});

Deno.test("install-tools - a zip archive is extracted honouring stripComponents", async () => {
  await withWorkspace(async (ws) => {
    const tool = await zipFixture(ws, "gradle-8.zip", {
      "gradle-8.11/bin/gradle": "#!/bin/sh\necho gradle\n",
      "gradle-8.11/lib/gradle.jar": "jar\n",
    });

    const run = await runInstaller(ws, [{
      id: "gradle",
      version: "8.11",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      stripComponents: 1,
      bin: ["bin"],
      env: { GRADLE_HOME: "" },
    }]);

    assertEquals(run.code, 0, run.stderr);
    assertEquals(
      await Deno.readTextFile(`${ws.prefix}/gradle/bin/gradle`),
      "#!/bin/sh\necho gradle\n",
    );
    assert(await exists(`${ws.prefix}/gradle/lib/gradle.jar`));
    assertEquals(await environmentFile(ws), [
      `PATH=${ws.prefix}/gradle/bin`,
      `GRADLE_HOME=${ws.prefix}/gradle`,
    ]);
  });
});

Deno.test("install-tools - stripComponents defaults to zero, keeping the archive's own layout", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "flat.tar.gz", "toolbox", {
      "toolbox/bin/tool": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "toolbox",
      version: "1",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      bin: ["toolbox/bin"],
    }]);

    assertEquals(run.code, 0, run.stderr);
    assert(await exists(`${ws.prefix}/toolbox/toolbox/bin/tool`));
    assertEquals(await environmentFile(ws), [
      `PATH=${ws.prefix}/toolbox/toolbox/bin`,
    ]);
  });
});

Deno.test("install-tools - a noarch download is used when the build architecture has none", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "anywhere.tar.gz", "anywhere", {
      "anywhere/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "anywhere",
      version: "1.0.0",
      url: { noarch: tool.url },
      sha256: { noarch: tool.sha256 },
      stripComponents: 1,
      bin: ["bin"],
    }], { arch: "arm64" });

    assertEquals(run.code, 0, run.stderr);
    assert(await exists(`${ws.prefix}/anywhere/bin/run`));
  });
});

Deno.test("install-tools - the architecture-specific download wins over noarch", async () => {
  await withWorkspace(async (ws) => {
    const specific = await tarFixture(ws, "specific.tar.gz", "tool", {
      "tool/marker": "arm64\n",
    });
    const generic = await tarFixture(ws, "generic.tar.gz", "tool", {
      "tool/marker": "noarch\n",
    });
    const run = await runInstaller(ws, [{
      id: "picky",
      version: "1",
      url: { arm64: specific.url, noarch: generic.url },
      sha256: { arm64: specific.sha256, noarch: generic.sha256 },
      stripComponents: 1,
    }], { arch: "arm64" });

    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.downloaded, [specific.url]);
    assertEquals(
      await Deno.readTextFile(`${ws.prefix}/picky/marker`),
      "arm64\n",
    );
  });
});

Deno.test("install-tools - with no architecture override the host architecture is used", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "host.tar.gz", "host", {
      "host/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "hosted",
      version: "1",
      url: { [HOST_ARCH]: tool.url },
      sha256: { [HOST_ARCH]: tool.sha256 },
      stripComponents: 1,
      bin: ["bin"],
    }], { arch: null });

    assertEquals(run.code, 0, run.stderr);
    assert(await exists(`${ws.prefix}/hosted/bin/run`));
  });
});

Deno.test("install-tools - the spec may be the .config.json object carrying container_tools", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "wrapped.tar.gz", "wrapped", {
      "wrapped/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, {
      container_tools: [{
        id: "wrapped",
        version: "1",
        url: { amd64: tool.url },
        sha256: { amd64: tool.sha256 },
        stripComponents: 1,
        bin: ["bin"],
      }],
    });

    assertEquals(run.code, 0, run.stderr);
    assert(await exists(`${ws.prefix}/wrapped/bin/run`));
  });
});

// ---------------------------------------------------------------------------
// An empty spec is a legitimate deployment: install nothing, loudly and cleanly
// ---------------------------------------------------------------------------

Deno.test("install-tools - an empty spec installs nothing and still writes an empty environment file", async () => {
  await withWorkspace(async (ws) => {
    const run = await runInstaller(ws, []);

    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.downloaded, []);
    assertEquals(
      await environmentFile(ws),
      [],
      "the PATH/env sub-issue always has a file to read, empty or not",
    );
  });
});

// ---------------------------------------------------------------------------
// Every malformed spec is rejected before anything is downloaded
// ---------------------------------------------------------------------------

Deno.test("install-tools - a malformed id aborts before any download", async () => {
  await withWorkspace(async (ws) => {
    const good = await tarFixture(ws, "good.tar.gz", "good", {
      "good/bin/run": "#!/bin/sh\n",
    });
    for (
      const bad of ["Java", "java tool", "../java", "java.sh", "1java", ""]
    ) {
      const run = await runInstaller(ws, [
        {
          id: "good",
          version: "1",
          url: { amd64: good.url },
          sha256: { amd64: good.sha256 },
        },
        {
          id: bad,
          version: "1",
          url: { amd64: good.url },
          sha256: { amd64: good.sha256 },
        },
      ]);

      assert(run.code !== 0, `${JSON.stringify(bad)} must be rejected`);
      assertStringIncludes(run.stderr, "lower-case");
      assertEquals(
        run.downloaded,
        [],
        "the whole set is validated before the first download",
      );
      assertEquals(await environmentFile(ws), null);
    }
  });
});

Deno.test("install-tools - a duplicate id aborts rather than installing over itself", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "dup.tar.gz", "dup", {
      "dup/bin/run": "#!/bin/sh\n",
    });
    const entry = {
      id: "java",
      version: "21",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
    };
    const run = await runInstaller(ws, [entry, { ...entry, version: "17" }]);

    assert(run.code !== 0, "a duplicate tool id must abort the build");
    assertStringIncludes(run.stderr.toLowerCase(), "duplicate");
    assertStringIncludes(run.stderr, "java");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - a tool with no download for the build architecture aborts, naming it", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "amd-only.tar.gz", "tool", {
      "tool/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
    }], { arch: "arm64" });

    assert(run.code !== 0, "a missing architecture must abort the build");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "arm64");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - an unrecognised archive extension aborts rather than guessing", async () => {
  await withWorkspace(async (ws) => {
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: `${FIXTURE_HOST}/java-21.tar.bz2` },
      sha256: { amd64: "a".repeat(64) },
    }]);

    assert(run.code !== 0, "an unknown archive type must abort the build");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, ".tar.bz2");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - a non-https url aborts", async () => {
  await withWorkspace(async (ws) => {
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: "http://fixtures.invalid/java-21.tar.gz" },
      sha256: { amd64: "a".repeat(64) },
    }]);

    assert(run.code !== 0, "a plaintext download must abort the build");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "https");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - a malformed or missing sha256 aborts before downloading", async () => {
  await withWorkspace(async (ws) => {
    for (
      const sha256 of [
        {},
        { amd64: "not-a-digest" },
        { arm64: "b".repeat(64) },
      ]
    ) {
      const run = await runInstaller(ws, [{
        id: "java",
        version: "21",
        url: { amd64: `${FIXTURE_HOST}/java-21.tar.gz` },
        sha256,
      }]);

      assert(
        run.code !== 0,
        `sha256 ${JSON.stringify(sha256)} must abort the build`,
      );
      assertStringIncludes(run.stderr, "java");
      assertEquals(run.downloaded, []);
    }
  });
});

Deno.test("install-tools - a bin or env value escaping the install prefix aborts", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "escape.tar.gz", "tool", {
      "tool/bin/run": "#!/bin/sh\n",
    });
    const base = {
      id: "java",
      version: "21",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      stripComponents: 1,
    };
    const escapes: Record<string, unknown>[] = [
      { ...base, bin: ["/usr/bin"] },
      { ...base, bin: ["../../usr/bin"] },
      { ...base, bin: ["~/bin"] },
      { ...base, env: { JAVA_HOME: "/etc" } },
      { ...base, env: { JAVA_HOME: "../.." } },
    ];

    for (const entry of escapes) {
      const run = await runInstaller(ws, [entry]);
      assert(
        run.code !== 0,
        `${JSON.stringify(entry)} must be rejected as escaping the prefix`,
      );
      assertStringIncludes(run.stderr, "java");
      assertEquals(run.downloaded, []);
    }
  });
});

Deno.test("install-tools - two tools setting the same environment variable abort", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "clash.tar.gz", "tool", {
      "tool/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [
      {
        id: "java",
        version: "21",
        url: { amd64: tool.url },
        sha256: { amd64: tool.sha256 },
        stripComponents: 1,
        env: { JAVA_HOME: "" },
      },
      {
        id: "java-legacy",
        version: "8",
        url: { amd64: tool.url },
        sha256: { amd64: tool.sha256 },
        stripComponents: 1,
        env: { JAVA_HOME: "" },
      },
    ]);

    assert(run.code !== 0, "a clashing environment variable must abort");
    assertStringIncludes(run.stderr, "JAVA_HOME");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - a tool may not claim the environment file's own name", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "env-id.tar.gz", "tool", {
      "tool/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "environment",
      version: "1",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      stripComponents: 1,
    }]);

    assert(run.code !== 0, "the id must not collide with the environment file");
    assertStringIncludes(run.stderr, "environment");
    assertEquals(run.downloaded, []);
  });
});

Deno.test("install-tools - a missing, unreadable or malformed spec file aborts", async () => {
  await withWorkspace(async (ws) => {
    const noArgument = await runInstaller(ws, [], { noArgument: true });
    assert(noArgument.code !== 0, "no spec file at all must abort the build");

    const notJson = await runInstaller(ws, null, { specText: "{ not json" });
    assert(notJson.code !== 0, "a malformed spec file must abort the build");
    assertStringIncludes(notJson.stderr, "JSON");

    const wrongShape = await runInstaller(ws, { tools: [] });
    assert(wrongShape.code !== 0, "a spec that is not an array must abort");

    assertEquals(await environmentFile(ws), null);
  });
});

// ---------------------------------------------------------------------------
// Download and verification failures abort loudly, naming the tool
// ---------------------------------------------------------------------------

Deno.test("install-tools - a checksum mismatch aborts naming the tool and installs nothing", async () => {
  await withWorkspace(async (ws) => {
    const java = await tarFixture(ws, "java-21.tar.gz", "jdk-21", {
      "jdk-21/bin/java": "#!/bin/sh\n",
    });
    const wrong = "0".repeat(64);
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21.0.5+11",
      url: { amd64: java.url },
      sha256: { amd64: wrong },
      stripComponents: 1,
      bin: ["bin"],
      env: { JAVA_HOME: "" },
    }]);

    assert(run.code !== 0, "a checksum mismatch must abort the build");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr.toLowerCase(), "sha-256");
    assertStringIncludes(run.stderr, wrong);
    assertEquals(run.downloaded, [java.url]);
    assert(
      !await exists(`${ws.prefix}/java/bin/java`),
      "an unverified download is never extracted",
    );
    assertEquals(
      await environmentFile(ws),
      [],
      "a failed tool contributes nothing to the environment file",
    );
  });
});

Deno.test("install-tools - a failed download aborts naming the tool", async () => {
  await withWorkspace(async (ws) => {
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: `${FIXTURE_HOST}/never-published.tar.gz` },
      sha256: { amd64: "c".repeat(64) },
    }]);

    assert(run.code !== 0, "a failed download must abort the build");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "never-published.tar.gz");
  });
});

Deno.test("install-tools - a later tool's failure aborts the build, not just its own install", async () => {
  await withWorkspace(async (ws) => {
    const good = await tarFixture(ws, "first.tar.gz", "first", {
      "first/bin/run": "#!/bin/sh\n",
    });
    const second = await tarFixture(ws, "second.tar.gz", "second", {
      "second/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [
      {
        id: "first",
        version: "1",
        url: { amd64: good.url },
        sha256: { amd64: good.sha256 },
        stripComponents: 1,
        bin: ["bin"],
      },
      {
        id: "second",
        version: "1",
        url: { amd64: second.url },
        sha256: { amd64: "d".repeat(64) },
        stripComponents: 1,
        bin: ["bin"],
      },
    ]);

    assert(run.code !== 0, "a failure anywhere in the set must abort");
    assertStringIncludes(run.stderr, "second");
    assertEquals(await environmentFile(ws), [`PATH=${ws.prefix}/first/bin`]);
  });
});

Deno.test("install-tools - a declared bin directory the archive does not contain aborts", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "nobin.tar.gz", "tool", {
      "tool/lib/thing.jar": "jar\n",
    });
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      stripComponents: 1,
      bin: ["bin"],
    }]);

    assert(
      run.code !== 0,
      "a PATH entry pointing at nothing must fail the build, not the worker",
    );
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "bin");
  });
});

Deno.test("install-tools - an env value pointing outside the extracted tree aborts", async () => {
  await withWorkspace(async (ws) => {
    const tool = await tarFixture(ws, "noenv.tar.gz", "tool", {
      "tool/bin/run": "#!/bin/sh\n",
    });
    const run = await runInstaller(ws, [{
      id: "java",
      version: "21",
      url: { amd64: tool.url },
      sha256: { amd64: tool.sha256 },
      stripComponents: 1,
      env: { JAVA_HOME: "jdk-home" },
    }]);

    assert(run.code !== 0, "an env value must resolve to a real path");
    assertStringIncludes(run.stderr, "JAVA_HOME");
  });
});
