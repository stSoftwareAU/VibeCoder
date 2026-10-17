/**
 * Tests for the security-fix discrimination runner (Issue #3659). The scenario
 * tests build a real temporary git repository; `git` runs for real while
 * `deno` is faked to read the production file out of the disposable checkout,
 * so a pass proves the base files were genuinely restored there. One
 * end-to-end test runs real `deno test`.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CitedSecurityTest,
  namedRustTestOutcome,
  namedTestOutcome,
  runSecurityFixDiscrimination,
  type SecurityFixDiscrimination,
} from "../lib/security_fix_discrimination.ts";
import {
  defaultMutationRunnerSeams,
  type MutationRunnerSeams,
  type ProcessResult,
} from "../lib/mutation_runner.ts";

const PASS_OUT = `running 1 test from ./a_test.ts
rejects injection attempt ... ok (228µs)

ok | 1 passed | 0 failed | 2 filtered out (3ms)
`;

const FAIL_OUT = `running 1 test from ./a_test.ts
fails here ... FAILED (510µs)

 ERRORS 

fails here => ./a_test.ts:2:6
error: Error: boom

 FAILURES 

fails here => ./a_test.ts:2:6

FAILED | 0 passed | 1 failed | 2 filtered out (3ms)
`;

Deno.test("namedTestOutcome: ok line is a pass", () => {
  assertEquals(namedTestOutcome(PASS_OUT, "rejects injection attempt"), "pass");
});

Deno.test("namedTestOutcome: FAILED line is a fail", () => {
  assertEquals(namedTestOutcome(FAIL_OUT, "fails here"), "fail");
});

Deno.test("namedTestOutcome: filter matching nothing is null, never a pass", () => {
  const out = "ok | 0 passed | 0 failed | 3 filtered out (2ms)\n";
  assertEquals(namedTestOutcome(out, "anything"), null);
});

Deno.test("namedTestOutcome: module-not-found run is null", () => {
  assertEquals(namedTestOutcome("", "anything"), null);
});

Deno.test("namedTestOutcome: an indented step line is not the test", () => {
  const out = "running 1 test\n  my test ... ok (1ms)\n";
  assertEquals(namedTestOutcome(out, "my test"), null);
});

Deno.test("namedTestOutcome: ANSI-coloured ok is still a pass", () => {
  const out =
    "my test ... \x1b[0m\x1b[32mok\x1b[0m \x1b[0m\x1b[90m(1ms)\x1b[0m\n";
  assertEquals(namedTestOutcome(out, "my test"), "pass");
});

Deno.test("namedTestOutcome: a name that prefixes another matches only exactly", () => {
  const out = "rejects injection attempt ... ok (1ms)\n";
  assertEquals(namedTestOutcome(out, "rejects"), null);
  const both = "rejects injection attempt ... FAILED (1ms)\nrejects ... ok\n";
  assertEquals(namedTestOutcome(both, "rejects"), "pass");
  assertEquals(namedTestOutcome(both, "rejects injection attempt"), "fail");
});

Deno.test("namedTestOutcome: ignored and regex characters in names", () => {
  assertEquals(namedTestOutcome("t ... ignored (1ms)\n", "t"), null);
  assertEquals(namedTestOutcome("a.c ... ok\n", "abc"), null);
  assertEquals(namedTestOutcome("a(b)+ ... ok\n", "a(b)+"), "pass");
});

const CARGO_PASS = `running 1 test
test rejects_oob_index ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out
`;

Deno.test("namedRustTestOutcome: ok and FAILED lines, bare or inside a mod", () => {
  assertEquals(namedRustTestOutcome(CARGO_PASS, "rejects_oob_index"), "pass");
  assertEquals(
    namedRustTestOutcome(
      "test checks::rejects_oob_index ... FAILED\n",
      "rejects_oob_index",
    ),
    "fail",
  );
});

Deno.test("namedRustTestOutcome: absent, ignored and look-alike names are null", () => {
  const none = "running 0 tests\n\ntest result: ok. 0 passed; 0 failed\n";
  assertEquals(namedRustTestOutcome(none, "rejects_oob_index"), null);
  assertEquals(
    namedRustTestOutcome(
      "test rejects_oob_index ... ignored\n",
      "rejects_oob_index",
    ),
    null,
  );
  assertEquals(
    namedRustTestOutcome(
      "test rejects_oob_index_more ... ok\n",
      "rejects_oob_index",
    ),
    null,
  );
  assertEquals(
    namedRustTestOutcome(
      "test xrejects_oob_index ... ok\n",
      "rejects_oob_index",
    ),
    null,
  );
});

Deno.test("namedRustTestOutcome: a failure beats a pass of a same-named test", () => {
  const out = "test a::t ... ok\ntest b::t ... FAILED\n";
  assertEquals(namedRustTestOutcome(out, "t"), "fail");
});

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

const TEST_NAME = "rejects injection attempt";
const CITED: CitedSecurityTest = {
  file: "tests/sanitise_test.ts",
  name: TEST_NAME,
};

async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function write(root: string, rel: string, text: string): Promise<void> {
  const path = `${root}/${rel}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function commit(root: string, msg: string): Promise<void> {
  await run("git", ["add", "-A"], root);
  await run("git", ["commit", "-q", "-m", msg], root);
}

/** A repo on branch `fix` cut from `main`; `baseFiles` and `branchFiles` are applied in turn. */
async function buildRepo(
  root: string,
  baseFiles: Record<string, string>,
  branchFiles: Record<string, string>,
): Promise<void> {
  await run("git", ["init", "-q", "-b", "main"], root);
  await run("git", ["config", "user.email", "t@example.com"], root);
  await run("git", ["config", "user.name", "T"], root);
  await write(root, "deno.json", "{}");
  for (const [f, t] of Object.entries(baseFiles)) await write(root, f, t);
  await commit(root, "base");
  await run("git", ["checkout", "-q", "-b", "fix"], root);
  for (const [f, t] of Object.entries(branchFiles)) await write(root, f, t);
  await commit(root, "branch");
}

