import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  prCompletionReportCommand,
  runPrCompletionCollect,
} from "../commands/pr_completion_report.ts";
import {
  ACTOR_ID_PATTERN,
  buildPrCompletionReport,
} from "../lib/pr_completion_report.ts";
import type { GhJson } from "../lib/pr_completion_snapshot.ts";
import type { WorkerConfig } from "../types.ts";

Deno.test("pr-completion-report reads a snapshot and returns dated metrics", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const inputPath = `${dir}/snapshot.json`;
    await Deno.writeTextFile(
      inputPath,
      JSON.stringify({
        cohort: {
          start: "2026-10-01T00:00:00Z",
          end: "2026-11-01T00:00:00Z",
          observedAt: "2026-11-02T00:00:00Z",
        },
        prs: [],
        actions: [],
        blockers: [],
        ciRuns: [],
        regressions: [],
        deployments: [],
        expectedDeployment: {
          components: ["worker"],
          revision: "abc",
          policyFingerprint: "a".repeat(64),
          maxHeartbeatAgeHours: 2,
        },
      }),
    );
    const result = await prCompletionReportCommand.execute(
      { input: inputPath },
      {} as WorkerConfig,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, '"unattendedWithin24Hours": null');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report fails loudly for a missing input path", async () => {
  const result = await prCompletionReportCommand.execute(
    { input: "/missing" },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "pr-completion-report failed:");
  assert(result.exitCode === undefined);
});

Deno.test("pr-completion-report needs exactly one of --input or --collect, naming both", async () => {
  const neither = await prCompletionReportCommand.execute(
    {},
    {} as WorkerConfig,
  );
  assertEquals(neither.success, false);
  assertStringIncludes(neither.message, "--input");
  assertStringIncludes(neither.message, "--collect");

  const both = await prCompletionReportCommand.execute(
    { input: "/missing", collect: true },
    {} as WorkerConfig,
  );
  assertEquals(both.success, false);
  assertStringIncludes(both.message, "--input");
  assertStringIncludes(both.message, "--collect");
});

Deno.test("pr-completion-report --collect fails loudly without a repository list", async () => {
  const result = await prCompletionReportCommand.execute(
    { collect: true },
    {} as WorkerConfig,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--repos");
});

Deno.test("pr-completion-report --collect treats an empty config repo list as no repository list, and uses a non-empty one", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  const empty = await runPrCompletionCollect(
    { collect: true },
    { repos: [] } as unknown as WorkerConfig,
    gh,
    () => "abcdef0123456789",
  );
  assertEquals(empty.success, false);
  assertStringIncludes(empty.message, "--repos");
  // With a configured repo the repository list is accepted, so the run moves
  // on to the revision check instead.
  const configured = await runPrCompletionCollect(
    { collect: true },
    { repos: ["org/repo"] } as unknown as WorkerConfig,
    gh,
    () => undefined,
  );
  assertStringIncludes(configured.message, "--expected-revision");
});

Deno.test("pr-completion-report --collect fails loudly without an expected revision", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  const result = await runPrCompletionCollect(
    { collect: true, repos: "org/repo" },
    {} as WorkerConfig,
    gh,
    () => undefined,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--expected-revision");
});

Deno.test("pr-completion-report --collect rejects a --max-prs-per-repo that is not a positive integer", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  for (const value of ["0", "-1", "two", "1.5", true]) {
    const result = await runPrCompletionCollect(
      {
        collect: true,
        repos: "org/repo",
        "expected-revision": "rev1",
        "max-prs-per-repo": value,
      },
      {} as WorkerConfig,
      gh,
      () => undefined,
    );
    assertEquals(result.success, false, `value ${String(value)}`);
    assertStringIncludes(
      result.message,
      "--max-prs-per-repo must be a positive integer",
    );
  }
});

