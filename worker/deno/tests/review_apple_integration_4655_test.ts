import { assertEquals } from "@std/assert";
import { appleRegressionRunner } from "../../../.claude/skills/review-fleet-prs/scripts/review_apple_runner.ts";
import { collectRegressionEvidence } from "../../../.claude/skills/review-fleet-prs/scripts/review_regression_collection.ts";

Deno.test({
  name:
    "Apple host collector runs a pinned offline test and returns observations only",
  ignore: !Deno.env.get("VIBE_OFFLINE_TEST_IMAGE"),
  async fn() {
    const root = await Deno.makeTempDir();
    const git = async (...args: string[]) => {
      const out = await new Deno.Command("git", { args, cwd: root }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout).trim();
    };
    try {
      await git("init");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.invalid");
      await Deno.writeTextFile(
        `${root}/value.ts`,
        "export const double = (n: number) => n * 3;\n",
      );
      await git("add", "value.ts");
      await git("commit", "-m", "base");
      const base = await git("rev-parse", "HEAD");
      await Deno.writeTextFile(
        `${root}/value.ts`,
        "export const double = (n: number) => n * 2;\n",
      );
      await Deno.writeTextFile(
        `${root}/guard_test.ts`,
        `import { double } from "./value.ts"; Deno.test("double", () => { if (double(3) !== 6) throw Error("wrong double"); });\n`,
      );
      await git("add", "value.ts", "guard_test.ts");
      await git("commit", "-m", "fixture");
      const head = await git("rev-parse", "HEAD");
      const result = await collectRegressionEvidence(
        {
          head,
          base: head,
          tests: ["guard_test.ts"],
          headFiles: new Set(["guard_test.ts"]),
        },
        appleRegressionRunner(
          root,
          root,
          Deno.env.get("VIBE_OFFLINE_TEST_IMAGE"),
        ),
      );
      assertEquals(result.status, "review");
      const redBase = await collectRegressionEvidence(
        {
          head,
          base,
          tests: ["guard_test.ts"],
          headFiles: new Set(["guard_test.ts"]),
        },
        appleRegressionRunner(
          root,
          root,
          Deno.env.get("VIBE_OFFLINE_TEST_IMAGE"),
        ),
      );
      assertEquals(redBase.status, "pending");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
