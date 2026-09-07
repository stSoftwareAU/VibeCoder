/**
 * Issue #1483: `deno task check:manifests` exists, its membership is derived
 * from the tree, and the derivation includes the two checks that actually
 * fired (#1481, #1482) while excluding what would make the family slow.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  completenessTestArgs,
  deriveCompletenessTestFiles,
  isCompletenessCheck,
} from "../lib/completeness_checks.ts";

const DENO_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const noHelpers = () => Promise.resolve("");

Deno.test("completeness checks - the task exists and runs the derived runner (Issue #1483)", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(`${DENO_DIR}/deno.json`),
  ) as {
    tasks: Record<string, string>;
  };
  const task = denoJson.tasks["check:manifests"];
  assert(task, "deno.json must define check:manifests");
  assert(task.includes("check_manifests.ts"), task);
  assert(
    !/tests\/[a-z_]+_test\.ts/.test(task),
    "membership is derived, never listed in the task",
  );
});

Deno.test("completeness checks - the two that fired in one hour are members (Issue #1483)", async () => {
  const files = await deriveCompletenessTestFiles(DENO_DIR);
  for (
    const expected of [
      "tests/lib_sweep_coverage_test.ts",
      "tests/vibe_env_registry_test.ts",
      "tests/integration_test_manifest_test.ts",
      "tests/test_shard_plan_test.ts",
      "tests/marker_dedup_author_cap_test.ts",
      "tests/no_verify_ban_test.ts",
      "tests/prompt_house_vocabulary_drift_test.ts",
    ]
  ) {
    assert(
      files.includes(expected),
      `${expected} must be in the family: ${files.join(", ")}`,
    );
  }
});

Deno.test("completeness checks - the family is the fast, tree-reading tests and nothing heavy (Issue #1483)", async () => {
  const files = await deriveCompletenessTestFiles(DENO_DIR);
  assert(
    files.length >= 20,
    `a family of ${files.length} is implausibly small`,
  );
  for (
    const excluded of [
      "tests/run_sh_launcher_test.ts", // spawns the launcher
      "tests/claim_path_incident_test.ts", // replays through a spawning fixture
      "tests/new_work_eligibility_test.ts", // temp dirs
      "tests/completion_phase_security_gate_test.ts", // temp repos
    ]
  ) {
    assertEquals(
      files.includes(excluded),
      false,
      `${excluded} must not be in the family`,
    );
  }
  assertEquals(
    files,
    [...files].sort(),
    "membership is sorted, so the task's output is diffable",
  );
});

Deno.test("completeness checks - the classifier's rules, one at a time (Issue #1483)", async () => {
  // Reads the tree: in.
  assertEquals(
    await isCompletenessCheck(
      'for await (const e of Deno.readDir("lib")) {}',
      noHelpers,
    ),
    true,
  );
  // Imports a ledger module: in, even without its own readDir.
  assertEquals(
    await isCompletenessCheck(
      'import { X } from "../lib/foo_manifest.ts";',
      noHelpers,
    ),
    true,
  );
  // Reads the tree but spawns: out.
  assertEquals(
    await isCompletenessCheck(
      'for await (const e of Deno.readDir("lib")) {}\nnew Deno.Command("deno");',
      noHelpers,
    ),
    false,
  );
  // Reads the tree but its fixture spawns: out.
  assertEquals(
    await isCompletenessCheck(
      'import { replay } from "./fixtures/state.ts";\nfor await (const e of Deno.readDir("lib")) {}',
      (dir, name) =>
        Promise.resolve(
          dir === "fixtures" && name === "state.ts"
            ? 'new Deno.Command("deno")'
            : "",
        ),
    ),
    false,
  );
  // A readDir mentioned only in a comment does not count.
  assertEquals(
    await isCompletenessCheck(
      "// Deno.readDir would be wrong here\nDeno.test('x', () => {});",
      noHelpers,
    ),
    false,
  );
  // Neither reads nor imports a ledger: out.
  assertEquals(
    await isCompletenessCheck(
      'import { a } from "../lib/config.ts";',
      noHelpers,
    ),
    false,
  );
});

Deno.test("completeness checks - the family runs under read and env permissions only (Issue #1483)", () => {
  const args = completenessTestArgs(["tests/a_test.ts"]);
  assertEquals(args.slice(0, 3), ["test", "--frozen", "--lock=deno.lock"]);
  assert(args.includes("--allow-read") && args.includes("--allow-env"));
  assertEquals(
    args.some((a) =>
      a.startsWith("--allow-run") || a.startsWith("--allow-write") ||
      a.startsWith("--allow-net")
    ),
    false,
    "nothing in the family may need more than read and env",
  );
  assertEquals(args[args.length - 1], "tests/a_test.ts");
});
