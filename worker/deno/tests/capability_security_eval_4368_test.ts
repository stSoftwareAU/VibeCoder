/**
 * Local capability-security evaluation (Issue #4368).
 *
 * Fixture arms are scored. Live model arms stay skipped. A missing cost
 * is unknown. Tampering with the acceptance tests is an error.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CommandRunner,
  defaultCommandRunner,
  EVAL_ARMS,
  runCapabilitySecurityEval,
  scoreTestOutput,
} from "../lib/capability_security_eval.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

Deno.test("scoreTestOutput keeps functionality and security apart", () => {
  const secure = scoreTestOutput(
    [
      "functional: authorised update persists ... ok (1ms)",
      "security: cross-tenant rejected ... ok (1ms)",
      "security: privileged field rejected ... ok (1ms)",
    ].join("\n"),
    true,
  );
  assertEquals(secure.functional.pass, true);
  assertEquals(secure.security.pass, true);

  const deny = scoreTestOutput(
    [
      "functional: authorised update persists ... FAILED (1ms)",
      "security: cross-tenant rejected ... ok (1ms)",
      "security: privileged field rejected ... ok (1ms)",
    ].join("\n"),
    true,
  );
  assertEquals(deny.functional.pass, false);
  assertEquals(deny.security.pass, true);

  const compile = scoreTestOutput("error: could not compile", true);
  assertEquals(compile.functional.executed, false);
  assertEquals(compile.security.pass, false);
  assertEquals(compile.functional.pass, false);
});

Deno.test("a spawn failure is retried once and then recorded", async () => {
  let denoCalls = 0;
  const runner: CommandRunner = (command) => {
    if (command === "deno") {
      denoCalls += 1;
      return Promise.resolve({
        code: null,
        stdout: "",
        stderr: "deno could not start",
      });
    }
    return Promise.resolve({ code: null, stdout: "", stderr: "no cargo" });
  };
  const artefact = await runCapabilitySecurityEval({ root: ROOT, runner });
  const empty = artefact.outcomes.find((item) =>
    item.task === "ts-resource-update" && item.arm === "empty"
  );
  assert(empty);
  assertEquals(empty.retries, 1);
  assertEquals(empty.functional.pass, false);
  assertEquals(empty.security.pass, false);
  assert(denoCalls >= 2);
});

Deno.test("an edited acceptance test is an error, not a pass", async () => {
  const runner: CommandRunner = async (command, _args, cwd) => {
    if (command === "deno") {
      await Deno.writeTextFile(`${cwd}/accept_test.ts`, "// tampered\n");
      return {
        code: 0,
        stdout: "functional: authorised update persists ... ok\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const artefact = await runCapabilitySecurityEval({ root: ROOT, runner });
  const secure = artefact.outcomes.find((item) =>
    item.task === "ts-resource-update" && item.arm === "secure"
  );
  assert(secure);
  assertStringIncludes(secure.detail, "acceptance tests were modified");
  assertEquals(secure.joint, false);
  assertEquals(secure.security.pass, false);
});

Deno.test("the fixture runner does not inherit a worker credential", async () => {
  const previous = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "super-secret-token");
  try {
    const result = await defaultCommandRunner(
      "printenv",
      ["GH_TOKEN"],
      Deno.cwd(),
    );
    assertEquals(result.stdout.includes("super-secret-token"), false);
    assertEquals(result.stderr.includes("super-secret-token"), false);
  } finally {
    if (previous === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", previous);
  }
});

Deno.test("a failed isolation provision is recorded and the fixture is not executed", async () => {
  let ran = false;
  const runner: CommandRunner = () => {
    ran = true;
    return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
  };
  const artefact = await runCapabilitySecurityEval(
    {
      root: ROOT,
      runner,
      isolationAvailable: () => false,
    } as Parameters<typeof runCapabilitySecurityEval>[0],
  );
  assertEquals(ran, false);
  const blocked = artefact.outcomes.filter((item) =>
    item.detail.toLowerCase().includes("isolation")
  );
  assertEquals(blocked.length, artefact.outcomes.length);
  for (const outcome of artefact.outcomes) {
    assertEquals(outcome.functional.executed, false);
    assertEquals(outcome.security.executed, false);
    assertEquals(outcome.joint, false);
  }
});

Deno.test("the fixture child does not receive the worker environment or network", async () => {
  const seen: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }[] = [];
  const runner: CommandRunner = (command, args, _cwd, env) => {
    seen.push({ command, args, ...(env ? { env } : {}) });
    return Promise.resolve({
      code: 0,
      stdout: [
        "functional: authorised update persists ... ok",
        "security: cross-tenant rejected ... ok",
        "security: privileged field rejected ... ok",
      ].join("\n"),
      stderr: "",
    });
  };
  await runCapabilitySecurityEval(
    {
      root: ROOT,
      runner,
      envSource: {
        PATH: "/usr/bin",
        HOME: "/tmp/capsec-home",
        GH_TOKEN: "super-secret-token",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      },
    } as Parameters<typeof runCapabilitySecurityEval>[0],
  );
  assert(seen.length > 0);
  for (const call of seen) {
    const env = call.env ?? {};
    assertEquals(env.GH_TOKEN, undefined);
    assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assertEquals(JSON.stringify(env).includes("super-secret-token"), false);
    assertEquals(JSON.stringify(env).includes("oauth-secret"), false);
    assertEquals(call.args.includes("--allow-net"), false);
    if (call.command === "deno") {
      assert(call.args.some((arg) => arg.includes("deny-net")));
      assert(call.args.some((arg) => arg.includes("max-old-space-size")));
      assertEquals(
        call.args.includes("--allow-env"),
        false,
        "the fixture must not be granted the whole environment",
      );
    }
    if (call.command === "cargo") {
      assert(call.args.includes("--offline"));
      assertEquals(env.CARGO_BUILD_JOBS, "1");
    }
  }
});

Deno.test("fixture arms score as specified and the live comparison stays partial", async () => {
  const artefact = await runCapabilitySecurityEval({ root: ROOT });
  const ts = (arm: string) => {
    const found = artefact.outcomes.find((item) =>
      item.task === "ts-resource-update" && item.arm === arm
    );
    if (!found) throw new Error(`missing ts arm ${arm}`);
    return found;
  };
  assertEquals(ts("secure").functional.pass, true);
  assertEquals(ts("secure").security.pass, true);
  assertEquals(ts("secure").joint, true);
  assertEquals(ts("insecure").functional.pass, true);
  assertEquals(ts("insecure").security.pass, false);
  assertEquals(ts("deny_all").functional.pass, false);
  assertEquals(ts("deny_all").security.pass, true);
  for (const arm of ["empty", "stub", "unwired", "unconditional"] as const) {
    assertEquals(ts(arm).functional.pass, false, arm);
    assertEquals(ts(arm).security.pass, false, arm);
  }
  const rust = (arm: string) => {
    const found = artefact.outcomes.find((item) =>
      item.task === "rust-resource-update" && item.arm === arm
    );
    if (!found) throw new Error(`missing rust arm ${arm}`);
    return found;
  };
  assertEquals(rust("secure").joint, true, rust("secure").detail);
  assertEquals(rust("insecure").functional.pass, true);
  assertEquals(rust("insecure").security.pass, false);
  assertEquals(rust("deny_all").functional.pass, false);
  assertEquals(rust("deny_all").security.pass, true);
  for (const arm of ["empty", "stub", "unwired", "unconditional"] as const) {
    assertEquals(rust(arm).functional.pass, false, arm);
    assertEquals(rust(arm).security.pass, false, arm);
  }
  assertEquals(artefact.liveComparison, "partial");
  assertEquals(artefact.winner, null);
  assertEquals(artefact.cost.status, "unknown");
  assertEquals(JSON.stringify(artefact.cost).includes(":0"), false);
  for (
    const arm of [
      "current-guidance",
      "generic-secure-coding",
      "codeguard-derived",
    ]
  ) {
    assert(artefact.skips.some((skip) => skip.arm === arm));
  }
  assertStringIncludes(artefact.retryPath, "Re-run");
  assertEquals(artefact.outcomes.length, EVAL_ARMS.length * 2);
});
