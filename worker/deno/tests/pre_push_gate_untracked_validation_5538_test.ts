/**
 * The pre-push gate's markdownlint and changed unit-test selection leave out a
 * pushed path git no longer tracks (Issue #5538).
 *
 * `git rm --cached` removes a file from the index while it stays on disk. The
 * branch's file list still names it. Issue #5410 stopped the formatters, lint
 * and cspell from checking it, but the gate kept handing the same path to
 * markdownlint and to the changed unit-test selection, so a file that is no
 * longer in the push could still block it (or demand a markdownlint binary).
 *
 * Australian English throughout (behaviour).
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import { runPrePushGate } from "../lib/pre_push_gate.ts";
import {
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";

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

/**
 * A runner that records every command. It fails (exit 1, stderr naming the
 * file) only when the command includes `failOn`, as markdownlint fails only on
 * the file that has a violation.
 */
function recordingRunner(seen: string[], failOn?: string): PreFlightRunner {
  return (command) => {
    seen.push(command);
    const fails = failOn !== undefined && command.includes(failOn);
    return Promise.resolve({
      started: true,
      code: fails ? 1 : 0,
      stdout: "",
      stderr: fails ? `${failOn}: MD018 no space after hash` : "",
    });
  };
}

function gateFor(
  repo: string,
  head: string,
  baseRef: string,
  runner: PreFlightRunner,
  findMarkdownlint: () => Promise<string | null>,
) {
  return runPrePushGate({
    cwd: repo,
    stdin: `refs/heads/feature ${head} refs/heads/feature ${"0".repeat(40)}\n`,
    preFlightCommands: [],
    baseRef,
    runner,
    findMarkdownlint,
    findCspell: () => Promise.resolve(null),
    findShellcheck: () => Promise.resolve(null),
    secretScan: "off",
  });
}

/**
 * Base commit tracks the markdownlint config; the branch adds `notes/scratch.md`
 * (a lint violation) and `notes/kept.md`, then optionally untracks scratch.
 */
