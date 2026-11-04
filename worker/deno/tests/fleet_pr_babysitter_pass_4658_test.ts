import { assertEquals } from "@std/assert";
import {
  pass,
  recordBabysitterDeployment,
} from "../commands/fleet_pr_babysitter.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  type PrDiscoveryEvent,
  readPrDiscoveryEvents,
} from "../lib/pr_discovery_events.ts";

// PR discovery events journalled by the real `pass` (Issue #4658).
const PASS_LOGIN = "fleet-babysitter[bot]";
// A free-form VIBE_HOST_ID; reportHostId maps it to "lab-box--".
const PASS_HOST = "lab box/ü";

function passFixturePr(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "OPEN",
    mergedAt: null,
    number,
    title: `PR ${number}`,
    author: { login: PASS_LOGIN },
    headRefName: `branch-${number}`,
    headRefOid: `head-${number}`,
    baseRefName: "main",
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    labels: [],
    autoMergeRequest: null,
    ...overrides,
  };
}

/**
 * Drive the real `pass` against a fake `gh` that answers `pr list` and
 * `pr view` from fixtures. Inject paths and a repair to keep the test isolated.
 * Returns the discovery ledger the pass wrote.
 */
async function runPassWithFakeGh(options: {
  execute: boolean;
  list: Record<string, unknown>[];
  view?: Record<string, unknown>;
  repoFilter?: string;
  prFilter?: number;
}): Promise<PrDiscoveryEvent[]> {
  const root = await Deno.makeTempDir();
  try {
    const config = {
      fleetPrAuthors: [PASS_LOGIN],
      serviceAccounts: [],
      repoConfig: {},
    };
    await pass(
      options.execute,
      PASS_LOGIN,
      {} as unknown as Parameters<typeof pass>[2],
      config as unknown as Parameters<typeof pass>[3],
      `${root}/.config.json`,
      ["org/repo"],
      options.repoFilter,
      options.prFilter,
      {
        gh: (args) =>
          Promise.resolve(JSON.stringify(
            args[0] === "pr" && args[1] === "list"
              ? options.list
              : args[0] === "pr" && args[1] === "view"
              ? options.view ?? {}
              : [],
          )),
        tempDir: root,
        stateDir: `${root}/state`,
        hostId: PASS_HOST,
        repair: () => Promise.resolve(),
      },
    );
    return await readPrDiscoveryEvents(
      `${root}/state/pr-discovery-events.jsonl`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("babysitter pass journals discovered, eligible and processed transitions on a live run", async () => {
  const events = await runPassWithFakeGh({
    execute: true,
    list: [
      passFixturePr(11, {
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      }),
      passFixturePr(12),
    ],
  });
  assertEquals(
    events.map((row) => [row.event, row.prNumber, row.hostId]),
    [
      ["discovered", 11, "lab-box--"],
      ["discovered", 12, "lab-box--"],
      ["eligible", 11, "lab-box--"],
      ["processed", 11, "lab-box--"],
    ],
  );
});

Deno.test("babysitter pass journals discovered and eligible but not processed on a dry run", async () => {
  const events = await runPassWithFakeGh({
    execute: false,
    list: [passFixturePr(11, { mergeable: "CONFLICTING" })],
  });
  assertEquals(
    events.map((row) => [row.event, row.prNumber]),
    [["discovered", 11], ["eligible", 11]],
  );
});

Deno.test("babysitter pass with a single-PR filter journals only the eligible transition", async () => {
  const events = await runPassWithFakeGh({
    execute: false,
    list: [],
    view: passFixturePr(11, { mergeable: "CONFLICTING" }),
    repoFilter: "org/repo",
    prFilter: 11,
  });
  assertEquals(
    events.map((row) => [row.event, row.prNumber]),
    [["eligible", 11]],
  );
});

Deno.test("a malformed discovery ledger does not stop a repair", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/pr-discovery-events.jsonl`, "invalid\n");
    let repaired = false;
    await pass(
      true,
      PASS_LOGIN,
      {} as unknown as Parameters<typeof pass>[2],
      {
        fleetPrAuthors: [PASS_LOGIN],
        serviceAccounts: [],
        repoConfig: {},
      } as unknown as Parameters<typeof pass>[3],
      `${root}/config.json`,
      ["org/repo"],
      "org/repo",
      11,
      {
        gh: () =>
          Promise.resolve(
            JSON.stringify(passFixturePr(11, { mergeable: "CONFLICTING" })),
          ),
        tempDir: root,
        stateDir: root,
        hostId: PASS_HOST,
        repair: () => {
          repaired = true;
          return Promise.resolve();
        },
      },
    );
    assertEquals(repaired, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("babysitter heartbeat maps a free-form VIBE_HOST_ID to a valid host id", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await recordBabysitterDeployment(
      dir,
      buildDefaultWorkerConfig(),
      "abcdef0123456789",
      "2026-11-02T00:00:00.000Z",
      PASS_HOST,
    );
    const heartbeat = JSON.parse(
      await Deno.readTextFile(`${dir}/deployment-health.json`),
    );
    assertEquals(heartbeat.hostId, "lab-box--");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
