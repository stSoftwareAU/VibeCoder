/**
 * Tests for container/install-tools.sh — installing deployer-supplied
 * build-time tools into the image (Issue #70, parent #5).
 *
 * Every test executes the real script against a temporary install prefix and
 * local fixture archives (via `file://` URLs — no network), and asserts on its
 * exit code, its stderr, the installed tree under `<prefix>/<id>`, and the
 * `<prefix>/environment` hand-off file — never on the script's source text.
 *
 * The whole-set-first validation discipline (Issue #5: no half-installed
 * image) is covered by the malformed/duplicate/checksum/extension/architecture
 * cases plus the two-tool success case.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The script the Containerfile (Issue #71) runs to install the tool set. */
const INSTALLER = `${REPO_ROOT}/container/install-tools.sh`;

interface InstallerRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Hex SHA-256 of a file, computed without shelling out. */
async function sha256Hex(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a fixture `.tar.gz` whose single top-level directory `<top>/` holds
 * the given files, so `stripComponents: 1` is exercised. Returns the archive
 * path and its real SHA-256.
 */
async function fixtureTarGz(
  workDir: string,
  top: string,
  files: Record<string, string>,
): Promise<{ url: string; sha256: string }> {
  const src = `${workDir}/src-${top}`;
  for (const [rel, body] of Object.entries(files)) {
    const full = `${src}/${top}/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, body);
  }
  const archive = `${workDir}/${top}.tar.gz`;
  const tar = await new Deno.Command("tar", {
    args: ["-czf", archive, "-C", src, top],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(tar.success, `tar failed: ${new TextDecoder().decode(tar.stderr)}`);
  return { url: `file://${archive}`, sha256: await sha256Hex(archive) };
}

/** Run the installer against a spec, into a fresh prefix, for a given arch. */
async function runInstaller(
  spec: unknown,
  options: { prefix: string; arch?: string; workDir: string },
): Promise<InstallerRun> {
  const specPath = `${options.workDir}/spec.json`;
  await Deno.writeTextFile(specPath, JSON.stringify(spec));
  const result = await new Deno.Command("bash", {
    args: [INSTALLER, specPath],
    env: {
      VIBE_TOOLS_PREFIX: options.prefix,
      VIBE_BUILD_ARCH: options.arch ?? "amd64",
    },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function withDirs(
  fn: (workDir: string, prefix: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-tools-work-" });
  const prefix = await Deno.makeTempDir({ prefix: "vibe-tools-prefix-" });
  try {
    await fn(workDir, prefix);
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(prefix, { recursive: true });
  }
}

// ---------------------------------------------------------------------------

Deno.test("install-tools - an empty spec installs nothing and succeeds", async () => {
  await withDirs(async (workDir, prefix) => {
    const run = await runInstaller([], { prefix, workDir });
    assertEquals(run.code, 0);
    // Nothing beyond the prefix directory itself.
    const entries = [...Deno.readDirSync(prefix)];
    assertEquals(entries.length, 0, "an empty spec must install nothing");
  });
});

Deno.test("install-tools - a malformed id is rejected before any download", async () => {
  await withDirs(async (workDir, prefix) => {
    const run = await runInstaller(
      [{
        id: "Java",
        url: { noarch: "file:///x.tar.gz" },
        sha256: { noarch: "00" },
      }],
      { prefix, workDir },
    );
    assert(run.code !== 0, "a malformed id must fail");
    assertStringIncludes(run.stderr, "Java");
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - duplicate ids are rejected", async () => {
  await withDirs(async (workDir, prefix) => {
    const entry = {
      id: "java",
      url: { noarch: "file:///x.tar.gz" },
      sha256: { noarch: "00" },
    };
    const run = await runInstaller([entry, entry], { prefix, workDir });
    assert(run.code !== 0, "duplicate ids must fail");
    assertStringIncludes(run.stderr, "duplicate");
    assertStringIncludes(run.stderr, "java");
  });
});

Deno.test("install-tools - an unsupported archive extension aborts before download", async () => {
  await withDirs(async (workDir, prefix) => {
    const run = await runInstaller(
      [{
        id: "weird",
        url: { noarch: "file:///pkg.7z" },
        sha256: { noarch: "00" },
      }],
      { prefix, workDir },
    );
    assert(run.code !== 0, "an unsupported extension must fail");
    assertStringIncludes(run.stderr, "weird");
    assertStringIncludes(run.stderr, "unsupported archive extension");
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - an entry with no spec for the build architecture aborts", async () => {
  await withDirs(async (workDir, prefix) => {
    // Only arm64 supplied; the build is amd64 and there is no noarch fallback.
    const run = await runInstaller(
      [{
        id: "java",
        url: { arm64: "file:///java.tar.gz" },
        sha256: { arm64: "00" },
      }],
      { prefix, workDir, arch: "amd64" },
    );
    assert(run.code !== 0, "a missing architecture must fail");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "amd64");
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - a checksum mismatch fails non-zero and names the tool", async () => {
  await withDirs(async (workDir, prefix) => {
    const fixture = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\n",
    });
    const run = await runInstaller(
      [{
        id: "java",
        url: { noarch: fixture.url },
        // Deliberately wrong checksum.
        sha256: { noarch: "0".repeat(64) },
        stripComponents: 1,
      }],
      { prefix, workDir },
    );
    assert(run.code !== 0, "a checksum mismatch must fail");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "SHA-256");
    // Fail-closed: nothing usable left behind.
    assert(
      !existsSync(`${prefix}/java/bin/java`),
      "a mismatched tool must not be installed",
    );
  });
});

Deno.test("install-tools - a valid two-tool spec installs both and writes the environment file", async () => {
  await withDirs(async (workDir, prefix) => {
    const java = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\necho java\n",
      "lib/rt": "rt\n",
    });
    const maven = await fixtureTarGz(workDir, "apache-maven-3.9", {
      "bin/mvn": "#!/bin/sh\necho mvn\n",
    });
    const run = await runInstaller(
      [
        {
          id: "java",
          url: { noarch: java.url },
          sha256: { noarch: java.sha256 },
          stripComponents: 1,
          bin: ["bin"],
          env: { JAVA_HOME: "" },
        },
        {
          id: "maven",
          url: { noarch: maven.url },
          sha256: { noarch: maven.sha256 },
          stripComponents: 1,
          bin: ["bin"],
          env: { MAVEN_HOME: "", M2_REPO: "repository" },
        },
      ],
      { prefix, workDir },
    );

    assertEquals(run.code, 0, run.stderr);
    // strip-components peeled the top directory off both.
    assertEquals(
      await Deno.readTextFile(`${prefix}/java/bin/java`),
      "#!/bin/sh\necho java\n",
    );
    assertEquals(await Deno.readTextFile(`${prefix}/java/lib/rt`), "rt\n");
    assertEquals(
      await Deno.readTextFile(`${prefix}/maven/bin/mvn`),
      "#!/bin/sh\necho mvn\n",
    );

    // The environment hand-off (#74 consumes it): PATH per bin dir, then env.
    const env = (await Deno.readTextFile(`${prefix}/environment`))
      .split("\n").filter((l) => l.length > 0);
    assert(env.includes(`PATH=${prefix}/java/bin`), env.join(" | "));
    assert(env.includes(`JAVA_HOME=${prefix}/java`), env.join(" | "));
    assert(env.includes(`PATH=${prefix}/maven/bin`), env.join(" | "));
    assert(env.includes(`MAVEN_HOME=${prefix}/maven`), env.join(" | "));
    assert(env.includes(`M2_REPO=${prefix}/maven/repository`), env.join(" | "));
  });
});

Deno.test("install-tools - a newline in an env value is refused before any download", async () => {
  await withDirs(async (workDir, prefix) => {
    const java = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\n",
    });
    // The environment hand-off is one KEY=value per line, so a value carrying a
    // newline would append a `PATH=` line aimed outside the install prefix.
    const run = await runInstaller(
      [{
        id: "java",
        url: { noarch: java.url },
        sha256: { noarch: java.sha256 },
        stripComponents: 1,
        env: { JAVA_HOME: "lib\nPATH=/tmp/attacker-bin" },
      }],
      { prefix, workDir },
    );

    assert(run.code !== 0, "a newline-bearing env value must fail");
    assertStringIncludes(run.stderr, "java");
    assertStringIncludes(run.stderr, "newline");
    // Refused for the whole set: nothing downloaded, nothing recorded.
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - a newline in a bin entry is refused before any download", async () => {
  await withDirs(async (workDir, prefix) => {
    const java = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\n",
    });
    const run = await runInstaller(
      [{
        id: "java",
        url: { noarch: java.url },
        sha256: { noarch: java.sha256 },
        stripComponents: 1,
        bin: ["bin\nPATH=/tmp/attacker-bin"],
      }],
      { prefix, workDir },
    );

    assert(run.code !== 0, "a newline-bearing bin entry must fail");
    assertStringIncludes(run.stderr, "newline");
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - a newline in an env NAME is refused before any download", async () => {
  await withDirs(async (workDir, prefix) => {
    const java = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\n",
    });
    // The name is the left half of the same line as the value, so a newline
    // there injects a line just as surely — here a PATH= the entrypoint would
    // prepend, aimed outside the install prefix.
    const run = await runInstaller(
      [{
        id: "java",
        url: { noarch: java.url },
        sha256: { noarch: java.sha256 },
        stripComponents: 1,
        env: { "A\nPATH=/tmp/attacker-bin:x": "" },
      }],
      { prefix, workDir },
    );

    assert(
      run.code !== 0,
      `a newline-bearing env name must fail: ${run.stdout}`,
    );
    assertStringIncludes(run.stderr, "newline");
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - a bin block jq cannot walk aborts rather than installing a PATH-less tool", async () => {
  await withDirs(async (workDir, prefix) => {
    const java = await fixtureTarGz(workDir, "java-1.0", {
      "bin/java": "#!/bin/sh\n",
    });
    // `bin` as a string, not an array. The environment-recording loops read it
    // through a process substitution whose status nothing observes, so this
    // used to install the tool, record no PATH line, and exit 0.
    const run = await runInstaller(
      [{
        id: "java",
        url: { noarch: java.url },
        sha256: { noarch: java.sha256 },
        stripComponents: 1,
        bin: "bin",
      }],
      { prefix, workDir },
    );

    assert(run.code !== 0, `a malformed bin block must fail: ${run.stdout}`);
    assertEquals([...Deno.readDirSync(prefix)].length, 0);
  });
});

Deno.test("install-tools - a zip whose strip level is a symlink does not copy the link target in", async () => {
  await withDirs(async (workDir, prefix) => {
    // A directory the archive has no business reaching: it stands in for
    // anything readable on the build host.
    const outside = `${workDir}/outside`;
    await Deno.mkdir(outside, { recursive: true });
    await Deno.writeTextFile(`${outside}/host-secret.txt`, "not yours\n");

    // One entry, `top`, a symlink at that directory — so `stripComponents: 1`
    // descends into it unless the installer refuses a symlinked strip level.
    const archive = `${workDir}/symlink.zip`;
    await Deno.writeFile(
      archive,
      zipSymlinkEntry("top", outside),
    );

    const run = await runInstaller(
      [{
        id: "zt",
        url: { noarch: `file://${archive}` },
        sha256: { noarch: await sha256Hex(archive) },
        stripComponents: 1,
      }],
      { prefix, workDir },
    );

    assert(run.code !== 0, `a symlinked strip level must fail: ${run.stdout}`);
    assertStringIncludes(run.stderr, "extraction failed");
    assert(
      !existsSync(`${prefix}/zt/host-secret.txt`),
      "the link target's tree must not be copied into the install prefix",
    );
  });
});

/** CRC-32 (IEEE) of a byte string, as the zip central directory records it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * A one-entry `.zip` holding a UNIX symlink — the link target is the entry's
 * body and the mode in the external attributes is what makes `unzip` restore
 * it as a link. Written here rather than shelled out to `zip`, which the
 * image does not carry.
 */
function zipSymlinkEntry(name: string, target: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode(target);
  const crc = crc32(data);
  const symlinkMode = 0o120777;

  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034B50, true);
  lv.setUint16(4, 20, true); // version needed
  lv.setUint16(8, 0, true); // stored, not deflated
  lv.setUint16(12, 0x21, true); // 1980-01-01
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014B50, true);
  cv.setUint16(4, (3 << 8) | 20, true); // made by UNIX — external attrs are a mode
  cv.setUint16(6, 20, true);
  cv.setUint16(14, 0x21, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(38, (symlinkMode << 16) >>> 0, true);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054B50, true);
  ev.setUint16(8, 1, true); // entries on this disk
  ev.setUint16(10, 1, true); // entries in total
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

/** Local existsSync without importing std/fs. */
function existsSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
