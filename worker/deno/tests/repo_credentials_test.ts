/**
 * Tests for repo_credentials.ts — credentials scoped to the repository that
 * declared them, and minted per run where the provider allows (Issues #573,
 * #574).
 *
 * The incident behind this was a long-lived AWS key: disabled after AWS
 * noticed, then a day spent tracing where it had escaped. A credential minted
 * per run and expiring within the hour is worthless by the time it reaches a
 * log archive — the leak becomes an incident with a clock on it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseMintedCredentials,
  resolveRepoCredentials,
} from "../lib/repo_credentials.ts";

const REPO = "org/needs-aws";

Deno.test("parseMintedCredentials - reads KEY=value, and skips what is not one", () => {
  const parsed = parseMintedCredentials([
    "# minted by sts assume-role",
    "",
    "AWS_ACCESS_KEY_ID=ASIAEXAMPLE",
    // Deliberately low-entropy placeholders: a realistic-looking fake key in
    // a fixture is exactly what the secret scanners should flag, and did.
    'export AWS_SECRET_ACCESS_KEY="example=example"',
    "AWS_SESSION_TOKEN='quoted token'",
    "not a variable line",
    "=novalue",
    "1BAD_NAME=x",
  ].join("\n"));

  assertEquals(parsed.AWS_ACCESS_KEY_ID, "ASIAEXAMPLE");
  // A value containing `=` survives: only the FIRST separator splits.
  assertEquals(parsed.AWS_SECRET_ACCESS_KEY, "example=example");
  assertEquals(parsed.AWS_SESSION_TOKEN, "quoted token");
  // Malformed lines are skipped, never guessed into a surprising variable.
  assertEquals(Object.keys(parsed).sort(), [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ]);
});

Deno.test("resolveRepoCredentials - a repository that declared nothing gets nothing", async () => {
  const result = await resolveRepoCredentials(REPO, undefined, {
    run: () => Promise.reject(new Error("must not run anything")),
  });
  assert(result.ok);
  assertEquals(result.value.env, {});
  assertEquals(result.value.names, []);
});

Deno.test("resolveRepoCredentials - a mint command supplies short-lived credentials", async () => {
  const commands: string[] = [];
  const result = await resolveRepoCredentials(REPO, {
    mint: "aws sts assume-role --role-arn arn:… --output env",
  }, {
    run: (command) => {
      commands.push(command);
      return Promise.resolve({
        code: 0,
        stdout: "AWS_ACCESS_KEY_ID=ASIA1\nAWS_SESSION_TOKEN=tok\n",
        stderr: "",
      });
    },
  });

  assert(result.ok);
  assertEquals(result.value.env.AWS_SESSION_TOKEN, "tok");
  assertEquals(result.value.usedLongLived, false);
  assertEquals(commands.length, 1);
});

Deno.test("resolveRepoCredentials - a failed mint is loud, never a silent run without credentials", async () => {
  // A check that runs without the credential it declared fails later and
  // further from the cause.
  const result = await resolveRepoCredentials(REPO, { mint: "false" }, {
    run: () =>
      Promise.resolve({ code: 1, stdout: "", stderr: "ExpiredToken: …" }),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, REPO);
  assertStringIncludes(result.error.message, "ExpiredToken");
});

Deno.test("resolveRepoCredentials - a mint that produces nothing is a failure too", async () => {
  const result = await resolveRepoCredentials(REPO, { mint: "true" }, {
    run: () =>
      Promise.resolve({ code: 0, stdout: "\n# nothing\n", stderr: "" }),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "no KEY=value lines");
});

Deno.test("resolveRepoCredentials - passthrough works and is reported as long-lived", async () => {
  const warnings: string[] = [];
  const result = await resolveRepoCredentials(REPO, {
    passthrough: ["AWS_ACCESS_KEY_ID", "NOT_SET_ANYWHERE"],
  }, {
    run: () => Promise.reject(new Error("no mint declared")),
    readEnv: (name) => name === "AWS_ACCESS_KEY_ID" ? "AKIA1" : undefined,
    warn: (m) => warnings.push(m),
  });

  assert(result.ok);
  assertEquals(result.value.env.AWS_ACCESS_KEY_ID, "AKIA1");
  // An absent name is simply absent — not an empty string a tool would then
  // treat as a configured-but-blank credential.
  assertEquals("NOT_SET_ANYWHERE" in result.value.env, false);
  assertEquals(result.value.usedLongLived, true);

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "long-lived");
  assertStringIncludes(warnings[0]!, "AWS_ACCESS_KEY_ID");
  // The NAME is reported, never the value — the credential preflight's rule.
  assertEquals(warnings[0]!.includes("AKIA1"), false);
});

Deno.test("resolveRepoCredentials - names are reported, values are not", async () => {
  const result = await resolveRepoCredentials(REPO, { mint: "x" }, {
    run: () => Promise.resolve({ code: 0, stdout: "B=2\nA=1\n", stderr: "" }),
  });
  assert(result.ok);
  assertEquals(result.value.names, ["A", "B"], "sorted names, for a log line");
});
