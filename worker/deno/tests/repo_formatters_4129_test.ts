/**
 * Worker-owned archive files are formatted after the repository formatters
 * (Issue #4129).
 *
 * The pre-push gate checks Markdown. The repository formatters still skip it,
 * because `deno fmt` re-wraps a whole document and trips markdownlint MD018.
 * The worker's own notes live under two directories that markdownlint does
 * not check. Those files, and only those, are formatted here and committed,
 * so the gate sees them clean. A missing formatter or a write failure is
 * logged and does not stop the gate.
 *
 * Australian English throughout (behaviour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRepoFormatterDeps,
  formatBeforeGate,
  FORMATTER_COMMIT_MESSAGE,
  type RepoFormatterDeps,
} from "../lib/repo_formatters.ts";
import type { Logger } from "../types.ts";

const ARCHIVE = [
  "docs/archive/handover/issue-1.md",
  "docs/archive/pr-summaries/pr-summary-1.facts.json",
  "docs/archive/pr-summaries/pr-summary-1.md",
] as const;

const UNTOUCHED = [
  "README.md",
  "docs/guide.md",
  "docs/archive/old.md",
] as const;

const LONG_LINE = "# Title\n\n" +
  "This sentence is deliberately far too long to fit in eighty columns so deno fmt must wrap it onto the following line before the gate sees the file.\n";

const UNSORTED_JSON = '{"z":1,"a":{"y":true,"b":2}}';

const CANONICAL_JSON = `{
  "a": {
    "b": 2,
    "y": true
  },
  "z": 1
}
`;

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

/** Git that answers the archive step without a real repository. */
function fakeGit(
  tracked: readonly string[],
  diffNames: readonly string[],
): RepoFormatterDeps["runGitCommand"] {
  const names = [
    ...ARCHIVE,
    ...UNTOUCHED,
    "docs/archive/handover/../../README.md",
    "docs/archive/pr-summaries/bad.facts.json",
    "src/main.ts",
  ];
  return (args) => {
    const stdout = args[0] === "log"
      ? `${names.join("\0")}\0`
      : args[0] === "ls-files"
      ? `${tracked.join("\0")}\0`
      : args[0] === "diff"
      ? `${diffNames.join("\0")}${diffNames.length > 0 ? "\0" : ""}`
      : "";
    const code = args[0] === "log" || args[0] === "ls-files" ||
        args[0] === "diff" || args[0] === "add" || args[0] === "commit"
      ? 0
      : 1;
    return Promise.resolve({
      ok: true,
      value: { code, stdout, stderr: code === 0 ? "" : "unexpected git" },
    });
  };
}

async function fixtureTree(repo: string): Promise<void> {
  for (const path of [...ARCHIVE, ...UNTOUCHED]) {
    await writeFile(
      repo,
      path,
      path.endsWith(".json") ? UNSORTED_JSON : LONG_LINE,
    );
  }
  await writeFile(repo, "README.md", LONG_LINE);
  await writeFile(
    repo,
    "docs/archive/pr-summaries/bad.facts.json",
    "{not json",
  );
  await writeFile(repo, "src/main.ts", "export const x = 1;\n");
}