async function markdownFixture(
  root: string,
  untrackScratch: boolean,
): Promise<{ repo: string; head: string; baseRef: string }> {
  const repo = await initRepo(root);
  await writeFile(
    repo,
    ".markdownlint-cli2.jsonc",
    '{ "globs": ["**/*.md"] }\n',
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const baseRef = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await writeFile(repo, "notes/scratch.md", "#Bad\n");
  await writeFile(repo, "notes/kept.md", "# Kept\n\nText.\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "add notes"]);
  if (untrackScratch) {
    await git(repo, ["rm", "--cached", "notes/scratch.md"]);
    await git(repo, ["commit", "-m", "untrack scratch"]);
  }
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, head, baseRef };
}

Deno.test("markdownlint leaves out a pushed Markdown file git no longer tracks (Issue #5538)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-md-" });
  try {
    const { repo, head, baseRef } = await markdownFixture(root, true);
    const seen: string[] = [];
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      recordingRunner(seen, "scratch.md"),
      () => Promise.resolve("/fake/mdl"),
    );
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    const mdl = gate.value.checksRun.filter((c) => c.includes("/fake/mdl"));
    assertEquals(mdl.length, 1, gate.value.checksRun.join("\n"));
    assertStringIncludes(mdl[0] as string, "notes/kept.md");
    assertEquals((mdl[0] as string).includes("scratch.md"), false, mdl[0]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("markdownlint still fails on a tracked Markdown file with a violation (Issue #5538 control)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-md-ctl-" });
  try {
    const { repo, head, baseRef } = await markdownFixture(root, false);
    const seen: string[] = [];
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      recordingRunner(seen, "scratch.md"),
      () => Promise.resolve("/fake/mdl"),
    );
    assert(!gate.ok);
    assertInstanceOf(gate.error, PreFlightGateError);
    assertStringIncludes(gate.error.command, "scratch.md");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an index-removed Markdown file does not demand a markdownlint binary (Issue #5538)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-md-bin-" });
  try {
    const repo = await initRepo(root);
    await writeFile(
      repo,
      ".markdownlint-cli2.jsonc",
      '{ "globs": ["**/*.md"] }\n',
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const baseRef = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await writeFile(repo, "notes/scratch.md", "#Bad\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add scratch"]);
    await git(repo, ["rm", "--cached", "notes/scratch.md"]);
    await git(repo, ["commit", "-m", "untrack scratch"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const seen: string[] = [];
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      recordingRunner(seen),
      () => Promise.resolve(null),
    );
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    assertEquals(
      gate.value.checksRun.some((c) => c.includes("markdownlint")),
      false,
      gate.value.checksRun.join("\n"),
    );
    assertEquals(seen.some((c) => c.includes("scratch.md")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a tracked Markdown file with no markdownlint binary is still refused (Issue #5538 control)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-md-bin-ctl-" });
  try {
    const { repo, head, baseRef } = await markdownFixture(root, false);
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      recordingRunner([]),
      () => Promise.resolve(null),
    );
    assert(!gate.ok);
    assertStringIncludes(
      gate.error.message,
      "markdownlint-cli2 could not be found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * A process-boundary fake of the repo's `test:unit` task. Each named test
 * imports its source (`tests/<name>_test.ts` -> `src/<name>.ts`) and fails when
 * that source, read from the working directory the command runs in, is broken.
 * Any other command passes. Reading the files keeps the verdict the task's own:
 * it depends on which tests the gate selected and on the tree they ran in.
 */
function unitTaskRunner(seen: string[]): PreFlightRunner {
  return async (command, options) => {
    seen.push(command);
    if (!command.startsWith("deno task test:unit")) {
      return { started: true, code: 0, stdout: "", stderr: "" };
    }
    const failed: string[] = [];
    for (const m of command.matchAll(/tests\/(\w+)_test\.ts/g)) {
      try {
        const src = await Deno.readTextFile(
          `${options.cwd}/src/${m[1]}.ts`,
        );
        if (src.includes("broken")) failed.push(m[0]);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return {
      started: true,
      code: failed.length > 0 ? 1 : 0,
      stdout: "",
      stderr: failed.map((f) => `${f} ... FAILED (broken source)`).join("\n"),
    };
  };
}

/**
 * Base tracks a `test:unit` deno.json and two tests that name neither source,
 * so only the changed-file selection (not the referenced-test scan) can pick
 * them. The tests pass at the base (no source yet). The branch adds both
 * sources, each optionally broken so its test fails, then optionally untracks
 * `src/gen.ts` (it stays on disk).
 */
async function unitFixture(
  root: string,
  opts: { untrackGen: boolean; genBroken: boolean; keptBroken: boolean },
): Promise<{ repo: string; head: string; baseRef: string }> {
  const repo = await initRepo(root);
  await writeFile(
    repo,
    "deno.json",
    JSON.stringify({ tasks: { "test:unit": "deno test" } }) + "\n",
  );
  await writeFile(repo, "tests/gen_test.ts", "export const a = 1;\n");
  await writeFile(repo, "tests/kept_test.ts", "export const b = 2;\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const baseRef = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await writeFile(
    repo,
    "src/gen.ts",
    `export const gen = "${opts.genBroken ? "broken" : "fine"}";\n`,
  );
  await writeFile(
    repo,
    "src/kept.ts",
    `export const kept = "${opts.keptBroken ? "broken" : "fine"}";\n`,
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "add sources"]);
  if (opts.untrackGen) {
    await git(repo, ["rm", "--cached", "src/gen.ts"]);
    await git(repo, ["commit", "-m", "untrack gen"]);
  }
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, head, baseRef };
}

Deno.test("a failing sibling test of a source git no longer tracks does not block the push (Issue #5538)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-unit-" });
  try {
    const { repo, head, baseRef } = await unitFixture(root, {
      untrackGen: true,
      genBroken: true,
      keptBroken: false,
    });
    const seen: string[] = [];
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      unitTaskRunner(seen),
      () => Promise.resolve(null),
    );
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    // Positive control: the retained tracked source's test did run.
    assert(
      gate.value.checksRun.some((c) => c.includes("tests/kept_test.ts")),
      gate.value.checksRun.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a newly failing sibling test of a tracked source blocks the push (Issue #5538 control)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-unit-ctl-" });
  try {
    const { repo, head, baseRef } = await unitFixture(root, {
      untrackGen: false,
      genBroken: true,
      keptBroken: false,
    });
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      unitTaskRunner([]),
      () => Promise.resolve(null),
    );
    assert(!gate.ok, "a newly failing selected test must block the push");
    assertInstanceOf(gate.error, PreFlightGateError);
    assertStringIncludes(gate.error.command, "tests/gen_test.ts");
    assertStringIncludes(gate.error.message, "tests/gen_test.ts");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a failing test of the tracked source still blocks when another source is untracked (Issue #5538)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gate5538-unit-kept-" });
  try {
    const { repo, head, baseRef } = await unitFixture(root, {
      untrackGen: true,
      genBroken: true,
      keptBroken: true,
    });
    const gate = await gateFor(
      repo,
      head,
      baseRef,
      unitTaskRunner([]),
      () => Promise.resolve(null),
    );
    assert(!gate.ok, "the tracked source's failing test must block");
    assertInstanceOf(gate.error, PreFlightGateError);
    assertStringIncludes(gate.error.message, "tests/kept_test.ts");
    assertEquals(gate.error.message.includes("tests/gen_test.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
