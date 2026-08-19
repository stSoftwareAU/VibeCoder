/**
 * Tests that the `quality` deno task is no looser than its shell entrypoint
 * (Issue #3661, SEC-91615038a0b2).
 *
 * `deno.json`'s `quality` task ran `quality.ts` with `--allow-all` while
 * `quality.sh` ran the same file with an explicit five-permission set. Two
 * entrypoints to one script should not grant different authority — the wider
 * one becomes the path of least resistance and quietly erodes the narrower.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

/** Repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

/** The `--allow-*` flags in a command string, sorted. */
function permissionFlags(command: string): string[] {
  return (command.match(/--allow-[a-z-]+(?:=[^\s]+)?/g) ?? []).sort();
}

Deno.test("deno.json - the quality task does not use --allow-all", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${repoRoot()}worker/deno/deno.json`),
  ) as { tasks: Record<string, string> };

  assertEquals(
    denoJson.tasks.quality?.includes("--allow-all"),
    false,
    "the quality task must not grant blanket permissions — quality.sh runs " +
      "the same script with an explicit permission set (Issue #3661)",
  );
});

Deno.test("deno.json - the quality task matches quality.sh's permission set", async () => {
  const root = repoRoot();
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${root}worker/deno/deno.json`),
  ) as { tasks: Record<string, string> };
  const qualityTask = denoJson.tasks.quality;
  assert(qualityTask, "deno.json must define a quality task");

  const shell = await Deno.readTextFile(`${root}quality.sh`);
  // The exec block that runs worker/deno/quality.ts. Since Issue #4258 the
  // exec line may carry a scheduler-priority prefix (nice) ahead of the
  // deno invocation; the permission flags all sit after `run`, so the
  // prefix is irrelevant to the parity this test guards.
  const execBlock = /exec [^\n]*?"\$DENO_CMD" run([\s\S]*?quality\.ts)/.exec(
    shell,
  );
  assert(execBlock, "could not locate the quality.ts exec block in quality.sh");

  assertEquals(
    permissionFlags(qualityTask),
    permissionFlags(execBlock[1]!),
    "the deno task and the shell entrypoint must grant the same permissions",
  );
});
