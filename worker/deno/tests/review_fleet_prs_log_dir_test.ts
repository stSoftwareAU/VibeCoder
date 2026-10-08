/**
 * The review-fleet-prs skill keeps its logs beside the Vibe Coder's own, in
 * `<log_dir>/review-fleet-prs` (the `.config.json` `log_dir`, else the
 * platform default), not in a hidden directory. History from the old
 * `~/.review-fleet-prs` moves across once, so no review is repeated.
 */
import { assertEquals } from "@std/assert";
import {
  LOG_FILE,
  migrateLegacyStateDir,
  stateDir,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

// The home directory is passed in, never set on the process: tests run in
// parallel and share one environment (Issue #880).
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return await fn(await Deno.makeTempDir());
}

// The environment a host with this home and no XDG_STATE_HOME would have.
const envFor = (home: string) => (name: string) =>
  name === "HOME" ? home : undefined;

Deno.test("stateDir lives in the configured log_dir, ~ expanded", async () => {
  await withHome(async (home) => {
    const config = `${home}/config.json`;
    await Deno.writeTextFile(config, JSON.stringify({ log_dir: "~/logs" }));
    assertEquals(
      stateDir(config, envFor(home)),
      `${home}/logs/review-fleet-prs`,
    );
  });
});

Deno.test("stateDir falls back to the Vibe Coder's platform log directory", async () => {
  await withHome(async (home) => {
    const dir = stateDir(`${home}/no-such-config.json`, envFor(home));
    const expected = Deno.build.os === "darwin"
      ? `${home}/Library/Logs/vibe-coder/review-fleet-prs`
      : `${home}/.local/state/vibe-coder/review-fleet-prs`;
    assertEquals(dir, expected);
  });
});

Deno.test("migrateLegacyStateDir moves ~/.review-fleet-prs history into the log directory once", async () => {
  await withHome(async (home) => {
    const legacy = `${home}/.review-fleet-prs`;
    await Deno.mkdir(`${legacy}/rounds/r1`, { recursive: true });
    await Deno.writeTextFile(`${legacy}/${LOG_FILE}`, '{"old":1}\n');
    await Deno.writeTextFile(`${legacy}/rounds/r1/gate.json`, "{}");
    const target = `${home}/logs/review-fleet-prs`;
    await Deno.mkdir(target, { recursive: true });
    await Deno.writeTextFile(`${target}/runner.log`, "new\n"); // already there

    await migrateLegacyStateDir(target, home);

    assertEquals(
      await Deno.readTextFile(`${target}/${LOG_FILE}`),
      '{"old":1}\n',
    );
    assertEquals(
      await Deno.readTextFile(`${target}/rounds/r1/gate.json`),
      "{}",
    );
    assertEquals(await Deno.readTextFile(`${target}/runner.log`), "new\n");
    let legacyGone = false;
    try {
      await Deno.stat(legacy);
    } catch {
      legacyGone = true;
    }
    assertEquals(legacyGone, true, "the hidden directory is removed");

    await migrateLegacyStateDir(target, home); // nothing left to move: a no-op
    assertEquals(
      await Deno.readTextFile(`${target}/${LOG_FILE}`),
      '{"old":1}\n',
    );
  });
});

Deno.test("migrateLegacyStateDir never overwrites history already in the log directory", async () => {
  await withHome(async (home) => {
    const legacy = `${home}/.review-fleet-prs`;
    await Deno.mkdir(legacy, { recursive: true });
    await Deno.writeTextFile(`${legacy}/${LOG_FILE}`, "old\n");
    const target = `${home}/logs/review-fleet-prs`;
    await Deno.mkdir(target, { recursive: true });
    await Deno.writeTextFile(`${target}/${LOG_FILE}`, "current\n");

    await migrateLegacyStateDir(target, home);

    assertEquals(await Deno.readTextFile(`${target}/${LOG_FILE}`), "current\n");
    assertEquals(await Deno.readTextFile(`${legacy}/${LOG_FILE}`), "old\n");
  });
});
