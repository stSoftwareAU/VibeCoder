/**
 * Tests for the full-history secrets scan (Issue #4190).
 *
 * The behavioural tests build a throwaway git repository containing a planted
 * fake credential in an old commit on a **non-default branch** and another in
 * a commit reachable only by a **tag**, then run the real
 * `runFullHistoryScan` against it.
 *
 * The scanners themselves are not installed in CI, so the injected runner
 * emulates them — but it emulates them *through real git*, resolving the
 * `--log-opts` this module actually passes. A regression that narrowed the
 * sweep back to the checked-out branch (the pre-fix behaviour, where
 * `.github/workflows/gitleaks.yml` scanned a PR commit range only) would make
 * both planted secrets invisible and fail these tests.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createDefaultRegistry } from "../mod.ts";
import { secretsHistoryScanCommand } from "../commands/secrets_history_scan.ts";
import {
  buildGitleaksCommand,
  buildTrufflehogCommand,
  type CommandOutcome,
  type CommandRunner,
  evaluateFindings,
  type FullHistoryScanResult,
  parseBaseline,
  parseGitleaksReport,
  parseTrufflehogOutput,
  runFullHistoryScan,
  type ScanCommand,
  type SecretsBaseline,
} from "../lib/secrets_history_scan.ts";

// The planted credentials. Deliberately fake, but shaped like the real thing
// so a reader can see what the fixture represents.
const BRANCH_SECRET = "ghp_FAKEbranch0000000000000000000000000000";
const TAG_SECRET = "ghp_FAKEtag00000000000000000000000000000000";
const BENIGN_SECRET = "AKIAFAKEEXAMPLEDOCS0";

const BRANCH_FILE = "legacy/deploy.sh";
const TAG_FILE = "release/notes.txt";
const BENIGN_FILE = "docs/example.md";

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

/** Run a real git command in `cwd`, throwing loudly on failure. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  if (output.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return stdout;
}

/** Write a file (creating parents) inside the fixture repo. */
async function writeFile(
  repo: string,
  path: string,
  contents: string,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
  }
  await Deno.writeTextFile(`${repo}/${path}`, contents);
}

/**
 * Build the throwaway fixture repository:
 *
 *   - `main`      — clean tip, plus a documentation file carrying a benign
 *                   example key (the known false positive).
 *   - `legacy`    — a non-default branch whose old commit leaks a token.
 *   - `v0.1.0`    — a tag on a commit that no branch reaches, also leaking.
 */
async function makeFixtureRepo(): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "secrets-history-fixture-" });
  await git(repo, "init", "--initial-branch=main", ".");
  await writeFile(repo, "README.md", "# fixture\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial commit");

  // Non-default branch with a leaked token in an old commit.
  await git(repo, "checkout", "-b", "legacy");
  await writeFile(repo, BRANCH_FILE, `#!/bin/sh\nTOKEN=${BRANCH_SECRET}\n`);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "legacy deploy script");
  // A later commit on the same branch removes it from the tip — the secret
  // survives only in history.
  await Deno.remove(`${repo}/${BRANCH_FILE}`);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "drop legacy deploy script");

  // A tagged commit reachable from no branch at all.
  await git(repo, "checkout", "main");
  await git(repo, "checkout", "-b", "tmp-tag-branch");
  await writeFile(repo, TAG_FILE, `deploy key: ${TAG_SECRET}\n`);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "release notes");
  await git(repo, "tag", "v0.1.0");
  await git(repo, "checkout", "main");
  await git(repo, "branch", "-D", "tmp-tag-branch");

  // Benign documentation example on the default branch.
  await writeFile(
    repo,
    BENIGN_FILE,
    `Example only, not a real key: ${BENIGN_SECRET}\n`,
  );
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "docs example");

  return repo;
}

// ---------------------------------------------------------------------------
// Scanner emulation — real git, driven by the flags the module passes
// ---------------------------------------------------------------------------

interface PlantedSecret {
  value: string;
  path: string;
  rule: string;
  detector: string;
}

