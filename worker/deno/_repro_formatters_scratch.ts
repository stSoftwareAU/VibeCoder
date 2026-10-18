import { assertEquals } from "jsr:@std/assert@^1.0.18";
import { gateUnpushedCommits } from "./lib/git_push.ts";
import { runGitCommand } from "./lib/git_timeout.ts";
import {
  formatBranchChanges,
  type RepoFormatterDeps,
} from "./lib/repo_formatters.ts";
import type { Logger } from "./types.ts";

const BRANCH = "issue-1-fix";
const NO_HOST_GIT_CONFIG = { GIT_CONFIG_COUNT: "0" };

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: NO_HOST_GIT_CONFIG,
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `git ${args.join(" ")}: ${stderr}`);
  return new TextDecoder().decode(out.stdout);
}

async function setIdentity(cwd: string): Promise<void> {
  await git(["config", "user.useConfigOnly", "true"], cwd);
  await git(["config", "user.name", "Fixture"], cwd);
  await git(["config", "user.email", "fixture@example.com"], cwd);
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

function realFormatterDeps(): RepoFormatterDeps {
  return {
    runCommand: async (cmd, options) => {
      const out = await new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        cwd: options?.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decoder = new TextDecoder();
      return {
        exitCode: out.code,
        output: decoder.decode(out.stdout) + decoder.decode(out.stderr),
      };
    },
    runGitCommand: (args, options) =>
      runGitCommand(args, { ...options, env: NO_HOST_GIT_CONFIG }),
    logger: silentLogger,
    runId: () => "fixture-run",
  };
}

async function makeRepo(
  seedFiles: Record<string, string>,
): Promise<{ tmp: string; repo: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "repro_fmt_" });
  const upstream = `${tmp}/upstream.git`;
  const repo = `${tmp}/repo`;
  await git(["init", "--bare", "-b", "main", upstream], tmp);
  await git(["clone", upstream, repo], tmp);
  await setIdentity(repo);
  for (const [path, content] of Object.entries(seedFiles)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${repo}/${path}`, content);
  }
  await git(["add", "."], repo);
  await git(["commit", "-m", "seed"], repo);
  await git(["push", "origin", "main"], repo);
  await git(["checkout", "-b", BRANCH], repo);
  return { tmp, repo };
}

async function commitBranch(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${repo}/${path}`, content);
  }
  await git(["add", "."], repo);
  await git(["commit", "-m", "Agent work"], repo);
}

const UNFORMATTED_RS = "pub fn   add(a:i32,b:i32)->i32 {\n    return a+b;\n}\n";
const FORMATTED_RS = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
const UNFORMATTED_JSON = '{"a":  1, "b": [1,2,  3], "c": {\n  "d": "e"\n}}\n';
const CARGO_TOML = `[package]
name = "probe"
version = "0.1.0"
edition = "2021"

[workspace]
`;

async function runCase(
  label: string,
  seedFiles: Record<string, string>,
  branchFiles: Record<string, string>,
): Promise<void> {
  const { tmp, repo } = await makeRepo(seedFiles);
  try {
    await commitBranch(repo, branchFiles);
    const fmt = await formatBranchChanges(repo, "origin/main", realFormatterDeps());
    console.log(`\n=== ${label} ===`);
    console.log("formatBranchChanges:", JSON.stringify({
      committed: fmt.committed,
      gitError: fmt.gitError,
      runs: fmt.runs.map((r) => ({ tool: r.tool, dir: r.dir, exitCode: r.exitCode, changed: r.changed, excerpt: r.excerpt })),
    }));
    const gate = await gateUnpushedCommits(
      BRANCH,
      { cwd: repo, env: NO_HOST_GIT_CONFIG },
      { commands: [] },
      false,
      "origin/main",
    );
    console.log("gate ok:", gate.ok, gate.ok ? "" : gate.error.message.slice(0, 1500));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

// Rust case.
await runCase(
  "Rust unformatted src/lib.rs",
  { "Cargo.toml": CARGO_TOML, "src/lib.rs": FORMATTED_RS },
  { "src/lib.rs": UNFORMATTED_RS },
);

// Nested-Deno JSON case.
await runCase(
  "Nested-Deno unformatted data.json",
  { "worker/deno/deno.json": "{}\n", "worker/deno/base.ts": "export const x = 1;\n" },
  { "worker/deno/data.json": UNFORMATTED_JSON },
);

// Mixed: Rust + nested Deno in one repo (the fleet shape).
await runCase(
  "Mixed Rust + nested Deno",
  {
    "Cargo.toml": CARGO_TOML,
    "src/lib.rs": FORMATTED_RS,
    "worker/deno/deno.json": "{}\n",
    "worker/deno/base.ts": "export const x = 1;\n",
  },
  {
    "src/lib.rs": UNFORMATTED_RS,
    "worker/deno/data.json": UNFORMATTED_JSON,
  },
);
