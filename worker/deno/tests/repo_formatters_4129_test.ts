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
  formatBranchChanges,
  FORMATTER_COMMIT_MESSAGE,
  isolateLinkageLines,
  MAX_ARCHIVE_REWRITE_BYTES,
  type RepoFormatterDeps,
} from "../lib/repo_formatters.ts";
import type { Logger } from "../types.ts";
import {
  NO_HOST_GIT_CONFIG,
  NO_HOST_HOOKS_ARGS,
} from "./support/no_host_git_config.ts";
import {
  PART_OF_OTHER,
  PART_OF_SAME,
} from "../../../.claude/skills/review-fleet-prs/scripts/test_change_policy.ts";

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
  options: { dirtyCheckFails?: boolean } = {},
): RepoFormatterDeps["runGitCommand"] {
  const names = [
    ...ARCHIVE,
    ...UNTOUCHED,
    "docs/archive/handover/../../README.md",
    "docs/archive/pr-summaries/bad.facts.json",
    "src/main.ts",
  ];
  return (args) => {
    // The uncommitted-changes check diffs against HEAD (Issue #5328).
    const dirtyCheck = args[0] === "diff" && args.includes("HEAD");
    if (dirtyCheck && options.dirtyCheckFails) {
      return Promise.resolve({
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'" },
      });
    }
    const stdout = args[0] === "log"
      ? `${names.join("\0")}\0`
      : args[0] === "ls-files"
      ? `${tracked.join("\0")}\0`
      : args[0] === "diff" && !dirtyCheck
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

Deno.test("formatBeforeGate formats worker-owned archive files with the production runner and commits them (Issue #4129)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4129-real-" });
  const repo = `${root}/repo`;
  try {
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

const LONG_PARAGRAPH =
  "Another deliberately over-long sentence, far beyond eighty columns, so deno fmt has to re-wrap this paragraph before the gate reads the summary.";

const LINKAGE_SUMMARY = "# Summary\n\n" +
  "Part of #1\n" +
  "Part of #2\n\n" +
  "Prose that ends the paragraph.\n" +
  "Closes #3\n\n" +
  `${LONG_PARAGRAPH}\n`;

const FENCED_SUMMARY = "# Summary\n\n" +
  "```\n" +
  "Part of #1\n" +
  "Part of #2\n" +
  "```\n";

/**
 * Init an empty repository at `${root}/repo` with the fixture identity and
 * hooks kept out of the host's config, and return its path.
 */
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
 * Seed a repository whose only archive file is `summary`, in the seed commit,
 * then run the production runner over it. The seed commit is the branch's
 * change, as in the test above.
 */
async function formatSeededSummary(
  root: string,
  summary: string,
): Promise<{ repo: string; logger: Logger & { lines: string[] } }> {
  const repo = await initRepo(root);
  await writeFile(repo, "worker/deno/deno.json", "{}\n");
  await writeFile(repo, ARCHIVE[2], summary);
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
  return { repo, logger };
}

Deno.test("formatBeforeGate keeps adjacent linkage lines on lines of their own and still re-wraps prose (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-linkage-" });
  try {
    const { repo, logger } = await formatSeededSummary(root, LINKAGE_SUMMARY);
    const formatted = await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`);
    const lines = formatted.split("\n");
    for (const expected of ["Part of #1", "Part of #2", "Closes #3"]) {
      assert(
        lines.includes(expected),
        `${expected} is not on a line of its own:\n${formatted}`,
      );
    }
    assertEquals(formatted.includes("Part of #1 Part of #2"), false, formatted);
    for (const line of lines) {
      assert(line.length <= 80, `${ARCHIVE[2]}: ${line}`);
    }
    const joined = logger.lines.join("\n");
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("ERROR:"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate leaves linkage-looking lines inside a code fence adjacent (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-fence-" });
  try {
    const { repo } = await formatSeededSummary(root, FENCED_SUMMARY);
    const formatted = await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`);
    assertStringIncludes(
      formatted,
      "```\nPart of #1\nPart of #2\n```",
      formatted,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * Seed a repository with `files` (and optional `links`, path to symlink
 * target) in one commit, run `beforeFormat`, then run the production runner.
 */
async function formatSeededFiles(
  root: string,
  files: Record<string, string>,
  options: {
    links?: Record<string, string>;
    beforeFormat?: (repo: string) => Promise<void>;
    setAsideUncommittedArchive?: boolean;
    /** Where the Deno config sits; the default keeps it under `worker/deno`. */
    denoConfig?: string;
    /** Run the production `formatBranchChanges` rather than a stub. */
    realBranchFormatter?: boolean;
    /** Replaces the production git runner, to stage a failing command. */
    runGitCommand?: RepoFormatterDeps["runGitCommand"];
  } = {},
): Promise<{ repo: string; logger: Logger & { lines: string[] } }> {
  const repo = await initRepo(root);
  await writeFile(repo, options.denoConfig ?? "worker/deno/deno.json", "{}\n");
  for (const [path, body] of Object.entries(files)) {
    await writeFile(repo, path, body);
  }
  for (const [path, target] of Object.entries(options.links ?? {})) {
    const absolute = `${repo}/${path}`;
    await Deno.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.symlink(target, absolute);
  }
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "seed"]);
  await options.beforeFormat?.(repo);

  const logger = recordingLogger();
  const formatterDeps = {
    ...createRepoFormatterDeps(),
    logger,
    ...(options.runGitCommand ? { runGitCommand: options.runGitCommand } : {}),
  };
  await formatBeforeGate(
    {
      git: {
        formatBranchChanges: options.realBranchFormatter
          ? (path, baseRef) => formatBranchChanges(path, baseRef, formatterDeps)
          : () => Promise.resolve({ runs: [], failures: [], committed: false }),
      },
      logger,
      formatterDeps,
    },
    repo,
    undefined,
    { setAsideUncommittedArchive: options.setAsideUncommittedArchive },
  );
  return { repo, logger };
}