Deno.test("pr-completion-report --collect passes --max-prs-per-repo to the collector and reports the truncation", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const open = (number: number) => ({
      number,
      state: "open",
      created_at: "2026-10-20T00:00:00Z",
      merged_at: null,
      closed_at: null,
      title: `Change ${number}`,
      body: "",
      labels: [],
      base: { ref: "main" },
      head: { ref: `issue-${number}`, sha: `sha${number}` },
    });
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) {
        return path.includes("page=1") ? [open(1), open(2)] : [];
      }
      if (
        path.startsWith("repos/org/repo/commits/") &&
        path.includes("/check-runs")
      ) {
        return { total_count: 0, check_runs: [] };
      }
      if (path.startsWith("repos/org/repo/pulls/")) return [];
      if (path.startsWith("repos/org/repo/issues/")) return [];
      throw new Error(`unrouted gh path: ${path}`);
    };
    const result = await runPrCompletionCollect(
      {
        collect: true,
        "audit-dir": auditDir,
        repos: "org/repo",
        "expected-revision": "rev1",
        start: "2026-10-01T00:00:00Z",
        end: "2026-11-01T00:00:00Z",
        "max-prs-per-repo": "1",
      },
      { repos: ["org/repo"] } as unknown as WorkerConfig,
      gh,
    );
    assertEquals(result.success, true);
    assertEquals(result.data?.truncatedRepos, ["org/repo"]);
    assertEquals(result.data?.report.coverage.truncatedRepos, ["org/repo"]);
    assertStringIncludes(result.message, "TRUNCATED: org/repo");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --collect writes a snapshot that --input reproduces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const target = `${dir}/snapshot.json`;
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) return [];
      throw new Error(`unrouted gh path: ${path}`);
    };
    const config = { repos: ["org/repo"] } as unknown as WorkerConfig;
    const result = await runPrCompletionCollect(
      {
        collect: true,
        "audit-dir": auditDir,
        "expected-revision": "rev1",
        start: "2026-10-01T00:00:00Z",
        end: "2026-11-01T00:00:00Z",
        "write-snapshot": target,
      },
      config,
      gh,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "coverage: audit dir");
    assertStringIncludes(result.message, '"prCount": 0');
    assertEquals(result.data?.truncatedRepos, []);

    const reread = await prCompletionReportCommand.execute(
      { input: target },
      {} as WorkerConfig,
    );
    assertEquals(reread.success, true);
    assertStringIncludes(reread.message, '"prCount": 0');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --collect rejects a --review-log that names no file", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  for (const value of [true, ",", " , "]) {
    const result = await runPrCompletionCollect(
      {
        collect: true,
        repos: "org/repo",
        "expected-revision": "rev1",
        "review-log": value,
      },
      {} as WorkerConfig,
      gh,
      () => undefined,
    );
    assertEquals(result.success, false, `value ${String(value)}`);
    assertStringIncludes(
      result.message,
      "--review-log <log.jsonl,...> must name at least one file",
    );
  }
});

Deno.test("pr-completion-report --collect notes a --review-log it cannot read, and notes the missing review-log source when none is given", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const missing = `${dir}/logs/absent.jsonl`;
    const open = {
      number: 1,
      state: "open",
      created_at: "2026-10-20T00:00:00Z",
      merged_at: null,
      closed_at: null,
      title: "Change 1",
      body: "",
      labels: [],
      base: { ref: "main" },
      head: { ref: "issue-1", sha: "sha1" },
    };
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) {
        return path.includes("page=1") ? [open] : [];
      }
      if (path.startsWith("repos/org/repo/pulls/1/reviews")) {
        return [{
          id: 601,
          state: "APPROVED",
          submitted_at: "2026-10-20T01:00:00Z",
          user: { id: 9001, login: "review-bot[bot]" },
        }];
      }
      if (
        path.startsWith("repos/org/repo/commits/") &&
        path.includes("/check-runs")
      ) {
        return { total_count: 0, check_runs: [] };
      }
      if (path.startsWith("repos/org/repo/pulls/")) return [];
      if (path.startsWith("repos/org/repo/issues/")) return [];
      throw new Error(`unrouted gh path: ${path}`);
    };
    const args = {
      collect: true,
      "audit-dir": auditDir,
      repos: "org/repo",
      "expected-revision": "rev1",
      start: "2026-10-01T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
    };
    const config = { repos: ["org/repo"] } as unknown as WorkerConfig;

    const withLog = await runPrCompletionCollect(
      { ...args, "review-log": missing },
      config,
      gh,
    );
    assertEquals(withLog.success, true);
    assert(
      withLog.data?.coverageNotes.includes(
        `review log ${missing} is missing; skipped`,
      ),
    );
    assertStringIncludes(withLog.message, `coverage: review log ${missing}`);

    const withoutLog = await runPrCompletionCollect(args, config, gh);
    assertEquals(withoutLog.success, true);
    assertStringIncludes(
      withoutLog.message,
      "coverage: 1 review event on 1 PR had no review-log source",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --collect refuses a bad --max-heartbeat-age-hours or --end before any read", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  for (const value of ["0", "-2", "soon"]) {
    const result = await runPrCompletionCollect(
      {
        collect: true,
        repos: "org/repo",
        "expected-revision": "rev1",
        "max-heartbeat-age-hours": value,
      },
      {} as WorkerConfig,
      gh,
      () => undefined,
    );
    assertEquals(result.success, false, `value ${value}`);
    assertStringIncludes(
      result.message,
      "--max-heartbeat-age-hours must be a positive number",
    );
  }
  const badEnd = await runPrCompletionCollect(
    {
      collect: true,
      repos: "org/repo",
      "expected-revision": "rev1",
      end: "2026-11-01",
    },
    {} as WorkerConfig,
    gh,
    () => undefined,
  );
  assertEquals(badEnd.success, false);
  assertStringIncludes(
    badEnd.message,
    "--end must be a UTC (Z) ISO timestamp",
  );
});

