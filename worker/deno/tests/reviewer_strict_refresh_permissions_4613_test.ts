import { assert, assertEquals } from "@std/assert";

for (const script of ["gate", "post", "post-shim"]) {
  Deno.test(`strict refresh through ${script} runs with the documented reviewer permissions`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "reviewer-strict-4613-" });
    try {
      await Deno.writeTextFile(
        `${dir}/config.json`,
        JSON.stringify({
          repos: ["acme/app"],
          fleet_pr_authors: ["VibeCoderST"],
          service_accounts: ["reviewer"],
        }),
      );
      await Deno.writeTextFile(
        `${dir}/input.json`,
        JSON.stringify({
          pr: {
            repo: "acme/app",
            number: 20,
            title: "Ready change",
            url: "https://github.com/acme/app/pull/20",
            baseRef: "main",
            headSha: "a".repeat(40),
            kind: "fleet",
            testChanges: { removed: [], edited: [] },
            checklistState: { problem: null, expected: [] },
            previousFindings: [],
          },
          review: {
            summary: "Looks right.",
            findings: [],
            testChanges: "none",
          },
        }),
      );
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-run=gh,osascript",
          "--allow-read",
          "--allow-write",
          "--allow-env=HOME,XDG_STATE_HOME",
          "--preload",
          new URL(
            "./fixtures/reviewer_strict_refresh_preload.ts",
            import.meta.url,
          ).pathname,
          new URL(
            script === "post-shim"
              ? "../../../.claude/skills/review-fleet-prs/post.ts"
              : `../../../.claude/skills/review-fleet-prs/scripts/${script}.ts`,
            import.meta.url,
          ).pathname,
          `--config=${dir}/config.json`,
          "--reviewer=reviewer",
          `--input=${dir}/input.json`,
          `--state-dir=${dir}/state`,
          "--no-model",
        ],
        env: { HOME: dir, XDG_STATE_HOME: dir },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      assert(out.success, stdout + stderr);
      const calls: string[][] = (await Deno.readTextFile(`${dir}/calls.jsonl`))
        .trim().split("\n").map((row) => JSON.parse(row));
      assertEquals(
        calls.filter((args) => args.includes("PUT")).length,
        1,
        stdout + stderr,
      );
      const result = JSON.parse(stdout.trim());
      if (script === "gate") {
        assertEquals(result.upkeep, ["acme/app#20 branch update requested"]);
      } else assertEquals(result.branchUpdated, true);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