const TWO_LINKAGE_LINES = "# Summary\n\nPart of #1\nPart of #2\n";

Deno.test("isolateLinkageLines puts blank lines only where a linkage line touches another line (Issue #4802)", () => {
  assertEquals(isolateLinkageLines("Part of #1"), "Part of #1");
  assertEquals(isolateLinkageLines("Part of #1\nProse"), "Part of #1\n\nProse");
  assertEquals(isolateLinkageLines("Prose\nPart of #1"), "Prose\n\nPart of #1");
  assertEquals(
    isolateLinkageLines("Prose\n\nPart of #1\n\nProse"),
    "Prose\n\nPart of #1\n\nProse",
  );
  assertEquals(
    isolateLinkageLines("Part of #1\nPart of #2\nFixes o/r#3."),
    "Part of #1\n\nPart of #2\n\nFixes o/r#3.",
  );
  assertEquals(
    isolateLinkageLines("Prose\n  Closes #4  \nProse"),
    "Prose\n\n  Closes #4  \n\nProse",
  );
});

Deno.test("isolateLinkageLines leaves prose lines and lines inside either fence style alone (Issue #4802)", () => {
  const prose = "First line\nsecond line\nThird line";
  assertEquals(isolateLinkageLines(prose), prose);
  const backticks = "```\nPart of #1\nPart of #2\n```";
  assertEquals(isolateLinkageLines(backticks), backticks);
  const tildes = "~~~\nPart of #1\nPart of #2\n~~~";
  assertEquals(isolateLinkageLines(tildes), tildes);
  assertEquals(
    isolateLinkageLines("~~~\nx\n~~~\nPart of #1\nPart of #2"),
    "~~~\nx\n~~~\n\nPart of #1\n\nPart of #2",
  );
});

Deno.test("isolateLinkageLines closes a fence only on the opener's character and length (Issue #4802)", () => {
  // A ``` line inside a ~~~ block does not end it, so the later ~~~ does.
  assertEquals(
    isolateLinkageLines("~~~text\n```\n~~~\nPart of #3\nPart of #4"),
    "~~~text\n```\n~~~\n\nPart of #3\n\nPart of #4",
  );
  // A shorter ``` run does not close a ```` block, so nothing inside changes.
  const nested = "````markdown\n```\nPart of #1\nPart of #2\n```\n````";
  assertEquals(isolateLinkageLines(nested), nested);
  const tildeInBackticks = "```markdown\n~~~\nPart of #1\nPart of #2\n~~~\n```";
  assertEquals(isolateLinkageLines(tildeInBackticks), tildeInBackticks);
  // A closer with an info string is not a closer.
  const infoCloser = "```\n```text\nPart of #1\nPart of #2\n```";
  assertEquals(isolateLinkageLines(infoCloser), infoCloser);
  // Linkage lines after the nested sample are isolated again.
  assertEquals(
    isolateLinkageLines(`${nested}\nPart of #5\nPart of #6`),
    `${nested}\n\nPart of #5\n\nPart of #6`,
  );
});

