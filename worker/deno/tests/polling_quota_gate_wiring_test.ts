/**
 * Production wiring for the quota-aware polling gate (Issue #3628).
 *
 * The factory probes the free GraphQL quota once per scan and defers the
 * idle-task filer while the reading is below the idle floor. The things
 * worth asserting here are the *wiring*: the probe is asked exactly once
 * per scan, a failed probe warns once and defers nothing (fail-open), and
 * the default filer seam defers below the floor and passes above it.
 *
 * The park WARNING line's emission needs a scan that actually parks a
 * repository, and the finder's `gh` runner has no factory-wide seam (the
 * seams are deliberately scoped, Issue #1050) — that path is covered by
 * `find_oldest_issue_quota_gate_test.ts` (the parked-repo flow) and
 * `polling_quota_gate_test.ts` (the formatters), with the stashing of
 * `lastScanParkedRepos` proven through `deps.findNextIssue` returning a
 * `parkedRepos`-free result over an empty repo list.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GraphqlQuotaReading } from "../lib/graphql_quota_probe.ts";
import type { WorkerConfig } from "../types.ts";

const HOUR = 3_600_000;

/** A host config with no repos, so the scan reaches no gh call. */
function gateConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [],
    workDir,
  };
}

/** A fixed quota reading, the shape `probeGraphqlQuota` reports. */
function reading(
  remaining: number,
  limit = 5000,
): GraphqlQuotaReading {
  return {
    limit,
    remaining,
    used: limit - remaining,
    reset: Math.floor(Date.now() / 1000) + HOUR,
    source: "headers",
  };
}

async function withWorkDir(
  fn: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "quota-gate-wiring-" });
  try {
    await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test(
  "production deps - findNextIssue probes the GraphQL quota exactly once per scan (Issue #3628)",
  async () => {
    await withWorkDir(async (workDir) => {
      let probes = 0;
      const lines: string[] = [];
      const { deps, cleanup } = await createProductionRunCoreDeps({
        repoDir: workDir,
        workDir,
        githubUser: "worker-bot",
        logger: createLogger({ write: (line: string) => lines.push(line) }),
        config: gateConfig(workDir),
        graphqlQuotaProbe: () => {
          probes++;
          return Promise.resolve({ ok: true, value: reading(4000) });
        },
      });
      try {
        const result = await deps.findNextIssue();
        assertEquals(result.ok, true);
        assertEquals(
          probes,
          1,
          "one free probe per scan — the gate's only quota cost",
        );
        assertEquals(
          lines.filter((l) => l.includes("polling-quota-gate:")),
          [],
          "a healthy reading parks nothing and logs nothing",
        );
      } finally {
        cleanup();
      }
    });
  },
);

Deno.test(
  "production deps - a failed probe warns once and defers nothing (Issue #3628)",
  async () => {
    await withWorkDir(async (workDir) => {
      const lines: string[] = [];
      const { deps, cleanup } = await createProductionRunCoreDeps({
        repoDir: workDir,
        workDir,
        githubUser: "worker-bot",
        logger: createLogger({ write: (line: string) => lines.push(line) }),
        config: gateConfig(workDir),
        graphqlQuotaProbe: () =>
          Promise.resolve({
            ok: false,
            error: new Error("gh unavailable"),
          }),
      });
      try {
        const result = await deps.findNextIssue();
        assertEquals(result.ok, true);
        const warnings = lines.filter((l) =>
          l.includes("polling gate reads as off")
        );
        assertEquals(
          warnings.length,
          1,
          `one fail-open warning, not one per probe: ${JSON.stringify(lines)}`,
        );
      } finally {
        cleanup();
      }
    });
  },
);

Deno.test(
  "production deps - the default idle-filer seam defers below the idle floor and passes above it (Issue #3628)",
  async () => {
    await withWorkDir(async (workDir) => {
      let remaining = 4000;
      let probes = 0;
      const { deps, cleanup } = await createProductionRunCoreDeps({
        repoDir: workDir,
        workDir,
        githubUser: "worker-bot",
        logger: createLogger({ write: () => {} }),
        config: gateConfig(workDir),
        graphqlQuotaProbe: () => {
          probes++;
          return Promise.resolve({ ok: true, value: reading(remaining) });
        },
      });
      try {
        remaining = 400;
        probes = 0;
        const below = await deps.idleFilerQuotaDeferred!();
        assertEquals(probes, 1);
        assert(below !== null, "below the idle floor the seam must defer");
        assert(
          below!.includes("remaining=400/5000"),
          `the reason must carry the reading: ${below}`,
        );
        assert(
          below!.includes("idle_floor=500"),
          `the reason must name the floor: ${below}`,
        );

        remaining = 4000;
        probes = 0;
        const above = await deps.idleFilerQuotaDeferred!();
        assertEquals(probes, 1);
        assertEquals(
          above,
          null,
          "above the idle floor the filer runs as before",
        );
      } finally {
        cleanup();
      }
    });
  },
);

Deno.test(
  "production deps - the default idle-filer seam returns null when the probe fails (Issue #3628)",
  async () => {
    await withWorkDir(async (workDir) => {
      const { deps, cleanup } = await createProductionRunCoreDeps({
        repoDir: workDir,
        workDir,
        githubUser: "worker-bot",
        logger: createLogger({ write: () => {} }),
        config: gateConfig(workDir),
        graphqlQuotaProbe: () =>
          Promise.resolve({ ok: false, error: new Error("gh unavailable") }),
      });
      try {
        assertEquals(
          await deps.idleFilerQuotaDeferred!(),
          null,
          "an unreadable quota defers nothing — fail-open",
        );
      } finally {
        cleanup();
      }
    });
  },
);
