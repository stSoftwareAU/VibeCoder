/**
 * Host git commands run inside a repair clone must not execute the hooks or
 * fsmonitor command the repair agent planted in the clone's `.git`
 * (HOST_GIT_HARDENING_ARGS in fleet_pr_babysitter.ts).
 *
 * Uses Australian English spelling (behaviour, neutralise, organisation, etc.)
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cloneForRepair,
  isValidRepoName,
  resetRepairCloneGitConfig,
  run,
  runHardenedRepairGit,
  validateAndCommit,
} from "../commands/fleet_pr_babysitter.ts";
import type { runGitArgv } from "../lib/git_timeout.ts";

const HARDENING = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

Deno.test("run puts the hook and fsmonitor neutralising flags before the git subcommand", async () => {
  const calls: string[][] = [];
  const runGit = ((argv: readonly string[]) => {
    calls.push([...argv]);
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  }) as typeof runGitArgv;

  await run("git", ["commit", "-m", "msg"], "/some/dir", runGit);

  assertEquals(calls, [["git", ...HARDENING, "commit", "-m", "msg"]]);
});

/** Run git in a fixture repository with a fixed identity. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function markerNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("validateAndCommit and push run no planted pre-commit, pre-push or fsmonitor", async () => {
  const root = await Deno.makeTempDir({ prefix: "babysitter-git-hardening-" });
  try {
    const repo = `${root}/repo`;
    const remote = `${root}/remote.git`;
    const markers = `${root}/markers`;
    await Deno.mkdir(repo);
    await Deno.mkdir(markers);
    await git(repo, "init", "-q");
    await Deno.writeTextFile(`${repo}/README.md`, "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-q", "-m", "base");
    await git(root, "init", "-q", "--bare", remote);
    await git(repo, "remote", "add", "origin", remote);

    // The agent-writable clone: planted hooks that leave a marker when run.
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = `${repo}/.git/hooks/${name}`;
      await Deno.writeTextFile(hook, `#!/bin/sh\n: > "${markers}/${name}"\n`);
      await Deno.chmod(hook, 0o755);
    }
    const fsmonitor = `${root}/fsmonitor.sh`;
    await Deno.writeTextFile(
      fsmonitor,
      `#!/bin/sh\n: > "${markers}/fsmonitor"\n`,
    );
    await Deno.chmod(fsmonitor, 0o755);
    await git(repo, "config", "core.fsmonitor", fsmonitor);

    // A staged change for the host to commit and push.
    await Deno.writeTextFile(`${repo}/fix.txt`, "fixed\n");
    await validateAndCommit(repo, 7, { login: "fixture-bot", id: "1" });
    assertEquals(
      await git(repo, "log", "-1", "--format=%s"),
      "Fix PR #7 quality issues",
    );
    await run("git", ["push", "-q", "origin", "HEAD"], repo);

    assertEquals(await markerNames(markers), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("repair resets agent-controlled filters, diff and SSH git config before host work", async () => {
  const root = await Deno.makeTempDir({ prefix: "babysitter-git-config-" });
  try {
    const repo = `${root}/repo`;
    const markers = `${root}/markers`;
    await Deno.mkdir(repo);
    await Deno.mkdir(markers);
    await git(repo, "init", "-q");
    await Deno.writeTextFile(`${repo}/.gitattributes`, "*.txt filter=owned\n");
    await Deno.writeTextFile(`${repo}/README.md`, "base\n");
    await git(repo, "add", ".gitattributes", "README.md");
    await git(repo, "commit", "-q", "-m", "base");
    const command = `${root}/host-command`;
    await Deno.writeTextFile(
      command,
      `#!/bin/sh\n: > "${markers}/executed"\n`,
    );
    await Deno.chmod(command, 0o755);
    await git(
      repo,
      "config",
      "core.sshCommand",
      command,
    );
    await git(repo, "config", "filter.owned.clean", command);
    await git(repo, "config", "diff.external", command);
    await git(repo, "config", "core.fsmonitor", command);
    await Deno.mkdir(`${repo}/.git/hooks`, { recursive: true });
    await Deno.writeTextFile(
      `${repo}/.git/hooks/pre-commit`,
      `#!/bin/sh\n: > "${markers}/hook"\n`,
    );
    await Deno.chmod(`${repo}/.git/hooks/pre-commit`, 0o755);

    await resetRepairCloneGitConfig(repo, "stSoftwareAU/VibeCoder", {
      gh: () => Promise.resolve("https\n"),
    });
    await Deno.writeTextFile(`${repo}/fix.txt`, "fixed\n");
    const add = await runHardenedRepairGit(["-C", repo, "add", "fix.txt"]);
    assert(add.ok && add.value.code === 0);
    const commit = await runHardenedRepairGit([
      "-C",
      repo,
      "-c",
      "user.name=fixture-bot",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "host repair commit",
    ]);
    assert(commit.ok && commit.value.code === 0);
    await run("git", ["status", "--porcelain"], repo);

    assertEquals(await markerNames(markers), []);
    assertEquals(
      await git(repo, "config", "--local", "--get", "remote.origin.url"),
      "https://github.com/stSoftwareAU/VibeCoder.git",
    );
    const config = await Deno.readTextFile(`${repo}/.git/config`);
    assert(
      !/filter\.owned|core\.sshCommand|diff\.external|fsmonitor/.test(config),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the publication reset writes the URL of gh's git protocol, and one repo-name rule guards both the clone and the reset", async () => {
  const root = await Deno.makeTempDir({ prefix: "babysitter-git-protocol-" });
  try {
    const repo = `${root}/repo`;
    await Deno.mkdir(repo);
    await git(repo, "init", "-q");
    await resetRepairCloneGitConfig(repo, "stSoftwareAU/VibeCoder", {
      gh: (args) => {
        assertEquals(args, [
          "config",
          "get",
          "git_protocol",
          "-h",
          "github.com",
        ]);
        return Promise.resolve("ssh\n");
      },
    });
    assertEquals(
      await git(repo, "config", "--local", "--get", "remote.origin.url"),
      "git@github.com:stSoftwareAU/VibeCoder.git",
    );

    for (
      const name of [
        "owner",
        "a/b/c",
        "owner/repo name",
        "owner.x/repo",
        "../x",
      ]
    ) {
      assertEquals(isValidRepoName(name), false, name);
      await assertRejects(
        () =>
          resetRepairCloneGitConfig(repo, name, {
            gh: () => Promise.resolve("ssh"),
          }),
        Error,
        "Refusing to publish a repair for an invalid repository name",
      );
      await assertRejects(
        () => cloneForRepair(name, `${root}/clone`),
        Error,
        "Invalid repository",
      );
    }
    assertEquals(isValidRepoName("stSoftwareAU/VibeCoder"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("publication git keeps the host's global config, while a planted pre-commit hook still does not run", async () => {
  const root = await Deno.makeTempDir({ prefix: "babysitter-global-" });
  try {
    const repo = `${root}/repo`;
    const markers = `${root}/markers`;
    await Deno.mkdir(repo);
    await Deno.mkdir(markers);
    await git(repo, "init", "-q");
    // The host's global config, supplied through the env the caller passes.
    const globalConfig = `${root}/host.gitconfig`;
    await Deno.writeTextFile(globalConfig, "[alias]\n\tzz = status\n");
    const globalEnv = { GIT_CONFIG_GLOBAL: globalConfig };
    const alias = await runHardenedRepairGit(
      ["-C", repo, "config", "--get", "alias.zz"],
      { env: globalEnv },
    );
    assert(alias.ok && alias.value.code === 0, "the global alias is read");
    assertEquals(alias.value.stdout.trim(), "status");

    await Deno.mkdir(`${repo}/.git/hooks`, { recursive: true });
    await Deno.writeTextFile(
      `${repo}/.git/hooks/pre-commit`,
      `#!/bin/sh\n: > "${markers}/hook"\n`,
    );
    await Deno.chmod(`${repo}/.git/hooks/pre-commit`, 0o755);
    await Deno.writeTextFile(`${repo}/fix.txt`, "fixed\n");
    const add = await runHardenedRepairGit(
      ["-C", repo, "add", "fix.txt"],
      { env: globalEnv },
    );
    assert(add.ok && add.value.code === 0);
    const commit = await runHardenedRepairGit(
      [
        "-C",
        repo,
        "-c",
        "user.name=fixture-bot",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "host repair commit",
      ],
      { env: globalEnv },
    );
    assert(commit.ok && commit.value.code === 0);
    assertEquals(await markerNames(markers), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
