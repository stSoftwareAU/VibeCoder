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
  kill) exit 0 ;;
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
    await writeExecutable(
      "ps",
      `#!/bin/bash
case " $* " in
  *' -p 6661 '*|*' -p 6662 '*) echo 1 ;;
  *) exec /bin/ps "$@" ;;
esac
`,
    );
    await writeExecutable("sleep", "#!/bin/bash\nexit 0\n");
    await writeExecutable(
      "bash_env",
      `kill() {
  case " $* " in
    *' 6661 '*|*' 6662 '*) printf '%s\\n' "$*" >>"${tmpDir}/signals.log"; return 0 ;;
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
      // The runtime kill is ineffective; the probe proceeds through the real
      // force_stop_container path while two unrelated launchd VMs have PPID 1.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const log = await Deno.readTextFile(join(tmpDir, "loop.log")).catch(() =>
        ""
      );
      assertStringIncludes(log, "survived the runtime kill");
      assertStringIncludes(
        log,
        "VM termination skipped for vibe-coder-worker — no verifiable VM ownership metadata",
      );
      const signals = await Deno.readTextFile(join(tmpDir, "signals.log"))
        .catch(() => "");
      assertEquals(
        signals,
        "",
        `unrelated Virtualization VM PIDs 6661 and 6662 must not receive signals: ${signals}`,
      );
    } finally {
      await killProcessTree(child);
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
