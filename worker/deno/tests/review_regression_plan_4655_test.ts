import { assertEquals, assertThrows } from "@std/assert";
import {
  parseHeadTree,
  planRegressionChecks,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_regression_plan.ts";

Deno.test("regression planner uses paths as data in a fixed offline Deno command", () => {
  assertEquals(
    planRegressionChecks(
      ["tests/guard_test.ts"],
      new Set(["tests/guard_test.ts"]),
    ),
    [{
      testFile: "tests/guard_test.ts",
      cwd: ".",
      argv: [
        "deno",
        "test",
        "--cached-only",
        "--no-prompt",
        "--allow-all",
        "./tests/guard_test.ts",
      ],
    }],
  );
});

Deno.test("regression planner uses the nearest Deno project in the verified tree", () => {
  const files = new Set([
    "worker/deno/deno.json",
    "worker/deno/tests/guard_test.ts",
  ]);
  const [plan] = planRegressionChecks(
    ["worker/deno/tests/guard_test.ts"],
    files,
  );
  assertEquals(plan?.cwd, "worker/deno");
  assertEquals(plan?.argv.at(-1), "./tests/guard_test.ts");
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

Deno.test("head tree parser selects regular blobs and rejects malformed records", () => {
  const oid = "a".repeat(40);
  const tree = `100644 blob ${oid}\ttests/guard_test.ts\0` +
    `120000 blob ${oid}\ttests/link_test.ts\0`;
  assertEquals([...parseHeadTree(tree)], ["tests/guard_test.ts"]);
  assertThrows(() => parseHeadTree(`100644 blob ${oid}\ttests/a_test.ts`));
  assertThrows(() => parseHeadTree(`100644 blob nonsense\ttests/a_test.ts\0`));
});