const PLANTED: PlantedSecret[] = [
  {
    value: BRANCH_SECRET,
    path: BRANCH_FILE,
    rule: "github-pat",
    detector: "Github",
  },
  {
    value: TAG_SECRET,
    path: TAG_FILE,
    rule: "github-pat",
    detector: "Github",
  },
  {
    value: BENIGN_SECRET,
    path: BENIGN_FILE,
    rule: "aws-access-token",
    detector: "AWS",
  },
];

/** A hit located by walking the commits the scan actually put in scope. */
interface Hit {
  commit: string;
  planted: PlantedSecret;
  line: number;
}

/**
 * Locate every planted secret in the commits reachable under `logOpts`.
 *
 * This is the crux of the test: `logOpts` is whatever the module passed to
 * gitleaks via `--log-opts`, resolved by real git. Narrow the scope and the
 * planted secrets stop being found.
 */
async function findHits(repo: string, logOpts: string[]): Promise<Hit[]> {
  const commits = (await git(repo, "log", ...logOpts, "--format=%H"))
    .split("\n").map((c) => c.trim()).filter((c) => c !== "");
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const commit of commits) {
    const tree = await git(repo, "ls-tree", "-r", "--name-only", commit);
    for (const path of tree.split("\n").map((p) => p.trim())) {
      const planted = PLANTED.find((p) => p.path === path);
      if (!planted) continue;
      const blob = await git(repo, "show", `${commit}:${path}`);
      if (!blob.includes(planted.value)) continue;
      const key = `${commit}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = blob.split("\n").findIndex((l) => l.includes(planted.value));
      hits.push({ commit, planted, line: line + 1 });
    }
  }
  return hits;
}

/** Extract the value of a `--flag value` or `--flag=value` argument. */
function argValue(args: string[], flag: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Runner that executes real git, and emulates gitleaks/trufflehog by
 * resolving the module's own scope flags through git.
 */
function emulatingRunner(repo: string): CommandRunner {
  return async (cmd: ScanCommand, cwd: string): Promise<CommandOutcome> => {
    if (cmd.bin === "git") {
      const stdout = await git(cwd, ...cmd.args);
      return { code: 0, stdout, stderr: "" };
    }
    if (cmd.bin === "gitleaks") {
      const logOpts = argValue(cmd.args, "--log-opts") ?? "";
      const reportPath = argValue(cmd.args, "--report-path");
      assert(reportPath, "gitleaks must be given a --report-path");
      const hits = await findHits(repo, logOpts.split(" ").filter(Boolean));
      const report = hits.map((h) => ({
        Description: "Planted fixture credential",
        StartLine: h.line,
        // A real gitleaks report carries the secret; the parser must drop it.
        Match: `TOKEN=${h.planted.value}`,
        Secret: h.planted.value,
        File: h.planted.path,
        Commit: h.commit,
        RuleID: h.planted.rule,
      }));
      await Deno.writeTextFile(reportPath, JSON.stringify(report));
      return { code: hits.length > 0 ? 1 : 0, stdout: "", stderr: "" };
    }
    if (cmd.bin === "trufflehog") {
      // trufflehog's git source walks every ref of the local clone.
      const hits = await findHits(repo, ["--all"]);
      const lines = hits.map((h) =>
        JSON.stringify({
          SourceMetadata: {
            Data: {
              Git: {
                commit: h.commit,
                file: h.planted.path,
                line: h.line,
              },
            },
          },
          DetectorName: h.planted.detector,
          Verified: false,
          Raw: h.planted.value,
        })
      );
      const stdout = ["scanning...", ...lines].join("\n");
      return { code: 0, stdout, stderr: "" };
    }
    throw new Error(`unexpected command: ${cmd.bin}`);
  };
}

/** Write a baseline file and return its path. */
async function writeBaseline(
  dir: string,
  baseline: Record<string, unknown>,
): Promise<string> {
  const path = `${dir}/baseline.json`;
  await Deno.writeTextFile(path, JSON.stringify(baseline, null, 2));
  return path;
}

/** Run the real scan against the fixture with the emulating runner. */
async function scan(
  repo: string,
  baseline: Record<string, unknown>,
): Promise<FullHistoryScanResult> {
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-work-" });
  const baselinePath = await writeBaseline(workDir, baseline);
  try {
    return await runFullHistoryScan({
      repoDir: repo,
      baselinePath,
      reportPath: `${workDir}/report.md`,
      gitleaksReportPath: `${workDir}/gitleaks.json`,
      runner: emulatingRunner(repo),
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
  } finally {
    // Leave the report on disk only for the duration of the assertion.
  }
}

/**
 * Baseline entries for the benign documentation example.
 *
 * Each scanner names the same match differently (`aws-access-token` vs
 * `AWS`), and keying by rule keeps them as separate rows — so suppressing the
 * false positive means baselining every row at that location.
 */
function benignEntries(
  result: FullHistoryScanResult,
): Array<Record<string, unknown>> {
  return rowsFor(result, BENIGN_FILE).map((row) => ({
    commit: row.commit,
    path: row.path,
    rule: row.rule,
    reason: "Documentation example key, never issued — see docs/example.md.",
  }));
}

/** Every row for a given path. */
function rowsFor(result: FullHistoryScanResult, path: string) {
  return result.findings.filter((f) => f.path === path);
}

/** Every scanner that reported a location, across its per-rule rows. */
function scannersFor(result: FullHistoryScanResult, path: string): string[] {
  return [...new Set(rowsFor(result, path).flatMap((f) => f.scanners))].sort();
}

// ---------------------------------------------------------------------------
// Full-history coverage
// ---------------------------------------------------------------------------

Deno.test("full-history scan finds planted secrets on a non-default branch and on a tag", async () => {
  const repo = await makeFixtureRepo();
  try {
    const result = await scan(repo, { falsePositives: [], confirmed: [] });

    assert(
      rowsFor(result, BRANCH_FILE).length > 0,
      "no finding for the non-default-branch secret",
    );
    assert(
      rowsFor(result, TAG_FILE).length > 0,
      "no finding for the tag-only secret",
    );

    // Both scanners reached both locations.
    assertEquals(scannersFor(result, BRANCH_FILE), [
      "gitleaks",
      "trufflehog",
    ]);
    assertEquals(scannersFor(result, TAG_FILE), ["gitleaks", "trufflehog"]);

    // Nothing is baselined, so the run fails.
    assertEquals(result.ok, false);
    assert(result.unbaselined.length >= 2);

    // Tags and branches are both counted in the ref summary.
    assert(result.refs.some((r) => r.kind === "tag"));
    assert(result.refs.some((r) => r.kind === "branch"));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("report records the location and rule but never the secret value", async () => {
  const repo = await makeFixtureRepo();
  try {
    const result = await scan(repo, { falsePositives: [], confirmed: [] });
    assertStringIncludes(result.report, BRANCH_FILE);
    assertStringIncludes(result.report, TAG_FILE);
    assertStringIncludes(result.report, "github-pat");
    assertEquals(result.report.includes(BRANCH_SECRET), false);
    assertEquals(result.report.includes(TAG_SECRET), false);
    assertEquals(result.report.includes(BENIGN_SECRET), false);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("report names the repository without the operator's absolute path", async () => {
  const repo = await makeFixtureRepo();
  try {
    const result = await scan(repo, { falsePositives: [], confirmed: [] });
    // The report is committed, so an operator checkout path must not leak
    // into it (the export scrub strips exactly this class of detail).
    assertEquals(result.report.includes(repo), false);
    assertStringIncludes(result.report, "**Repository**");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("baseline suppresses a known false positive but not the real leaks", async () => {
  const repo = await makeFixtureRepo();
  try {
    const first = await scan(repo, { falsePositives: [], confirmed: [] });
    const benignRows = rowsFor(first, BENIGN_FILE);
    assert(
      benignRows.length > 0,
      "fixture should surface the benign documentation key",
    );

    const result = await scan(repo, {
      falsePositives: benignEntries(first),
      confirmed: [],
    });
    for (const row of rowsFor(result, BENIGN_FILE)) {
      assertEquals(row.status, "false-positive");
    }
    assertEquals(
      result.unbaselined.some((f) => f.path === BENIGN_FILE),
      false,
    );
    // The genuine leaks are still unbaselined, so the run still fails.
    assertEquals(result.ok, false);
    assert(result.unbaselined.length > 0);
    assertEquals(
      new Set(result.unbaselined.map((f) => f.path)),
      new Set([BRANCH_FILE, TAG_FILE]),
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("an unrotated confirmed finding fails the run", async () => {
  const repo = await makeFixtureRepo();
  try {
    const first = await scan(repo, { falsePositives: [], confirmed: [] });

    const confirmed = first.unbaselined
      .filter((f) => f.path !== BENIGN_FILE)
      .map((f, index) => ({
        commit: f.commit,
        path: f.path,
        rule: f.rule,
        reason: "Real GitHub token leaked into the private history.",
        credentialClass: "github-pat",
        usedIn: "legacy deploy automation",
        // Every leak but the first has been rotated; the first blocks.
        rotated: index !== 0,
        rotatedOn: index !== 0 ? "2026-08-01" : null,
      }));
    assert(confirmed.length > 1);

    const result = await scan(repo, {
      falsePositives: benignEntries(first),
      confirmed,
    });

    assertEquals(result.unbaselined.length, 0);
    assertEquals(result.unrotated.length, 1);
    assertEquals(result.ok, false, "unrotated confirmed finding must fail");
    assertStringIncludes(result.report, "NOT ROTATED");
    assertStringIncludes(result.summary, "unrotated");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("scan passes once every finding is baselined and every leak rotated", async () => {
  const repo = await makeFixtureRepo();
  try {
    const first = await scan(repo, { falsePositives: [], confirmed: [] });

    const confirmed = first.unbaselined
      .filter((f) => f.path !== BENIGN_FILE)
      .map((f) => ({
        commit: f.commit,
        path: f.path,
        rule: f.rule,
        reason: "Real GitHub token leaked into the private history.",
        credentialClass: "github-pat",
        usedIn: "legacy deploy automation",
        rotated: true,
        rotatedOn: "2026-08-01",
      }));

    const result = await scan(repo, {
      falsePositives: benignEntries(first),
      confirmed,
    });

    assertEquals(result.baselineErrors, []);
    assertEquals(result.unbaselined, []);
    assertEquals(result.unrotated, []);
    assertEquals(result.ok, true);
    assertStringIncludes(result.report, "✅ rotated");
    assertStringIncludes(result.summary, "clean");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("scan writes the report to disk at the requested path", async () => {
  const repo = await makeFixtureRepo();
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-out-" });
  try {
    const baselinePath = await writeBaseline(workDir, {
      falsePositives: [],
      confirmed: [],
    });
    const reportPath = `${workDir}/nested/report.md`;
    const result = await runFullHistoryScan({
      repoDir: repo,
      baselinePath,
      reportPath,
      gitleaksReportPath: `${workDir}/gitleaks.json`,
      runner: emulatingRunner(repo),
      now: new Date("2026-08-18T00:00:00.000Z"),
    });
    const written = await Deno.readTextFile(reportPath);
    assertEquals(written, result.report);
    assertStringIncludes(written, "## Rotation log");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-loud behaviour
// ---------------------------------------------------------------------------

Deno.test("a missing scanner binary fails loud rather than reporting a clean sweep", async () => {
  const repo = await makeFixtureRepo();
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-fail-" });
  try {
    const baselinePath = await writeBaseline(workDir, {
      falsePositives: [],
      confirmed: [],
    });
    const runner: CommandRunner = async (cmd, cwd) => {
      if (cmd.bin === "git") {
        return { code: 0, stdout: await git(cwd, ...cmd.args), stderr: "" };
      }
      throw new Error(`failed to run "${cmd.bin}": No such file or directory`);
    };
    let message = "";
    try {
      await runFullHistoryScan({
        repoDir: repo,
        baselinePath,
        reportPath: `${workDir}/report.md`,
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "gitleaks");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("an unexpected gitleaks exit code fails loud", async () => {
  const repo = await makeFixtureRepo();
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-exit-" });
  try {
    const baselinePath = await writeBaseline(workDir, {
      falsePositives: [],
      confirmed: [],
    });
    const runner: CommandRunner = async (cmd, cwd) => {
      if (cmd.bin === "git") {
        return { code: 0, stdout: await git(cwd, ...cmd.args), stderr: "" };
      }
      return { code: 2, stdout: "", stderr: "config parse error" };
    };
    let message = "";
    try {
      await runFullHistoryScan({
        repoDir: repo,
        baselinePath,
        reportPath: `${workDir}/report.md`,
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "config parse error");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("a missing baseline file fails loud instead of suppressing nothing", async () => {
  const repo = await makeFixtureRepo();
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-nobl-" });
  try {
    let message = "";
    try {
      await runFullHistoryScan({
        repoDir: repo,
        baselinePath: `${workDir}/absent.json`,
        reportPath: `${workDir}/report.md`,
        runner: emulatingRunner(repo),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "cannot read baseline");
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Scanner invocation scope
// ---------------------------------------------------------------------------

Deno.test("gitleaks is invoked over all refs with redaction", () => {
  const cmd = buildGitleaksCommand("/repo", "/tmp/report.json", "/cfg.toml");
  assertEquals(cmd.bin, "gitleaks");
  assert(cmd.args.includes("--log-opts=--all"));
  assert(cmd.args.includes("--redact"));
  assert(cmd.args.includes("--config"));
  assert(cmd.args.includes("/cfg.toml"));
});

Deno.test("trufflehog is invoked over the local clone with JSON output", () => {
  const cmd = buildTrufflehogCommand("/repo");
  assertEquals(cmd.bin, "trufflehog");
  assert(cmd.args.includes("git"));
  assert(cmd.args.includes("file:///repo"));
  assert(cmd.args.includes("--json"));
  // No --branch filter — narrowing it would drop refs from the sweep.
  assertEquals(cmd.args.includes("--branch"), false);
});

// ---------------------------------------------------------------------------
// Parsers — location only, never the secret
// ---------------------------------------------------------------------------

Deno.test("parseGitleaksReport keeps the location and drops the secret", () => {
  const findings = parseGitleaksReport(JSON.stringify([{
    Commit: "abc123",
    File: "src/app.ts",
    RuleID: "generic-api-key",
    StartLine: 12,
    Secret: "super-secret-value",
    Match: "key = super-secret-value",
  }]));
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.commit, "abc123");
  assertEquals(findings[0]?.path, "src/app.ts");
  assertEquals(findings[0]?.rule, "generic-api-key");
  assertEquals(findings[0]?.line, 12);
  assertEquals(
    JSON.stringify(findings).includes("super-secret-value"),
    false,
  );
});

Deno.test("parseGitleaksReport handles an empty report and rejects malformed JSON", () => {
  assertEquals(parseGitleaksReport(""), []);
  assertEquals(parseGitleaksReport("[]"), []);
  let threw = false;
  try {
    parseGitleaksReport("{not json");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseTrufflehogOutput keeps the location and drops the raw value", () => {
  const stdout = [
    "2026-08-18 loading detectors",
    JSON.stringify({
      SourceMetadata: {
        Data: { Git: { commit: "def456", file: "cfg/prod.env", line: 3 } },
      },
      DetectorName: "AWS",
      Raw: "AKIAREALLOOKINGVALUE",
      RawV2: "AKIAREALLOOKINGVALUE:secret",
    }),
  ].join("\n");
  const findings = parseTrufflehogOutput(stdout);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.commit, "def456");
  assertEquals(findings[0]?.path, "cfg/prod.env");
  assertEquals(findings[0]?.rule, "AWS");
  assertEquals(
    JSON.stringify(findings).includes("AKIAREALLOOKINGVALUE"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Baseline validation
// ---------------------------------------------------------------------------

Deno.test("baseline entries require an explanatory reason", () => {
  const { errors } = parseBaseline(JSON.stringify({
    falsePositives: [{
      commit: "abc",
      path: "docs/x.md",
      rule: "aws-access-token",
      reason: "test",
    }],
    confirmed: [],
  }));
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0] ?? "", "reason");
});

Deno.test("confirmed entries require a credential class, usage and rotation state", () => {
  const { errors } = parseBaseline(JSON.stringify({
    falsePositives: [],
    confirmed: [{
      commit: "abc",
      path: "legacy/deploy.sh",
      rule: "github-pat",
      reason: "Leaked GitHub token in the private history.",
    }],
  }));
  assertStringIncludes(errors.join("\n"), "credentialClass");
  assertStringIncludes(errors.join("\n"), "usedIn");
  assertStringIncludes(errors.join("\n"), "rotated");
});

Deno.test("a rotated entry must carry an ISO rotation date", () => {
  const { errors } = parseBaseline(JSON.stringify({
    falsePositives: [],
    confirmed: [{
      commit: "abc",
      path: "legacy/deploy.sh",
      rule: "github-pat",
      reason: "Leaked GitHub token in the private history.",
      credentialClass: "github-pat",
      usedIn: "deploy automation",
      rotated: true,
      rotatedOn: "last Tuesday",
    }],
  }));
  assertStringIncludes(errors.join("\n"), "rotatedOn");
});

Deno.test("duplicate baseline entries are rejected", () => {
  const entry = {
    commit: "abc",
    path: "docs/x.md",
    rule: "aws-access-token",
    reason: "Documentation example key, never issued.",
  };
  const { errors } = parseBaseline(JSON.stringify({
    falsePositives: [entry, { ...entry }],
    confirmed: [],
  }));
  assertStringIncludes(errors.join("\n"), "duplicate");
});

Deno.test("a malformed baseline is an error, not an empty allowlist", () => {
  const { errors } = parseBaseline("[1, 2, 3]");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0] ?? "", "JSON object");
});

Deno.test("the repository baseline file parses cleanly", async () => {
  const text = await Deno.readTextFile(
    new URL(
      "../../../docs/audits/secrets-history-baseline.json",
      import.meta.url,
    ),
  );
  const { errors } = parseBaseline(text);
  assertEquals(errors, []);
});

// ---------------------------------------------------------------------------
// evaluateFindings unit cases
// ---------------------------------------------------------------------------

Deno.test("evaluateFindings flags stale baseline entries that match nothing", () => {
  const baseline: SecretsBaseline = {
    falsePositives: [{
      commit: "gone",
      path: "old/file.txt",
      rule: "github-pat",
      reason: "Removed by a history rewrite upstream, kept for the record.",
    }],
    confirmed: [],
  };
  const { staleBaselineKeys, rows } = evaluateFindings([], baseline);
  assertEquals(rows, []);
  assertEquals(staleBaselineKeys, ["gone|old/file.txt|github-pat"]);
});

Deno.test("evaluateFindings blocks on a confirmed leak even after it stops being detected", () => {
  const baseline: SecretsBaseline = {
    falsePositives: [],
    confirmed: [{
      commit: "abc",
      path: "legacy/deploy.sh",
      rule: "github-pat",
      reason: "Leaked GitHub token in the private history.",
      credentialClass: "github-pat",
      usedIn: "deploy automation",
      rotated: false,
      rotatedOn: null,
    }],
  };
  const { unrotated } = evaluateFindings([], baseline);
  assertEquals(unrotated.length, 1);
});

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

Deno.test("secrets-history-scan command is registered in the default registry", () => {
  const registry = createDefaultRegistry();
  assertEquals(registry.has("secrets-history-scan"), true);
});

Deno.test("secrets-history-scan reports a failed scan rather than throwing", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "secrets-history-cmd-" });
  try {
    // No git repository and no baseline here — the command must fail loudly
    // with a message, not report success.
    const result = await secretsHistoryScanCommand.execute(
      { repo: workDir },
      // deno-lint-ignore no-explicit-any
      {} as any,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "could not run");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
