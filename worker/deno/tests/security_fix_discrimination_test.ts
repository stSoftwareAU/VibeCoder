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

function recordingSeams(fakeDeno: FakeDeno | null): Recorded {
  const real = defaultMutationRunnerSeams();
  const calls: Recorded["calls"] = [];
  const tempDirs: string[] = [];
  const seams: MutationRunnerSeams = {
    ...real,
    async runProcess(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      if (cmd === "deno" && fakeDeno !== null) return await fakeDeno(opts.cwd);
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

Deno.test("discrimination: no Deno test cited is not_checked", async () => {
  const rec = recordingSeams(markerDeno);
  const rust = await runSecurityFixDiscrimination(
    { ...input("/nonexistent"), tests: [{ file: "src/foo.rs", name: "x" }] },
    rec.seams,
  );
  assertStringIncludes(reasonOf(rust), "only Deno tests");
  assertStringIncludes(reasonOf(rust), "src/foo.rs");
  const none = await runSecurityFixDiscrimination(
    { ...input("/nonexistent"), tests: [] },
    rec.seams,
  );
  assertStringIncludes(reasonOf(none), "cites no string-named test");
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
