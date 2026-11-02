import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  prCompletionReportCommand,
  runPrCompletionCollect,
} from "../commands/pr_completion_report.ts";
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

Deno.test("pr-completion-report --collect fails loudly without an expected revision", async () => {
  const saved = Deno.env.get("VIBE_BUILD_COMMIT");
  Deno.env.delete("VIBE_BUILD_COMMIT");
  try {
    const result = await prCompletionReportCommand.execute(
      { collect: true, repos: "org/repo" },
      {} as WorkerConfig,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--expected-revision");
  } finally {
    if (saved !== undefined) Deno.env.set("VIBE_BUILD_COMMIT", saved);
  }
});

Deno.test("pr-completion-report --collect writes a snapshot that --input reproduces", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    const target = `${dir}/snapshot.json`;
    const paths: string[] = [];
    const gh: GhJson = async (path) => {
      paths.push(path);
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
    assert(paths.every((path) => !path.includes("method=")));

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
