/**
 * Recovery-boundary coverage scan (Issue #4417).
 *
 * A retry, restart or fallback line near a credential, mount or identity
 * alteration must keep the configured authority, and a test must exercise that
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
  const broader = { credential: "org-admin-token", mounts: [...config.mounts, "/"] };
  return retry(() => launch(["--volume", "/:/host"], broader));
}
`;

const SAME_SCOPE_REFRESH =
  `export async function refreshSession(session: { token: string; scope: string }) {
  const next = await retry(() => reissue(session.token, session.scope));
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

const REFRESH_TEST_GENERIC =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("retry, restart and recover are wired", () => {});
Deno.test("preserves the response body and succeed on the happy path", () => {});
`;

const REFRESH_TEST_BARE_PRESERVES =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("after a denial, the refresh preserves the response body", () => {});
Deno.test("the permitted operation succeeds", () => {});
`;

const REFRESH_TEST_PRESERVES_CONFIGURED =
  `import { refreshSession } from "../src/session/refresh.ts";
Deno.test("after a denial, the refresh preserves the configured scope", () => {});
Deno.test("the permitted operation succeeds", () => {});
`;

const REFRESH_TEST_PATH = "tests/session_refresh_test.ts";

const COMMENT_RETRY_MOUNT = [
  "// retry the launch after a denial, keeping the same scope",
  "export function launchArgs(base: string[]) {",
  '  return launch(["--mount", base[0]]);',
  "}",
].join("\n");

const TRAILING_COMMENT_RETRY_MOUNT = [
  "export function launchArgs(base: string[]) {",
  '  return launch(["--mount", base[0]]); // retry on denial',
  "}",
].join("\n");

const COMMENT_ONLY_AUTHORITY = [
  "export async function retryOnce(run: () => Promise<void>) {",
  "  // the token and the mount are not touched here",
  "  await retry(run);",
  "}",
].join("\n");

const AUTH_HEADER_RETRY = [
  "export async function fetchAuthorised(url: string, token: string) {",
  "  const res = await retry(() => fetch(url, { headers: { Authorization: `Bearer ${token}` } }));",
  "  return res;",
  "}",
].join("\n");

const SWAP_ON_RETRY = [
  "export async function retryWithBroaderCredential(credential: string, broader: string) {",
  "  return retry(() => swap(credential, broader));",
  "}",
].join("\n");

const MOUNT_ON_RETRY = [
  "export async function retryWithExtraMount() {",
  '  return retry(() => launch(["--mount", "/data"]));',
  "}",
].join("\n");

function filler(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `const filler${i} = ${i};`);
}

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

Deno.test("a generic retry, restart or recover test with no failure injection is still a finding", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_GENERIC },
  ], { testsExecuted: true });
  const finding = scan.findings.find((f) => f.capability === RECOVERY_KIND);
  assert(finding);
  assertEquals(finding.testsInspected, [REFRESH_TEST_PATH]);
  assertEquals(scan.pass, false);
});

Deno.test("a bare preserves without the configured, same or existing object is not non-widening", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_BARE_PRESERVES },
  ], { testsExecuted: true });
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
  assertEquals(scan.pass, false);
});

Deno.test("preserves the configured scope satisfies the non-widening term", async () => {
  const scan = await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    { path: REFRESH_TEST_PATH, text: REFRESH_TEST_PRESERVES_CONFIGURED },
  ]);
  assertEquals(recoveryFindingsOf(scan.findings), []);
});

Deno.test("an authorised recovery-scope-change marker on a comment line turns the recovery check off", async () => {
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

Deno.test("an authorised marker inside a string literal does not exempt the file", async () => {
  const scan = await scanCapabilityCoverageFiles([{
    path: RESTART_PATH,
    text:
      `const note = "// recovery-scope-change: authorised, the operator widened the mounts";\n${WIDENING_RESTART}`,
  }]);
  assertEquals(scan.status, "findings");
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
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

Deno.test("a retry that sends an Authorization token header is not applicable", async () => {
  assertEquals(altersAuthorityOnRecovery(AUTH_HEADER_RETRY), false);
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/http/authorised_fetch.ts",
    text: AUTH_HEADER_RETRY,
  }]);
  assertEquals(recoveryFindingsOf(scan.findings), []);
});

Deno.test("a retry that swaps in a broader credential is applicable", async () => {
  assert(altersAuthorityOnRecovery(SWAP_ON_RETRY));
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/session/swap.ts",
    text: SWAP_ON_RETRY,
  }]);
  assertEquals(recoveryFindingsOf(scan.findings).length, 1);
});

Deno.test("a retry that adds a --mount flag is applicable without an alteration verb", () => {
  assert(altersAuthorityOnRecovery(MOUNT_ON_RETRY));
});

Deno.test("a retry only in a comment near a --mount line is not applicable", async () => {
  assertEquals(altersAuthorityOnRecovery(COMMENT_RETRY_MOUNT), false);
  assertEquals(altersAuthorityOnRecovery(TRAILING_COMMENT_RETRY_MOUNT), false);
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/mounts/launch.ts",
    text: COMMENT_RETRY_MOUNT,
  }]);
  assertEquals(scan.status, "none");
});

Deno.test("an authority word only in a comment is not applicable", async () => {
  assertEquals(altersAuthorityOnRecovery(COMMENT_ONLY_AUTHORITY), false);
  const scan = await scanCapabilityCoverageFiles([{
    path: "src/retry_once.ts",
    text: COMMENT_ONLY_AUTHORITY,
  }]);
  assertEquals(scan.status, "none");
});

Deno.test("a credential signal more than the window from the retry is not applicable", async () => {
  const text = [
    "await retry(refresh);",
    ...filler(25),
    "const token = await refresh();",
  ].join("\n");
  const scan = await scanCapabilityCoverageFiles([{
    path: REFRESH_PATH,
    text,
  }]);
  assertEquals(scan.status, "none");
  assertEquals(scan.findings, []);
});

Deno.test("a credential signal exactly at the window bound still applies", () => {
  const text = [
    "await retry(refresh);",
    ...filler(24),
    "const token = await refresh();",
  ].join("\n");
  assert(altersAuthorityOnRecovery(text));
});

Deno.test("an authority line more than the window before the recovery is not applicable", () => {
  const text = [
    "const token = await refresh();",
    ...filler(25),
    "await retry(run);",
  ].join("\n");
  assertEquals(altersAuthorityOnRecovery(text), false);
});

Deno.test("an authority line exactly at the window bound before the recovery still applies", () => {
  const text = [
    "const token = await refresh();",
    ...filler(24),
    "await retry(run);",
  ].join("\n");
  assert(altersAuthorityOnRecovery(text));
});

/** Each look-alike has a retry on line 1, so only the look-alike line could make it apply. */
const LOOK_ALIKE_NEGATIVES: Array<[string, string]> = [
  ["tokens.push(x)", ["await retry(run);", "tokens.push(x);"].join("\n")],
  [
    "switch (token.kind)",
    ["await retry(run);", "switch (token.kind) {", "  default:", "}"].join(
      "\n",
    ),
  ],
  [
    'token.replace("Bearer ", "")',
    ["await retry(run);", 'const raw = token.replace("Bearer ", "");'].join(
      "\n",
    ),
  ],
  ["user.uid", ["await retry(run);", "const id = user.uid;"].join("\n")],
  [
    "curl --user-agent",
    ["await retry(run);", 'const args = ["curl", "--user-agent", url];'].join(
      "\n",
    ),
  ],
  [
    'React fallback= prop near credentials: "include"',
    [
      "export function Panel(url: string) {",
      "  return (",
      "    <Boundary fallback={<Spinner />}>",
      '      {fetch(url, { credentials: "include" })}',
      "    </Boundary>",
      "  );",
      "}",
    ].join("\n"),
  ],
  [
    "retry word in a logger string literal",
    [
      "export function report(token: string) {",
      '  logger.info("retry after token refresh");',
      "}",
    ].join("\n"),
  ],
  [
    "multi-line block comment holding the signals",
    [
      "await retry(run);",
      "/*",
      " * swap the token, add --mount and reload the mounts",
      " * for a broader credential",
      " */",
      "export const ready = true;",
    ].join("\n"),
  ],
];

