import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { writeBabysitterAppConfig } from "../lib/fleet_babysitter_app.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

/** The host-local retry record written as `attempt-v2-<signature>.json`. */
interface RetryRecord {
  blockerClass: string;
  lastOutcome: string;
  nextEligibleAt: string | null;
  attempts: { infrastructure: number; substantive: number };
}

/** Real CLI, filesystem and orchestration, with offline GitHub/tool boundaries. */
async function repairScenario(
  scenario: string,
  check: (result: {
    success: boolean;
    stdout: string;
    stderr: string;
    events: string[];
    attempts: string[];
    attemptRecords: RetryRecord[];
    appliedBody: string | undefined;
    proposedBody: string | undefined;
  }) => void,
  passes = 1,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const home = `${root}/home`;
    await Deno.mkdir(home);
    await Deno.mkdir(`${root}/tmp`);
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    );
    const pem = [
      "-----BEGIN " + "PRIVATE KEY-----",
      ...btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!,
      "-----END " + "PRIVATE KEY-----",
      "",
    ].join("\n");
    const privateKeyPath = `${root}/app.pem`;
    await Deno.writeTextFile(privateKeyPath, pem, { mode: 0o600 });
    await writeBabysitterAppConfig(home, {
      appId: "123",
      installationId: "456",
      privateKeyPath,
    });
    const configPath = `${root}/${
      scenario === "default-config" ? ".config.json" : "operator-config.json"
    }`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        repos: ["owner/repo"],
        fleet_pr_authors: ["babysitter[bot]"],
        github_app_private_key_path: `${root}/custom-credential`,
      }),
    );
    const info = await runWithTimeout(Deno.execPath(), ["info", "--json"], {
      timeoutMs: 10_000,
    });
    assert(info.ok);
    assert(info.value.success, info.value.stderr);
    const { denoDir } = JSON.parse(info.value.stdout);
    const runPass = () =>
      runWithTimeout(Deno.execPath(), [
        "run",
        "--allow-all",
        "--cached-only",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        "--preload",
        new URL(
          "./fixtures/fleet_babysitter_repair_preload.ts",
          import.meta.url,
        )
          .pathname,
        new URL("../commands/fleet_pr_babysitter.ts", import.meta.url).pathname,
        "--repo=owner/repo",
        "--pr=1",
      ], {
        cwd: root,
        timeoutMs: 20_000,
        clearEnv: true,
        env: {
          HOME: home,
          TMPDIR: `${root}/tmp`,
          XDG_STATE_HOME: `${root}/state`,
          ...(scenario === "default-config" ? {} : {
            CONFIG_PATH: scenario === "relative-config"
              ? "operator-config.json"
              : configPath,
          }),
          BABYSITTER_REPAIR_FIXTURE: root,
          BABYSITTER_REPAIR_SCENARIO: scenario,
          DENO_DIR: denoDir,
        },
      });
    // Each pass is a fresh process over the same state directory and head.
    let output = await runPass();
    for (let pass = 1; pass < passes; pass++) output = await runPass();
    assert(output.ok);
    // A pass that starts no agent records no event and no attempt.
    let events: string[] = [];
    try {
      events = JSON.parse(await Deno.readTextFile(`${root}/events.json`));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const attempts: string[] = [];
    const attemptRecords: RetryRecord[] = [];
    const stateDir = `${root}/state/vibe-coder/fleet-pr-babysitter`;
    try {
      for await (const entry of Deno.readDir(stateDir)) {
        // The ledgers and audit roster share this directory with attempt
        // markers, which are the only `attempt-v2-*` files (babysitter_retry_state.ts).
        if (entry.isFile && entry.name.startsWith("attempt-v2-")) {
          attempts.push(entry.name);
          attemptRecords.push(
            JSON.parse(await Deno.readTextFile(`${stateDir}/${entry.name}`)),
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let appliedBody: string | undefined;
    try {
      appliedBody = await Deno.readTextFile(`${root}/applied-body.md`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    let proposedBody: string | undefined;
    try {
      proposedBody = await Deno.readTextFile(`${root}/proposed-body.md`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    check({
      ...output.value,
      events,
      attempts,
      attemptRecords,
      appliedBody,
      proposedBody,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

for (const scenario of ["ready", "multiline-ready"]) {
  Deno.test(`babysitter CLI revalidates ${scenario} retry before committing`, async () => {
    await repairScenario(scenario, (result) => {
      assertEquals(result.success, true, result.stderr);
      assertEquals(result.events, [
        "agent-1",
        "gate-1",
        "agent-2",
        "gate-2",
        "staged",
        "committed",
        "pushed",
      ]);
      assertEquals(result.appliedBody, undefined);
      assertStringIncludes(
        result.stdout,
        "Runner validation passed: ./quality.sh",
      );
      assertEquals(result.attempts.length, 1);
    });
  });
}

for (
  const [scenario, cause] of [
    ["not-ready", "repair agent did not report runner findings fixed"],
    ["missing-response", "agent did not write its completion response"],
    ["agent-failed", "agent failed to repair runner validation findings"],
    [
      "lock-lost-before-spawn",
      "PR lock renewal failed; refusing to retry agent",
    ],
    [
      "lock-lost-after-spawn",
      "agent failed to repair runner validation findings",
    ],
  ]
) {
  Deno.test(`babysitter CLI refuses commit after ${scenario}`, async () => {
    await repairScenario(scenario!, (result) => {
      assertEquals(result.success, false, result.stdout);
      assertStringIncludes(result.stderr, cause!);
      assertEquals(result.events.filter((event) => event.startsWith("gate-")), [
        "gate-1",
      ]);
      assert(!result.events.includes("committed"));
      assert(!result.events.includes("pushed"));
      assertEquals(result.appliedBody, undefined);
      assertEquals(result.attempts.length, 1);
    });
  });
}

Deno.test("babysitter CLI retains attempt after a second failed gate", async () => {
  await repairScenario("still-failing", (result) => {
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "browser assertion failed");
    assertEquals(result.events, ["agent-1", "gate-1", "agent-2", "gate-2"]);
    assertEquals(result.attempts.length, 1);
    assertEquals(result.appliedBody, undefined);
  });
});

Deno.test("babysitter CLI preserves current closing references in a retry body proposal", async () => {
  await repairScenario("body-proposal", (result) => {
    assertEquals(result.success, true, result.stderr);
    assertEquals(result.proposedBody, "Repaired browser check\n\nCloses\n#42");
    assertEquals(result.events, [
      "agent-1",
      "gate-1",
      "agent-2",
      "gate-2",
      "staged",
      "committed",
      "pushed",
      "body-updated",
    ]);
    assertEquals(result.appliedBody, "Repaired browser check\n\nCloses\n#42");
  });
});

// A missing runner capability is recoverable: it is retried later on a capable
// host (Issue #4656), so it is recorded as a capability retry, not a repair attempt.
Deno.test("babysitter CLI records an unavailable runner as a capability retry, not a repair attempt", async () => {
  await repairScenario("unavailable", (result) => {
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "Runner validation unavailable");
    assertEquals(result.events, ["agent-1", "gate-1"]);
    assertEquals(result.attempts.length, 1);
    const [record] = result.attemptRecords;
    assertEquals(record!.blockerClass, "capability");
    assertEquals(record!.attempts.substantive, 0);
    assertEquals(record!.attempts.infrastructure, 1);
    assert(
      record!.nextEligibleAt !== null &&
        Date.parse(record!.nextEligibleAt) > Date.now(),
      `nextEligibleAt must be a future time: ${record!.nextEligibleAt}`,
    );
    assertStringIncludes(record!.lastOutcome, "Runner validation unavailable");
    assertEquals(result.appliedBody, undefined);
  });
});

Deno.test("babysitter CLI refuses a HEAD change after a ready retry", async () => {
  await repairScenario("head-change", (result) => {
    assertEquals(result.success, false);
    assertStringIncludes(
      result.stderr,
      "repair agent changed HEAD; refusing to commit",
    );
    assertEquals(result.events, ["agent-1", "gate-1", "agent-2"]);
    assertEquals(result.attempts.length, 1);
    assertEquals(result.appliedBody, undefined);
  });
});

for (const scenario of ["default-config", "relative-config"]) {
  Deno.test(`babysitter CLI resolves ${scenario} before validation`, async () => {
    await repairScenario(scenario, (result) => {
      assertEquals(result.success, true, result.stderr);
      assertEquals(result.events, [
        "agent-1",
        "gate-1",
        "agent-2",
        "gate-2",
        "staged",
        "committed",
        "pushed",
      ]);
    });
  });
}

Deno.test("babysitter CLI preserves Linux agent-validated repairs", async () => {
  await repairScenario("linux", (result) => {
    assertEquals(result.success, true, result.stderr);
    assertEquals(result.events, ["agent-1", "staged", "committed", "pushed"]);
  });
});

for (const scenario of ["linux-symlink", "linux-oversized"]) {
  Deno.test(`babysitter CLI preserves agent validation with ${scenario} gate`, async () => {
    await repairScenario(scenario, (result) => {
      assertEquals(result.success, true, result.stderr);
      assertEquals(result.events, ["agent-1", "staged", "committed", "pushed"]);
    });
  });
}

Deno.test("babysitter CLI reports an unavailable sandbox probe and starts no agent", async () => {
  await repairScenario("probe-unavailable", (result) => {
    assertEquals(result.success, false);
    assertStringIncludes(result.stderr, "Runner validation unavailable");
    assertStringIncludes(
      result.stderr,
      "sandbox_apply: Operation not permitted",
    );
    assertEquals(result.events, []);
    assertEquals(result.attempts.length, 1);
    assertEquals(result.attemptRecords[0]!.blockerClass, "capability");
    assertEquals(result.attemptRecords[0]!.attempts.substantive, 0);
    assertEquals(result.attemptRecords[0]!.attempts.infrastructure, 1);
    assertEquals(result.appliedBody, undefined);
  });
});

// Two passes over the same head: the probe fails before any agent session, and
// the capability backoff holds the second pass, which neither starts an agent
// nor records a second retry.
Deno.test("babysitter CLI holds a probe-unavailable head across passes without a second record", async () => {
  await repairScenario("probe-unavailable", (result) => {
    assertEquals(result.events, []);
    assertEquals(result.attempts.length, 1);
    const [record] = result.attemptRecords;
    assertEquals(record!.blockerClass, "capability");
    assertEquals(record!.attempts.substantive, 0);
    assertEquals(record!.attempts.infrastructure, 1);
    assertStringIncludes(
      record!.lastOutcome,
      "sandbox_apply: Operation not permitted",
    );
    assertEquals(result.appliedBody, undefined);
  }, 2);
});