Deno.test("isolateLinkageLines accepts the same Part of shapes as the reviewer's PART_OF_SAME and PART_OF_OTHER (Issue #4802)", () => {
  const variants = [
    "Part of #5",
    "Part of #5.",
    "Part of #5 .",
    "Part of #5\t.",
    "Part of #5 . ",
    "  Part of #5  ",
    "part of #5",
    "PART OF #5",
    "Part of o/r#5",
    "Part of o/r#5 .",
    "Part of o/r#5.",
    "Part of Owner-1/re.po_2#5",
    "Part of #5x",
    "Part of #",
    "Part of  #5",
    "Part of #5..",
    "Part of #5 . .",
    "Part of o/r/x#5",
    "Part of /r#5",
    "Part of o/r #5",
    "Partof #5",
  ];
  for (const line of variants) {
    const reviewer = PART_OF_SAME.test(line) || PART_OF_OTHER.test(line);
    const isolated = isolateLinkageLines(`Prose\n${line}\nProse`) !==
      `Prose\n${line}\nProse`;
    assertEquals(isolated, reviewer, JSON.stringify(line));
  }
  // The table must exercise both outcomes, so it cannot pass vacuously.
  assert(variants.some((line) => PART_OF_SAME.test(line)));
  assert(variants.some((line) => PART_OF_OTHER.test(line)));
  assert(
    variants.some((line) =>
      !PART_OF_SAME.test(line) && !PART_OF_OTHER.test(line)
    ),
  );
});