for (const [name, text] of LOOK_ALIKE_NEGATIVES) {
  Deno.test(`a look-alike is not applicable: ${name}`, () => {
    assertEquals(altersAuthorityOnRecovery(text), false);
  });
}

/** Real triggers that must still apply after the word and comment rules. */
const REAL_TRIGGER_POSITIVES: Array<[string, string]> = [
  [
    "swapCredential( on a retry",
    ["await retry(run);", "swapCredential(session);"].join("\n"),
  ],
  [
    "useBroaderCredential on a retry",
    ["await retry(run);", "const session = useBroaderCredential(config);"].join(
      "\n",
    ),
  ],
  [
    "credential = broaderCredential on a retry",
    ["await retry(run);", "credential = broaderCredential;"].join("\n"),
  ],
  [
    "a TS private field #token = ... is code, not a comment",
    ["await retry(run);", "  #token = await refresh();"].join("\n"),
  ],
  [
    "a --user flag on a retry",
    ["await retry(run);", 'const args = ["--user", "1000:1000"];'].join("\n"),
  ],
  [
    "runArgs mutation on restart",
    [
      "export async function restart(session: { runArgs: string[] }) {",
      "  session.runArgs.push(extra);",
      "  return retry(() => launch(session));",
      "}",
    ].join("\n"),
  ],
];

for (const [name, text] of REAL_TRIGGER_POSITIVES) {
  Deno.test(`a real trigger is applicable: ${name}`, () => {
    assert(altersAuthorityOnRecovery(text));
  });
}

