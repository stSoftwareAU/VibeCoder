/**
 * Tests for rust_use_union.ts — folding duplicated Rust `use` declarations
 * that a textual union merge produced (Issue #3007).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mergeDuplicateRustUses } from "../lib/rust_use_union.ts";
import { unionMergeConflictedFile } from "../lib/milestone_conflict_git.ts";
import type { ConflictedFile } from "../lib/milestone_conflict_triage.ts";

// ---------------------------------------------------------------------------
// Regression: the exact logged lines from Issue #3007.
// ---------------------------------------------------------------------------

Deno.test(
  "mergeDuplicateRustUses - folds the exact logged duplicate from Issue #3007",
  () => {
    const input = `//! Policy evaluation.
use grq_policy::{AccountId, Industry, IndustryOf, StrategyConfig, Symbol, TradingDate};
use grq_reporting::{EvaluationAlertKind, ExceptionKind, timed_out_after};
use grq_policy::{Industry, IndustryOf, ScreenLimits, StrategyConfig, Symbol};

#[test]
fn it_evaluates() {
    assert!(true);
}
`;

    // The single-line union would be 101 characters — over the 100-char
    // limit — so the correct rendering is the multi-line block form.
    const oneLine =
      "use grq_policy::{AccountId, Industry, IndustryOf, ScreenLimits, " +
      "StrategyConfig, Symbol, TradingDate};";
    assertEquals(oneLine.length, 101, "sanity: this is why it wraps");

    const expected = `//! Policy evaluation.
use grq_policy::{
    AccountId, Industry, IndustryOf, ScreenLimits, StrategyConfig, Symbol, TradingDate,
};
use grq_reporting::{EvaluationAlertKind, ExceptionKind, timed_out_after};

#[test]
fn it_evaluates() {
    assert!(true);
}
`;

    assertEquals(mergeDuplicateRustUses(input), expected);
  },
);

// ---------------------------------------------------------------------------
// Simple folds.
// ---------------------------------------------------------------------------

Deno.test(
  "mergeDuplicateRustUses - an exact duplicate line is removed",
  () => {
    const input = "use a::b::C;\nuse a::b::C;\n";
    assertEquals(mergeDuplicateRustUses(input), "use a::b::C;\n");
  },
);

Deno.test(
  "mergeDuplicateRustUses - a single-item use folds into a braced duplicate",
  () => {
    const input = "use a::b::C;\nuse a::b::{C, D};\n";
    assertEquals(mergeDuplicateRustUses(input), "use a::b::{C, D};\n");
  },
);

// ---------------------------------------------------------------------------
// Negative cases: nothing here is a fold candidate.
// ---------------------------------------------------------------------------

Deno.test(
  "mergeDuplicateRustUses - the same leaf under different prefixes is untouched",
  () => {
    const input = "use a::X;\nuse b::X;\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - a #[cfg]-gated use is left alone",
  () => {
    const input = "#[cfg(test)]\nuse a::b::C;\nuse a::b::C;\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - an indented use (inside a mod) is left alone",
  () => {
    const input = "mod tests {\n    use a::b::C;\n    use a::b::C;\n}\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - non-overlapping same-prefix groups are left alone",
  () => {
    const input = "use a::b::{C};\nuse a::b::{D};\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - a nested brace group is skipped, not folded",
  () => {
    const input = "use a::{b::{C, D}, E};\nuse a::{b::{C, D}, E};\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - a glob import is skipped",
  () => {
    const input = "use a::b::*;\nuse a::b::*;\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

Deno.test(
  "mergeDuplicateRustUses - text with no duplicates is returned identical",
  () => {
    const input = "use a::b::C;\nuse x::y::Z;\n";
    assertEquals(mergeDuplicateRustUses(input), input);
  },
);

// ---------------------------------------------------------------------------
// Rendering rules.
// ---------------------------------------------------------------------------

Deno.test(
  "mergeDuplicateRustUses - a long union renders in the multi-line form",
  () => {
    const input =
      "use very_long_crate_name::{AlphaItemName, BetaItemName, GammaItemName};\n" +
      "use very_long_crate_name::{DeltaItemName, EpsilonItemName, AlphaItemName};\n";

    const merged = mergeDuplicateRustUses(input);

    assertStringIncludes(merged, "use very_long_crate_name::{\n");
    assert(
      merged.includes("};\n"),
      "the multi-line block closes with its own line",
    );
    for (
      const item of [
        "AlphaItemName",
        "BetaItemName",
        "GammaItemName",
        "DeltaItemName",
        "EpsilonItemName",
      ]
    ) {
      assertStringIncludes(merged, item);
    }
    // No line of the rendered block exceeds 100 characters.
    for (const line of merged.split("\n")) {
      assert(line.length <= 100, `line too long: ${line}`);
    }
  },
);

Deno.test(
  "mergeDuplicateRustUses - unsorted input keeps first-occurrence order",
  () => {
    const input = "use a::b::{B, A};\nuse a::b::{A, C};\n";
    assertEquals(mergeDuplicateRustUses(input), "use a::b::{B, A, C};\n");
  },
);

// ---------------------------------------------------------------------------
// Integration: unionMergeConflictedFile on a real conflicted .rs file.
// ---------------------------------------------------------------------------

/** Run a git command in `dir`, failing the test loudly on a non-zero exit. */
async function git(dir: string, args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

Deno.test(
  "unionMergeConflictedFile - a real merge conflict on a duplicated use line folds and stages (Issue #3007)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "vibe-rust-use-union-" });
    try {
      await git(dir, ["init"]);
      await git(dir, ["config", "user.email", "test@example.com"]);
      await git(dir, ["config", "user.name", "Test"]);
      await git(dir, ["config", "commit.gpgsign", "false"]);

      const path = "src/lib.rs";
      await Deno.mkdir(`${dir}/src`, { recursive: true });

      const base = `use grq_policy::{AccountId, TradingDate};

#[test]
fn it_works() {
    assert!(true);
}
`;
      await Deno.writeTextFile(`${dir}/${path}`, base);
      await git(dir, ["add", path]);
      await git(dir, ["commit", "-m", "base"]);
      await git(dir, ["branch", "-M", "main"]);

      await git(dir, ["checkout", "-b", "feature"]);
      await Deno.writeTextFile(
        `${dir}/${path}`,
        base.replace(
          "use grq_policy::{AccountId, TradingDate};",
          "use grq_policy::{AccountId, Industry, IndustryOf, TradingDate};",
        ),
      );
      await git(dir, ["commit", "-am", "feature side"]);

      await git(dir, ["checkout", "main"]);
      await Deno.writeTextFile(
        `${dir}/${path}`,
        base.replace(
          "use grq_policy::{AccountId, TradingDate};",
          "use grq_policy::{AccountId, StrategyConfig, Symbol, TradingDate};",
        ),
      );
      await git(dir, ["commit", "-am", "main side"]);

      // Merge feature into main; both sides touched the same line, so git
      // reports a conflict and leaves stages 1/2/3 in the index.
      let conflicted = false;
      try {
        await git(dir, ["merge", "--no-ff", "feature"]);
      } catch {
        conflicted = true;
      }
      assert(conflicted, "the merge must conflict for this test to prove anything");

      const base1 = await git(dir, ["show", `:1:${path}`]);
      const ours2 = await git(dir, ["show", `:2:${path}`]);
      const theirs3 = await git(dir, ["show", `:3:${path}`]);

      const file: ConflictedFile = {
        path,
        ours: ours2,
        theirs: theirs3,
        base: base1,
        oursFixes: [],
        theirsFixes: [],
      };

      const result = await unionMergeConflictedFile(file, { cwd: dir });
      assertEquals(result, null, `expected the union to stage cleanly: ${result}`);

      const staged = await Deno.readTextFile(`${dir}/${path}`);
      const useLines = staged
        .split("\n")
        .filter((line) => line.includes("use grq_policy"));
      assertEquals(
        useLines.length,
        1,
        `expected exactly one folded 'use grq_policy' declaration, got: ${
          JSON.stringify(staged)
        }`,
      );
      assertStringIncludes(staged, "AccountId");
      assertStringIncludes(staged, "StrategyConfig");
      assertStringIncludes(staged, "Industry");
      assertStringIncludes(staged, "TradingDate");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
);
