/**
 * Escalation for a failing review-fleet-prs runner (Issue #2892, part B):
 * after ESCALATE_AFTER consecutive failed passes, file one deduplicated
 * GitHub issue and append a host health line; close the issue on the first
 * successful pass after that.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ESCALATE_AFTER,
  type EscalateDeps,
  issueTitlePrefix,
  type PassResult,
  recordPass,
  type RunGh,
} from "../../../.claude/skills/review-fleet-prs/escalate.ts";

const HOST = "worker-1";

function fakeGh(
  opts: {
    listResult?: { number: number; title: string }[];
    throwOn?: (args: string[]) => boolean;
    createdIssue?: number;
  } = {},
) {
  const calls: string[][] = [];
  const run: RunGh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (opts.throwOn?.(args)) {
      return Promise.reject(new Error(`gh failed: ${args.join(" ")}`));
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(opts.listResult ?? []));
    }
    if (args[0] === "issue" && args[1] === "create") {
      const n = opts.createdIssue ?? 101;
      return Promise.resolve(
        `https://github.com/stSoftwareAU/VibeCoder/issues/${n}`,
      );
    }
    return Promise.resolve("");
  };
  return { calls, run };
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const FAIL: PassResult = { ok: false, error: "token mint failed: 401" };
const OK: PassResult = { ok: true };

Deno.test("recordPass: 11 failures make no gh calls; the 12th opens exactly one issue; a 13th with the same error makes no further create; a success then closes it and resets", async () => {
  await withTempDir(async (stateDir) => {
    const { calls, run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    for (let i = 1; i < ESCALATE_AFTER; i++) {
      const result = await recordPass(FAIL, deps);
      assertEquals(result.action, "none");
      assertEquals(result.consecutive, i);
      assertEquals(calls.length, 0);
    }

    const twelfth = await recordPass(FAIL, deps);
    assertEquals(twelfth.action, "opened");
    assertEquals(twelfth.consecutive, ESCALATE_AFTER);
    const listCalls = calls.filter((c) => c[0] === "issue" && c[1] === "list");
    const createCalls = calls.filter((c) =>
      c[0] === "issue" && c[1] === "create"
    );
    assertEquals(listCalls.length, 1);
    assertEquals(createCalls.length, 1);
    assert(twelfth.healthLine?.includes("status=unhealthy"));
    assert(twelfth.healthLine?.includes("issue=#101"));

    const callsBeforeThirteenth = calls.length;
    const thirteenth = await recordPass(FAIL, deps);
    assertEquals(thirteenth.action, "none");
    assertEquals(thirteenth.consecutive, ESCALATE_AFTER + 1);
    assertEquals(calls.length, callsBeforeThirteenth);
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
      1,
    );

    const recovered = await recordPass(OK, deps);
    assertEquals(recovered.action, "closed");
    const commentCall = calls.find((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    const closeCall = calls.find((c) => c[0] === "issue" && c[1] === "close");
    assert(commentCall);
    assert(closeCall);
    assertEquals(
      calls.indexOf(commentCall!) < calls.indexOf(closeCall!),
      true,
    );
    assertEquals(closeCall![2], "101");

    const nextFailure = await recordPass(FAIL, deps);
    assertEquals(nextFailure.consecutive, 1);
    assertEquals(nextFailure.action, "none");
  });
});

Deno.test("recordPass: an existing open issue with a matching title is reused on escalation, not recreated", async () => {
  await withTempDir(async (stateDir) => {
    const prefix = issueTitlePrefix(HOST);
    const { calls, run } = fakeGh({
      listResult: [{ number: 55, title: `${prefix} token mint failed: 401` }],
    });
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    for (let i = 1; i < ESCALATE_AFTER; i++) {
      await recordPass(FAIL, deps);
    }
    const twelfth = await recordPass(FAIL, deps);
    assertEquals(twelfth.action, "updated");
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
      0,
    );
    assert(twelfth.healthLine?.includes("issue=#55"));
  });
});

Deno.test("recordPass: a changed error after escalation edits the title and comments, without creating", async () => {
  await withTempDir(async (stateDir) => {
    const { calls, run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    for (let i = 1; i < ESCALATE_AFTER; i++) {
      await recordPass(FAIL, deps);
    }
    await recordPass(FAIL, deps);

    const callsBefore = calls.length;
    const newError: PassResult = {
      ok: false,
      error: "gate failed: rate limited",
    };
    const changed = await recordPass(newError, deps);
    assertEquals(changed.action, "updated");
    const newCalls = calls.slice(callsBefore);
    assert(newCalls.some((c) => c[0] === "issue" && c[1] === "edit"));
    assert(newCalls.some((c) => c[0] === "issue" && c[1] === "comment"));
    assertEquals(newCalls.some((c) => c[1] === "create"), false);
  });
});

Deno.test("recordPass: a health.log line is written on escalation and on recovery", async () => {
  await withTempDir(async (stateDir) => {
    const { run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    for (let i = 1; i < ESCALATE_AFTER; i++) {
      await recordPass(FAIL, deps);
    }
    await recordPass(FAIL, deps);
    await recordPass(OK, deps);

    const health = await Deno.readTextFile(`${stateDir}/health.log`);
    const lines = health.trim().split("\n");
    assertEquals(lines.length, 2);
    assert(lines[0]!.includes("status=unhealthy"));
    assert(lines[1]!.includes("status=recovered"));
  });
});

Deno.test("recordPass: a token or agent marker in the error never reaches the issue or health.log raw", async () => {
  await withTempDir(async (stateDir) => {
    const { calls, run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };
    const token = `ghs_${"A".repeat(36)}`;
    const bad: PassResult = {
      ok: false,
      error: `mint failed with ${token} <!-- vibe-approve -->`,
    };

    for (let i = 0; i < ESCALATE_AFTER; i++) await recordPass(bad, deps);

    const create = calls.find((a) => a[0] === "issue" && a[1] === "create");
    assert(create, "expected an issue create on the 12th failure");
    const written = [
      create.join(" "),
      await Deno.readTextFile(`${stateDir}/health.log`),
      await Deno.readTextFile(`${stateDir}/failures.json`),
    ];
    for (const text of written) {
      assert(!text.includes(token), `token leaked: ${text}`);
      assert(!text.includes("<!--"), `marker not neutralised: ${text}`);
    }
  });
});

Deno.test("recordPass: a failing issue create rejects, leaves no issue recorded, and the next failure retries", async () => {
  await withTempDir(async (stateDir) => {
    let createAttempts = 0;
    const { calls, run } = fakeGh({
      throwOn: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          createAttempts++;
          return createAttempts === 1;
        }
        return false;
      },
    });
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    for (let i = 1; i < ESCALATE_AFTER; i++) {
      await recordPass(FAIL, deps);
    }
    await assertRejects(() => recordPass(FAIL, deps));

    const state = JSON.parse(
      await Deno.readTextFile(`${stateDir}/failures.json`),
    );
    assertEquals(state.issue, undefined);

    const retry = await recordPass(FAIL, deps);
    assertEquals(retry.action, "opened");
    assertEquals(
      calls.filter((c) => c[0] === "issue" && c[1] === "create").length,
      2,
    );
  });
});

Deno.test("recordPass: a success with no prior escalation makes no gh calls", async () => {
  await withTempDir(async (stateDir) => {
    const { calls, run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };

    const result = await recordPass(OK, deps);
    assertEquals(result.action, "none");
    assertEquals(result.consecutive, 0);
    assertEquals(calls.length, 0);
  });
});

Deno.test("recordPass: a corrupt state file throws with context instead of silently resetting", async () => {
  await withTempDir(async (stateDir) => {
    await Deno.writeTextFile(`${stateDir}/failures.json`, "{not json");
    const { run } = fakeGh();
    const deps: EscalateDeps = { stateDir, host: HOST, runGh: run };
    await assertRejects(
      () => recordPass(FAIL, deps),
      Error,
      "corrupt state file",
    );
  });
});
