/**
 * Tests for lib/escape_hatch_trusted_authors.ts (Issue #185, SEC-8f21c4a0e7b3).
 *
 * The escape-hatch follow-up gate is only as good as the set of logins it
 * trusts. These tests pin what goes into that set (worker login, fleet
 * siblings, `allowed_authors`, `authorized_commenters`) and what stays out.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  loadTrustedFollowUpAuthors,
  resolveTrustedFollowUpAuthors,
} from "../lib/escape_hatch_trusted_authors.ts";
import { isTrustedFollowUpAuthor } from "../lib/escape_hatch_verify.ts";
import type { WorkerDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

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
  loadConfig: () => Promise<unknown>,
): WorkerDeps {
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

/** Run `fn` with GITHUB_USER set to `value` (or unset when undefined). */
async function withGithubUserEnv(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get("GITHUB_USER");
  if (value === undefined) Deno.env.delete("GITHUB_USER");
  else Deno.env.set("GITHUB_USER", value);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("GITHUB_USER");
    else Deno.env.set("GITHUB_USER", previous);
  }
}

Deno.test("loadTrustedFollowUpAuthors - the passed worker login seeds the set (Issue #185)", async () => {
  // The env var is unset, so without the passed login the gate would fail
  // closed on a follow-up the worker filed itself.
  await withGithubUserEnv(undefined, async () => {
    const authors = await loadTrustedFollowUpAuthors(
      makeStubDeps(() => Promise.resolve({ allowedAuthors: ["owner"] })),
      silentLogger,
      "vibe-bot",
    );
    assert(isTrustedFollowUpAuthor("vibe-bot", authors));
    assert(isTrustedFollowUpAuthor("owner", authors));
  });
});

Deno.test("loadTrustedFollowUpAuthors - the passed login wins over the env var", async () => {
  await withGithubUserEnv("stale-login", async () => {
    const authors = await loadTrustedFollowUpAuthors(
      makeStubDeps(() => Promise.resolve({})),
      silentLogger,
      "vibe-bot",
    );
    assertEquals(authors, ["vibe-bot"]);
  });
});

Deno.test("loadTrustedFollowUpAuthors - falls back to GITHUB_USER when no login is passed", async () => {
  await withGithubUserEnv("env-bot", async () => {
    const authors = await loadTrustedFollowUpAuthors(
      makeStubDeps(() => Promise.resolve({})),
      silentLogger,
    );
    assertEquals(authors, ["env-bot"]);
  });
});

Deno.test("loadTrustedFollowUpAuthors - a config failure narrows to the worker login, never widens", async () => {
  await withGithubUserEnv(undefined, async () => {
    const errors: string[] = [];
    const authors = await loadTrustedFollowUpAuthors(
      makeStubDeps(() => Promise.reject(new Error("unreadable config"))),
      { ...silentLogger, error: (msg: string) => errors.push(msg) },
      "vibe-bot",
    );
    assertEquals(authors, ["vibe-bot"]);
    assertEquals(errors.length, 1);
  });
});
