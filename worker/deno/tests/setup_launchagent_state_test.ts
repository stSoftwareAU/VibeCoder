/**
 * `launchagent --status` must report what launchd knows, not what `stat` sees
 * (Issue #1369).
 *
 * On GRQ-25 the agent was booted out while its plist stayed on disk. Status
 * read the plist and printed `installed`, so the host looked healthy while
 * launchd had no such service; re-running setup then compared plist *content*,
 * found it identical, and reported "already up to date" without bootstrapping,
 * so answering `y` could not recover the host — only a hand-typed
 * `launchctl bootstrap` did.
 *
 * launchctl is driven through an injected driver here, so these tests assert
 * real behaviour on any platform without touching the host's agents.
 *
 * Australian English spelling used throughout (behaviour, honoured).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  bootstrapAgent,
  getLaunchAgentStatus,
  type LaunchctlDriver,
  reloadIfUnloaded,
} from "../setup/launchagent.ts";

const PLIST_NAME = "com.vibe.auto-issue-worker.plist";

/** A launchctl that records its calls and answers `print` as told. */
function fakeLaunchctl(
  options: { loaded: boolean; failing?: string[] },
): LaunchctlDriver & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    uid: () => Promise.resolve("501"),
    run: (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") {
        return Promise.resolve({ success: options.loaded });
      }
      const failing = options.failing ?? [];
      return Promise.resolve({ success: !failing.includes(args[0] ?? "") });
    },
  };
}

/** A temp LaunchAgents directory, optionally holding a plist. */
async function withDir(
  withPlist: boolean,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    if (withPlist) await Deno.writeTextFile(`${dir}/${PLIST_NAME}`, "<plist/>");
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── getLaunchAgentStatus ────────────────────────────────────────────────

Deno.test("getLaunchAgentStatus - a plist launchd has forgotten is not 'installed' (Issue #1369)", async () => {
  await withDir(true, async (dir) => {
    const launchctl = fakeLaunchctl({ loaded: false });
    assertEquals(
      await getLaunchAgentStatus(dir, launchctl),
      "plist-not-loaded",
    );
    // The verdict came from launchd, not from stat.
    assertEquals(launchctl.calls[0], [
      "print",
      "gui/501/com.vibe.auto-issue-worker",
    ]);
  });
});

Deno.test("getLaunchAgentStatus - a loaded agent reports installed (Issue #1369)", async () => {
  await withDir(true, async (dir) => {
    assertEquals(
      await getLaunchAgentStatus(dir, fakeLaunchctl({ loaded: true })),
      "installed",
    );
  });
});

Deno.test("getLaunchAgentStatus - no plist is not-installed, and launchd is not asked (Issue #1369)", async () => {
  await withDir(false, async (dir) => {
    const launchctl = fakeLaunchctl({ loaded: false });
    assertEquals(await getLaunchAgentStatus(dir, launchctl), "not-installed");
    assertEquals(launchctl.calls.length, 0);
  });
});

// ── reloadIfUnloaded ────────────────────────────────────────────────────

Deno.test("reloadIfUnloaded - an unloaded plist is bootstrapped and enabled (Issue #1369)", async () => {
  const launchctl = fakeLaunchctl({ loaded: false });
  const result = await reloadIfUnloaded("/tmp/x.plist", launchctl);

  assertEquals(result.ok, true);
  assertEquals(result.reloaded, true);
  assertEquals(launchctl.calls, [
    ["print", "gui/501/com.vibe.auto-issue-worker"],
    ["bootstrap", "gui/501", "/tmp/x.plist"],
    ["enable", "gui/501/com.vibe.auto-issue-worker"],
  ]);
});

Deno.test("reloadIfUnloaded - a loaded agent is left alone (Issue #1369)", async () => {
  const launchctl = fakeLaunchctl({ loaded: true });
  const result = await reloadIfUnloaded("/tmp/x.plist", launchctl);

  assertEquals(result.ok, true);
  assertEquals(result.reloaded, false);
  assertEquals(launchctl.calls.length, 1);
});

Deno.test("reloadIfUnloaded - falls back to legacy load when bootstrap fails (Issue #1369)", async () => {
  const launchctl = fakeLaunchctl({ loaded: false, failing: ["bootstrap"] });
  const result = await reloadIfUnloaded("/tmp/x.plist", launchctl);

  assertEquals(result.ok, true);
  assertEquals(result.reloaded, true);
  assertEquals(launchctl.calls[2], ["load", "/tmp/x.plist"]);
});

Deno.test("reloadIfUnloaded - a job launchd refuses to enable fails loud (Issue #1369)", async () => {
  // Bootstrapped but disabled is a host with no worker, and that must never
  // be reported as a reload that worked.
  const launchctl = fakeLaunchctl({ loaded: false, failing: ["enable"] });
  const result = await reloadIfUnloaded("/tmp/x.plist", launchctl);

  assertEquals(result.ok, false);
  assertEquals(result.reloaded, false);
  assertStringIncludes(result.message, "launchctl enable");
});

Deno.test("bootstrapAgent - reports the enabled job it loaded (Issue #1369)", async () => {
  const launchctl = fakeLaunchctl({ loaded: false });
  const result = await bootstrapAgent("/tmp/x.plist", launchctl);

  assertEquals(result.ok, true);
  assertEquals(launchctl.calls, [
    ["bootstrap", "gui/501", "/tmp/x.plist"],
    ["enable", "gui/501/com.vibe.auto-issue-worker"],
  ]);
});

Deno.test("reloadIfUnloaded - a plist that cannot be loaded fails loud (Issue #1369)", async () => {
  const launchctl = fakeLaunchctl({
    loaded: false,
    failing: ["bootstrap", "load"],
  });
  const result = await reloadIfUnloaded("/tmp/x.plist", launchctl);

  assertEquals(result.ok, false);
  assertEquals(result.reloaded, false);
  assertStringIncludes(result.message, "launchctl bootstrap");
  assertStringIncludes(result.message, "/tmp/x.plist");
});