Deno.test("formatBeforeGate passes only worker-owned archive paths to deno fmt (Issue #4129)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "fmt4129-paths-" });
  try {
    await fixtureTree(repo);
    const before = await Deno.readTextFile(
      `${repo}/docs/archive/pr-summaries/bad.facts.json`,
    );
    const commands: string[][] = [];
    const logger = recordingLogger();
    const order: string[] = [];
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () => {
            order.push("branch");
            return Promise.resolve({
              runs: [],
              failures: [],
              committed: false,
            });
          },
        },
        logger,
        formatterDeps: {
          runCommand: (cmd) => {
            commands.push(cmd);
            order.push("deno");
            return Promise.resolve({ exitCode: 0, output: "" });
          },
          runGitCommand: fakeGit(
            ["worker/deno/deno.json", ...ARCHIVE],
            [...ARCHIVE],
          ),
          logger,
          runId: () => "test-run",
        },
      },
      repo,
      undefined,
    );
    assertEquals(order, ["branch", "deno"]);
    assertEquals(commands, [[
      "deno",
      "fmt",
      "--permit-no-files",
      "docs/archive/handover/issue-1.md",
      "docs/archive/pr-summaries/bad.facts.json",
      "docs/archive/pr-summaries/pr-summary-1.facts.json",
      "docs/archive/pr-summaries/pr-summary-1.md",
    ]]);
    const joined = logger.lines.join("\n");
    assertStringIncludes(
      joined,
      "Formatter deno fmt on worker-owned archive: exit 0, 3 files changed",
    );
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("ERROR:"), false, joined);
    assertEquals(
      await Deno.readTextFile(
        `${repo}/docs/archive/pr-summaries/bad.facts.json`,
      ),
      before,
    );
    assertEquals(
      await Deno.readTextFile(
        `${repo}/docs/archive/pr-summaries/pr-summary-1.facts.json`,
      ),
      CANONICAL_JSON,
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("formatBeforeGate leaves the archive alone when the repo has no Deno formatter (Issue #4129)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "fmt4129-nodeno-" });
  try {
    await fixtureTree(repo);
    const before = await Deno.readTextFile(`${repo}/README.md`);
    const jsonBefore = await Deno.readTextFile(
      `${repo}/docs/archive/pr-summaries/pr-summary-1.facts.json`,
    );
    let ran = false;
    const logger = recordingLogger();
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () =>
            Promise.resolve({ runs: [], failures: [], committed: false }),
        },
        logger,
        formatterDeps: {
          runCommand: () => {
            ran = true;
            return Promise.resolve({ exitCode: 0, output: "" });
          },
          runGitCommand: fakeGit(["README.md"], []),
          logger,
          runId: () => "test-run",
        },
      },
      repo,
      undefined,
    );
    assertEquals(ran, false);
    assertStringIncludes(
      logger.lines.join("\n"),
      "no Deno formatter in this repository",
    );
    assertEquals(await Deno.readTextFile(`${repo}/README.md`), before);
    assertEquals(
      await Deno.readTextFile(
        `${repo}/docs/archive/pr-summaries/pr-summary-1.facts.json`,
      ),
      jsonBefore,
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("formatBeforeGate logs a formatter that cannot write and still returns (Issue #4129)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "fmt4129-deny-" });
  try {
    await fixtureTree(repo);
    const jsonPath =
      `${repo}/docs/archive/pr-summaries/pr-summary-1.facts.json`;
    await Deno.chmod(jsonPath, 0o444);
    const usage = `${"usage line\n".repeat(80)}--help  Print help`;
    const logger = recordingLogger();
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () =>
            Promise.reject(new Error("repo formatters exploded")),
        },
        logger,
        formatterDeps: {
          runCommand: () =>
            Promise.resolve({
              exitCode: 1,
              output:
                `Error writing files: Permission denied (os error 13)\n${usage}`,
            }),
          runGitCommand: fakeGit(["deno.json"], []),
          logger,
          runId: () => "test-run",
        },
      },
      repo,
      undefined,
    );
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "skipped before the gate");
    assertStringIncludes(joined, "Permission denied");
    assertStringIncludes(joined, "could not rewrite");
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("ERROR:"), false, joined);
    assertEquals(joined.includes("Print help"), true);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("formatBeforeGate logs a missing formatter binary and still returns (Issue #4129)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "fmt4129-missing-" });
  try {
    await fixtureTree(repo);
    const logger = recordingLogger();
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () =>
            Promise.resolve({ runs: [], failures: [], committed: false }),
        },
        logger,
        formatterDeps: {
          runCommand: () => {
            throw new Error("deno fmt binary missing");
          },
          runGitCommand: fakeGit(["deno.json"], []),
          logger,
          runId: () => "test-run",
        },
      },
      repo,
      undefined,
    );
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "deno fmt binary missing");
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("ERROR:"), false, joined);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

async function git(repo: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `git ${args.join(" ")}: ${stderr}`);
  return new TextDecoder().decode(out.stdout);
}

Deno.test("formatBeforeGate formats worker-owned archive files with the production runner and commits them (Issue #4129)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4129-real-" });
  const repo = `${root}/repo`;
  try {
    await new Deno.Command("git", {
      args: ["init", "-b", "main", repo],
      stdout: "null",
      stderr: "piped",
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
    await writeFile(repo, "worker/deno/deno.json", "{}\n");
    for (const path of UNTOUCHED) await writeFile(repo, path, LONG_LINE);
    await writeFile(repo, ARCHIVE[0], LONG_LINE);
    await writeFile(repo, ARCHIVE[2], LONG_LINE);
    await writeFile(repo, ARCHIVE[1], UNSORTED_JSON);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "seed"]);

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

    for (const path of UNTOUCHED) {
      assertEquals(await Deno.readTextFile(`${repo}/${path}`), LONG_LINE, path);
    }
    assertEquals(
      await Deno.readTextFile(`${repo}/${ARCHIVE[1]}`),
      CANONICAL_JSON,
    );
    for (const path of [ARCHIVE[0], ARCHIVE[2]]) {
      const formatted = await Deno.readTextFile(`${repo}/${path}`);
      assert(formatted !== LONG_LINE, `${path} was not formatted`);
      for (const line of formatted.split("\n")) {
        assert(line.length <= 80, `${path}: ${line}`);
      }
    }
    const check = await new Deno.Command("deno", {
      args: ["fmt", "--check", ...ARCHIVE.map((path) => `${repo}/${path}`)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      check.code,
      0,
      new TextDecoder().decode(check.stderr),
    );
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals((await git(repo, ["status", "--porcelain"])).trim(), "");
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "files changed");
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("ERROR:"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
