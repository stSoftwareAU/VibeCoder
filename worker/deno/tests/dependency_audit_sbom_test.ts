/**
 * Tests for the SBOM-generation job in .github/workflows/dependency-audit.yml.
 *
 * Issue #2687 (SCR-SBOM): the supply-chain readiness audit flagged that no
 * machine-readable Software Bill of Materials is produced by CI. The fix adds a
 * read-only `generate-sbom` job that emits a CycloneDX SBOM and uploads it as a
 * build artefact, so an incident responder can answer "are we exposed, and
 * where?" with a single grep against a stable artefact.
 *
 * These tests parse the actual workflow YAML and assert on the SBOM job's
 * correctness properties (CycloneDX format, artefact upload, read-only token,
 * SHA-pinned third-party actions) so a regression that removes or weakens the
 * job fails the quality gate.
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const WORKFLOW_PATH =
  new URL("../../../.github/workflows/dependency-audit.yml", import.meta.url)
    .pathname;

// deno-lint-ignore no-explicit-any
function loadWorkflow(): any {
  const text = Deno.readTextFileSync(WORKFLOW_PATH);
  return parseYaml(text);
}

// deno-lint-ignore no-explicit-any
function sbomJob(): any {
  const wf = loadWorkflow();
  assert(wf.jobs, "workflow has no jobs block");
  const job = wf.jobs["generate-sbom"];
  assert(job, "dependency-audit.yml is missing the generate-sbom job");
  return job;
}

function isFullSha(uses: string): boolean {
  const ref = uses.split("@")[1] ?? "";
  return /^[0-9a-f]{40}$/.test(ref);
}

Deno.test("dependency-audit SBOM - generate-sbom job exists", () => {
  const job = sbomJob();
  assertEquals(job["runs-on"], "ubuntu-latest");
});

Deno.test("dependency-audit SBOM - emits a CycloneDX SBOM", () => {
  const job = sbomJob();
  // deno-lint-ignore no-explicit-any
  const steps: any[] = job.steps;
  assert(Array.isArray(steps), "generate-sbom job has no steps");
  const gen = steps.find((s) =>
    typeof s.uses === "string" && s.uses.includes("trivy-action")
  );
  assert(gen, "no SBOM-generation step using trivy-action found");
  assertEquals(gen.with.format, "cyclonedx", "SBOM format must be cyclonedx");
  assert(
    typeof gen.with.output === "string" && gen.with.output.length > 0,
    "SBOM step must write to an output file",
  );
});

Deno.test("dependency-audit SBOM - uploads the SBOM as an artefact", () => {
  const job = sbomJob();
  // deno-lint-ignore no-explicit-any
  const steps: any[] = job.steps;
  const gen = steps.find((s) =>
    typeof s.uses === "string" && s.uses.includes("trivy-action")
  );
  const upload = steps.find((s) =>
    typeof s.uses === "string" && s.uses.includes("upload-artifact")
  );
  assert(upload, "no upload-artifact step found");
  // The uploaded path must match the file the generator wrote.
  assertEquals(
    upload.with.path,
    gen.with.output,
    "upload path must match the generated SBOM file",
  );
});

Deno.test("dependency-audit SBOM - job token is read-only", () => {
  const wf = loadWorkflow();
  const job = wf.jobs["generate-sbom"];
  // Either the workflow-level permissions are read-only and inherited, or the
  // job declares its own read-only block. Both satisfy least privilege.
  const effective = job.permissions ?? wf.permissions;
  assertEquals(
    effective?.contents,
    "read",
    "SBOM job must run with read-only contents permission",
  );
  // The job must not grant write to anything.
  if (job.permissions) {
    for (const [scope, level] of Object.entries(job.permissions)) {
      assert(
        level !== "write",
        `SBOM job must not grant write on ${scope}`,
      );
    }
  }
});

Deno.test("dependency-audit SBOM - third-party actions pinned to 40-char SHAs", () => {
  const job = sbomJob();
  // deno-lint-ignore no-explicit-any
  const steps: any[] = job.steps;
  for (const step of steps) {
    if (typeof step.uses !== "string") continue;
    assert(
      isFullSha(step.uses),
      `action must be pinned to a 40-char commit SHA: ${step.uses}`,
    );
  }
});
