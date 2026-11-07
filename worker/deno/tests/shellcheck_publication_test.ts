/**
 * Real publication entry points must enforce repository ShellCheck policy
 * (#4631). These drive the host's real ShellCheck, and take the CI version from the binary it finds.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  commitAndPushPending,
  resolveRepairPreFlightSpec,
} from "../lib/git_push.ts";
import { validateAndCommit } from "../commands/fleet_pr_babysitter.ts";
import { requireRealShellcheck } from "./support/shellcheck_support.ts";

const REAL_SHELLCHECK = await requireRealShellcheck();

const repoRoot = new URL("../../../", import.meta.url).pathname;
const config = `${repoRoot}worker/deno/deno.json`;
const cli = `${repoRoot}worker/deno/lib/pre_push_gate_cli.ts`;
const decoder = new TextDecoder();

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    cwd,
    args: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: cwd, GIT_CONFIG_COUNT: "0" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, decoder.decode(out.stderr));
  return decoder.decode(out.stdout).trim();
}

async function fixture(): Promise<{ root: string; dir: string }> {
  const root = await Deno.makeTempDir();
  await git(root, "init", "-q", "--bare", "-b", "main", `${root}/remote.git`);
  await git(root, "clone", "-q", `${root}/remote.git`, `${root}/repo`);
  const dir = `${root}/repo`;
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.invalid");
  await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/.github/workflows/check.yml`,
    `jobs:\n  lint:\n    env:\n      SHELLCHECK_VERSION: "${REAL_SHELLCHECK.version}"\n    steps:\n      - run: |\n          find . -name "*.sh" -type f -exec shellcheck -s sh {} +\n`,
  );
  await Deno.writeTextFile(`${dir}/script.sh`, '#!/bin/sh\necho "$1"\n');
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "baseline");
  await git(dir, "push", "-qu", "origin", "HEAD:main");
  await git(dir, "checkout", "-qb", "repair");
  await git(dir, "push", "-qu", "origin", "repair");
  return { root, dir };
}

async function child(
  source: string,
  cwd: string,
  path: string,
): Promise<{ ok: boolean; message?: string }> {
  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  const denoCache = JSON.parse(decoder.decode(cacheInfo.stdout)).denoDir;
  const script = `${cwd}/../probe.ts`;
  await Deno.writeTextFile(script, source);
  const out = await new Deno.Command(Deno.execPath(), {
    cwd,
    args: ["run", "--config", config, "--allow-all", script],
    env: {
      PATH: path,
      HOME: `${cwd}/..`,
      DENO_DIR: denoCache,
      GIT_CONFIG_COUNT: "0",
      VIBE_AUDIT_DISABLED: "1",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, decoder.decode(out.stderr));
  const last = decoder.decode(out.stdout).trim().split("\n").at(-1)!;
  return JSON.parse(last);
}

Deno.test(
  "commitAndPushPending: a repair without pre-flight commands blocks a real ShellCheck diagnostic",
  async () => {
    const { root, dir } = await fixture();
    try {
      const remote = await git(dir, "rev-parse", "origin/repair");
      await Deno.writeTextFile(`${dir}/script.sh`, "#!/bin/sh\necho $1\n");
      const result = await commitAndPushPending(
        "repair",
        "Fix #4631",
        { cwd: dir, env: { GIT_CONFIG_COUNT: "0" } },
        false,
        resolveRepairPreFlightSpec(undefined, "org/repo"),
      );
      assertEquals(result.ok, false);
      if (!result.ok) assertStringIncludes(result.error.message, "SC2086");
      assertEquals(
        await git(dir, "ls-remote", "origin", "refs/heads/repair"),
        `${remote}\trefs/heads/repair`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "commitAndPushPending: a WIP checkpoint with no spec still pushes a ShellCheck diagnostic",
  async () => {
    const { root, dir } = await fixture();
    try {
      await Deno.writeTextFile(`${dir}/script.sh`, "#!/bin/sh\necho $1\n");
      // The WIP checkpoint, timeout-preservation and hand-off call shape: no spec.
      const result = await commitAndPushPending("repair", "wip: checkpoint", {
        cwd: dir,
        env: { GIT_CONFIG_COUNT: "0" },
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(result.value.finalUnpushedCount, 0);
      assertEquals(
        await git(dir, "rev-parse", "origin/repair"),
        await git(dir, "rev-parse", "HEAD"),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "validateAndCommit: babysitter refuses a real ShellCheck diagnostic before commit",
  async () => {
    const { root, dir } = await fixture();
    try {
      const head = await git(dir, "rev-parse", "HEAD");
      await Deno.writeTextFile(`${dir}/script.sh`, "#!/bin/sh\necho $1\n");
      let message = "";
      try {
        await validateAndCommit(dir, 4631, { login: "test", id: "1" });
      } catch (error) {
        message = (error as Error).message;
      }
      assertStringIncludes(message, "SC2086");
      assertEquals(await git(dir, "rev-parse", "HEAD"), head);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

for (const entry of ["commitAndPushPending", "validateAndCommit"]) {
  Deno.test(
    `${entry}: missing ShellCheck recovers and checks the repaired content`,
    async () => {
      const { root, dir } = await fixture();
      try {
        const tools = `${root}/tools`;
        await Deno.mkdir(tools);
        const gitPath = decoder.decode(
          (await new Deno.Command("which", { args: ["git"], stdout: "piped" })
            .output()).stdout,
        ).trim();
        const shellcheckPath = decoder.decode(
          (await new Deno.Command("which", {
            args: ["shellcheck"],
            stdout: "piped",
          }).output()).stdout,
        ).trim();
        await Deno.symlink(gitPath, `${tools}/git`);
        const source = entry === "commitAndPushPending"
          ? `import { commitAndPushPending, resolveRepairPreFlightSpec } from ${
            JSON.stringify(`${repoRoot}worker/deno/lib/git_push.ts`)
          };
           const result = await commitAndPushPending("repair", "Fix #4631", { cwd: Deno.cwd() }, false, resolveRepairPreFlightSpec(undefined, "org/repo"));
           console.log(JSON.stringify(result.ok ? {ok:true} : {ok:false, message:result.error.message}));`
          : `import { validateAndCommit } from ${
            JSON.stringify(
              `${repoRoot}worker/deno/commands/fleet_pr_babysitter.ts`,
            )
          };
           try { await validateAndCommit(Deno.cwd(), 4631, {login:"test",id:"1"}); console.log(JSON.stringify({ok:true})); }
           catch (error) { console.log(JSON.stringify({ok:false, message:error.message})); }`;
        await Deno.writeTextFile(`${dir}/script.sh`, "#!/bin/sh\necho $1\n");
        const missing = await child(source, dir, tools);
        assertEquals(missing.ok, false);
        assertStringIncludes(missing.message!, "could not be found");
        await Deno.symlink(shellcheckPath, `${tools}/shellcheck`);
        const diagnostic = await child(source, dir, tools);
        assertEquals(diagnostic.ok, false);
        assertStringIncludes(diagnostic.message!, "SC2086");
        await Deno.writeTextFile(
          `${dir}/script.sh`,
          '#!/bin/sh\necho "fixed: $1"\n',
        );
        const recovered = await child(source, dir, tools);
        assertEquals(recovered, { ok: true });
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  );
}

Deno.test("pre-push CLI: actual repository workflows pass with empty hook input under --no-config", async () => {
  const root = await Deno.makeTempDir();
  try {
    const spec = `${root}/spec.json`;
    await Deno.writeTextFile(spec, '{"preFlightCommands":[]}');
    const out = await new Deno.Command(Deno.execPath(), {
      cwd: repoRoot,
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--allow-read",
        "--allow-run",
        "--allow-env",
        cli,
        "--spec",
        spec,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: root,
        GIT_CONFIG_COUNT: "0",
      },
      clearEnv: true,
    }).output();
    assertEquals(out.code, 0, decoder.decode(out.stderr));
    assertStringIncludes(
      decoder.decode(out.stderr),
      "pre-push gate passed (0 changed-file checks",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "pre-push CLI: ambient HOME, XDG and external ancestor configs cannot suppress repository diagnostics",
  async () => {
    const { root, dir } = await fixture();
    try {
      await Deno.writeTextFile(`${dir}/script.sh`, "#!/bin/sh\necho $1\n");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "diagnostic");
      await Deno.writeTextFile(`${root}/.shellcheckrc`, "disable=SC2086\n");
      await Deno.mkdir(`${root}/xdg`, { recursive: true });
      await Deno.writeTextFile(`${root}/xdg/shellcheckrc`, "disable=SC2086\n");
      const spec = `${root}/spec.json`;
      await Deno.writeTextFile(spec, '{"preFlightCommands":[]}');
      const head = await git(dir, "rev-parse", "HEAD");
      const process = new Deno.Command(Deno.execPath(), {
        cwd: dir,
        args: [
          "run",
          "--no-config",
          "--no-lock",
          "--allow-all",
          cli,
          "--spec",
          spec,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: root,
          XDG_CONFIG_HOME: `${root}/xdg`,
          GIT_CONFIG_COUNT: "0",
        },
      }).spawn();
      const writer = process.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(
          `refs/heads/repair ${head} refs/heads/repair ${"0".repeat(40)}\n`,
        ),
      );
      await writer.close();
      const out = await process.output();
      assertEquals(out.code, 1, decoder.decode(out.stderr));
      assertStringIncludes(decoder.decode(out.stderr), "SC2086");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