interface Recorded {
  seams: MutationRunnerSeams;
  calls: Array<{ cmd: string; args: string[]; cwd: string; env?: unknown }>;
  tempDirs: string[];
}

type FakeDeno = (cwd: string) => Promise<ProcessResult>;
type FakeCargo = FakeDeno;

/**
 * The env the real runner filters, with the running deno's directory on PATH.
 * The runner spawns `deno` by name from an allowlisted env, so a CI runner
 * whose PATH lacks the toolchain directory otherwise fails to find it.
 */
function envWithDenoOnPath(): Record<string, string> {
  const env = Deno.env.toObject();
  const denoDir = Deno.execPath().replace(/\/[^/]*$/, "");
  return {
    ...env,
    PATH: [denoDir, env.PATH ?? ""].filter((p) => p !== "").join(":"),
  };
}

function recordingSeams(
  fakeDeno: FakeDeno | null,
  fakeCargo: FakeCargo | null = null,
): Recorded {
  const real = defaultMutationRunnerSeams(envWithDenoOnPath());
  const calls: Recorded["calls"] = [];
  const tempDirs: string[] = [];
  const seams: MutationRunnerSeams = {
    ...real,
    async runProcess(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      if (cmd === "deno" && fakeDeno !== null) return await fakeDeno(opts.cwd);
      if (cmd === "cargo" && fakeCargo !== null) {
        return await fakeCargo(opts.cwd);
      }
      return await real.runProcess(cmd, args, opts);
    },
    async makeTempDir() {
      const d = await real.makeTempDir();
      tempDirs.push(d);
      return d;
    },
  };
  return { seams, calls, tempDirs };
}

/** Fake deno: green iff the checkout's src/sanitise.ts carries the FIXED marker. */
const markerDeno: FakeDeno = async (cwd) => {
  const src = await Deno.readTextFile(`${cwd}/src/sanitise.ts`);
  return src.includes("FIXED")
    ? { code: 0, stdout: PASS_OUT, stderr: "", timedOut: false }
    : {
      code: 1,
      stdout: PASS_OUT.replace("... ok (228µs)", "... FAILED (228µs)"),
      stderr: "error: Test failed",
      timedOut: false,
    };
};

const TEST_SRC = `Deno.test("${TEST_NAME}", () => {});\n`;
const VULN = "export const clean = (s: string) => s; // vulnerable\n";
const FIXED = "export const clean = (s: string) => s.trim(); // FIXED\n";

