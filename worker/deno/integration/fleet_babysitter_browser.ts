import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildBabysitterValidationProfile,
  runBabysitterValidation,
  validateWithSingleRepair,
} from "../lib/fleet_babysitter_validation.ts";
import { validateAndCommit } from "../commands/fleet_pr_babysitter.ts";
import { posixSingleQuote } from "../lib/shell_quote.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test({
  name: "macOS runner sandbox launches Chromium without exposing credentials",
  fn: async () => {
    assertEquals(Deno.build.os, "darwin", "Browser integration requires macOS");
    const root = await Deno.realPath(await Deno.makeTempDir());
    const scratch = await Deno.realPath(await Deno.makeTempDir());
    const home = await Deno.realPath(await Deno.makeTempDir());
    const secretDir = await Deno.realPath(await Deno.makeTempDir());
    const keychainDir = `${home}/Library/Keychains`;
    let markerProcess: Deno.ChildProcess | undefined;
    try {
      const secret = `${secretDir}/credential`;
      const secretLink = `${home}/credential-link`;
      const customAppKey = `${secretDir}/custom-babysitter-key.pem`;
      const selectedAppKey = `${home}/selected-babysitter-key.pem`;
      const configPath = `${home}/worker-config.json`;
      const chromium = Deno.env.get("CHROMIUM_PATH");
      assert(chromium, "CHROMIUM_PATH must name the macOS Chromium binary");
      await Deno.mkdir(keychainDir, { recursive: true });
      await git(root, "init", "-q");
      await git(root, "config", "user.name", "Test");
      await git(root, "config", "user.email", "test@example.invalid");
      await Deno.writeTextFile(secret, "must not be readable\n");
      await Deno.symlink(secret, secretLink);
      await Deno.writeTextFile(customAppKey, "must not be readable\n");
      await Deno.symlink(customAppKey, selectedAppKey);
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          github_app_private_key_path: secret,
          ssh_key_path: secretLink,
        }),
      );
      await Deno.writeTextFile(
        `${root}/index.html`,
        "<!doctype html><title>runner browser check</title><p>runner-browser-ok</p>",
      );
      const browserArgs = [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--dump-dom",
        `--user-data-dir=${scratch}/restricted-browser-profile`,
        `file://${root}/index.html`,
      ];

      // Lookup alone cannot authorise the browser's bootstrap_check_in call.
      const restrictedPath = `${scratch}/agent-restrictions.sb`;
      const restrictedProfile = buildBabysitterValidationProfile(
        root,
        scratch,
        [secret, secretLink, keychainDir],
      ).split("\n").filter((rule) => !rule.startsWith("(allow mach-register"))
        .join("\n");
      await Deno.writeTextFile(restrictedPath, restrictedProfile, {
        mode: 0o600,
      });
      const sandboxBaseline = await runWithTimeout(
        "/usr/bin/sandbox-exec",
        ["-f", restrictedPath, "/usr/bin/true"],
        { timeoutMs: 10_000, quiet: true },
      );
      assert(sandboxBaseline.ok);
      assert(
        sandboxBaseline.value.success,
        `Host must permit sandbox startup: ${sandboxBaseline.value.stderr}`,
      );
      await Deno.writeTextFile(
        `${root}/process-probe.c`,
        `
#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (strcmp(argv[1], "--hold") == 0) {
    const char *marker = getenv("VIBE_PROCESS_MARKER");
    if (!marker || strcmp(marker, "runner-private-marker") != 0) return 2;
    if (write(STDOUT_FILENO, "R", 1) != 1) return 2;
    sleep(300);
    return 0;
  }
  int mib[] = { CTL_KERN, KERN_PROCARGS2, atoi(argv[1]) };
  char buffer[262144];
  size_t size = sizeof(buffer);
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) {
    int denied = errno == EPERM || errno == EACCES;
    perror("process environment sysctl");
    return denied ? 1 : 2;
  }
  const char *marker = "VIBE_PROCESS_MARKER=runner-private-marker";
  for (size_t i = 0; i + strlen(marker) <= size; ++i)
    if (memcmp(buffer + i, marker, strlen(marker)) == 0) return 0;
  return 2;
}
`,
      );
      const processCompile = await runWithTimeout("/usr/bin/clang", [
        `${root}/process-probe.c`,
        "-o",
        `${root}/process-probe`,
      ], { timeoutMs: 30_000, quiet: true });
      assert(processCompile.ok && processCompile.value.success);
      markerProcess = new Deno.Command(`${root}/process-probe`, {
        args: ["--hold"],
        env: { VIBE_PROCESS_MARKER: "runner-private-marker" },
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = markerProcess.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      assertEquals(new TextDecoder().decode(ready.value), "R");
      const processBaseline = await runWithTimeout(`${root}/process-probe`, [
        String(markerProcess.pid),
      ], { timeoutMs: 10_000, quiet: true });
      assert(
        processBaseline.ok && processBaseline.value.success,
        `Process environment marker must be readable outside the sandbox: ${
          processBaseline.ok ? processBaseline.value.stderr : "probe failed"
        }`,
      );
      const restrictedLaunch = await runWithTimeout(
        "/usr/bin/sandbox-exec",
        ["-f", restrictedPath, chromium, ...browserArgs],
        {
          timeoutMs: 30_000,
          clearEnv: true,
          env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch },
          quiet: true,
        },
      );
      assert(restrictedLaunch.ok);
      assert(
        !restrictedLaunch.value.success,
        "Chromium unexpectedly launched without Mach registration permission",
      );
      const keychainBaseline = await runWithTimeout(
        "/usr/bin/security",
        ["list-keychains", "-d", "user"],
        { timeoutMs: 10_000, clearEnv: true, env: { HOME: home }, quiet: true },
      );
      assert(keychainBaseline.ok);
      assert(
        keychainBaseline.value.success,
        "Keychain probe must succeed outside the runner sandbox",
      );

      // cfprefsd acts on files for its caller and is deliberately outside the
      // browser service allowlist. Prove it exists before testing its denial.
      await Deno.writeTextFile(
        `${root}/mach-probe.c`,
        `
#include <mach/mach.h>
#include <servers/bootstrap.h>
int main(void) {
  mach_port_t service = MACH_PORT_NULL;
  return bootstrap_look_up(bootstrap_port, "com.apple.cfprefsd.agent", &service) == KERN_SUCCESS ? 0 : 1;
}
`,
      );
      const compile = await runWithTimeout("/usr/bin/clang", [
        `${root}/mach-probe.c`,
        "-o",
        `${root}/mach-probe`,
      ], { timeoutMs: 30_000, quiet: true });
      assert(compile.ok && compile.value.success, "Mach probe requires clang");
      const lookupBaseline = await runWithTimeout(`${root}/mach-probe`, [], {
        timeoutMs: 10_000,
        quiet: true,
      });
      assert(
        lookupBaseline.ok && lookupBaseline.value.success,
        "Out-of-list Mach service must be reachable outside the sandbox",
      );
      // Exercise ordinary gate IPC and terminal operations without broad grants.
      await Deno.writeTextFile(
        `${root}/resource-probe.c`,
        `
#include <fcntl.h>
#include <semaphore.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
int main(void) {
  char name[64];
  snprintf(name, sizeof(name), "/vibe-gate-%d", getpid());
  sem_t *sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
  if (sem == SEM_FAILED) { perror("sem_open"); return 40; }
  sem_unlink(name);
  if (sem_post(sem) || sem_wait(sem) || sem_close(sem)) return 41;
  int memory = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0600);
  if (memory < 0) { perror("shm_open"); return 42; }
  shm_unlink(name);
  if (ftruncate(memory, 4096)) return 43;
  void *mapped = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, memory, 0);
  if (mapped == MAP_FAILED) return 44;
  munmap(mapped, 4096);
  close(memory);
  int terminal = posix_openpt(O_RDWR | O_NOCTTY);
  if (terminal < 0 || grantpt(terminal) || unlockpt(terminal)) {
    perror("pseudo-terminal"); return 45;
  }
  close(terminal);
  return 0;
}
`,
      );
      const resourceCompile = await runWithTimeout("/usr/bin/clang", [
        `${root}/resource-probe.c`,
        "-o",
        `${root}/resource-probe`,
      ], { timeoutMs: 30_000, quiet: true });
      assert(
        resourceCompile.ok && resourceCompile.value.success,
        "Resource probe requires clang",
      );
      await Deno.writeTextFile(
        `${root}/quality.sh`,
        `#!/bin/bash
set -euo pipefail
/usr/bin/uname -m | /usr/bin/grep -q .
/bin/hostname | /usr/bin/grep -q .
printf x | /usr/bin/xargs /bin/echo | /usr/bin/grep -q x
deno eval 'import { cpus } from "node:os"; if (cpus().length === 0) Deno.exit(1);'
if ./process-probe ${markerProcess.pid}; then exit 46; else test "$?" -eq 1; fi
sleep 60 &
child=$!
kill -TERM "$child"
if wait "$child"; then exit 39; else test "$?" -eq 143; fi
./resource-probe
test -z "\${GH_TOKEN+x}"
test -z "\${GITHUB_APP_PRIVATE_KEY+x}"
${
          posixSingleQuote(chromium)
        } --headless --disable-gpu --no-first-run --user-data-dir="$TMPDIR/browser-profile" --dump-dom "file://$PWD/index.html" > "$TMPDIR/rendered.html"
grep -q runner-browser-ok "$TMPDIR/rendered.html"
${
          posixSingleQuote(chromium)
        } --headless --disable-gpu --no-first-run --user-data-dir="$TMPDIR/screenshot-profile" --screenshot="$PWD/browser-check.png" "file://$PWD/index.html"
test -s browser-check.png
if cat ${posixSingleQuote(configPath)} >/dev/null 2>&1; then exit 30; fi
if cat ${posixSingleQuote(secret)} >/dev/null 2>&1; then exit 31; fi
if cat ${posixSingleQuote(secretLink)} >/dev/null 2>&1; then exit 32; fi
if ls ${posixSingleQuote(keychainDir)} >/dev/null 2>&1; then exit 33; fi
if touch .git/runner-write 2>/dev/null; then exit 34; fi
if /usr/bin/security list-keychains -d user >/dev/null 2>&1; then exit 35; fi
if cat ${posixSingleQuote(customAppKey)} >/dev/null 2>&1; then exit 36; fi
if cat ${posixSingleQuote(selectedAppKey)} >/dev/null 2>&1; then exit 37; fi
if ./mach-probe; then exit 38; fi
touch gate-ran
`,
      );
      await Deno.chmod(`${root}/quality.sh`, 0o700);
      await git(root, "add", "index.html", "quality.sh");
      await git(root, "commit", "-m", "initial");
      const initialHead = await git(root, "rev-parse", "HEAD");
      await Deno.writeTextFile(
        `${root}/index.html`,
        "<!doctype html><title>broken browser check</title><p>broken</p>",
      );
      let validations = 0;
      let repairs = 0;
      await validateWithSingleRepair({
        validate: () => {
          validations++;
          return validateAndCommit(
            root,
            4674,
            { login: "bot[bot]", id: "123" },
            {
              scratch,
              configPath,
              home,
              privateKeyPath: selectedAppKey,
              runValidation: (dir, temp, config, hostHome, validationOptions) =>
                runBabysitterValidation(dir, temp, config, hostHome, {
                  ...validationOptions,
                  env: {
                    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
                    CHROMIUM_PATH: chromium,
                    GH_TOKEN: "must-not-reach-gate",
                    GITHUB_APP_PRIVATE_KEY: "must-not-reach-gate",
                  },
                }),
            },
          );
        },
        repair: async (failure) => {
          repairs++;
          assertEquals(failure.kind, "failed");
          assertEquals(await git(root, "rev-parse", "HEAD"), initialHead);
          assertEquals(await git(root, "diff", "--cached", "--name-only"), "");
          await Deno.writeTextFile(
            `${root}/index.html`,
            "<!doctype html><title>fixed browser check</title><p>runner-browser-ok</p>",
          );
        },
      });
      assertEquals(validations, 2);
      assertEquals(repairs, 1);
      assertEquals(
        await git(root, "show", "-s", "--format=%s", "HEAD"),
        "Fix PR #4674 quality issues",
      );
      assert((await Deno.stat(`${root}/browser-check.png`)).size > 0);
      assert((await Deno.stat(`${root}/gate-ran`)).isFile);
      await assertRejects(
        () => Deno.stat(`${root}/.git/runner-write`),
        Deno.errors.NotFound,
      );
    } finally {
      try {
        markerProcess?.kill("SIGKILL");
      } catch (error) {
        assert(error instanceof Deno.errors.NotFound);
      }
      if (markerProcess) {
        await markerProcess.status;
        await markerProcess.stdout.cancel();
      }
      await Deno.remove(root, { recursive: true });
      await Deno.remove(scratch, { recursive: true });
      await Deno.remove(home, { recursive: true });
      await Deno.remove(secretDir, { recursive: true });
    }
  },
});
