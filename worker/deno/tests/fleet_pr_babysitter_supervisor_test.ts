import { assert, assertEquals } from "@std/assert";
import {
  pruneLogs,
  recoverLogs,
} from "../commands/fleet_pr_babysitter_supervisor.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

Deno.test("retention only removes old completed babysitter archives", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (
      const name of [
        "pass-a.log.gz",
        "pass-b.log.gz",
        "pass-c.log.gz",
        "pass-active.log",
        "other.log.gz",
      ]
    ) {
      await Deno.writeTextFile(`${dir}/${name}`, name);
    }
    await pruneLogs(dir, 2);
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(
      names.filter((name) => /^pass-.*\.log\.gz$/.test(name)).length,
      2,
    );
    assert(names.includes("pass-active.log"));
    assert(names.includes("other.log.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("interrupted logs are recovered without touching a live pass", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/pass-99999999-dead.log`, "recovered");
    await Deno.writeTextFile(`${dir}/pass-${Deno.pid}-live.log`, "active");
    await recoverLogs(dir);
    assertEquals(
      await Deno.readTextFile(`${dir}/pass-${Deno.pid}-live.log`),
      "active",
    );
    const file = await Deno.open(`${dir}/pass-99999999-dead.log.gz`);
    assertEquals(
      await new Response(
        file.readable.pipeThrough(new DecompressionStream("gzip")),
      ).text(),
      "recovered",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failed pass is archived and calls the configured health hook", async () => {
  const home = await Deno.makeTempDir();
  try {
    const root = `${home}/.vibe-coder/fleet-pr-babysitter`;
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/health-hook`,
      `#!/bin/sh\nprintf '%s' "$1" > '${root}/health-result'\n`,
      { mode: 0o700 },
    );
    const checkout = decodeURIComponent(
      new URL("../../..", import.meta.url).pathname,
    );
    const result = await runWithTimeout(Deno.execPath(), [
      "run",
      "--allow-all",
      "worker/deno/commands/fleet_pr_babysitter_supervisor.ts",
      "--invalid",
    ], {
      cwd: checkout,
      env: { HOME: home },
      timeoutMs: 60_000,
    });
    assert(result.ok);
    assert(!result.value.success);
    assertEquals(await Deno.readTextFile(`${root}/health-result`), "1");
    const files: string[] = [];
    for await (const item of Deno.readDir(`${root}/logs`)) {
      files.push(item.name);
    }
    assertEquals(files.length, 1);
    assert(files[0]?.endsWith(".log.gz"));
    const archive = await Deno.open(`${root}/logs/${files[0]}`);
    const output = await new Response(
      archive.readable.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    assert(output.includes("Usage: fleet_pr_babysitter.ts"));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