async function withRepo(
  baseFiles: Record<string, string>,
  branchFiles: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "vibe-disc-test-" });
  try {
    await buildRepo(root, baseFiles, branchFiles);
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function input(root: string, extra: Record<string, unknown> = {}) {
  return {
    repoPath: root,
    baseRef: "main",
    productionFiles: ["src/sanitise.ts"],
    tests: [CITED],
    budgetSeconds: 60,
    ...extra,
  };
}

function reasonOf(r: SecurityFixDiscrimination): string {
  assertEquals(r.kind, "not_checked");
  return r.kind === "not_checked" ? r.reason : "";
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

Deno.test("discrimination: red at base, green at head is checked fail/pass", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    {
      "src/sanitise.ts": FIXED,
      "src/added.ts": "export const added = 1;\n",
      "tests/sanitise_test.ts": TEST_SRC,
    },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(
        input(root, {
          productionFiles: ["src/sanitise.ts", "src/added.ts"],
          credentialEnv: { SECRET_TOKEN: "abc" },
        }),
        rec.seams,
      );
      assertEquals(r, {
        kind: "checked",
        test: CITED,
        preFix: "fail",
        postFix: "pass",
      });
      // The issue checkout is untouched.
      assertEquals(await run("git", ["status", "--porcelain"], root), "");
      assertEquals(await Deno.readTextFile(`${root}/src/sanitise.ts`), FIXED);
      // The disposable checkout is gone.
      assertEquals(rec.tempDirs.length, 1);
      const tmp = rec.tempDirs[0] as string;
      assertEquals(
        await Deno.stat(tmp).then(() => true, () => false),
        false,
      );
      // Credentials reach deno only.
      const deno = rec.calls.filter((c) => c.cmd === "deno");
      const git = rec.calls.filter((c) => c.cmd === "git");
      assertEquals(deno.length, 2);
      for (const c of deno) assertEquals(c.env, { SECRET_TOKEN: "abc" });
      assert(git.length > 0);
      for (const c of git) assertEquals(c.env, undefined);
      assertEquals(deno[0]?.args, [
        "test",
        "--no-check",
        "-A",
        "--filter",
        TEST_NAME,
        "tests/sanitise_test.ts",
      ]);
    },
  );
});

Deno.test("discrimination: green at base and head is checked pass/pass", async () => {
  await withRepo(
    { "src/sanitise.ts": FIXED, "src/other.ts": "export const o = 1;\n" },
    {
      "src/other.ts": "export const o = 2;\n",
      "tests/sanitise_test.ts": TEST_SRC,
    },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(
        input(root, { productionFiles: ["src/other.ts"] }),
        rec.seams,
      );
      assertEquals(r, {
        kind: "checked",
        test: CITED,
        preFix: "pass",
        postFix: "pass",
      });
    },
  );
});

Deno.test("discrimination: red at head is checked fail/fail", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    {
      "src/sanitise.ts":
        "export const clean = (s: string) => s; // still bad\n",
      "tests/sanitise_test.ts": TEST_SRC,
    },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(input(root), rec.seams);
      assertEquals(r, {
        kind: "checked",
        test: CITED,
        preFix: "fail",
        postFix: "fail",
      });
    },
  );
});

Deno.test("discrimination: a run that cannot start is not_checked, never red", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    { "src/sanitise.ts": FIXED, "tests/sanitise_test.ts": TEST_SRC },
    async (root) => {
      const rec = recordingSeams(() =>
        Promise.resolve({
          code: 1,
          stdout: "",
          stderr:
            'error: Module not found "file:///tmp/x/missing.ts".\n    at file:///tmp/x/a_test.ts:1:8\n',
          timedOut: false,
        })
      );
      const r = await runSecurityFixDiscrimination(input(root), rec.seams);
      assertStringIncludes(reasonOf(r), "Module not found");
      assertStringIncludes(reasonOf(r), "head");
    },
  );
});

Deno.test("discrimination: a timed-out run is not_checked", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    { "src/sanitise.ts": FIXED, "tests/sanitise_test.ts": TEST_SRC },
    async (root) => {
      const rec = recordingSeams(() =>
        Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true })
      );
      const r = await runSecurityFixDiscrimination(input(root), rec.seams);
      assertStringIncludes(reasonOf(r), "timed out");
    },
  );
});

Deno.test("discrimination: a base run that reports nothing is not_checked", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    { "src/sanitise.ts": FIXED, "tests/sanitise_test.ts": TEST_SRC },
    async (root) => {
      const rec = recordingSeams(async (cwd) => {
        const src = await Deno.readTextFile(`${cwd}/src/sanitise.ts`);
        return src.includes("FIXED")
          ? { code: 0, stdout: PASS_OUT, stderr: "", timedOut: false }
          : { code: 1, stdout: "", stderr: "", timedOut: false };
      });
      const r = await runSecurityFixDiscrimination(input(root), rec.seams);
      assertStringIncludes(reasonOf(r), "base");
      assertStringIncludes(reasonOf(r), "was reported");
    },
  );
});

Deno.test("discrimination: a missing base ref is not_checked with git's cause", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    { "src/sanitise.ts": FIXED, "tests/sanitise_test.ts": TEST_SRC },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(
        input(root, { baseRef: "nosuchbranch" }),
        rec.seams,
      );
      const reason = reasonOf(r);
      assertStringIncludes(reason, "merge-base");
      assertStringIncludes(reason, "nosuchbranch");
    },
  );
});

Deno.test("discrimination: unusable base ref is rejected", async () => {
  const rec = recordingSeams(markerDeno);
  for (const baseRef of ["", "--output=/x"]) {
    const r = await runSecurityFixDiscrimination(
      { ...input("/nonexistent"), baseRef },
      rec.seams,
    );
    reasonOf(r);
  }
  assertEquals(rec.calls.length, 0);
});

