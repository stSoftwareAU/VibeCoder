/**
 * Recovery-boundary coverage scan (Issue #4417).
 *
 * A retry, restart or fallback that alters credentials, mounts or execution
 * identity must keep the configured authority, and a test must exercise that
 * boundary. A missing test is a best-practices finding, not an exploit.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  altersAuthorityOnRecovery,
  coverageFindingId,
  planCapabilityCoverageFiling,
  scanCapabilityCoverageFiles,
} from "../lib/capability_coverage_scan.ts";

const RECOVERY_KIND = "capsec-recovery-boundary";
const RESTART_PATH = "src/session/restart.ts";
const REFRESH_PATH = "src/session/refresh.ts";

const WIDENING_RESTART =
  `export async function restartWorker(config: { credential: string; mounts: string[] }) {
  // after a denial, restart with a broader credential and an extra mount
  const broader = { credential: "org-admin-token", mounts: [...config.mounts, "/"] };
  return launch(["--volume", "/:/host"], broader);
}
`;

const SAME_SCOPE_REFRESH =
  `export async function refreshSession(session: { token: string; scope: string }) {
  // after a denial, retry the token refresh with the same scope
  const next = await reissue(session.token, session.scope);
  return { ...session, token: next };
}
`;

const REFRESH_TEST_ALL_THREE =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("refresh after a denial retries with the same scope", () => {});
Deno.test("the permitted operation succeeds on the recovered run", () => {});
`;

const REFRESH_TEST_NO_FAILURE_TERM =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("refresh keeps the same scope", () => {});
Deno.test("the permitted operation succeeds", () => {});
`;

const REFRESH_TEST_NO_NON_WIDENING_TERM =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("refresh after a denial retries", () => {});
Deno.test("the permitted operation succeeds", () => {});
`;

const REFRESH_TEST_NO_RESUMPTION_TERM =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("refresh after a denial keeps the same scope", () => {});
`;

const REFRESH_TEST_ONE_TERM =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("refresh after a denial", () => {});
`;

const REFRESH_TEST_PATH = "tests/session_refresh_test.ts";

function recoveryFindingsOf(
  findings: readonly { capability: string }[],
): { capability: string }[] {
  return findings.filter((finding) => finding.capability === RECOVERY_KIND);
}

Deno.test("an unsafe widening recovery with no tests is a coverage finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: RESTART_PATH, text: WIDENING_RESTART },
  ]);
  assertEquals(scan.status, "findings");
  assertEquals(scan.pass, false);
  const found = recoveryFindingsOf(scan.findings);
  assertEquals(found.length, 1);
  const finding = scan.findings.find((f) => f.capability === RECOVERY_KIND);
  assert(finding);
  assertEquals(finding.path, RESTART_PATH);
  assertEquals(finding.testsInspected, []);
  assertStringIncludes(finding.body, "Tests inspected:** none");
  assertStringIncludes(finding.body, `Production path:** \`${RESTART_PATH}\``);
  assertStringIncludes(finding.body, "not proof of an exploit");
  assertStringIncludes(
    finding.contract,
    "keeps the configured repositories, credential scope, mounts and network guarantee (no broader)",
  );
  assertStringIncludes(
    finding.contract,
    "a permitted operation still succeeds on the recovered run",
  );
});

Deno.test("a same-scope refresh is clean with an executed covering test and a finding without one", async () => {
  const covered = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_ALL_THREE },
  ], { testsExecuted: true });
  assertEquals(covered.findings, []);
  assertEquals(covered.pass, true);

  const uncovered = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
  ]);
  assertEquals(uncovered.pass, false);
  const finding = uncovered.findings.find((f) =>
    f.capability === RECOVERY_KIND
  );
  assert(finding);
  assertEquals(finding.testsInspected, []);
  assertStringIncludes(finding.body, "not proof of an exploit");
});

Deno.test("a fully covered recovery has no finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_ALL_THREE },
  ]);
  assertEquals(recoveryFindingsOf(scan.findings), []);
});

Deno.test("dropping the failure term keeps the recovery finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_NO_FAILURE_TERM },
  ], { testsExecuted: true });
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
  assertEquals(scan.pass, false);
});

Deno.test("dropping the non-widening term keeps the recovery finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_NO_NON_WIDENING_TERM },
  ], { testsExecuted: true });
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
  assertEquals(scan.pass, false);
});

Deno.test("dropping the resumption term keeps the recovery finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_NO_RESUMPTION_TERM },
  ], { testsExecuted: true });
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
  assertEquals(scan.pass, false);
});

Deno.test("a test with one term alone keeps the recovery finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_ONE_TERM },
  ], { testsExecuted: true });
  const finding = scan.findings.find((f) => f.capability === RECOVERY_KIND);
  assert(finding);
  assertEquals(finding.testsInspected, [REFRESH_TEST_PATH]);
});

Deno.test("an authorised recovery-scope-change marker turns the recovery check off", async () => {
  const lower = await scanCapabilityCoverageFiles([{
    path: RESTART_PATH,
    text:
      `// recovery-scope-change: authorised, the operator widened the mounts\n${WIDENING_RESTART}`,
  }]);
  assertEquals(lower.status, "none");
  assertEquals(lower.findings, []);

  const upper = await scanCapabilityCoverageFiles([{
    path: RESTART_PATH,
    text:
      `// Recovery-Scope-Change: AUTHORISED, the operator widened the mounts\n${WIDENING_RESTART}`,
  }]);
  assertEquals(upper.status, "none");
  assertEquals(upper.findings, []);
});

Deno.test("an unrelated HTTP backoff retry is not applicable", async () => {
  const text = `export async function fetchWithBackoff(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    await new Promise((done) => setTimeout(done, 2 ** attempt * 100));
  }
  throw new Error("retry budget exhausted");
}
`;
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/http/backoff.ts",
    text,
  }]);
  assertEquals(scan.status, "none");
  assertEquals(scan.findings, []);
});

Deno.test("a credential signal more than the window from the retry is not applicable", async () => {
  const filler = Array.from(
    { length: 25 },
    (_, i) => `const filler${i} = ${i};`,
  );
  const text = [
    "// on denial, retry the refresh",
    ...filler,
    "const token = await refresh();",
  ].join("\n");
  const scan = await scanCapabilityCoverageFiles([{
    path: REFRESH_PATH,
    text,
  }]);
  assertEquals(scan.status, "none");
  assertEquals(scan.findings, []);
});

Deno.test("a credential signal exactly at the window bound still applies", async () => {
  const filler = Array.from(
    { length: 24 },
    (_, i) => `const filler${i} = ${i};`,
  );
  const text = [
    "// on denial, retry the refresh",
    ...filler,
    "const token = await refresh();",
  ].join("\n");
  assert(altersAuthorityOnRecovery(text));
});

Deno.test("a suppression marker with the real id removes the recovery finding", async () => {
  const id = await coverageFindingId(RECOVERY_KIND, RESTART_PATH);
  const scan = await scanCapabilityCoverageFiles([{
    path: RESTART_PATH,
    text: `${WIDENING_RESTART}\n// best-practice-ignore: ${id}\n`,
  }]);
  assertEquals(scan.findings, []);
  assertEquals(scan.status, "not_checked");
});

Deno.test("an open security issue for the recovery path dedups the filing", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: RESTART_PATH, text: WIDENING_RESTART },
  ]);
  const plan = planCapabilityCoverageFiling(scan, [{
    number: 88,
    title: "security-scan of src/session/restart.ts",
    labels: ["security"],
  }]);
  assertEquals(plan.outcome, "dedup");
  if (plan.outcome === "dedup") {
    assertEquals(plan.existingIssue, 88);
    assertEquals(plan.path, RESTART_PATH);
  }
});

Deno.test("a non-security issue naming the recovery path does not dedup", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: RESTART_PATH, text: WIDENING_RESTART },
  ]);
  const plan = planCapabilityCoverageFiling(scan, [{
    number: 89,
    title: "Tidy src/session/restart.ts",
    labels: ["enhancement"],
  }]);
  assertEquals(plan.outcome, "one");
});

Deno.test("the three older capabilities still fire on their own inputs", async () => {
  const resource = await scanCapabilityCoverageFiles([{
    path: "src/update.ts",
    text: `
export function update(request: { body: { role: string; tenantId: string } }) {
  const role = request.body.role;
  if (request.body.tenantId === "a") return { role };
  return { role };
}
`,
  }]);
  const auth = resource.findings.find((f) =>
    f.capability === "capsec-resource-auth"
  );
  assert(auth);
  assertEquals(recoveryFindingsOf(resource.findings), []);

  const logging = await scanCapabilityCoverageFiles([{
    path: "src/send.ts",
    text: "export function send(secret: string) {\n  console.log(secret);\n}\n",
  }]);
  assert(
    logging.findings.some((f) => f.capability === "capsec-secret-logging"),
  );
  assertEquals(recoveryFindingsOf(logging.findings), []);
});

Deno.test("hostile input: the retry signal pattern rejects a 200k run without hanging", () => {
  const text = `${"x".repeat(200_000)}\ntoken`;
  assertEquals(altersAuthorityOnRecovery(text), false);
});

Deno.test("hostile input: the authority signal pattern rejects a 200k run without hanging", () => {
  const text = `retry on denial\n${"x".repeat(200_000)}`;
  assertEquals(altersAuthorityOnRecovery(text), false);
});

Deno.test("hostile input: the authorised-marker pattern rejects a 200k run without hanging", () => {
  const text = `retry on denial, token refresh\n// recovery-scope-change:${
    " ".repeat(200_000)
  }x`;
  assertEquals(altersAuthorityOnRecovery(text), true);
});

Deno.test("hostile input: the failure-term pattern rejects a 200k run without hanging", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    {
      path: REFRESH_TEST_PATH,
      text:
        `import "../src/session/refresh.ts";\nDeno.test("keeps the same scope, the permitted operation succeeds", () => {});\n${
          "x".repeat(200_000)
        }`,
    },
  ]);
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
});

Deno.test("hostile input: the non-widening pattern rejects a 200k run without hanging", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    {
      path: REFRESH_TEST_PATH,
      text:
        `import "../src/session/refresh.ts";\nDeno.test("after a denial, the permitted operation succeeds", () => {});\n${
          "x".repeat(200_000)
        }`,
    },
  ]);
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
});

Deno.test("hostile input: the resumption pattern rejects a 200k run without hanging", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    {
      path: REFRESH_TEST_PATH,
      text:
        `import "../src/session/refresh.ts";\nDeno.test("after a denial, keeps the same scope", () => {});\n${
          "x".repeat(200_000)
        }`,
    },
  ]);
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
});
