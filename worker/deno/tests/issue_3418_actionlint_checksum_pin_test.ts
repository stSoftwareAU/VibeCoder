/**
 * Regression test for Issue #3418 — actionlint binary installed without an
 * in-repo SHA-256 checksum pin.
 *
 * The `Install actionlint` step in `.github/workflows/validate-scripts.yml`
 * fetched and ran the actionlint release binary without verifying it against
 * a checksum committed to this repo, so a substituted upstream release asset
 * could execute on the CI runner. The sibling `Install gitleaks` step already
 * pins and verifies a `GITLEAKS_SHA256`; this test pins the matching hardening
 * for actionlint.
 *
 * The test parses the real workflow, locates the actionlint install step, and
 * asserts it pins a 64-hex SHA-256 and verifies the download with
 * `sha256sum -c` before installing the binary. A future change that drops the
 * checksum gate fails this test, preventing a silent regression.
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const WORKFLOW_PATH = `${REPO_ROOT}/.github/workflows/validate-scripts.yml`;

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
}

async function loadActionlintStep(): Promise<WorkflowStep> {
  const raw = await Deno.readTextFile(WORKFLOW_PATH);
  // deno-lint-ignore no-explicit-any
  const parsed = parseYaml(raw) as any;
  const steps: WorkflowStep[] = parsed?.jobs?.validate?.steps ?? [];
  const step = steps.find((s) => s.name === "Install actionlint");
  assert(step, "workflow must define an 'Install actionlint' step");
  return step;
}

Deno.test("Issue #3418 — actionlint install verifies a pinned SHA-256", async () => {
  const step = await loadActionlintStep();
  const run = step.run ?? "";

  // The download must be verified against a committed checksum before the
  // binary is moved into place / executed.
  assert(
    /sha256sum\s+-c/.test(run),
    `actionlint install must verify the download with 'sha256sum -c'. run:\n${run}`,
  );

  // A 64-hex SHA-256 must be pinned in the repo — either as an env var or a
  // literal in the run block.
  const envValues = Object.values(step.env ?? {}).map((v) => String(v));
  const haystack = [run, ...envValues].join("\n");
  const sha = haystack.match(/\b[0-9a-f]{64}\b/);
  assert(
    sha,
    `actionlint install must pin a 64-hex SHA-256 checksum. searched:\n${haystack}`,
  );

  // Pin the exact linux_amd64 tarball hash for actionlint 1.7.12 (from the
  // published actionlint_1.7.12_checksums.txt) so a tampered release asset
  // cannot pass verification.
  assertEquals(
    sha[0],
    "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    "pinned actionlint checksum must match the published linux_amd64 hash",
  );

  // The verification must precede the install (`sudo mv`) so an unverified
  // binary is never placed on PATH.
  const verifyIdx = run.search(/sha256sum\s+-c/);
  const installIdx = run.search(/sudo\s+mv/);
  assert(installIdx > verifyIdx, "checksum must be verified before install");
});
