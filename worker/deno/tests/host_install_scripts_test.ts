/**
 * The host installers under infra/host verify before they install
 * (Issue #2199).
 *
 * The documented Linux host path piped two vendor installers straight into a
 * shell, unpinned and unverified, while every toolchain the container fetches
 * is checked against a pin first. These tests hold the host to the same
 * standard: the Deno pin tracks the image, both scripts refuse tampered
 * bytes and install nothing, and no `curl | sh` installer returns to the
 * four call sites.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const DENO_SCRIPT = `${ROOT}infra/host/install-deno.sh`;
const CLAUDE_SCRIPT = `${ROOT}infra/host/install-claude.sh`;

function read(path: string): string {
  return Deno.readTextFileSync(path);
}

function shellVar(script: string, name: string): string {
  const match = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  assert(match, `${name} is set in the script`);
  return match[1]!;
}

Deno.test("install-deno.sh - pins the same Deno version as the container image", () => {
  const containerfile = read(`${ROOT}container/Containerfile`);
  const image = containerfile.match(
    /denoland\/deno:bin-(\d+\.\d+\.\d+)@sha256:/,
  );
  assert(image, "the Containerfile pins a bin-<version> Deno image");
  assertEquals(shellVar(read(DENO_SCRIPT), "DENO_VERSION"), image[1]);
});

Deno.test("install-deno.sh - carries a 64-hex SHA-256 for each supported architecture and checks it before installing", () => {
  const script = read(DENO_SCRIPT);
  for (const name of ["DENO_SHA256_X86_64", "DENO_SHA256_AARCH64"]) {
    assert(
      /^[0-9a-f]{64}$/.test(shellVar(script, name)),
      `${name} is a SHA-256`,
    );
  }
  const check = script.indexOf("sha256sum -c -");
  const unzip = script.indexOf("unzip -q");
  const install = script.indexOf("install -m 0755");
  assert(
    check > 0 && check < unzip && unzip < install,
    "verify, then extract, then install",
  );
  assert(!/install\.sh\s*\|/.test(script), "no curl-pipe installer");
});

Deno.test("install-claude.sh - reads the version, source and per-arch checksum from container/tools.json, the pin the image is built from", () => {
  const script = read(CLAUDE_SCRIPT);
  assertStringIncludes(script, "container/tools.json");
  for (const field of [".version", ".source", ".binary", ".sha256[$arch]"]) {
    assertStringIncludes(script, field);
  }
  const check = script.indexOf("sha256sum -c -");
  const install = script.indexOf("install -m 0755");
  assert(check > 0 && check < install, "verify before install");
  const manifest = JSON.parse(read(`${ROOT}container/tools.json`)) as {
    providers: Array<{ id: string; sha256: Record<string, string> }>;
  };
  const claude = manifest.providers.find((p) => p.id === "claude");
  assert(
    claude?.sha256.amd64 && claude.sha256.arm64,
    "the manifest carries both pins",
  );
});

/**
 * Run a script with a stub `curl` on PATH that serves `served` for any URL,
 * in a throwaway HOME, and report the exit code, output, and whether anything
 * was installed.
 */
async function runWithStubCurl(
  script: string,
  served: string,
  env: Record<string, string> = {},
): Promise<{ code: number; output: string; installed: string[] }> {
  const home = await Deno.makeTempDir();
  const bin = `${home}/stub-bin`;
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/served.bin`, served);
  await Deno.writeTextFile(
    `${bin}/curl`,
    `#!/usr/bin/env bash
# stub: -o <file> <url> → copy the served bytes
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
cp "${bin}/served.bin" "$out"
`,
  );
  await Deno.chmod(`${bin}/curl`, 0o755);
  // uname says Linux on the CI runner; on a developer's macOS the script
  // refuses before curl — so the platform guard is stubbed too.
  await Deno.writeTextFile(
    `${bin}/uname`,
    `#!/usr/bin/env bash
case "$1" in -s) echo Linux;; -m) echo x86_64;; *) /usr/bin/uname "$@";; esac
`,
  );
  await Deno.chmod(`${bin}/uname`, 0o755);
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: [script],
    env: {
      ...env,
      HOME: home,
      PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
      DENO_INSTALL: `${home}/.deno`,
      CLAUDE_INSTALL_DIR: `${home}/.local/bin`,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const installed: string[] = [];
  for (
    const candidate of [`${home}/.deno/bin/deno`, `${home}/.local/bin/claude`]
  ) {
    try {
      await Deno.stat(candidate);
      installed.push(candidate);
    } catch {
      // not installed
    }
  }
  await Deno.remove(home, { recursive: true });
  return {
    code,
    output: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
    installed,
  };
}

Deno.test("install-deno.sh - a download whose SHA-256 does not match the pin is refused and nothing is installed", async () => {
  const result = await runWithStubCurl(
    DENO_SCRIPT,
    "not the deno release asset\n",
  );
  assert(
    result.code !== 0,
    `expected a refusal, got exit 0:\n${result.output}`,
  );
  assertStringIncludes(result.output, "FAILED");
  assertEquals(result.installed, []);
});

Deno.test("install-claude.sh - a download whose SHA-256 does not match the manifest pin is refused and nothing is installed", async () => {
  const result = await runWithStubCurl(
    CLAUDE_SCRIPT,
    "not the claude binary\n",
  );
  assert(
    result.code !== 0,
    `expected a refusal, got exit 0:\n${result.output}`,
  );
  assertStringIncludes(result.output, "FAILED");
  assertEquals(result.installed, []);
});

Deno.test("no curl-pipe installer remains at any of the four call sites (Issue #2199)", () => {
  for (
    const path of [
      "docs/SETUP.md",
      "infra/cloudformation/linux-verification-host.yaml",
      "setup.sh",
      "quality.sh",
    ]
  ) {
    const text = read(`${ROOT}${path}`);
    assert(
      !/curl[^\n]*install\.sh[^\n]*\|\s*(sh|bash)\b/.test(text),
      `${path} still pipes an installer into a shell`,
    );
    assert(
      !text.includes("deno.land/install.sh") &&
        !text.includes("claude.ai/install.sh"),
      `${path} still names a vendor installer`,
    );
  }
});