Deno.test("formatBeforeGate keeps linkage lines apart after a mixed-fence block and leaves a nested sample untouched (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-mixed-" });
  try {
    const nested = "````markdown\n```\nPart of #1\nPart of #2\n```\n````\n";
    const { repo } = await formatSeededSummary(
      root,
      `# Summary\n\n~~~text\n\`\`\`\n~~~\n\nPart of #3\nPart of #4\n\n${nested}`,
    );
    const formatted = await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`);
    const lines = formatted.split("\n");
    assert(lines.includes("Part of #3"), formatted);
    assert(lines.includes("Part of #4"), formatted);
    assertEquals(formatted.includes("Part of #3 Part of #4"), false, formatted);
    assertStringIncludes(formatted, nested, formatted);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate still joins adjacent prose lines while isolating linkage lines (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-prose-" });
  try {
    const { repo } = await formatSeededFiles(root, {
      [ARCHIVE[2]]: "# Summary\n\nFirst line\nsecond line\n",
    });
    assertEquals(
      await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`),
      "# Summary\n\nFirst line second line\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate isolates linkage lines in .markdown files and canonicalises .jsonc files (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-ext-" });
  try {
    const { repo } = await formatSeededFiles(root, {
      "docs/archive/handover/note.markdown": TWO_LINKAGE_LINES,
      "docs/archive/pr-summaries/x.facts.jsonc": UNSORTED_JSON,
    });
    assertEquals(
      await Deno.readTextFile(`${repo}/docs/archive/handover/note.markdown`),
      "# Summary\n\nPart of #1\n\nPart of #2\n",
    );
    assertEquals(
      await Deno.readTextFile(
        `${repo}/docs/archive/pr-summaries/x.facts.jsonc`,
      ),
      CANONICAL_JSON,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate does not rewrite an archive file that is already canonical (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-nowrite-" });
  try {
    const canonicalMarkdown = "# Summary\n\nPart of #1\n\nPart of #2\n";
    const old = new Date("2001-02-03T04:05:06Z");
    const paths = [ARCHIVE[1], ARCHIVE[2]];
    const { repo } = await formatSeededFiles(root, {
      [ARCHIVE[1]]: CANONICAL_JSON,
      [ARCHIVE[2]]: canonicalMarkdown,
    }, {
      beforeFormat: async (repo) => {
        for (const path of paths) await Deno.utime(`${repo}/${path}`, old, old);
      },
    });
    for (const path of paths) {
      const info = await Deno.stat(`${repo}/${path}`);
      assertEquals(info.mtime?.getTime(), old.getTime(), path);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate leaves the target of an archive symlink alone (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-symlink-" });
  try {
    const outside = `${root}/outside.md`;
    await Deno.writeTextFile(outside, TWO_LINKAGE_LINES);
    const { logger } = await formatSeededFiles(root, {}, {
      links: { "docs/archive/pr-summaries/link.md": outside },
    });
    assertEquals(await Deno.readTextFile(outside), TWO_LINKAGE_LINES);
    const joined = logger.lines.join("\n");
    assertEquals(joined.includes("WARNING:"), false, joined);
    assertEquals(joined.includes("could not rewrite"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate skips an archive file over the size limit and never formats the rest of the repository (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-big-" });
  try {
    const big = `${TWO_LINKAGE_LINES}${
      "x\n".repeat(MAX_ARCHIVE_REWRITE_BYTES)
    }`;
    const readme = "Prose\n\nPart of #1\nPart of #2\n";
    const unformatted = "const   x  =  1\n";
    const { repo, logger } = await formatSeededFiles(root, {
      "deno.json": "{}\n",
      "README.md": readme,
      "src/main.ts": unformatted,
      [ARCHIVE[2]]: big,
    });
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`), big);
    assertEquals(await Deno.readTextFile(`${repo}/README.md`), readme);
    assertEquals(await Deno.readTextFile(`${repo}/src/main.ts`), unformatted);
    assertEquals(await git(repo, ["status", "--porcelain"]), "");
    assertEquals((await git(repo, ["log", "--format=%s"])).trim(), "seed");
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, `skipped ${ARCHIVE[2]}`);
    assertEquals(joined.includes("Formatter deno fmt"), false, joined);
    assertEquals(joined.includes("committed worker-owned"), false, joined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate still formats the other archive files when one is over the size limit (Issue #4802)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt4802-bigmix-" });
  try {
    const big = `${TWO_LINKAGE_LINES}${
      "x\n".repeat(MAX_ARCHIVE_REWRITE_BYTES)
    }`;
    const { repo } = await formatSeededFiles(root, {
      "deno.json": "{}\n",
      [ARCHIVE[0]]: TWO_LINKAGE_LINES,
      [ARCHIVE[2]]: big,
    });
    assertEquals(
      await Deno.readTextFile(`${repo}/${ARCHIVE[0]}`),
      "# Summary\n\nPart of #1\n\nPart of #2\n",
    );
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`), big);
    assertEquals(await git(repo, ["status", "--porcelain"]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate leaves an archive summary with an uncommitted edit uncommitted and unformatted (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-dirty-" });
  try {
    const seed = "# Summary\n\nNot delivered.\n";
    const edit = `# Summary\n\nEdited after the seed.\n\n${LONG_PARAGRAPH}\n`;
    const { repo, logger } = await formatSeededFiles(root, {
      [ARCHIVE[2]]: seed,
    }, {
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[2], edit),
    });
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      "seed",
    );
    assertEquals(await git(repo, ["show", `HEAD:${ARCHIVE[2]}`]), seed);
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`), edit);
    assertEquals(
      await git(repo, ["status", "--porcelain"]),
      ` M ${ARCHIVE[2]}\n`,
    );
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, ARCHIVE[2]);
    assertStringIncludes(joined, "uncommitted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate commits a clean archive file and leaves a summary staged outside the commit (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-staged-" });
  try {
    const seed = "# Summary\n\nNot delivered.\n";
    const staged = "# Summary\n\nStaged after the seed.\n";
    const { repo } = await formatSeededFiles(root, {
      [ARCHIVE[0]]: LONG_LINE,
      [ARCHIVE[2]]: seed,
    }, {
      beforeFormat: async (repo) => {
        await writeFile(repo, ARCHIVE[2], staged);
        await git(repo, ["add", ARCHIVE[2]]);
      },
    });
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      ARCHIVE[0],
    );
    assertEquals(await git(repo, ["show", `HEAD:${ARCHIVE[2]}`]), seed);
    assertEquals(
      (await git(repo, ["diff", "--cached", "--name-only"])).trim(),
      ARCHIVE[2],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate stashes an uncommitted archive summary when asked, and still formats and commits the clean files (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-stash-" });
  try {
    const seed = "# Summary\n\nNot delivered.\n";
    const edit = `# Summary\n\nEdited after the seed.\n\n${LONG_PARAGRAPH}\n`;
    const { repo, logger } = await formatSeededFiles(root, {
      [ARCHIVE[0]]: LONG_LINE,
      [ARCHIVE[2]]: seed,
    }, {
      setAsideUncommittedArchive: true,
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[2], edit),
    });
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      ARCHIVE[0],
    );
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`), seed);
    assertEquals(await git(repo, ["status", "--porcelain"]), "");
    assertEquals(await git(repo, ["show", `stash@{0}:${ARCHIVE[2]}`]), edit);
    assertStringIncludes(logger.lines.join("\n"), "set aside");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate logs a stash that fails and leaves the uncommitted summary in place (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-stashfail-" });
  try {
    const seed = "# Summary\n\nNot delivered.\n";
    const edit = `# Summary\n\nEdited after the seed.\n\n${LONG_PARAGRAPH}\n`;
    const real = createRepoFormatterDeps().runGitCommand;
    const { repo, logger } = await formatSeededFiles(root, {
      [ARCHIVE[2]]: seed,
    }, {
      setAsideUncommittedArchive: true,
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[2], edit),
      runGitCommand: (args, options) =>
        args[0] === "stash"
          ? Promise.resolve({
            ok: true as const,
            value: { code: 128, stdout: "", stderr: "fatal: stash refused" },
          })
          : real(args, options),
    });
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[2]}`), edit);
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      "seed",
    );
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "could not set aside");
    assertStringIncludes(joined, "stash refused");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate skips the archive step when the uncommitted-changes check fails (Issue #5328)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "fmt5328-check-" });
  try {
    await fixtureTree(repo);
    const jsonPath =
      `${repo}/docs/archive/pr-summaries/pr-summary-1.facts.json`;
    const commands: string[][] = [];
    const gitArgs: string[][] = [];
    const inner = fakeGit(
      ["worker/deno/deno.json", ...ARCHIVE],
      [...ARCHIVE],
      { dirtyCheckFails: true },
    );
    const logger = recordingLogger();
    await formatBeforeGate(
      {
        git: {
          formatBranchChanges: () =>
            Promise.resolve({ runs: [], failures: [], committed: false }),
        },
        logger,
        formatterDeps: {
          runCommand: (cmd) => {
            commands.push(cmd);
            return Promise.resolve({ exitCode: 0, output: "" });
          },
          runGitCommand: (args, options) => {
            gitArgs.push(args);
            return inner(args, options);
          },
          logger,
          runId: () => "test-run",
        },
      },
      repo,
      undefined,
    );
    assert(
      gitArgs.some((args) => args[0] === "diff" && args.includes("HEAD")),
      JSON.stringify(gitArgs),
    );
    assertEquals(commands, []);
    assertEquals(
      gitArgs.filter((args) => args[0] === "add" || args[0] === "commit"),
      [],
    );
    assertEquals(await Deno.readTextFile(jsonPath), UNSORTED_JSON);
    const joined = logger.lines.join("\n");
    assertStringIncludes(joined, "worker-owned archive skipped");
    assertStringIncludes(joined, "bad revision");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("formatBranchChanges commit leaves a file staged outside the formatted paths staged and out of the formatter commit (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-commit-" });
  try {
    const repo = await initRepo(root);
    await writeFile(repo, "deno.json", "{}\n");
    await writeFile(repo, "bad.ts", "export const x   =  1\n");
    await writeFile(repo, "notes.md", "# Notes\n\nFirst draft.\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "seed"]);
    await writeFile(repo, "notes.md", "# Notes\n\nSecond draft.\n");
    await git(repo, ["add", "notes.md"]);

    const logger = recordingLogger();
    const result = await formatBranchChanges(repo, undefined, {
      ...createRepoFormatterDeps(),
      logger,
    });
    assertEquals(result.committed, true);
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      (await git(repo, ["show", "--name-only", "--format=", "HEAD"])).trim(),
      "bad.ts",
    );
    assertEquals(
      (await git(repo, ["diff", "--cached", "--name-only"])).trim(),
      "notes.md",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const EDITED_JSON = '{"z":2,   "a":{"y":true,"b":3}}';

Deno.test("formatBeforeGate keeps an archive JSON file with an uncommitted edit out of the formatter commit under a root Deno config (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-json-" });
  try {
    const { repo, logger } = await formatSeededFiles(root, {
      [ARCHIVE[1]]: UNSORTED_JSON,
    }, {
      denoConfig: "deno.json",
      realBranchFormatter: true,
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[1], EDITED_JSON),
    });
    assertEquals(
      (await git(repo, ["log", "--format=%s"])).trim(),
      "seed",
    );
    assertEquals(
      await git(repo, ["show", `HEAD:${ARCHIVE[1]}`]),
      UNSORTED_JSON,
    );
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[1]}`), EDITED_JSON);
    assertEquals(
      await git(repo, ["status", "--porcelain"]),
      ` M ${ARCHIVE[1]}\n`,
    );
    assertEquals(await git(repo, ["stash", "list"]), "");
    assertStringIncludes(logger.lines.join("\n"), "uncommitted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBeforeGate stashes an archive JSON edit and formats the committed copy under a root Deno config (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-json-stash-" });
  try {
    const { repo } = await formatSeededFiles(root, {
      [ARCHIVE[1]]: UNSORTED_JSON,
    }, {
      denoConfig: "deno.json",
      realBranchFormatter: true,
      setAsideUncommittedArchive: true,
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[1], EDITED_JSON),
    });
    assertEquals(
      (await git(repo, ["log", "-1", "--format=%s"])).trim(),
      FORMATTER_COMMIT_MESSAGE,
    );
    assertEquals(
      await git(repo, ["show", `HEAD:${ARCHIVE[1]}`]),
      CANONICAL_JSON,
    );
    assertEquals(
      await Deno.readTextFile(`${repo}/${ARCHIVE[1]}`),
      CANONICAL_JSON,
    );
    assertEquals(await git(repo, ["status", "--porcelain"]), "");
    assertEquals(
      await git(repo, ["show", `stash@{0}:${ARCHIVE[1]}`]),
      EDITED_JSON,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBranchChanges still formats and commits an archive JSON file with no uncommitted edit under a root Deno config (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-json-clean-" });
  try {
    const { repo } = await formatSeededFiles(root, {
      [ARCHIVE[1]]: UNSORTED_JSON,
    }, { denoConfig: "deno.json", realBranchFormatter: true });
    assertEquals(
      await git(repo, ["show", `HEAD:${ARCHIVE[1]}`]),
      CANONICAL_JSON,
    );
    assertEquals(await git(repo, ["status", "--porcelain"]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("formatBranchChanges leaves every archive file out when the uncommitted-changes check fails (Issue #5328)", async () => {
  const root = await Deno.makeTempDir({ prefix: "fmt5328-json-check-" });
  try {
    const { repo, logger } = await formatSeededFiles(root, {
      [ARCHIVE[1]]: UNSORTED_JSON,
    }, {
      denoConfig: "deno.json",
      realBranchFormatter: true,
      beforeFormat: (repo) => writeFile(repo, ARCHIVE[1], EDITED_JSON),
      runGitCommand: (args, options) =>
        args[0] === "diff" && args.includes("HEAD")
          ? Promise.resolve({
            ok: true as const,
            value: { code: 128, stdout: "", stderr: "fatal: bad revision" },
          })
          : createRepoFormatterDeps().runGitCommand(args, options),
    });
    assertEquals(
      (await git(repo, ["log", "--format=%s"])).trim(),
      "seed",
    );
    assertEquals(await Deno.readTextFile(`${repo}/${ARCHIVE[1]}`), EDITED_JSON);
    assertStringIncludes(logger.lines.join("\n"), "left out of the formatters");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
