/**
 * The worker's own prompts are unwritable at run time (Issue #1445).
 *
 * `prompts/` holds the worker's instructions to itself. An agent that can
 * edit the copy the worker READS rewrites how every later phase of that
 * launch behaves, and the change never appears in a pull request diff —
 * unlike editing `prompts/` inside a repository clone, which is the ordinary
 * reviewed route and stays available.
 *
 * The container already arranges this through a read-only checkout mount and
 * an entrypoint that stages only `worker/deno`. These tests exist because
 * that is three decisions in two files lining up rather than a guarantee:
 * they make the property deterministic instead of incidental.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPromptsImmutable,
  classifyPromptsWritability,
  IN_IMAGE_ENV,
  probePromptsWritable,
  PROMPT_PROBE_PREFIX,
  type PromptProbeDeps,
} from "../lib/prompt_immutability.ts";

const DIR = "/workspace/prompts";

/** An environment lookup that reports running inside the container image. */
const inImage = (name: string): string | undefined =>
  name === IN_IMAGE_ENV ? "claude" : undefined;

/** An environment lookup for a developer host — no in-image signal. */
const onHost = (_name: string): string | undefined => undefined;

// ---------------------------------------------------------------------------
// The refusal direction
// ---------------------------------------------------------------------------

Deno.test("prompt immutability - a writable prompts dir inside the image is refused", () => {
  const verdict = classifyPromptsWritability({
    writable: true,
    inImage: true,
    promptsDir: DIR,
  });
  assertEquals(verdict.ok, false);
  assertStringIncludes(verdict.reason ?? "", DIR);
  // The message must say what to look at, not merely that something is wrong.
  assertStringIncludes(verdict.reason ?? "", "PROMPTS_DIR");
});

Deno.test("prompt immutability - the check refuses end to end when a write succeeds", async () => {
  const written: string[] = [];
  const deps: PromptProbeDeps = {
    writeTextFile: (path) => {
      written.push(path);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
  const verdict = await checkPromptsImmutable(DIR, inImage, deps);
  assertEquals(verdict.ok, false);
  // The probe wrote a uniquely-named dot file into the directory it tested.
  assertEquals(written.length, 1);
  assert(written[0]!.startsWith(`${DIR}/${PROMPT_PROBE_PREFIX}`));
});

// ---------------------------------------------------------------------------
// The permit direction — the check must not break a legitimate run
// ---------------------------------------------------------------------------

Deno.test("prompt immutability - a read-only prompts dir passes", async () => {
  const deps: PromptProbeDeps = {
    // A read-only mount rejects the write; the mode bits may still look
    // writable, which is exactly why the probe writes rather than stats.
    writeTextFile: () => Promise.reject(new Error("EROFS")),
    remove: () => Promise.resolve(),
  };
  assertEquals((await checkPromptsImmutable(DIR, inImage, deps)).ok, true);
});

Deno.test("prompt immutability - a writable checkout on a developer host is allowed", async () => {
  // Outside the image the checkout is the operator's own working tree and is
  // meant to be writable; refusing there would make the worker unrunnable on
  // a host for no gain, since no agent/worker boundary exists to protect.
  const deps: PromptProbeDeps = {
    writeTextFile: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  assertEquals((await checkPromptsImmutable(DIR, onHost, deps)).ok, true);
});

Deno.test("prompt immutability - the probe removes what it wrote", async () => {
  const written: string[] = [];
  const removed: string[] = [];
  const deps: PromptProbeDeps = {
    writeTextFile: (path) => {
      written.push(path);
      return Promise.resolve();
    },
    remove: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  assertEquals(await probePromptsWritable(DIR, deps), true);
  assertEquals(removed, written, "the probe must not leave a file behind");
});

Deno.test("prompt immutability - a failed cleanup does not change the verdict", async () => {
  // The write already answered the question; a removal failure must not be
  // reported as "not writable", which would be the unsafe direction.
  const deps: PromptProbeDeps = {
    writeTextFile: () => Promise.resolve(),
    remove: () => Promise.reject(new Error("EACCES")),
  };
  assertEquals(await probePromptsWritable(DIR, deps), true);
});

Deno.test("prompt immutability - each probe uses a fresh name", async () => {
  const seen = new Set<string>();
  const deps: PromptProbeDeps = {
    writeTextFile: (path) => {
      seen.add(path);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
  await probePromptsWritable(DIR, deps);
  await probePromptsWritable(DIR, deps);
  assertEquals(seen.size, 2, "a fixed name would collide between slots");
});

// ---------------------------------------------------------------------------
// The property this exists to make deterministic
// ---------------------------------------------------------------------------

Deno.test("prompt immutability - the entrypoint keeps prompts on the read-only mount", async () => {
  // The runtime check above refuses a writable prompts directory. This pins
  // the arrangement that makes it unwritable in the first place, so a staging
  // change is caught in CI rather than at 3am on a fleet host: prompts are
  // read from BASE_DIR (the read-only checkout mount), and only worker/deno
  // is copied to the writable staged tree.
  const entrypoint = await Deno.readTextFile(
    new URL("../../../container/entrypoint.sh", import.meta.url),
  );
  assertStringIncludes(entrypoint, 'PROMPTS_DIR="${BASE_DIR}/prompts"');
  assert(
    !/cp -R "\$\{BASE_DIR\}\/prompts"/.test(entrypoint),
    "prompts must never be staged into the writable local copy",
  );
});
