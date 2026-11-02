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

      await Deno.writeTextFile(
        `${root}/quality.sh`,
        `#!/bin/bash
set -euo pipefail
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
      await Deno.remove(root, { recursive: true });
      await Deno.remove(scratch, { recursive: true });
      await Deno.remove(home, { recursive: true });
      await Deno.remove(secretDir, { recursive: true });
    }
  },
});
