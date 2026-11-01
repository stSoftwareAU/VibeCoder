/** Regression coverage for the host-side recovery in loop.sh (Issue #4632). */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { killProcessTree } from "./fixtures/process_tree.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const LOOP_SH = `${REPO_ROOT}/loop.sh`;
const join = (...parts: string[]): string => parts.join("/");

Deno.test({
  name:
    "loop.sh leaves unrelated Virtualization VMs untouched during recovery (Issue #4632)",
  permissions: { read: true, write: true, run: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_vm_recovery_" });
    const binDir = join(tmpDir, "bin");
    await Deno.mkdir(binDir);
    await Deno.copyFile(LOOP_SH, join(tmpDir, "loop.sh"));
    await Deno.symlink(join(REPO_ROOT, "worker"), join(tmpDir, "worker"));
    await Deno.chmod(join(tmpDir, "loop.sh"), 0o755);

    const writeExecutable = async (name: string, contents: string) => {
      const path = join(binDir, name);
      await Deno.writeTextFile(path, contents);
      await Deno.chmod(path, 0o755);
    };

    await writeExecutable(
      "container",
      `#!/bin/bash
case "$1" in
  kill) /bin/sleep 0.75; exit 0 ;;
  ls) printf 'NAME STATUS\\nvibe-coder-worker running\\n' ;;
  exec) exit 1 ;;
  *) exit 2 ;;
esac
`,
    );
    await writeExecutable(
      "pgrep",
      `#!/bin/bash
case "$*" in
  *'container run '*) echo 5555 ;;
  *Virtualization.VirtualMachine*) printf '6661\\n6662\\n' ;;
  *) exit 1 ;;
esac
`,
    );
    const startHelper = () =>
      new Deno.Command("/bin/sleep", { args: ["30"] }).spawn();
    const helpers = [startHelper(), startHelper(), startHelper()] as const;
    await writeExecutable(
      "ps",
      `#!/bin/bash
case " $* " in
  *' -A -o pid=,args= '*) printf '%s container-runtime-linux vibe-coder-worker\\n%s container-runtime-linux vibe-coder-other\\n%s Virtualization.VirtualMachine\\n' "${
        helpers[0].pid
      }" "${helpers[1].pid}" "${helpers[2].pid}" ;;
  *' -p 6661 '*|*' -p 6662 '*) echo 1 ;;
  *) exec /bin/ps "$@" ;;
esac
`,
    );
    await writeExecutable("sleep", "#!/bin/bash\nexit 0\n");
    // Intercept every fabricated PID before it can reach the real kill builtin.
    await writeExecutable(
      "bash_env",
      `kill() {
  case " $* " in
    *' 5555 '*|*' 6661 '*|*' 6662 '*) printf '%s\\n' "$*" >>"${tmpDir}/signals.log"; return 0 ;;
    *) builtin kill "$@" ;;
  esac
}
`,
    );

    const runPath = join(tmpDir, "run.sh");
    await Deno.writeTextFile(runPath, "#!/bin/bash\nexec /bin/sleep 30\n");
    await Deno.chmod(runPath, 0o755);

    const child = new Deno.Command("bash", {
      args: ["-c", "exec ./loop.sh > loop.log 2>&1"],
      cwd: tmpDir,
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        BASH_ENV: join(binDir, "bash_env"),
        HOME: tmpDir,
        VIBE_STATE_DIR: join(tmpDir, "state"),
        VIBE_PROBE_INTERVAL_SECONDS: "0",
        VIBE_PROBE_FAILURES: "1",
        LOOP_SLEEP_SECONDS: "1",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();

    try {
      // Wait for recovery, including a slow runtime response, under a deadline.
      let log = "";
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        log = await Deno.readTextFile(join(tmpDir, "loop.log")).catch(() => "");
        if (log.includes("container reaper finished")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertStringIncludes(log, "survived the runtime kill");
      assertStringIncludes(
        log,
        "container reaper finished for vibe-coder-worker",
      );
      const targetStatus = await Promise.race([
        helpers[0].status,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 1_000)
        ),
      ]);
      assertEquals(targetStatus?.success, false);
      for (const helper of helpers.slice(1)) {
        Deno.kill(helper.pid, 0);
      }
      const signals = await Deno.readTextFile(join(tmpDir, "signals.log"))
        .catch(() => "");
      assertEquals(
        signals,
        "-TERM 5555\n-KILL 5555\n",
        `only the fake client PID 5555 may receive signals; unrelated Virtualization VM PIDs 6661 and 6662 must not: ${signals}`,
      );
    } finally {
      await killProcessTree(child);
      for (const helper of helpers) {
        try {
          helper.kill("SIGKILL");
        } catch { /* already exited */ }
        await helper.status;
      }
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