Deno.test("discrimination: an unrunnable cited test names its language as the cause", async () => {
  const rec = recordingSeams(markerDeno);
  const py = await runSecurityFixDiscrimination(
    {
      ...input("/nonexistent"),
      tests: [{ file: "tests/test_db.py", name: "test_rejects" }],
    },
    rec.seams,
  );
  assertStringIncludes(reasonOf(py), "language of the cited test cannot be");
  assertStringIncludes(reasonOf(py), "tests/test_db.py");
  // A name-less Rust citation is not runnable either.
  const nameless = await runSecurityFixDiscrimination(
    { ...input("/nonexistent"), tests: [{ file: "tests/a.rs", name: " " }] },
    rec.seams,
  );
  assertStringIncludes(reasonOf(nameless), "language of the cited test");
  const none = await runSecurityFixDiscrimination(
    { ...input("/nonexistent"), tests: [] },
    rec.seams,
  );
  assertStringIncludes(reasonOf(none), "cites no test the worker can execute");
  assertEquals(rec.calls.length, 0);
});

Deno.test("discrimination: a zero budget is not_checked", async () => {
  await withRepo(
    { "src/sanitise.ts": VULN },
    { "src/sanitise.ts": FIXED, "tests/sanitise_test.ts": TEST_SRC },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(
        input(root, { budgetSeconds: 0 }),
        rec.seams,
      );
      assertStringIncludes(reasonOf(r), "budget of 0s");
      assertEquals(rec.calls.length, 0);
    },
  );
});

const BRANCH_FILES = {
  "src/sanitise.ts": FIXED,
  "tests/sanitise_test.ts": TEST_SRC,
};

Deno.test("discrimination: a repo with no Deno marker is not_checked", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    await run("git", ["rm", "-q", "deno.json"], root);
    await commit(root, "drop deno.json");
    const rec = recordingSeams(markerDeno);
    const r = await runSecurityFixDiscrimination(input(root), rec.seams);
    assertStringIncludes(
      reasonOf(r),
      "no deno.json, deno.jsonc or deno.lock above tests/sanitise_test.ts",
    );
    assertEquals(rec.calls.filter((c) => c.cmd === "deno").length, 0);
  });
});

Deno.test("discrimination: a timed-out git step is not_checked", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    const rec = recordingSeams(markerDeno);
    const wrapped: MutationRunnerSeams = {
      ...rec.seams,
      runProcess(cmd, args, opts) {
        if (cmd === "git" && args[0] === "clone") {
          return Promise.resolve({
            code: 0,
            stdout: "",
            stderr: "",
            timedOut: true,
          });
        }
        return rec.seams.runProcess(cmd, args, opts);
      },
    };
    const r = await runSecurityFixDiscrimination(input(root), wrapped);
    assertEquals(reasonOf(r), "git clone timed out");
  });
});

Deno.test("discrimination: no production files means no ls-tree and the base run is the head tree", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    const rec = recordingSeams(markerDeno);
    const r = await runSecurityFixDiscrimination(
      input(root, { productionFiles: [] }),
      rec.seams,
    );
    assertEquals(r, {
      kind: "checked",
      test: CITED,
      preFix: "pass",
      postFix: "pass",
    });
    assertEquals(
      rec.calls.filter((c) => c.cmd === "git" && c.args[0] === "ls-tree")
        .length,
      0,
    );
    assertEquals(rec.calls.filter((c) => c.cmd === "deno").length, 2);
  });
});

Deno.test("discrimination: only a branch-added production file means no base restore", async () => {
  await withRepo(
    { "src/sanitise.ts": FIXED },
    { ...BRANCH_FILES, "src/added.ts": "export const added = 1;\n" },
    async (root) => {
      const rec = recordingSeams(markerDeno);
      const r = await runSecurityFixDiscrimination(
        input(root, { productionFiles: ["src/added.ts"] }),
        rec.seams,
      );
      assertEquals(r.kind, "checked");
      const gitCalls = rec.calls.filter((c) => c.cmd === "git");
      assertEquals(gitCalls.filter((c) => c.args[0] === "ls-tree").length, 1);
      assertEquals(
        gitCalls.filter((c) =>
          c.args[0] === "checkout" && c.args.includes("--") &&
          !c.args.includes("--detach")
        ).length,
        0,
      );
    },
  );
});

Deno.test("discrimination: stderr without an error line reports its first line", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    const rec = recordingSeams(() =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "\n  Download failed somewhere\nsecond line\n",
        timedOut: false,
      })
    );
    const r = await runSecurityFixDiscrimination(input(root), rec.seams);
    assertStringIncludes(reasonOf(r), "Download failed somewhere");
    assert(!reasonOf(r).includes("was reported"));
  });
});

