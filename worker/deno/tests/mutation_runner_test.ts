/**
 * Unit tests for the helpers that remain in mutation_runner.ts after the
 * automatic mutation check was retired by Issue #5095 (originally Issue
 * #3393), driven through fake seams where a test needs one: confinePath,
 * importsModule, the temporary-directory and scratch-root helpers, the default
 * child environment and listTestFiles.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import {
  confinePath,
  defaultMutationRunnerSeams,
  importsModule,
  makeMutationTempDir,
  resolveMutationScratchRoot,
} from "../lib/mutation_runner.ts";
import { parseDenoProjectConfig } from "../lib/deno_test_config.ts";
import { ALLOWED_ENV_NAMES } from "../lib/untrusted_command_env.ts";

async function realRepo(
  run: (repo: string, outside: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "mut-repo-" });
  const outside = await Deno.makeTempDir({ prefix: "mut-outside-" });
  try {
    await run(repo, outside);
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
}

Deno.test("confinePath - rejects a climb out of the repo, accepts one that stays in", async () => {
  await realRepo(async (repo, outside) => {
    const seams = defaultMutationRunnerSeams();
    const real = await Deno.realPath(repo);
    await Deno.symlink(outside, `${repo}/link`);
    assertEquals(await confinePath(repo, "../x.ts", seams), null);
    assertEquals(await confinePath(repo, "a/../../x.ts", seams), null);
    assertEquals(await confinePath(repo, "/etc/passwd", seams), null);
    assertEquals(await confinePath(repo, "link/x.ts", seams), null);
    assertEquals(
      await confinePath(repo, "a/../b/x.ts", seams),
      `${real}/b/x.ts`,
    );
  });
});

async function writeRepoFiles(
  repo: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = `${repo}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, text);
  }
}

Deno.test("listTestFiles - the real seam lists suffix tests and include-matched files under their nearest project, sorted", async () => {
  await realRepo(async (repo) => {
    await writeRepoFiles(repo, {
      "deno.json": JSON.stringify({
        test: {
          include: ["test/**/*.ts"],
          exclude: ["test/fixtures/**"],
        },
        imports: { "@neat/": "./src/NEAT/" },
      }),
      "test/a.ts": "",
      "test/ci/b.ts": "",
      "test/fixtures/c.ts": "",
      "test/types.d.ts": "",
      "src/NEAT/Neat.ts": SOURCE,
      "lib/m_test.ts": "",
      "node_modules/x_test.ts": "",
      "worker/deno/deno.json": '{"test":{"include":["tests/**"]}}',
      "worker/deno/tests/w.ts": "",
      "worker/deno/lib/v.ts": "",
      // The root's test/** must not reach this: the nested project is nearest.
      "worker/deno/test/u.ts": "",
    });
    const listed = await defaultMutationRunnerSeams().listTestFiles(repo);
    assertEquals(listed, [
      "lib/m_test.ts",
      "test/a.ts",
      "test/ci/b.ts",
      "worker/deno/tests/w.ts",
    ]);
  });
});

Deno.test("listTestFiles - a directory include lists suffix tests, not source files", async () => {
  await realRepo(async (repo) => {
    await writeRepoFiles(repo, {
      "deno.json": '{"test":{"include":["src/"]}}',
      "src/foo.ts": SOURCE,
      "src/foo_test.ts": "",
    });
    assertEquals(await defaultMutationRunnerSeams().listTestFiles(repo), [
      "src/foo_test.ts",
    ]);
  });
});

