/**
 * The pre-started guest memory tag reaper (Issue #5638). Linux only: the
 * helper walks /proc with bash builtins, and these tests spawn real processes
 * carrying the spawn tag.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  AGENT_SPAWN_TAG_ENV,
  DEFAULT_LEFTOVER_REAPER_DEPS,
} from "../lib/agent_leftover_reaper.ts";
import { startGuestMemoryTagReaper } from "../lib/guest_memory_tag_reaper.ts";

const opts = { ignore: Deno.build.os !== "linux" };
const permissions = {
  read: true,
  write: true,
  run: true,
  env: true,
} as const;

/** Spawn `sleep 300` with exactly `extraEnv` added to a minimal environment. */
function spawnSleep(extraEnv: Record<string, string>): Deno.ChildProcess {
  return new Deno.Command("sleep", {
    args: ["300"],
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", ...extraEnv },
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

/**
 * Spawn `bash -c 'sleep 300 & echo $!; wait'` carrying `extraEnv`, and read
 * back the pid of the `sleep` it started, a grandchild of the test.
 */
async function spawnBashWithGrandchild(
  extraEnv: Record<string, string>,
): Promise<{ child: Deno.ChildProcess; grandchild: number }> {
  const child = new Deno.Command("bash", {
    args: ["-c", "sleep 300 & echo $!; wait"],
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", ...extraEnv },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  return { child, grandchild: Number(text.trim()) };
}

/** Whether `pid` is running and not a zombie, read from /proc. */
async function isLive(pid: number): Promise<boolean> {
  let stat: string;
  try {
    stat = await Deno.readTextFile(`/proc/${pid}/stat`);
  } catch {
    return false;
  }
  // The state is the first field after the parenthesised command name.
  const state = stat.slice(stat.lastIndexOf(")") + 2).charAt(0);
  return state !== "Z" && state !== "X";
}

/** Poll until `pid` is gone or a zombie, for up to 5 s. */
async function waitUntilGone(pid: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (!(await isLive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Kill a child the test still holds, then wait for its status. */
async function stopChild(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // The child has already exited.
  }
  await child.status;
}

Deno.test({
  name:
    "guest memory tag reaper - a sweep signals the tagged processes and nothing else (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const tag = crypto.randomUUID();
    const tagged = { [AGENT_SPAWN_TAG_ENV]: tag };
    const direct = spawnSleep(tagged);
    const bash = await spawnBashWithGrandchild(tagged);
    const nearMiss = spawnSleep({ [AGENT_SPAWN_TAG_ENV]: `${tag}0` });
    const untagged = spawnSleep({});
    const reaper = startGuestMemoryTagReaper(tag, { spawnTimeoutMs: 60_000 });
    try {
      assertEquals(await reaper.sweep(), 3);
      assertEquals((await direct.status).signal, "SIGKILL");
      assertEquals((await bash.child.status).signal, "SIGKILL");
      await waitUntilGone(bash.grandchild);
      assert(!(await isLive(bash.grandchild)), "grandchild still running");
      assert(await isLive(nearMiss.pid), "near-miss tag was signalled");
      assert(await isLive(untagged.pid), "untagged process was signalled");
      assertEquals(await reaper.sweep(), 0);
    } finally {
      await reaper.close();
      await stopChild(direct);
      await stopChild(bash.child);
      await stopChild(nearMiss);
      await stopChild(untagged);
    }
  },
});

Deno.test({
  name:
    "guest memory tag reaper - a malformed tag is refused before anything spawns (Issue #5638)",
  ...opts,
  permissions,
  fn() {
    for (const tag of ["../x", ""]) {
      assertThrows(
        () => startGuestMemoryTagReaper(tag, { spawnTimeoutMs: 1_000 }),
        Error,
        "malformed spawn tag",
      );
    }
  },
});

Deno.test({
  name:
    "guest memory tag reaper - a sweep after close rejects and close twice is fine (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const reaper = startGuestMemoryTagReaper(crypto.randomUUID(), {
      spawnTimeoutMs: 60_000,
    });
    await reaper.close();
    await reaper.close();
    await assertRejects(() => reaper.sweep(), Error, "closed");
  },
});

Deno.test({
  name:
    "guest memory tag reaper - a helper that dies makes the sweep reject with its cause (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const reaper = startGuestMemoryTagReaper(crypto.randomUUID(), {
      bashPath: "false",
      spawnTimeoutMs: 60_000,
    });
    try {
      await assertRejects(
        () => reaper.sweep(),
        Error,
        "exited before answering",
      );
    } finally {
      await reaper.close();
    }
  },
});

Deno.test({
  name:
    "guest memory tag reaper - the sweep lists exactly the pids the leftover reaper's scan finds (Issue #5638)",
  ...opts,
  permissions,
  async fn() {
    const tag = crypto.randomUUID();
    const tagged = spawnSleep({ [AGENT_SPAWN_TAG_ENV]: tag });
    const nearMiss = spawnSleep({ [AGENT_SPAWN_TAG_ENV]: `${tag}0` });
    const prefixOnly = spawnSleep({
      [AGENT_SPAWN_TAG_ENV]: tag.slice(0, -1),
    });
    const untagged = spawnSleep({});
    const reaper = startGuestMemoryTagReaper(tag, { spawnTimeoutMs: 60_000 });
    try {
      const found = await DEFAULT_LEFTOVER_REAPER_DEPS.findTagged(
        `${AGENT_SPAWN_TAG_ENV}=${tag}`,
      );
      assert(found.ok, `scan failed: ${found.ok ? "" : found.error}`);
      assertEquals([...found.pids].sort(), [tagged.pid]);
      assertEquals(await reaper.sweep(), found.pids.length);
      assertEquals((await tagged.status).signal, "SIGKILL");
      assert(await isLive(nearMiss.pid), "near-miss tag was signalled");
      assert(await isLive(prefixOnly.pid), "prefix-only tag was signalled");
      assert(await isLive(untagged.pid), "untagged process was signalled");
    } finally {
      await reaper.close();
      await stopChild(tagged);
      await stopChild(nearMiss);
      await stopChild(prefixOnly);
      await stopChild(untagged);
    }
  },
});