Deno.test("discrimination: empty stderr and no named line says no test was reported", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    const rec = recordingSeams(() =>
      Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false })
    );
    const r = await runSecurityFixDiscrimination(input(root), rec.seams);
    assertStringIncludes(
      reasonOf(r),
      `no test named "${TEST_NAME}" was reported`,
    );
  });
});

Deno.test("discrimination: an unexpected throw is wrapped as a runner failure", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, BRANCH_FILES, async (root) => {
    const rec = recordingSeams(markerDeno);
    const wrapped: MutationRunnerSeams = {
      ...rec.seams,
      makeTempDir: () => Promise.reject(new Error("disk full")),
    };
    const r = await runSecurityFixDiscrimination(input(root), wrapped);
    assertEquals(reasonOf(r), "discrimination runner failed: disk full");
  });
});

// ---------------------------------------------------------------------------
// End to end with real deno
// ---------------------------------------------------------------------------

Deno.test("discrimination: real deno run is checked fail/pass", async () => {
  await withRepo(
    { "src/mod.ts": "export const isSafe = (_s: string) => true;\n" },
    {
      "src/mod.ts": 'export const isSafe = (s: string) => !s.includes("..");\n',
      "tests/mod_test.ts": 'import { isSafe } from "../src/mod.ts";\n' +
        'Deno.test("rejects dot dot traversal", () => {\n' +
        '  if (isSafe("../x")) throw new Error("unsafe");\n' +
        "});\n",
    },
    async (root) => {
      const rec = recordingSeams(null);
      const test = {
        file: "tests/mod_test.ts",
        name: "rejects dot dot traversal",
      };
      const r = await runSecurityFixDiscrimination(
        input(root, { productionFiles: ["src/mod.ts"], tests: [test] }),
        rec.seams,
      );
      assertEquals(r, {
        kind: "checked",
        test,
        preFix: "fail",
        postFix: "pass",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Rust (PR #3921 review)
// ---------------------------------------------------------------------------

const RUST_CITED: CitedSecurityTest = {
  file: "crates/idx/tests/index_test.rs",
  name: "rejects_oob_index",
};
const RUST_VULN = "pub fn get(i: usize) -> usize { i } // vulnerable\n";
const RUST_FIXED = "pub fn get(i: usize) -> usize { i.min(3) } // FIXED\n";
const CARGO_TOML = '[package]\nname = "idx"\nversion = "0.1.0"\n';

/** Fake cargo: green iff the package's src/lib.rs carries the FIXED marker. */
const markerCargo: FakeCargo = async (cwd) => {
  const src = await Deno.readTextFile(`${cwd}/src/lib.rs`);
  return src.includes("FIXED")
    ? { code: 0, stdout: CARGO_PASS, stderr: "", timedOut: false }
    : {
      code: 101,
      stdout: CARGO_PASS.replace("... ok", "... FAILED"),
      stderr: "error: test failed",
      timedOut: false,
    };
};

async function withRustRepo(
  body: (root: string) => Promise<void>,
): Promise<void> {
  await withRepo(
    { "crates/idx/src/lib.rs": RUST_VULN },
    {
      "crates/idx/Cargo.toml": CARGO_TOML,
      "crates/idx/src/lib.rs": RUST_FIXED,
      "crates/idx/tests/index_test.rs": "#[test]\nfn rejects_oob_index() {}\n",
    },
    async (root) => {
      await run("git", ["rm", "-q", "deno.json"], root);
      await commit(root, "no deno marker");
      await body(root);
    },
  );
}

function rustInput(root: string, extra: Record<string, unknown> = {}) {
  return {
    ...input(root, extra),
    productionFiles: ["crates/idx/src/lib.rs"],
    tests: [RUST_CITED],
  };
}

Deno.test("discrimination: a cited Rust test runs under cargo, red at base and green at head", async () => {
  await withRustRepo(async (root) => {
    const rec = recordingSeams(null, markerCargo);
    const r = await runSecurityFixDiscrimination(
      rustInput(root, { credentialEnv: { SECRET_TOKEN: "abc" } }),
      rec.seams,
    );
    assertEquals(r, {
      kind: "checked",
      test: RUST_CITED,
      preFix: "fail",
      postFix: "pass",
    });
    const cargo = rec.calls.filter((c) => c.cmd === "cargo");
    assertEquals(cargo.length, 2);
    for (const c of cargo) {
      assertEquals(c.env, { SECRET_TOKEN: "abc" });
      assert(c.cwd.endsWith("/checkout/crates/idx"), c.cwd);
      assertEquals(c.args, [
        "test",
        "--no-fail-fast",
        "--test",
        "index_test",
        "rejects_oob_index",
      ]);
    }
    for (const c of rec.calls.filter((c) => c.cmd === "git")) {
      assertEquals(c.env, undefined);
    }
    assertEquals(rec.calls.filter((c) => c.cmd === "deno").length, 0);
  });
});

Deno.test("discrimination: a Rust test red at head is checked fail/fail", async () => {
  await withRustRepo(async (root) => {
    const rec = recordingSeams(
      null,
      () =>
        Promise.resolve({
          code: 101,
          stdout: CARGO_PASS.replace("... ok", "... FAILED"),
          stderr: "",
          timedOut: false,
        }),
    );
    const r = await runSecurityFixDiscrimination(rustInput(root), rec.seams);
    assertEquals(r, {
      kind: "checked",
      test: RUST_CITED,
      preFix: "fail",
      postFix: "fail",
    });
  });
});

Deno.test("discrimination: a Rust build failure is not_checked with rustc's cause", async () => {
  await withRustRepo(async (root) => {
    const rec = recordingSeams(
      null,
      () =>
        Promise.resolve({
          code: 101,
          stdout: "",
          stderr:
            "   Compiling idx v0.1.0\nerror[E0432]: unresolved import `crate::gone`\nerror: could not compile `idx`\n",
          timedOut: false,
        }),
    );
    const r = await runSecurityFixDiscrimination(rustInput(root), rec.seams);
    assertStringIncludes(reasonOf(r), "unresolved import `crate::gone`");
    assertStringIncludes(reasonOf(r), "head");
  });
});

Deno.test("discrimination: a Rust test with no package manifest above it is not_checked", async () => {
  await withRustRepo(async (root) => {
    await run("git", ["rm", "-q", "crates/idx/Cargo.toml"], root);
    await commit(root, "drop Cargo.toml");
    const rec = recordingSeams(null, markerCargo);
    const r = await runSecurityFixDiscrimination(rustInput(root), rec.seams);
    assertStringIncludes(
      reasonOf(r),
      "no Cargo.toml declaring a package above",
    );
    assertEquals(rec.calls.filter((c) => c.cmd === "cargo").length, 0);
  });
});

Deno.test("discrimination: a Rust citation that is not a function name is refused", async () => {
  const rec = recordingSeams(null, markerCargo);
  const r = await runSecurityFixDiscrimination(
    {
      ...input("/nonexistent"),
      tests: [{ file: "tests/a.rs", name: "--nocapture" }],
    },
    rec.seams,
  );
  assertStringIncludes(reasonOf(r), "is not a function name");
  assertEquals(rec.calls.length, 0);
});

Deno.test("discrimination: a Rust test outside tests/ runs as a package-wide filter, with no --test target", async () => {
  await withRustRepo(async (root) => {
    const rec = recordingSeams(null, markerCargo);
    const cited = {
      file: "crates/idx/src/checks.rs",
      name: "rejects_oob_index",
    };
    const r = await runSecurityFixDiscrimination(
      { ...rustInput(root), tests: [cited] },
      rec.seams,
    );
    assertEquals(r.kind, "checked");
    const cargo = rec.calls.filter((c) => c.cmd === "cargo");
    assertEquals(cargo.length, 2);
    for (const c of cargo) {
      assertEquals(c.args, ["test", "--no-fail-fast", "rejects_oob_index"]);
    }
  });
});

Deno.test("discrimination: a Rust test climbs past a directory with no manifest to the root package", async () => {
  await withRustRepo(async (root) => {
    await run("git", ["rm", "-q", "crates/idx/Cargo.toml"], root);
    await write(root, "Cargo.toml", CARGO_TOML);
    await write(root, "src/lib.rs", RUST_FIXED);
    await commit(root, "package at the root");
    const rec = recordingSeams(null, async (cwd) => {
      assertEquals(
        await Deno.stat(`${cwd}/Cargo.toml`).then(() => true, () => false),
        true,
      );
      return { code: 0, stdout: CARGO_PASS, stderr: "", timedOut: false };
    });
    const r = await runSecurityFixDiscrimination(
      { ...rustInput(root), productionFiles: [] },
      rec.seams,
    );
    assertEquals(r.kind, "checked");
    const cargo = rec.calls.filter((c) => c.cmd === "cargo");
    assertEquals(cargo.length, 2);
    for (const c of cargo) {
      assert(c.cwd.endsWith("/checkout"), c.cwd);
      assertEquals(c.args.slice(2), ["rejects_oob_index"]);
    }
  });
});

Deno.test("discrimination: a virtual workspace manifest is not a package to run in", async () => {
  await withRustRepo(async (root) => {
    await run("git", ["rm", "-q", "crates/idx/Cargo.toml"], root);
    await write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/idx"]\n');
    await commit(root, "virtual workspace only");
    const rec = recordingSeams(null, markerCargo);
    const r = await runSecurityFixDiscrimination(rustInput(root), rec.seams);
    assertStringIncludes(
      reasonOf(r),
      "no Cargo.toml declaring a package above",
    );
    assertEquals(rec.calls.filter((c) => c.cmd === "cargo").length, 0);
  });
});

// ---------------------------------------------------------------------------
// #[should_panic] tests (PR #3921 review)
// ---------------------------------------------------------------------------

Deno.test("namedRustTestOutcome: libtest's ' - should panic' line is the named test, bare or in a mod", () => {
  const out = (path: string, status: string) =>
    `running 1 test\ntest ${path} - should panic ... ${status}\n`;
  assertEquals(
    namedRustTestOutcome(out("rejects_x", "ok"), "rejects_x"),
    "pass",
  );
  assertEquals(
    namedRustTestOutcome(out("rejects_x", "FAILED"), "rejects_x"),
    "fail",
  );
  assertEquals(
    namedRustTestOutcome(out("checks::rejects_x", "ok"), "rejects_x"),
    "pass",
  );
  assertEquals(
    namedRustTestOutcome(out("checks::rejects_x", "FAILED"), "rejects_x"),
    "fail",
  );
});

Deno.test("namedRustTestOutcome: a should_panic line stays fail-closed for another name or an ignored test", () => {
  assertEquals(
    namedRustTestOutcome("test rejects_x - should panic ... ok\n", "rejects"),
    null,
  );
  assertEquals(
    namedRustTestOutcome(
      "test other::rejects_x_more - should panic ... ok\n",
      "rejects_x",
    ),
    null,
  );
  assertEquals(
    namedRustTestOutcome(
      "test rejects_x - should panic ... ignored\n",
      "rejects_x",
    ),
    null,
  );
});

Deno.test("discrimination: a cited #[should_panic] Rust test is checked fail/pass, not not_checked", async () => {
  await withRustRepo(async (root) => {
    const panicOut = (status: string) =>
      `running 1 test\ntest rejects_oob_index - should panic ... ${status}\n`;
    const rec = recordingSeams(null, async (cwd) => {
      const fixed = (await Deno.readTextFile(`${cwd}/src/lib.rs`)).includes(
        "FIXED",
      );
      return {
        code: fixed ? 0 : 101,
        stdout: panicOut(fixed ? "ok" : "FAILED"),
        stderr: "",
        timedOut: false,
      };
    });
    const r = await runSecurityFixDiscrimination(rustInput(root), rec.seams);
    assertEquals(r, {
      kind: "checked",
      test: RUST_CITED,
      preFix: "fail",
      postFix: "pass",
    });
  });
});

// ---------------------------------------------------------------------------
// Several cited tests (PR #3921 review)
// ---------------------------------------------------------------------------

const FIRST: CitedSecurityTest = {
  file: "tests/sanitise_test.ts",
  name: "first case",
};
const SECOND: CitedSecurityTest = {
  file: "tests/sanitise_test.ts",
  name: "second case",
};
const MULTI_FILES = {
  "src/sanitise.ts": FIXED,
  "tests/sanitise_test.ts":
    `Deno.test("first case", () => {});\nDeno.test("second case", () => {});\n`,
};

/** What a faked `deno test --filter <name>` reports at the base and the head. */
type Reported = "ok" | "FAILED" | "nothing";
type Plan = Record<string, { base: Reported; head: Reported }>;

/** Fake deno that answers per `--filter` name, by whether the FIXED marker is present. */
function planSeams(plan: Plan, filters: string[], tick = 0): Recorded & {
  clock: { elapsed: number };
} {
  const rec = recordingSeams(null);
  const clock = { elapsed: 0 };
  const seams: MutationRunnerSeams = {
    ...rec.seams,
    now: () => clock.elapsed,
    async runProcess(cmd, args, opts) {
      clock.elapsed += tick;
      if (cmd !== "deno") return await rec.seams.runProcess(cmd, args, opts);
      rec.calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const name = args[args.indexOf("--filter") + 1] as string;
      filters.push(name);
      const fixed = (await Deno.readTextFile(`${opts.cwd}/src/sanitise.ts`))
        .includes("FIXED");
      const reported = plan[name]?.[fixed ? "head" : "base"] ?? "nothing";
      return {
        code: reported === "FAILED" ? 1 : 0,
        stdout: reported === "nothing" ? "" : `${name} ... ${reported} (1ms)\n`,
        stderr: "",
        timedOut: false,
      };
    },
  };
  return { ...rec, seams, clock };
}

Deno.test("discrimination: of several cited tests, the red-to-green one decides and every run is recorded", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const filters: string[] = [];
    const rec = planSeams(
      {
        "first case": { base: "ok", head: "ok" },
        "second case": { base: "FAILED", head: "ok" },
      },
      filters,
    );
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [FIRST, SECOND] }),
      rec.seams,
    );
    assertEquals(r, {
      kind: "checked",
      test: SECOND,
      preFix: "fail",
      postFix: "pass",
      others: [{ test: FIRST, preFix: "pass", postFix: "pass" }],
    });
    // Both cited tests were executed, not only the first.
    assertEquals(filters, [
      "first case",
      "first case",
      "second case",
      "second case",
    ]);
  });
});

Deno.test("discrimination: when no cited test goes red to green, the first run decides and the rest are recorded", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const rec = planSeams(
      {
        "first case": { base: "ok", head: "ok" },
        "second case": { base: "ok", head: "FAILED" },
      },
      [],
    );
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [FIRST, SECOND] }),
      rec.seams,
    );
    assertEquals(r, {
      kind: "checked",
      test: FIRST,
      preFix: "pass",
      postFix: "pass",
      others: [{ test: SECOND, preFix: "pass", postFix: "fail" }],
    });
  });
});

