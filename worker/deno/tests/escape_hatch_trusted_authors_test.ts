/**
 * Tests for lib/escape_hatch_trusted_authors.ts (Issue #185, SEC-8f21c4a0e7b3).
 *
 * The escape-hatch follow-up gate is only as good as the set of logins it
 * trusts. These tests pin what goes into that set (worker login, fleet
 * siblings, the derived trusted authors, `authorized_commenters`) and what
 * stays out.
 *
 * Issue #1066: `loadTrustedFollowUpAuthors` prefers the process-wide trust
 * snapshot over a fresh `loadConfig`, so every test here clears that snapshot
 * first. Otherwise a suite that ran a real trust refresh earlier would decide
 * these outcomes instead of the stub.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  loadTrustedFollowUpAuthors,
  resolveTrustedFollowUpAuthors,
} from "../lib/escape_hatch_trusted_authors.ts";
import { isTrustedFollowUpAuthor } from "../lib/escape_hatch_verify.ts";
import { _resetLiveTrustedAuthors } from "../lib/trust_snapshot.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

/** Minimal WorkerDeps stub — only `config.loadConfig` is touched. */
function makeStubDeps(
  loadConfig: (path?: string) => Promise<unknown>,
): WorkerDeps {
  // Issue #1066: the gate reads the live snapshot when one exists, so clear
  // it here — these tests are about what the stubbed config contributes.
  _resetLiveTrustedAuthors();
  return { config: { loadConfig } } as unknown as WorkerDeps;
}

Deno.test("resolveTrustedFollowUpAuthors - unions the worker, fleet and allowlists", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    allowedAuthors: ["owner"],
    fleetPrAuthors: ["vibe-bot-2"],
    authorisedCommenters: ["maintainer"],
  });
  assertEquals(authors.sort(), [
    "maintainer",
    "owner",
    "vibe-bot",
    "vibe-bot-2",
  ]);
});

Deno.test("resolveTrustedFollowUpAuthors - drops blanks and de-duplicates by login case", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    allowedAuthors: ["Vibe-Bot", "  ", "owner"],
    fleetPrAuthors: ["owner"],
    authorisedCommenters: [""],
  });
  assertEquals(authors, ["vibe-bot", "owner"]);
});

Deno.test("resolveTrustedFollowUpAuthors - an unconfigured worker yields an empty set (Issue #185)", () => {
  // Empty means "cannot verify", which the gate must treat as a rejection —
  // never as a wildcard that trusts every author.
  assertEquals(resolveTrustedFollowUpAuthors({ githubUser: "" }), []);
  assertEquals(
    isTrustedFollowUpAuthor(
      "anyone",
      resolveTrustedFollowUpAuthors({
        githubUser: "",
      }),
    ),
    false,
  );
});

Deno.test("resolveTrustedFollowUpAuthors - an arbitrary reviewer is not trusted", () => {
  const authors = resolveTrustedFollowUpAuthors({
    githubUser: "vibe-bot",
    authorisedCommenters: ["maintainer"],
  });
  assert(isTrustedFollowUpAuthor("maintainer", authors));
  assertEquals(isTrustedFollowUpAuthor("drive-by-reviewer", authors), false);
});

// The environment reaches `loadTrustedFollowUpAuthors` as its fourth
// parameter (Issue #965), so these tests state the ambient identity instead
// of writing `GITHUB_USER` into the process — a write that races every other
// test sharing the process. Each injected login is absent from every real
// environment, so a fall back to `Deno.env.get` fails here rather than
// passing on the host's own value.

Deno.test("loadTrustedFollowUpAuthors - the passed worker login seeds the set (Issue #185)", async () => {
  // The env var is unset, so without the passed login the gate would fail
  // closed on a follow-up the worker filed itself.
  const authors = await loadTrustedFollowUpAuthors(
    makeStubDeps(() => Promise.resolve({ allowedAuthors: ["owner"] })),
    silentLogger,
    "vibe-bot",
    emptyEnv,
  );
  assert(isTrustedFollowUpAuthor("vibe-bot", authors));
  assert(isTrustedFollowUpAuthor("owner", authors));
});

Deno.test("loadTrustedFollowUpAuthors - the passed login wins over the env var", async () => {
  const authors = await loadTrustedFollowUpAuthors(
    makeStubDeps(() => Promise.resolve({})),
    silentLogger,
    "vibe-bot",
    envFrom({ GITHUB_USER: "stale-login" }),
  );
  assertEquals(authors, ["vibe-bot"]);
});

Deno.test("loadTrustedFollowUpAuthors - falls back to GITHUB_USER when no login is passed", async () => {
  const authors = await loadTrustedFollowUpAuthors(
    makeStubDeps(() => Promise.resolve({})),
    silentLogger,
    undefined,
    envFrom({ GITHUB_USER: "seam-only-bot" }),
  );
  assertEquals(authors, ["seam-only-bot"]);
});

Deno.test("loadTrustedFollowUpAuthors - an empty environment yields an empty set", async () => {
  // No passed login and no `GITHUB_USER` means "cannot verify", which the
  // gate must treat as a rejection.
  const authors = await loadTrustedFollowUpAuthors(
    makeStubDeps(() => Promise.resolve({})),
    silentLogger,
    undefined,
    emptyEnv,
  );
  assertEquals(authors, []);
  assertEquals(isTrustedFollowUpAuthor("anyone", authors), false);
});

Deno.test("loadTrustedFollowUpAuthors - the config path comes from the injected environment", async () => {
  const paths: string[] = [];
  await loadTrustedFollowUpAuthors(
    makeStubDeps((path?: string) => {
      paths.push(String(path));
      return Promise.resolve({});
    }),
    silentLogger,
    "vibe-bot",
    envFrom({ CONFIG_PATH: "/nowhere/seam-only.config.json" }),
  );
  assertEquals(paths, ["/nowhere/seam-only.config.json"]);
});

Deno.test("loadTrustedFollowUpAuthors - a config failure narrows to the worker login, never widens", async () => {
  const errors: string[] = [];
  const authors = await loadTrustedFollowUpAuthors(
    makeStubDeps(() => Promise.reject(new Error("unreadable config"))),
    { ...silentLogger, error: (msg: string) => errors.push(msg) },
    "vibe-bot",
    emptyEnv,
  );
  assertEquals(authors, ["vibe-bot"]);
  assertEquals(errors.length, 1);
});
