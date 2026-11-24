/**
 * A branch-changed path git no longer tracks is left out of the repository
 * formatters and the archive step (Issue #5410).
 *
 * `git rm --cached` removes a file from the index while it stays on disk. The
 * branch's file list still names it, but `git add -u` cannot stage it, so the
 * formatters' commit used to fail and lose the whole formatting pass.
 *
 * Australian English throughout (behaviour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRepoFormatterDeps,
  formatBeforeGate,
  formatBranchChanges,
  FORMATTER_COMMIT_MESSAGE,
  type RepoFormatterDeps,
} from "../lib/repo_formatters.ts";
import { runPrePushGate } from "../lib/pre_push_gate.ts";
import type { Logger } from "../types.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";

const LONG_LINE = "# Title\n\n" +
  "This sentence is deliberately far too long to fit in eighty columns so deno fmt must wrap it onto the following line before the gate sees the file.\n";

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (message: string) => {
    lines.push(message);
  };
  return {
    lines,
    info: record,
    warn: record,
    error: record,
    debug: record,
    security: (event, details) => record(`${event} ${details}`),
    skipReason: (code, details) => record(`${code} ${details}`),
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

async function writeFile(
  repo: string,
  path: string,
  body: string,
): Promise<void> {
  const absolute = `${repo}/${path}`;
  await Deno.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(absolute, body);
}

async function git(repo: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [...NO_HOST_HOOKS_ARGS, ...args],
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
    env: NO_HOST_GIT_CONFIG,
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `git ${args.join(" ")}: ${stderr}`);
  return new TextDecoder().decode(out.stdout);
}

/** Init an empty repository at `${root}/repo` with the fixture identity. */
async function initRepo(root: string): Promise<string> {
  const repo = `${root}/repo`;
  await new Deno.Command("git", {
    args: [...NO_HOST_HOOKS_ARGS, "init", "-b", "main", repo],
    stdout: "null",
    stderr: "piped",
    env: NO_HOST_GIT_CONFIG,
  }).output();
  await Deno.mkdir(`${root}/hooks`);
  for (
    const [key, value] of [
      ["user.useConfigOnly", "true"],
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.com"],
      ["core.hooksPath", `${root}/hooks`],
    ] as const
  ) {
    await git(repo, ["config", key, value]);
  }
  return repo;
}

Deno.test("formatBeforeGate leaves a branch path git no longer tracks out of the formatter commit and never formats it (Issue #5410)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5410-code-" });
  try {
    const repo = await initRepo(root);
    const unformattedGen = "export const  y   =  2\n";
    await writeFile(repo, "deno.json", "{}\n");
    await writeFile(repo, "src/bad.ts", "export const x   =  1\n");
    await writeFile(repo, "src/gen.ts", unformattedGen);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "seed"]);
    await git(repo, ["rm", "--cached", "src/gen.ts"]);
    await git(repo, ["commit", "-m", "untrack generated file"]);

    const logger = recordingLogger();
    const formatterDeps: RepoFormatterDeps = {
      ...createRepoFormatterDeps(),
      logger,
    };
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: (path, baseRef) =>
            formatBranchChanges(path, baseRef, formatterDeps),
        },
        logger,
        formatterDeps,
      },
      repo,
      undefined,
    );

    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "src/bad.ts",
    );
    assertEquals(
      await git(repo, ["show", "HEAD:src/bad.ts"]),
      "export const x = 1;\n",
    );
    assertEquals(
      await git(repo, ["status", "--porcelain"]),
      "?? src/gen.ts\n",
    );
    assertEquals(
      await Deno.readTextFile(`${repo}/src/gen.ts`),
      unformattedGen,
    );
    const joined = logger.lines.join("\n");
    assertEquals(joined.includes("git add -u failed"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate leaves an archive file git no longer tracks out of the archive commit and never rewrites it (Issue #5410)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5410-archive-" });
  try {
    const repo = await initRepo(root);
    const tracked = "docs/archive/pr-summaries/pr-summary-1.md";
    const untracked = "docs/archive/handover/issue-1.md";
    await writeFile(repo, "deno.json", "{}\n");
    await writeFile(repo, tracked, LONG_LINE);
    await writeFile(repo, untracked, LONG_LINE);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "seed"]);
    await git(repo, ["rm", "--cached", untracked]);
    await git(repo, ["commit", "-m", "untrack handover"]);

    const logger = recordingLogger();
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () =>
            Promise.resolve({ runs: [], failures: [], committed: false }),
        },
        logger,
        formatterDeps: { ...createRepoFormatterDeps(), logger },
      },
      repo,
      undefined,
    );

    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      tracked,
    );
    const committed = await git(repo, ["show", `HEAD:${tracked}`]);
    assert(committed !== LONG_LINE, `${tracked} was not formatted`);
    for (const line of committed.split("\n")) {
      assert(line.length <= 80, `${tracked}: ${line}`);
    }
    assertEquals(await Deno.readTextFile(`${repo}/${untracked}`), LONG_LINE);
    assertEquals(
      await git(repo, ["status", "--porcelain", "--untracked-files=all"]),
      `?? ${untracked}\n`,
    );
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "no longer tracked by git");
    assertEquals(joined.includes("git add -u failed"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the pre-push gate passes after formatBeforeGate leaves a branch path git no longer tracks unformatted on disk (Issue #5410)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5410-gate-" });
  try {
    const repo = await initRepo(root);
    await writeFile(repo, "deno.json", "{}\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const baseRef = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const unformattedGen = "export const  y   =  2\n";
    await writeFile(repo, "src/bad.ts", "export const x   =  1\n");
    await writeFile(repo, "src/gen.ts", unformattedGen);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add sources"]);
    await git(repo, ["rm", "--cached", "src/gen.ts"]);
    await git(repo, ["commit", "-m", "untrack generated file"]);

    const logger = recordingLogger();
    const formatterDeps: RepoFormatterDeps = {
      ...createRepoFormatterDeps(),
      logger,
    };
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: (path, ref) =>
            formatBranchChanges(path, ref, formatterDeps),
        },
        logger,
        formatterDeps,
      },
      repo,
      baseRef,
    );
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      await Deno.readTextFile(`${repo}/src/gen.ts`),
      unformattedGen,
    );

    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const gate = await runPrePushGate({
      cwd: repo,
      stdin: `refs/heads/feature ${head} refs/heads/feature ${
        "0".repeat(40)
      }\n`,
      preFlightCommands: [],
      baseRef,
      findMarkdownlint: () => Promise.resolve(null),
      findCspell: () => Promise.resolve(null),
      findShellcheck: () => Promise.resolve(null),
      secretScan: "off",
    });
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    const ran = gate.value.checksRun.join("\n");
    assertStringIncludes(ran, "src/bad.ts");
    assertEquals(ran.includes("src/gen.ts"), false, ran);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