Deno.test("discrimination: a cited test that could not be run makes an otherwise undiscriminating result not_checked", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const rec = planSeams(
      {
        "first case": { base: "nothing", head: "nothing" },
        "second case": { base: "ok", head: "ok" },
      },
      [],
    );
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [FIRST, SECOND] }),
      rec.seams,
    );
    const reason = reasonOf(r);
    assertStringIncludes(reason, "1 of 2 cited tests could not be run");
    assertStringIncludes(reason, "tests/sanitise_test.ts::first case");
    assertStringIncludes(reason, "did not run at the head");
    assertStringIncludes(reason, "second case base pass, head pass");
  });
});

Deno.test("discrimination: a red-to-green cited test decides even when another cited test could not be run", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const rec = planSeams(
      {
        "first case": { base: "nothing", head: "nothing" },
        "second case": { base: "FAILED", head: "ok" },
      },
      [],
    );
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [FIRST, SECOND] }),
      rec.seams,
    );
    assertEquals(r, {
      kind: "checked",
      test: SECOND,
      preFix: "fail",
      postFix: "pass",
      notRun: [{
        test: FIRST,
        reason:
          'the cited test did not run at the head: no test named "first case" was reported',
      }],
    });
  });
});

Deno.test("discrimination: the cited tests share one budget, so a later test starves rather than overrunning it", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const rec = planSeams(
      {
        "first case": { base: "ok", head: "ok" },
        "second case": { base: "FAILED", head: "ok" },
      },
      [],
      1000,
    );
    // One second per process; the first test spends 9 of the 10 seconds.
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [FIRST, SECOND], budgetSeconds: 10 }),
      rec.seams,
    );
    const reason = reasonOf(r);
    assertStringIncludes(reason, "1 of 2 cited tests could not be run");
    assertStringIncludes(reason, "budget of 10s ran out");
    assertStringIncludes(reason, "first case base pass, head pass");
  });
});

