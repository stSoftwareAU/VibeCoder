// Process-state mutator suite (Issue #4658). These tests set PATH, HOME,
// XDG_STATE_HOME, TMPDIR and VIBE_HOST_ID so the real `pass` runs against a
// fake `gh`. They live apart from fleet_pr_babysitter_test.ts so that suite
// stays in the parallel pass. This file is listed in
// PROCESS_STATE_MUTATOR_TEST_FILES.
import { assert, assertEquals } from "@std/assert";
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
 * `pr view` from fixtures. HOME, XDG_STATE_HOME and TMPDIR live in a fresh
 * temp directory and PATH holds only the fake. Returns the discovery ledger
 * the pass wrote, and restores the environment afterwards.
 */
async function runPassWithFakeGh(options: {
  execute: boolean;
  list: Record<string, unknown>[];
  view?: Record<string, unknown>;
  repoFilter?: string;
  prFilter?: number;
}): Promise<PrDiscoveryEvent[]> {
  const root = await Deno.makeTempDir();
  const names = ["PATH", "HOME", "XDG_STATE_HOME", "TMPDIR", "VIBE_HOST_ID"];
  const saved = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    const json = (value: unknown): string => {
      const text = JSON.stringify(value);
      assert(
        !text.includes("'"),
        "fixture JSON must not contain single quotes",
      );
      return text;
    };
    // printf is a shell builtin, so the fake needs no other PATH entry.
    await Deno.writeTextFile(
      `${bin}/gh`,
      [
        "#!/bin/sh",
        `if [ "$1" = pr ] && [ "$2" = list ]; then printf '%s\\n' '${
          json(options.list)
        }'; exit 0; fi`,
        `if [ "$1" = pr ] && [ "$2" = view ]; then printf '%s\\n' '${
          json(options.view ?? {})
        }'; exit 0; fi`,
        "printf '%s\\n' '[]'",
      ].join("\n") + "\n",
    );
    await Deno.chmod(`${bin}/gh`, 0o755);
    await Deno.mkdir(`${root}/tmp`);
    Deno.env.set("PATH", bin);
    Deno.env.set("HOME", root);
    Deno.env.set("XDG_STATE_HOME", `${root}/state`);
    Deno.env.set("TMPDIR", `${root}/tmp`);
    Deno.env.set("VIBE_HOST_ID", PASS_HOST);
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
    );
    return await readPrDiscoveryEvents(
      `${root}/state/vibe-coder/fleet-pr-babysitter/pr-discovery-events.jsonl`,
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
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

Deno.test("babysitter heartbeat maps a free-form VIBE_HOST_ID to a valid host id", async () => {
  const dir = await Deno.makeTempDir();
  const saved = Deno.env.get("VIBE_HOST_ID");
  try {
    Deno.env.set("VIBE_HOST_ID", PASS_HOST);
    await recordBabysitterDeployment(
      dir,
      buildDefaultWorkerConfig(),
      "abcdef0123456789",
      "2026-11-02T00:00:00.000Z",
    );
    const heartbeat = JSON.parse(
      await Deno.readTextFile(`${dir}/deployment-health.json`),
    );
    assertEquals(heartbeat.hostId, "lab-box--");
  } finally {
    if (saved === undefined) Deno.env.delete("VIBE_HOST_ID");
    else Deno.env.set("VIBE_HOST_ID", saved);
    await Deno.remove(dir, { recursive: true });
  }
});