Deno.test("listTestFiles - an invalid deno.json in an unrelated project falls back to the suffix rule", async () => {
  await realRepo(async (repo) => {
    await writeRepoFiles(repo, {
      "deno.json": '{"test":{"include":["test/**/*.ts"]}}',
      "test/a.ts": "",
      "lib/m_test.ts": "",
      "fixtures/bad/deno.json": "{ not json",
      "fixtures/bad/x_test.ts": "",
      "fixtures/bad/y.ts": "",
      "fixtures/neg/deno.json": '{"test":{"include":["!a.ts"]}}',
      "fixtures/neg/z.test.ts": "",
    });
    const listed = await defaultMutationRunnerSeams().listTestFiles(repo);
    assertEquals(listed, [
      "fixtures/bad/x_test.ts",
      "fixtures/neg/z.test.ts",
      "lib/m_test.ts",
      "test/a.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hostile input to the specifier scan
// ---------------------------------------------------------------------------

Deno.test("importsModule - hostile unclosed-specifier text scans in linear time", () => {
  const shapes: Array<[string, (chars: number) => string]> = [
    ["repeated './", (n) => "'./".repeat(Math.ceil(n / 3))],
    ["quote then unclosed ./", (n) => '"' + "./".repeat(Math.ceil(n / 2))],
  ];
  for (const [label, build] of shapes) {
    const found = assertLinearGrowth(
      label,
      build,
      (text) => importsModule(text, "tests", "lib/m.ts"),
      { baseChars: 12_500, sizeFactor: 4 },
    );
    assertEquals(found, false);
  }
  assertEquals(
    importsModule("import '../lib/m.ts'", "tests", "lib/m.ts"),
    true,
  );
});

Deno.test("importsModule - a bare alias counts only with the project's imports map", () => {
  const text = 'import { f } from "@neat/Neat.ts";\n';
  const project = {
    dir: "",
    config: parseDenoProjectConfig(
      '{"imports":{"@neat/":"./src/NEAT/"}}',
      "deno.json",
    ),
  };
  assertEquals(importsModule(text, "test", "src/NEAT/Neat.ts"), false);
  assertEquals(importsModule(text, "test", "src/NEAT/Neat.ts", project), true);
  assertEquals(
    importsModule(text, "test", "src/NEAT/Other.ts", project),
    false,
  );
  // Relative specifiers behave as before, with or without the project.
  const rel = 'import "../lib/m.ts";';
  assertEquals(importsModule(rel, "tests", "lib/m.ts"), true);
  assertEquals(importsModule(rel, "tests", "lib/m.ts", project), true);
});

Deno.test("importsModule - a nested project's alias resolves against that project's directory", () => {
  const project = {
    dir: "worker/deno",
    config: parseDenoProjectConfig(
      '{"imports":{"@neat/":"./src/NEAT/"}}',
      "worker/deno/deno.json",
    ),
  };
  assertEquals(
    importsModule(
      'import "@neat/Neat.ts";',
      "worker/deno/tests",
      "worker/deno/src/NEAT/Neat.ts",
      project,
    ),
    true,
  );
});

Deno.test("importsModule - a run of quotes with a project matches nothing and returns", () => {
  const project = {
    dir: "",
    config: parseDenoProjectConfig(
      '{"imports":{"@neat/":"./src/NEAT/"}}',
      "deno.json",
    ),
  };
  const hostile = '"'.repeat(200_000) + " ";
  assertEquals(
    importsModule(hostile, "test", "src/NEAT/Neat.ts", project),
    false,
  );
});

// ---------------------------------------------------------------------------
// Child environment (Issue #572: repository code never sees worker credentials)
// ---------------------------------------------------------------------------

Deno.test("defaultMutationRunnerSeams runProcess - the child gets the allowlisted environment, not the worker's", async () => {
  const source: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    GH_TOKEN: "ghp_mutation_runner_test_secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth_mutation_runner_test_secret",
    AWS_SECRET_ACCESS_KEY: "aws_mutation_runner_test_secret",
    VIBE_MUTATION_TEST_PLAIN: "plain_mutation_runner_test_value",
  };
  const r = await defaultMutationRunnerSeams(source).runProcess("env", [], {
    cwd: Deno.cwd(),
    timeoutMs: 20_000,
  });
  assertEquals(r.code, 0, r.stderr);
  const names = r.stdout.split("\n").filter((l) => l !== "").map((l) =>
    l.split("=")[0] ?? ""
  );
  for (
    const name of [
      "GH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]
  ) {
    assertEquals(names.includes(name), false, `${name} reached the child`);
  }
  assertEquals(r.stdout.includes("_mutation_runner_test_secret"), false);
  assert(names.includes("PATH"));
  // Nothing outside the allowlist: not the planted variable, and not whatever
  // this test process itself inherited (clearEnv).
  const allowed = new Set(ALLOWED_ENV_NAMES);
  assertEquals(names.filter((n) => !allowed.has(n)), []);
});

Deno.test("defaultMutationRunnerSeams runProcess - a declared credential reaches the child and an undeclared one does not", async () => {
  const source: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    UNDECLARED_API_TOKEN: "undeclared_mutation_runner_test_secret",
  };
  const r = await defaultMutationRunnerSeams(source).runProcess("env", [], {
    cwd: Deno.cwd(),
    timeoutMs: 20_000,
    env: { DECLARED_API_TOKEN: "declared_mutation_runner_test_value" },
  });
  assertEquals(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert(
    lines.includes("DECLARED_API_TOKEN=declared_mutation_runner_test_value"),
  );
  assertEquals(r.stdout.includes("UNDECLARED_API_TOKEN"), false);
});

// ---------------------------------------------------------------------------
// Budget expiry: SIGTERM first, SIGKILL only after a grace period
// ---------------------------------------------------------------------------

const SOURCE =
  "export function f(a: boolean) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n";

const SH_ENV = { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" };

Deno.test("defaultMutationRunnerSeams runProcess - a timeout sends SIGTERM first so the child can clean up", async () => {
  // The child traps SIGTERM and writes its marker, as cargo-mutants stops its
  // process groups and removes its scratch copy; SIGKILL would not let it.
  const r = await defaultMutationRunnerSeams(SH_ENV, 20_000).runProcess(
    "sh",
    [
      "-c",
      'trap "echo cleaned-up; exit 0" TERM; echo ready; while :; do :; done',
    ],
    { cwd: Deno.cwd(), timeoutMs: 500 },
  );
  assertEquals(r.timedOut, true);
  assertStringIncludes(r.stdout, "cleaned-up");
  assertEquals(r.code, 0);
});

Deno.test("defaultMutationRunnerSeams runProcess - a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const r = await defaultMutationRunnerSeams(SH_ENV, 100).runProcess(
    "sh",
    ["-c", 'trap "" TERM; echo ready; while :; do :; done'],
    { cwd: Deno.cwd(), timeoutMs: 500 },
  );
  assertEquals(r.timedOut, true);
  assertEquals(r.code, 137);
});

// ---------------------------------------------------------------------------
// Temporary directory (Issue #4127): TMPDIR first, a private work-volume root
// when the system temp directory refuses
// ---------------------------------------------------------------------------

function envOf(
  env: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => env[name];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("resolveMutationScratchRoot - WORK_DIR wins, HOME is the fallback, relative and empty values are skipped", () => {
  assertEquals(
    resolveMutationScratchRoot(envOf({ WORK_DIR: "/work/", HOME: "/home/u" })),
    "/work/.mutation-scratch",
  );
  assertEquals(
    resolveMutationScratchRoot(envOf({ WORK_DIR: "  ", HOME: "/home/u/" })),
    "/home/u/auto-issue-work/.mutation-scratch",
  );
  assertEquals(
    resolveMutationScratchRoot(
      envOf({ WORK_DIR: "relative/dir", HOME: "rel" }),
    ),
    null,
  );
  assertEquals(resolveMutationScratchRoot(envOf({})), null);
});

Deno.test("makeMutationTempDir - uses TMPDIR when it is writable", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    await Deno.mkdir(`${testRoot}/tmp`);
    const made = await makeMutationTempDir(
      envOf({ TMPDIR: `${testRoot}/tmp`, WORK_DIR: `${testRoot}/work` }),
    );
    assert(made.startsWith(`${testRoot}/tmp/`), made);
    assertEquals(await pathExists(`${testRoot}/work/.mutation-scratch`), false);
    await Deno.remove(made, { recursive: true });
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});

Deno.test("makeMutationTempDir - falls back to a private work-volume root when TMPDIR refuses", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    const work = `${testRoot}/work`;
    const root = `${work}/.mutation-scratch`;
    const made = await makeMutationTempDir(
      envOf({ TMPDIR: `${testRoot}/missing`, WORK_DIR: work }),
    );
    assert(made.startsWith(`${root}/`), made);
    assert((await Deno.stat(made)).isDirectory);
    await Deno.writeTextFile(`${made}/probe.txt`, "writable");
    assertEquals(((await Deno.stat(root)).mode ?? 0) & 0o077, 0);
    await Deno.remove(made, { recursive: true });
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});

Deno.test("makeMutationTempDir - rejects naming both causes when neither is writable", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    await Deno.writeTextFile(
      `${testRoot}/file`,
      "a regular file, not a directory",
    );
    const work = `${testRoot}/file/work`;
    let message = "";
    try {
      await makeMutationTempDir(
        envOf({ TMPDIR: `${testRoot}/missing`, WORK_DIR: work }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertStringIncludes(message, "system temp directory:");
    assertStringIncludes(message, `${work}/.mutation-scratch`);
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

Deno.test("makeMutationTempDir - with no TMPDIR it uses Deno's default temp directory, not the work volume", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  const work = `${testRoot}/work`;
  let made = "";
  try {
    made = await makeMutationTempDir(envOf({ WORK_DIR: work }));
    assert(!made.startsWith(`${work}/.mutation-scratch/`), made);
    assert((await Deno.stat(made)).isDirectory);
    assertEquals(await pathExists(`${work}/.mutation-scratch`), false);
  } finally {
    if (made !== "") await Deno.remove(made, { recursive: true });
    await Deno.remove(testRoot, { recursive: true });
  }
});

Deno.test("makeMutationTempDir - with neither WORK_DIR nor HOME, a refused TMPDIR rejects naming the missing fallback", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    const message = await rejectionMessage(
      makeMutationTempDir(envOf({ TMPDIR: `${testRoot}/missing` })),
    );
    assert(message !== "", "expected a rejection");
    assertStringIncludes(message, "system temp directory:");
    assertStringIncludes(message, "no work-volume fallback");
    assertStringIncludes(message, "No such file or directory");
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});

Deno.test("makeMutationTempDir - a pre-existing group/other-writable scratch root is refused and nothing is created in it", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    const work = `${testRoot}/work`;
    const root = `${work}/.mutation-scratch`;
    await Deno.mkdir(root, { recursive: true });
    await Deno.chmod(root, 0o777);
    const message = await rejectionMessage(
      makeMutationTempDir(
        envOf({ TMPDIR: `${testRoot}/missing`, WORK_DIR: work }),
      ),
    );
    assert(message !== "", "expected a rejection");
    assertStringIncludes(message, root);
    assertStringIncludes(message, "group/other");
    const entries: string[] = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry.name);
    assertEquals(entries, []);
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});

Deno.test("makeMutationTempDir - a fallback root whose temp dir is refused rejects naming the root and the cause", async () => {
  const testRoot = await Deno.makeTempDir({ prefix: "vibe-mutation-test-" });
  try {
    const work = `${testRoot}/work`;
    const root = `${work}/.mutation-scratch`;
    const fallbackDirs: string[] = [];
    const message = await rejectionMessage(
      makeMutationTempDir(
        envOf({ TMPDIR: `${testRoot}/missing`, WORK_DIR: work }),
        (options) => {
          if (options.dir === root) {
            fallbackDirs.push(root);
            return Promise.reject(
              new Error("Permission denied (os error 13): tmpdir"),
            );
          }
          return Deno.makeTempDir(options);
        },
      ),
    );
    assert(message !== "", "expected a rejection");
    assertStringIncludes(message, "system temp directory:");
    assertStringIncludes(message, root);
    assertStringIncludes(message, "Permission denied");
    // Positive control: the fallback really was reached with the root.
    assertEquals(fallbackDirs, [root]);
  } finally {
    await Deno.remove(testRoot, { recursive: true });
  }
});
