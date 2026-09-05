/**
 * Tests for the conflict-resolution git argv builders (Issue #3294).
 *
 * These builders exist so a conflicted filename beginning with `-` can never be
 * parsed by git as an option instead of a pathspec — the `--` end-of-options
 * separator must always precede the (untrusted) filename.
 */

import { assertEquals } from "@std/assert";
import {
  buildAddPathArgs,
  buildCheckoutStrategyArgs,
  buildRemovePathArgs,
} from "../lib/git_conflict_args.ts";

Deno.test("buildAddPathArgs - inserts -- before an ordinary filename", () => {
  assertEquals(buildAddPathArgs("src/foo.ts"), ["add", "--", "src/foo.ts"]);
});

Deno.test("buildAddPathArgs - -- precedes a dash-leading filename", () => {
  const args = buildAddPathArgs("--pathspec-from-file=/tmp/x");
  assertEquals(args, ["add", "--", "--pathspec-from-file=/tmp/x"]);
  // The separator must come immediately before the filename so git treats the
  // dash-leading value as a pathspec, not an option.
  const sepIndex = args.indexOf("--");
  assertEquals(args[sepIndex + 1], "--pathspec-from-file=/tmp/x");
});

Deno.test("buildAddPathArgs - -- precedes an -rf filename", () => {
  const args = buildAddPathArgs("-rf");
  assertEquals(args, ["add", "--", "-rf"]);
});

Deno.test("buildCheckoutStrategyArgs - theirs with -- before filename", () => {
  assertEquals(
    buildCheckoutStrategyArgs("theirs", "src/foo.ts"),
    ["checkout", "--theirs", "--", "src/foo.ts"],
  );
});

Deno.test("buildCheckoutStrategyArgs - ours with -- before dash-leading name", () => {
  const args = buildCheckoutStrategyArgs("ours", "--output=/tmp/x");
  assertEquals(args, ["checkout", "--ours", "--", "--output=/tmp/x"]);
  const sepIndex = args.indexOf("--");
  assertEquals(args[sepIndex + 1], "--output=/tmp/x");
});

Deno.test("buildRemovePathArgs - forces the removal with -- before the filename", () => {
  assertEquals(
    buildRemovePathArgs("lib/fleet_health.ts"),
    ["rm", "--force", "--ignore-unmatch", "--", "lib/fleet_health.ts"],
  );
});

Deno.test("buildRemovePathArgs - -- precedes a dash-leading filename", () => {
  const args = buildRemovePathArgs("-rf");
  assertEquals(args, ["rm", "--force", "--ignore-unmatch", "--", "-rf"]);
  const sepIndex = args.indexOf("--", 1);
  assertEquals(args[sepIndex + 1], "-rf");
});

Deno.test("buildRemovePathArgs - an empty path still lands after the separator", () => {
  const args = buildRemovePathArgs("");
  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 1], "");
});