Deno.test("pr-completion-report --collect names the snapshot path when it cannot be written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) return [];
      throw new Error(`unrouted gh path: ${path}`);
    };
    // The parent directory does not exist, so the atomic write must fail.
    const target = `${dir}/no-such-dir/snapshot.json`;
    const result = await runPrCompletionCollect(
      {
        collect: true,
        "audit-dir": auditDir,
        repos: "org/repo",
        "expected-revision": "rev1",
        "write-snapshot": target,
      },
      { repos: ["org/repo"] } as unknown as WorkerConfig,
      gh,
    );
    assertEquals(result.success, false);
    assertStringIncludes(
      result.message,
      `could not write snapshot ${target}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --input refuses a non-string value as a missing path", async () => {
  for (const value of [42, true]) {
    const result = await prCompletionReportCommand.execute(
      { input: value },
      {} as WorkerConfig,
    );
    assertEquals(result.success, false, `value ${String(value)}`);
    assertStringIncludes(result.message, "--input <path> is required");
  }
});

Deno.test("pr-completion-report --collect rejects an --expected-host that is not a host name, naming the flag", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  for (const value of ["bad host", "host/a", "a".repeat(65), true]) {
    const result = await runPrCompletionCollect(
      {
        collect: true,
        repos: "org/repo",
        "expected-revision": "rev1",
        "expected-host": value,
      },
      {} as WorkerConfig,
      gh,
      () => undefined,
    );
    assertEquals(result.success, false, `value ${String(value)}`);
    assertStringIncludes(result.message, "--expected-host");
  }
});

Deno.test("pr-completion-report --collect rejects a --human-actor-id that is not digits, naming the flag", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  for (const value of ["octocat", "12a", "-1", true]) {
    const result = await runPrCompletionCollect(
      {
        collect: true,
        repos: "org/repo",
        "expected-revision": "rev1",
        "human-actor-id": value,
      },
      {} as WorkerConfig,
      gh,
      () => undefined,
    );
    assertEquals(result.success, false, `value ${String(value)}`);
    assertStringIncludes(result.message, "--human-actor-id");
  }
});

Deno.test("pr-completion-report --collect rejects a 21-digit --human-actor-id at the flag, not inside the collector", async () => {
  const gh: GhJson = () => Promise.reject(new Error("must not be called"));
  const result = await runPrCompletionCollect(
    {
      collect: true,
      repos: "org/repo",
      "expected-revision": "rev1",
      "human-actor-id": "1".repeat(21),
    },
    {} as WorkerConfig,
    gh,
    () => undefined,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--human-actor-id");
  assertStringIncludes(result.message, "1 to 20 digits");
});

/** Run `--collect` against an empty audit directory, with the given extra args. */
function collectEmpty(extra: Record<string, unknown>, auditDir: string) {
  const gh: GhJson = async (path) => {
    if (path === "repos/org/repo") return { default_branch: "main" };
    if (path.startsWith("repos/org/repo/pulls?")) return [];
    throw new Error(`unrouted gh path: ${path}`);
  };
  return runPrCompletionCollect(
    {
      collect: true,
      "audit-dir": auditDir,
      repos: "org/repo",
      "expected-revision": "rev1",
      "expected-components": "worker",
      start: "2026-10-01T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
      ...extra,
    },
    { repos: ["org/repo"] } as unknown as WorkerConfig,
    gh,
    () => undefined,
  );
}

Deno.test("the CLI and the report agree on the host-name and actor-id bounds, so a value passes one only if it passes the other", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    for (const host of ["a".repeat(64), "a".repeat(65)]) {
      const cli = await collectEmpty({ "expected-host": host }, auditDir);
      let reportAccepts = true;
      try {
        buildPrCompletionReport({
          cohort: {
            start: "2026-10-01T00:00:00.000Z",
            end: "2026-11-01T00:00:00.000Z",
            observedAt: "2026-11-02T00:00:00.000Z",
          },
          prs: [],
          actions: [],
          blockers: [],
          ciRuns: [],
          regressions: [],
          deployments: [],
          expectedDeployment: {
            components: ["worker"],
            revision: "rev1",
            policyFingerprint: "a".repeat(64),
            maxHeartbeatAgeHours: 2,
            hosts: [host],
          },
        });
      } catch {
        reportAccepts = false;
      }
      // The CLI must refuse at the flag, naming it, exactly when the report refuses.
      const cliRefusesAtFlag = !cli.success &&
        cli.message.includes("--expected-host");
      assertEquals(
        !cliRefusesAtFlag,
        reportAccepts,
        `host length ${host.length}`,
      );
      assertEquals(
        reportAccepts,
        host.length === 64,
        `host length ${host.length}`,
      );
    }
    for (const id of ["1".repeat(20), "1".repeat(21)]) {
      const cli = await collectEmpty({ "human-actor-id": id }, auditDir);
      const cliRefusesAtFlag = !cli.success &&
        cli.message.includes("--human-actor-id");
      assertEquals(
        !cliRefusesAtFlag,
        ACTOR_ID_PATTERN.test(id),
        `actor id length ${id.length}`,
      );
      assertEquals(
        ACTOR_ID_PATTERN.test(id),
        id.length === 20,
        `actor id length ${id.length}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --collect passes --human-actor-id to the collector, which counts that account's merge as human-assisted", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const merged = {
      number: 1,
      state: "closed",
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
      closed_at: "2026-10-20T02:00:00Z",
      title: "Change 1",
      body: "",
      labels: [],
      base: { ref: "main" },
      head: { ref: "issue-1", sha: "sha1" },
    };
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) {
        return path.includes("page=1") ? [merged] : [];
      }
      if (path.startsWith("repos/org/repo/pulls/1/reviews")) return [];
      if (path.startsWith("repos/org/repo/pulls/1/commits")) return [];
      if (path.startsWith("repos/org/repo/commits/sha1/check-runs")) {
        return { total_count: 0, check_runs: [] };
      }
      if (path.startsWith("repos/org/repo/issues/1/events")) {
        return path.includes("page=1")
          ? [{
            id: 7,
            event: "merged",
            actor: { id: 42, login: "owner" },
            created_at: "2026-10-20T02:00:00Z",
          }]
          : [];
      }
      throw new Error(`unrouted gh path: ${path}`);
    };
    const run = (extra: Record<string, unknown>) =>
      runPrCompletionCollect(
        {
          collect: true,
          "audit-dir": auditDir,
          repos: "org/repo",
          "expected-revision": "rev1",
          start: "2026-10-01T00:00:00Z",
          end: "2026-11-01T00:00:00Z",
          ...extra,
        },
        { repos: ["org/repo"] } as unknown as WorkerConfig,
        gh,
      );
    const unlisted = await run({});
    assertEquals(unlisted.success, true);
    assertEquals(unlisted.data?.report.completion.humanAssistedMerged, 0);
    const listed = await run({ "human-actor-id": "42,43" });
    assertEquals(listed.success, true);
    assertEquals(listed.data?.report.completion.humanAssistedMerged, 1);
    assertEquals(listed.data?.report.completion.unattendedMerged, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr-completion-report --collect passes --expected-host to the collector, which reports each host without a heartbeat", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const gh: GhJson = async (path) => {
      if (path === "repos/org/repo") return { default_branch: "main" };
      if (path.startsWith("repos/org/repo/pulls?")) return [];
      throw new Error(`unrouted gh path: ${path}`);
    };
    const result = await runPrCompletionCollect(
      {
        collect: true,
        "audit-dir": auditDir,
        repos: "org/repo",
        "expected-revision": "rev1",
        "expected-components": "worker",
        "expected-host": "host-a,host-b,host-a",
        start: "2026-10-01T00:00:00Z",
        end: "2026-11-01T00:00:00Z",
      },
      { repos: ["org/repo"] } as unknown as WorkerConfig,
      gh,
    );
    assertEquals(result.success, true);
    assertEquals(result.data?.report.deployment.missingHostHeartbeats, [
      "worker@host-a",
      "worker@host-b",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
