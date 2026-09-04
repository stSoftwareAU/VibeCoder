/**
 * Tests for host_escalation.ts — the channel a HOST-level failure reaches a
 * human through (Issue #556).
 *
 * The pure and filesystem-driven halves are covered here; the `gh` writes
 * themselves are exercised through their callers' injected seams, the way
 * every other worker write is.
 *
 * Issue #967: every case hands the module its own environment map instead of
 * moving `HOME`, `GH_CONFIG_DIR` and the scratch root for every other test in
 * the process. The injected values are throwaway temporary directories that
 * appear in no real environment, so a fall back to `Deno.env.get` fails here
 * rather than passing on the ambient value.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  escalationHostId,
  parseOriginRepo,
  resolveEscalationGhEnv,
} from "../lib/host_escalation.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("parseOriginRepo - reads owner/repo from SSH and HTTPS origins", () => {
  assertEquals(
    parseOriginRepo("git@github.com:stSoftwareAU/VibeCoder.git"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(
    parseOriginRepo("https://github.com/stSoftwareAU/VibeCoder"),
    "stSoftwareAU/VibeCoder",
  );
  assertEquals(parseOriginRepo("https://example.com/not/github"), null);
});

Deno.test("escalationHostId - the fleet host id wins over the machine name", () => {
  assertEquals(escalationHostId(envFrom({ VIBE_HOST_ID: "GRQ-23" })), "GRQ-23");
});

Deno.test("escalationHostId - no host id falls back to the machine name", () => {
  // The injected map carries no VIBE_HOST_ID, so the hostname branch runs —
  // and a read of the ambient variable (set on every fleet host) would give
  // the fleet id instead and fail here.
  assertEquals(escalationHostId(emptyEnv), Deno.hostname().split(".")[0]);
});

Deno.test("resolveEscalationGhEnv - an established GH_CONFIG_DIR is left alone", async () => {
  assertEquals(
    await resolveEscalationGhEnv(envFrom({ GH_CONFIG_DIR: "/staged/gh" })),
    {},
  );
});

Deno.test("resolveEscalationGhEnv - finds the scratch copy the entrypoint stages", async () => {
  // Issue #515 moved the writable copy to the scratch root; an escalation
  // runs before the configuration load, so it must know both locations.
  const root = await Deno.makeTempDir();
  try {
    const scratch = `${root}/scratch`;
    await Deno.mkdir(`${scratch}/gh`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/gh/hosts.yml`, "github.com:\n");
    assertEquals(
      await resolveEscalationGhEnv(
        envFrom({ VIBE_SCRATCH_DIR: scratch, HOME: root }),
      ),
      { GH_CONFIG_DIR: `${scratch}/gh` },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveEscalationGhEnv - falls back to the legacy runtime copy", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.config/gh-runtime`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.config/gh-runtime/hosts.yml`,
      "github.com:\n",
    );
    assertEquals(
      await resolveEscalationGhEnv(envFrom({ HOME: home })),
      { GH_CONFIG_DIR: `${home}/.config/gh-runtime` },
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("resolveEscalationGhEnv - no staged copy leaves gh to resolve its own", async () => {
  const home = await Deno.makeTempDir();
  try {
    assertEquals(await resolveEscalationGhEnv(envFrom({ HOME: home })), {});
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
