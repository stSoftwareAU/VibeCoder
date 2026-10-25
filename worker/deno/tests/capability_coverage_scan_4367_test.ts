/**
 * Behavioural coverage scan (Issue #4367).
 *
 * Missing assertions are a best-practices finding. A test that was not
 * executed is not a pass. A read failure is unknown. An existing
 * security issue for the same path is not filed again.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  coverageFindingId,
  planCapabilityCoverageFiling,
  scanCapabilityCoverageDir,
  scanCapabilityCoverageFiles,
} from "../lib/capability_coverage_scan.ts";
import { createBestPracticesTemplate } from "../lib/idle_task_templates/best_practices_template.ts";
import type { AwsEmulatorCheckResult } from "../lib/aws_emulator_in_ci_check.ts";

const VULNERABLE = `
export function update(request: { body: { role: string; tenantId: string } }) {
  const role = request.body.role;
  if (request.body.tenantId === "a") return { role };
  return { role };
}
`;

const SECURE_TEST = `
Deno.test("authorised update succeeds", () => {});
Deno.test("unauthorised cross-tenant update is forbidden", () => {});
Deno.test("privileged role is rejected by the allowlist", () => {});
`;

const REDACT = `
export function send(secret: string) {
  console.log(secret);
}
`;

Deno.test("a vulnerable path with no covering test is one finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
  ]);
  assertEquals(scan.status, "findings");
  assertEquals(scan.pass, false);
  assert(scan.findings.length >= 1);
  const auth = scan.findings.find((f) =>
    f.capability === "capsec-resource-auth"
  );
  assert(auth);
  assertEquals(auth.path, "src/update.ts");
  assertEquals(auth.testsInspected, []);
  assertStringIncludes(auth.body, "Tests inspected:** none");
  assertStringIncludes(auth.body, "Uncovered contract:");
  assertStringIncludes(auth.body, "not proof of an exploit");
  const plan = planCapabilityCoverageFiling(scan, []);
  assertEquals(plan.outcome, "one");
  if (plan.outcome === "one") assertEquals(plan.pass, false);
});

Deno.test("assertions without an executed test are not a pass", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
    { path: "src/update_test.ts", text: SECURE_TEST },
  ]);
  assertEquals(scan.pass, false);
  assertEquals(scan.status, "not_checked");
  assertEquals(planCapabilityCoverageFiling(scan, []).outcome, "zero");
});

Deno.test("executed covering tests can pass, and an untested sink is a finding", async () => {
  const covered = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
    { path: "src/update_test.ts", text: SECURE_TEST },
  ], { testsExecuted: true });
  assertEquals(covered.pass, true);
  assertEquals(covered.findings, []);

  const untested = await scanCapabilityCoverageFiles([
    { path: "src/send.ts", text: REDACT },
  ]);
  assertEquals(untested.pass, false);
  assertEquals(untested.findings.length, 1);
  assertEquals(untested.findings[0]!.testsInspected, []);
  assertStringIncludes(untested.findings[0]!.contract, "redacted");
});

Deno.test("a public-by-design update and a covering integration test are not findings", async () => {
  const publicRoute = await scanCapabilityCoverageFiles([{
    path: "src/public_update.ts",
    text:
      "// This update is public by design. No tenant check.\nexport function update(input: { name: string }) { return input.name; }\n",
  }]);
  assertEquals(publicRoute.status, "none");
  assertEquals(publicRoute.findings, []);

  const integration = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
    { path: "tests/update_integration_test.ts", text: SECURE_TEST },
  ], { testsExecuted: true });
  assertEquals(integration.findings, []);
  assertEquals(integration.pass, true);
});

Deno.test("a file named security with no matching sink is not a finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/security.ts", text: "export const note = 'nothing here';\n" },
    { path: "README.md", text: "docs only" },
  ]);
  assertEquals(scan.status, "none");
  assertEquals(scan.pass, false);
  assertEquals(planCapabilityCoverageFiling(scan, []).outcome, "zero");
});

Deno.test("an open security issue for the same path is not filed again", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
  ]);
  const plan = planCapabilityCoverageFiling(scan, [{
    number: 42,
    title: "security-scan of src/update.ts",
    labels: ["security"],
  }]);
  assertEquals(plan.outcome, "dedup");
  if (plan.outcome === "dedup") assertEquals(plan.existingIssue, 42);
});

Deno.test("a label-only security issue for the same path dedups", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/update.ts", text: VULNERABLE },
  ]);
  const plan = planCapabilityCoverageFiling(scan, [{
    number: 7,
    title: "Investigate src/update.ts",
    labels: ["security"],
  }]);
  assertEquals(plan.outcome, "dedup");
});

Deno.test("a suppression marker removes the finding", async () => {
  const id = await coverageFindingId("capsec-secret-logging", "src/send.ts");
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/send.ts",
    text: `${REDACT}\n// best-practice-ignore: ${id}\n`,
  }]);
  assertEquals(scan.findings, []);
  assertEquals(scan.status, "not_checked");
});

Deno.test("a missing checkout is an error, not a clean scan", async () => {
  const missing = await Deno.makeTempDir();
  await Deno.remove(missing);
  const scan = await scanCapabilityCoverageDir(missing);
  assertEquals(scan.status, "unknown");
  assertEquals(scan.pass, false);
  const plan = planCapabilityCoverageFiling(scan, []);
  assertEquals(plan.outcome, "error");
});

Deno.test("the best-practices template files one coverage issue and dedups a security issue", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: "src/send.ts", text: REDACT },
  ]);
  assertEquals(scan.findings.length, 1);
  const finding = scan.findings[0]!;
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        body: "**Bucket:** `general`\n",
      }));
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/org/repo/issues/11\n");
    }
    if (args.includes("number,title,labels")) return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
  const tpl = createBestPracticesTemplate({
    dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    ghCommandFn: gh,
    checkAwsEmulatorFn: (): Promise<AwsEmulatorCheckResult> =>
      Promise.resolve({
        usesAws: false,
        awsEvidence: [],
        emulatorConfigured: false,
        workflowsLoaded: true,
      }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
    scanCapabilityCoverageFn: () => Promise.resolve(scan),
  });
  const filed = await tpl.runTask({
    repo: "org/repo",
    workDir: "/tmp/repo",
    idleTaskIssueNumber: 50,
  });
  assert(filed.ok);
  const created = calls.find((args) =>
    args[0] === "issue" && args[1] === "create"
  );
  assert(created);
  assert(created.join(" ").includes(finding.path));
  assert(created.join(" ").includes("severity:low"));

  const dedupCalls: string[][] = [];
  const dedupGh = (args: string[]): Promise<string> => {
    dedupCalls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        body: "**Bucket:** `general`\n",
      }));
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.reject(new Error("duplicate coverage issue was filed"));
    }
    if (args.includes("number,title,labels")) {
      return Promise.resolve(JSON.stringify([{
        number: 9,
        title: "Look at src/send.ts",
        labels: [{ name: "security" }],
      }]));
    }
    return Promise.resolve("[]");
  };
  const dedup = createBestPracticesTemplate({
    dedupAuthors: { fleetAuthors: ["vibe-bot"] },
    ghCommandFn: dedupGh,
    checkAwsEmulatorFn: (): Promise<AwsEmulatorCheckResult> =>
      Promise.resolve({
        usesAws: false,
        awsEvidence: [],
        emulatorConfigured: false,
        workflowsLoaded: true,
      }),
    runScanFn: () => Promise.resolve({ ok: true, value: true }),
    scanCapabilityCoverageFn: () => Promise.resolve(scan),
  });
  const skipped = await dedup.runTask({
    repo: "org/repo",
    workDir: "/tmp/repo",
    idleTaskIssueNumber: 50,
  });
  assert(skipped.ok);
  assertEquals(
    dedupCalls.some((args) => args[0] === "issue" && args[1] === "create"),
    false,
  );
});