Deno.test("discrimination: an unsupported citation makes a green-green result not_checked", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const unsupported = {
      file: "tests/sanitise.bats",
      name: "rejects dot-dot traversal",
    };
    const rec = planSeams({ "first case": { base: "ok", head: "ok" } }, []);
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [unsupported, FIRST] }),
      rec.seams,
    );
    const reason = reasonOf(r);
    assertStringIncludes(
      reason,
      "tests/sanitise.bats::rejects dot-dot traversal",
    );
    assertStringIncludes(reason, "language");
    assertStringIncludes(reason, "only Deno and Rust");
    assertStringIncludes(reason, "first case base pass, head pass");
  });
});

Deno.test("discrimination: red-green records an unsupported citation without executing it as Deno", async () => {
  await withRepo({ "src/sanitise.ts": VULN }, MULTI_FILES, async (root) => {
    const unsupported = {
      file: "tests/sanitise_test.py",
      name: "test_rejects_traversal",
    };
    const filters: string[] = [];
    const rec = planSeams(
      { "first case": { base: "FAILED", head: "ok" } },
      filters,
    );
    const r = await runSecurityFixDiscrimination(
      input(root, { tests: [unsupported, FIRST] }),
      rec.seams,
    );
    assertEquals(filters, ["first case", "first case"]);
    assertEquals(r.kind, "checked");
    assertStringIncludes(JSON.stringify(r), '"notRun"');
    assertStringIncludes(JSON.stringify(r), unsupported.file);
    assertStringIncludes(JSON.stringify(r), unsupported.name);
    assertStringIncludes(JSON.stringify(r), "language");
  });
});
