import { assertEquals, assertThrows } from "@std/assert";
import { planRegressionChecks } from "../../../.claude/skills/review-fleet-prs/scripts/review_regression_plan.ts";

Deno.test("regression planner uses paths as data in a fixed offline Deno command", () => {
  assertEquals(
    planRegressionChecks(
      ["tests/guard_test.ts"],
      new Set(["tests/guard_test.ts"]),
    ),
    [{
      testFile: "tests/guard_test.ts",
      argv: [
        "deno",
        "test",
        "--cached-only",
        "--no-prompt",
        "--allow-all",
        "tests/guard_test.ts",
      ],
    }],
  );
});

Deno.test("regression planner rejects non-tree, unsafe, unsupported and excessive paths", () => {
  for (
    const path of [
      "../guard_test.ts",
      "/guard_test.ts",
      "-x_test.ts",
      "a\\b_test.ts",
      "a\n_test.ts",
      "test.ts",
      "missing_test.ts",
    ]
  ) {
    assertThrows(() =>
      planRegressionChecks([path], new Set(["tests/guard_test.ts"]))
    );
  }
  assertThrows(() => planRegressionChecks([], new Set()));
  assertThrows(() =>
    planRegressionChecks(
      Array.from({ length: 9 }, (_, n) => `${n}_test.ts`),
      new Set(Array.from({ length: 9 }, (_, n) => `${n}_test.ts`)),
    )
  );
});
