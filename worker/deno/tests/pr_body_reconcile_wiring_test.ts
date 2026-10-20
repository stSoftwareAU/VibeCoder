/**
 * The production factory wires the PR body digest reconcile (Issue #3760).
 *
 * `pr_body_reconcile_test.ts` injects every collaborator, so it cannot show
 * that `run_core_production_deps.ts` hands the pass the configured repos and
 * the maintenance author set. This drives the real
 * `reconcilePrBodyDigests()` slot with a recording `gh` runner at the
 * `gh_spawn.ts` boundary, and asserts on the argv it issues.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { buildIdempotencyMarker } from "../lib/pr_body.ts";
import { buildSummaryDigestMarker } from "../lib/pr_body_sync.ts";

const REPO = "owner/repo";
const HOST_LOGIN = "host-user";
/** Fleet author: listed through `config.fleetPrAuthors`, so in maintenance set. */
const FLEET_LOGIN = "fleet-bot";
const PR_NUMBER = 7;
const ISSUE_NUMBER = 42;
/** Forty lowercase hex characters, a valid commit SHA. */
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
/** Sixty-four lowercase hex characters, a valid summary digest. */
const DIGEST = "ab".repeat(32);

/** A PR body carrying the worker marker and a summary digest marker. */
const WORKER_BODY = [
  buildIdempotencyMarker(ISSUE_NUMBER),
  "## Summary",
  "",
  "Original summary text. Closes #42.",
  "",
  buildSummaryDigestMarker(DIGEST),
].join("\n");

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

function failed(stderr: string): GhSpawnResult {
  return { code: 1, success: false, stdout: "", stderr };
}

/** The open PR the listing returns for the fleet author. */
function openPr(): unknown {
  return {
    number: PR_NUMBER,
    headRefOid: HEAD_SHA,
    body: WORKER_BODY,
    author: { login: FLEET_LOGIN },
  };
}

/**
 * Stub the `gh` process boundary. `gh pr list` returns one fleet-authored PR
 * (or fails, when `listing` is "fail"). Every contents read fails with a
 * non-404 error, so the pass never reaches a clone. Each argv is recorded.
 */
function stubGh(listing: "ok" | "fail", calls: string[][]): void {
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "list") {
      if (listing === "fail") {
        return Promise.resolve(
          failed("gh: Must have push access to repository (HTTP 403)"),
        );
      }
      const author = args[args.indexOf("--author") + 1];
      const prs = author === FLEET_LOGIN ? [openPr()] : [];
      return Promise.resolve(ok(JSON.stringify(prs)));
    }
    if (args[0] === "api" && (args[1] ?? "").includes("/contents/")) {
      return Promise.resolve(
        failed("gh: Resource not accessible by integration (HTTP 403)"),
      );
    }
    return Promise.resolve(
      failed(`unexpected gh call: ${args.join(" ")}`),
    );
  });
}

/**
 * Build the production deps for a config listing `REPO`, run the real
 * `reconcilePrBodyDigests()` slot once, and return its result with every
 * recorded `gh` argv. Fresh deps and a fresh work directory per call, so the
 * issue cache and the in-sync memo cannot carry state between tests.
 */
async function runReconcile(
  listing: "ok" | "fail",
): Promise<{ result: { ok: boolean }; calls: string[][] }> {
  const calls: string[][] = [];
  const workDir = await Deno.makeTempDir({
    prefix: "pr-body-reconcile-wiring-",
  });
  try {
    stubGh(listing, calls);
    const config = {
      ...buildDefaultWorkerConfig({
        repos: [REPO],
        fleetPrAuthors: [FLEET_LOGIN],
      }),
      workDir,
    };
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: HOST_LOGIN,
      logger: createLogger({ write: () => {} }),
      config,
    });
    try {
      const result = await deps.reconcilePrBodyDigests!();
      return { result, calls };
    } finally {
      cleanup();
    }
  } finally {
    _resetGhSpawnRunner();
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("Issue #3760: production reconcile reads the digest at the head of the configured repo", async () => {
  const { result, calls } = await runReconcile("ok");

  assert(result.ok, "the handler must resolve ok");
  const contentsReads = calls.filter((a) =>
    a[0] === "api" && (a[1] ?? "").startsWith(`repos/${REPO}/contents/`)
  );
  assert(
    contentsReads.length > 0,
    `expected a contents read for ${REPO}; calls: ${JSON.stringify(calls)}`,
  );
  assert(
    contentsReads.every((a) => (a[1] ?? "").endsWith(`?ref=${HEAD_SHA}`)),
    `every contents read must pin ref=${HEAD_SHA}; calls: ${
      JSON.stringify(contentsReads)
    }`,
  );
  // A failed read never reaches the disposable clone.
  const clones = calls.filter((a) => a[0] === "repo" && a[1] === "clone");
  assertEquals(clones.length, 0, JSON.stringify(calls));
});

Deno.test("Issue #3760: production reconcile resolves ok when the gh listing fails", async () => {
  const { result, calls } = await runReconcile("fail");

  assert(result.ok, "the handler must resolve ok even when gh fails");
  assert(
    calls.some((a) => a[0] === "pr" && a[1] === "list"),
    `the listing must have been attempted; calls: ${JSON.stringify(calls)}`,
  );
});
