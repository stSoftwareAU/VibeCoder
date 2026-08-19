/**
 * Tests for the in-container sequential quality gate (Issue #4267).
 *
 * Agent sessions kept being SIGKILLed the moment the full gate started —
 * even with the gate under `nice` (#4258/#4259). The remaining spike is
 * parallel-checks mode: `deno test` (13k tests, constant subprocess churn),
 * a whole-repo `deno check`, lint, markdownlint and mermaid all at once
 * inside the VM. quality.sh therefore appends `--sequential` when the
 * container image stamp (`VIBE_IMAGE_AGENT_PROVIDERS`) is present, unless
 * the caller already chose the mode; host/native runs keep parallel mode.
 *
 * The tests drive the real quality.sh with a stub `deno` on PATH that just
 * prints its argv, and a fully explicit environment (clearEnv) so the
 * in-container CI run cannot leak the real image stamp into the "host" case.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

async function runQualitySh(
  extraEnv: Record<string, string>,
  args: string[] = [],
): Promise<string[]> {
  const stubDir = await Deno.makeTempDir({ prefix: "quality_sh_stub_" });
  try {
    await Deno.writeTextFile(
      `${stubDir}/deno`,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@"\n`,
    );
    await Deno.chmod(`${stubDir}/deno`, 0o755);

    const command = new Deno.Command("bash", {
      args: [`${repoRoot()}quality.sh`, ...args],
      clearEnv: true,
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        HOME: stubDir,
        ...extraEnv,
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    assertEquals(
      output.code,
      0,
      `quality.sh must exec the stub cleanly: ${stdout}\n${
        new TextDecoder().decode(output.stderr)
      }`,
    );
    return stdout.trim().split("\n");
  } finally {
    await Deno.remove(stubDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("quality.sh - appends --sequential inside the container (Issue #4267)", async () => {
  const argv = await runQualitySh({ VIBE_IMAGE_AGENT_PROVIDERS: "claude" });
  assertEquals(
    argv.filter((a) => a === "--sequential").length,
    1,
    `the container image stamp must force sequential mode; argv: ${argv}`,
  );
});

Deno.test("quality.sh - keeps parallel mode on the host (Issue #4267)", async () => {
  const argv = await runQualitySh({});
  assertEquals(
    argv.includes("--sequential"),
    false,
    `no image stamp means the caller's mode stands; argv: ${argv}`,
  );
});

Deno.test("quality.sh - an explicit --sequential is not duplicated in the container (Issue #4267)", async () => {
  const argv = await runQualitySh(
    { VIBE_IMAGE_AGENT_PROVIDERS: "claude" },
    ["--sequential"],
  );
  assertEquals(
    argv.filter((a) => a === "--sequential").length,
    1,
    `the caller's explicit choice must pass through once; argv: ${argv}`,
  );
});

Deno.test("quality.sh - other flags still pass through alongside the container default (Issue #4267)", async () => {
  const argv = await runQualitySh(
    { VIBE_IMAGE_AGENT_PROVIDERS: "claude" },
    ["--strict"],
  );
  assert(argv.includes("--strict"), `--strict must survive; argv: ${argv}`);
  assertEquals(
    argv.filter((a) => a === "--sequential").length,
    1,
    `sequential still applied alongside other flags; argv: ${argv}`,
  );
});
