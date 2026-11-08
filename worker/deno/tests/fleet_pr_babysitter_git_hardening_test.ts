/**
 * Host git commands run inside a repair clone must not execute the hooks or
 * fsmonitor command the repair agent planted in the clone's `.git`
 * (HOST_GIT_HARDENING_ARGS in fleet_pr_babysitter.ts).
 *
 * Uses Australian English spelling (behaviour, neutralise, organisation, etc.)
 */
import { assertEquals } from "@std/assert";
import { run, validateAndCommit } from "../commands/fleet_pr_babysitter.ts";
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
