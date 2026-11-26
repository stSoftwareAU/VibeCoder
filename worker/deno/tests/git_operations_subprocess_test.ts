/** Regression coverage for command tests running under ambient audit settings. */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { denoCacheEnv } from "./support/deno_cache_env.ts";
import { NO_HOST_GIT_CONFIG } from "./support/no_host_git_config.ts";

// Exercise both the WORK_DIR fallback and an explicit journal override.
for (const explicitAuditDir of [false, true]) {
  const setting = explicitAuditDir ? "VIBE_AUDIT_DIR" : "WORK_DIR";
  Deno.test(`milestone command tests leave hostile ${setting} audit directory empty`, async () => {
    const workDir = await Deno.makeTempDir({
      prefix: "milestone-command-audit-",
    });
    try {
      const auditDir = `${workDir}/audit`;
      await Deno.mkdir(auditDir);
      const output = await new Deno.Command(Deno.execPath(), {
        cwd: new URL("../", import.meta.url),
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          ...denoCacheEnv(),
          ...NO_HOST_GIT_CONFIG,
          HOME: Deno.env.get("HOME") ?? workDir,
          TMPDIR: workDir,
          WORK_DIR: workDir,
          ...(explicitAuditDir ? { VIBE_AUDIT_DIR: auditDir } : {}),
          VIBE_AUDIT_DISABLED: "0",
          WORKER_UNIQUE_ID: "milestone-command-audit",
          VIBE_RUN_ID: "milestone-command-audit",
          NO_COLOR: "1",
        },
        args: [
          "test",
          "--cached-only",
          "--no-check",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-run",
          "--allow-sys=hostname",
          "--filter",
          "git operations command - ensure-milestone-branch",
          "tests/milestone_branch_ensure_test.ts",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(output.code, 0, `${stdout}\n${stderr}`);
      assertStringIncludes(stdout, "4 passed | 0 failed");
      const entries = [];
      for await (const entry of Deno.readDir(auditDir)) {
        entries.push(entry.name);
      }
      assertEquals(entries, [], `command tests wrote audit state: ${entries}`);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  });
}
