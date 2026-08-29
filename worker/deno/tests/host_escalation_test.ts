/**
 * Tests for host_escalation.ts — the channel a HOST-level failure reaches a
 * human through (Issue #556).
 *
 * The pure and filesystem-driven halves are covered here; the `gh` writes
 * themselves are exercised through their callers' injected seams, the way
 * every other worker write is.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  escalationHostId,
  parseOriginRepo,
  resolveEscalationGhEnv,
} from "../lib/host_escalation.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}

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
  const previous = Deno.env.get("VIBE_HOST_ID");
  try {
    Deno.env.set("VIBE_HOST_ID", "GRQ-23");
    assertEquals(escalationHostId(), "GRQ-23");
  } finally {
    restoreEnv("VIBE_HOST_ID", previous);
  }
});

Deno.test("resolveEscalationGhEnv - an established GH_CONFIG_DIR is left alone", async () => {
  const previous = Deno.env.get("GH_CONFIG_DIR");
  try {
    Deno.env.set("GH_CONFIG_DIR", "/staged/gh");
    assertEquals(await resolveEscalationGhEnv(), {});
  } finally {
    restoreEnv("GH_CONFIG_DIR", previous);
  }
});

Deno.test("resolveEscalationGhEnv - finds the scratch copy the entrypoint stages", async () => {
  // Issue #515 moved the writable copy to the scratch root; an escalation
  // runs before the configuration load, so it must know both locations.
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousScratch = Deno.env.get("VIBE_SCRATCH_DIR");
  const previousHome = Deno.env.get("HOME");
  const root = await Deno.makeTempDir();
  try {
    const scratch = `${root}/scratch`;
    await Deno.mkdir(`${scratch}/gh`, { recursive: true });
    await Deno.writeTextFile(`${scratch}/gh/hosts.yml`, "github.com:\n");
    Deno.env.delete("GH_CONFIG_DIR");
    Deno.env.set("VIBE_SCRATCH_DIR", scratch);
    Deno.env.set("HOME", root);
    assertEquals(await resolveEscalationGhEnv(), {
      GH_CONFIG_DIR: `${scratch}/gh`,
    });
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("VIBE_SCRATCH_DIR", previousScratch);
    restoreEnv("HOME", previousHome);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveEscalationGhEnv - falls back to the legacy runtime copy", async () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousScratch = Deno.env.get("VIBE_SCRATCH_DIR");
  const previousHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.config/gh-runtime`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.config/gh-runtime/hosts.yml`,
      "github.com:\n",
    );
    Deno.env.delete("GH_CONFIG_DIR");
    Deno.env.delete("VIBE_SCRATCH_DIR");
    Deno.env.set("HOME", home);
    assertEquals(await resolveEscalationGhEnv(), {
      GH_CONFIG_DIR: `${home}/.config/gh-runtime`,
    });
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("VIBE_SCRATCH_DIR", previousScratch);
    restoreEnv("HOME", previousHome);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("resolveEscalationGhEnv - no staged copy leaves gh to resolve its own", async () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousScratch = Deno.env.get("VIBE_SCRATCH_DIR");
  const previousHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir();
  try {
    Deno.env.delete("GH_CONFIG_DIR");
    Deno.env.delete("VIBE_SCRATCH_DIR");
    Deno.env.set("HOME", home);
    assertEquals(await resolveEscalationGhEnv(), {});
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("VIBE_SCRATCH_DIR", previousScratch);
    restoreEnv("HOME", previousHome);
    await Deno.remove(home, { recursive: true });
  }
});