// Operands of the marker test: present before comment stripping (in a comment)
// and absent after it. Each operand has its own case.
Deno.test("an authorised marker inside a block comment turns the recovery check off", async () => {
  const scan = await scanCapabilityCoverageFiles([{
    path: RESTART_PATH,
    text:
      `/* recovery-scope-change: authorised, the operator widened the mounts */\n${WIDENING_RESTART}`,
  }]);
  assertEquals(scan.status, "none");
  assertEquals(scan.findings, []);
});

Deno.test("an authorised marker outside any comment or string does not exempt the file", () => {
  const text = [
    "recovery-scope-change: authorised, the operator widened the mounts",
    "await retry(run);",
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

// Each hostile test checks two things: the 200k run alone is rejected, and the
// same run with a real trigger at its end is applied. The second assertion
// shows the pattern under test actually ran over the long line.

Deno.test("hostile input: the retry signal pattern rejects a 200k run without hanging", () => {
  const head = "const token = await refresh();\n";
  const run = "retr".repeat(50_000);
  assertEquals(altersAuthorityOnRecovery(`${head}${run}`), false);
  assert(altersAuthorityOnRecovery(`${head}${run} retry`));
});

Deno.test("hostile input: the authority flag pattern rejects a 200k run without hanging", () => {
  const head = "retry on denial\n";
  const run = "x".repeat(200_000);
  assertEquals(altersAuthorityOnRecovery(`${head}${run}`), false);
  assert(altersAuthorityOnRecovery(`${head}${run} --mount`));
});

Deno.test("hostile input: the authority noun pattern rejects a 200k run without hanging", () => {
  const head = "retry on denial\n";
  const run = "tokex ".repeat(33_334);
  assertEquals(altersAuthorityOnRecovery(`${head}${run}`), false);
  assert(altersAuthorityOnRecovery(`${head}${run}token swap`));
});

Deno.test("hostile input: the authority verb pattern rejects a 200k run without hanging", () => {
  const head = "retry on denial\n";
  const run = "swapx ".repeat(40_000);
  assertEquals(altersAuthorityOnRecovery(`${head}token ${run}!`), false);
  assert(altersAuthorityOnRecovery(`${head}token ${run}swap`));
});

Deno.test("hostile input: the authorised-marker pattern rejects a 200k run without hanging", () => {
  const head = "retry on denial, token refresh\n// recovery-scope-change:";
  const spaces = " ".repeat(200_000);
  assertEquals(altersAuthorityOnRecovery(`${head}${spaces}x`), true);
  assertEquals(altersAuthorityOnRecovery(`${head}${spaces}authorised`), false);
});

/** Scan the refresh production file with one test file whose text is `testText`. */
async function scanRefreshWithTest(testText: string) {
  return await scanCapabilityCoverageFiles([
    { path: REFRESH_PATH, text: SAME_SCOPE_REFRESH },
    {
      path: REFRESH_TEST_PATH,
      text: `import "../src/session/refresh.ts";\n${testText}`,
    },
  ]);
}

Deno.test("hostile input: the failure-term pattern rejects a 200k run without hanging", async () => {
  const run = "x".repeat(200_000);
  const hostile = await scanRefreshWithTest(
    `Deno.test("retry, restart and recover keep the same scope, the permitted operation succeeds", () => {});\n${run}`,
  );
  assertEquals(recoveryFindingsOf(hostile.findings).length, 1);
  const reached = await scanRefreshWithTest(
    `Deno.test("retry, restart and recover keep the same scope, the permitted operation succeeds", () => {});\n${run} denied`,
  );
  assertEquals(recoveryFindingsOf(reached.findings).length, 0);
});

Deno.test("hostile input: the non-widening pattern rejects a 200k run without hanging", async () => {
  const run = "x".repeat(200_000);
  const hostile = await scanRefreshWithTest(
    `Deno.test("after a denial, preserves the permitted operation succeeds", () => {});\n${run}`,
  );
  assertEquals(recoveryFindingsOf(hostile.findings).length, 1);
  const reached = await scanRefreshWithTest(
    `Deno.test("after a denial, preserves the permitted operation succeeds", () => {});\n${run} preserves the same scope`,
  );
  assertEquals(recoveryFindingsOf(reached.findings).length, 0);
});

Deno.test("hostile input: the resumption pattern rejects a 200k run without hanging", async () => {
  const run = "x".repeat(200_000);
  const hostile = await scanRefreshWithTest(
    `Deno.test("after a denial, keeps the same scope", () => {});\n${run}`,
  );
  assertEquals(recoveryFindingsOf(hostile.findings).length, 1);
  const reached = await scanRefreshWithTest(
    `Deno.test("after a denial, keeps the same scope", () => {});\n${run} succeeds`,
  );
  assertEquals(recoveryFindingsOf(reached.findings).length, 0);
});
