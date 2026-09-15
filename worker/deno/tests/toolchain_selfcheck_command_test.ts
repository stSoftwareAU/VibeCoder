/**
 * Tests for the `toolchain-selfcheck` command (Issues #1956, #2070–#2073).
 *
 * The command is the worker's own start-up check exposed to CI; these cases
 * pin the contract CI relies on — the exit status per fault kind, and that a
 * run outside the image is a failure rather than a silent pass.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { toolchainSelfcheckCommand } from "../commands/toolchain_selfcheck.ts";
import {
  TOOLCHAIN_SELFCHECK_EXIT_STATUS,
  TOOLCHAIN_SELFCHECK_FAILURE_MARKER,
} from "../lib/toolchain_selfcheck.ts";
import { CONTAINER_IMAGE_STAMP_ENV } from "../lib/container_stamp.ts";
import type { WorkerConfig } from "../types.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const CONFIG = {} as WorkerConfig;

const IN_IMAGE = (name: string): string | undefined =>
  name === CONTAINER_IMAGE_STAMP_ENV ? "claude" : undefined;

const ON_HOST = (_name: string): string | undefined => undefined;

const COMMITTED_MANIFEST = JSON.parse(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
) as Record<string, unknown>;

function manifestWith(toolchains: Array<Record<string, unknown>>): string {
  return JSON.stringify({ ...COMMITTED_MANIFEST, toolchains });
}

function commandToolchain(id: string, version: string) {
  return {
    id,
    version,
    versionArg: `${id.toUpperCase().replace(/-/g, "_")}_VERSION`,
    commands: [id],
    versionCommand: id,
    source: `https://example.invalid/${id}`,
    repos: ["stSoftwareAU/VibeCoder"],
    sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) },
  };
}

Deno.test("toolchain-selfcheck - is registered under the name the CI step invokes", () => {
  assertEquals(toolchainSelfcheckCommand.name, "toolchain-selfcheck");
});

Deno.test("toolchain-selfcheck - outside the image is a failure, not a pass", async () => {
  const result = await toolchainSelfcheckCommand.execute(
    { "base-dir": REPO_ROOT },
    CONFIG,
    { env: ON_HOST },
  );
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.message, "nothing verified");
  assertStringIncludes(result.message, CONTAINER_IMAGE_STAMP_ENV);
});

Deno.test("toolchain-selfcheck - a healthy image passes with one line per toolchain", async () => {
  const result = await toolchainSelfcheckCommand.execute(
    { "base-dir": "/nowhere" },
    CONFIG,
    {
      env: IN_IMAGE,
      readManifest: () =>
        Promise.resolve(manifestWith([commandToolchain("node", "24.19.0")])),
      runProbe: () =>
        Promise.resolve({ code: 0, stdout: "v24.19.0\n", stderr: "" }),
    },
  );
  assertEquals(result.success, true, result.message);
  assertEquals(result.exitCode, undefined);
  assertStringIncludes(result.message, "ok node 24.19.0");
  assertStringIncludes(result.message, "1 toolchains verified");
});

Deno.test("toolchain-selfcheck - an image fault exits with the worker's own status and marker", async () => {
  const result = await toolchainSelfcheckCommand.execute(
    { "base-dir": "/nowhere" },
    CONFIG,
    {
      env: IN_IMAGE,
      readManifest: () =>
        Promise.resolve(manifestWith([commandToolchain("node", "24.19.0")])),
      runProbe: () =>
        Promise.resolve({ code: 0, stdout: "v22.0.0\n", stderr: "" }),
    },
  );
  assertEquals(result.success, false);
  assertEquals(result.exitCode, TOOLCHAIN_SELFCHECK_EXIT_STATUS);
  assertStringIncludes(result.message, "FAILED node 24.19.0");
  assertStringIncludes(
    result.message,
    `${TOOLCHAIN_SELFCHECK_FAILURE_MARKER} node`,
  );
  assertEquals(result.data?.failed, ["node"]);
});

Deno.test("toolchain-selfcheck - a manifest fault is the ordinary status 1 with no marker", async () => {
  const result = await toolchainSelfcheckCommand.execute(
    { "base-dir": "/nowhere" },
    CONFIG,
    {
      env: IN_IMAGE,
      readManifest: () => Promise.reject(new Error("ENOENT")),
    },
  );
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
  assertEquals(
    result.message.includes(TOOLCHAIN_SELFCHECK_FAILURE_MARKER),
    false,
  );
  assertStringIncludes(result.message, "could not be read");
});

Deno.test("toolchain-selfcheck - defaults the repository root to the working directory", async () => {
  const seen: string[] = [];
  await toolchainSelfcheckCommand.execute({}, CONFIG, {
    env: IN_IMAGE,
    readManifest: () => {
      seen.push("read");
      return Promise.reject(new Error("stop"));
    },
  });
  // The manifest path is derived from the root; a read attempt proves the
  // default root was used rather than the command refusing without --base-dir.
  assertEquals(seen, ["read"]);
});
