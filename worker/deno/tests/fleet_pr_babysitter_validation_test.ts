/**
 * Runner-owned validation before the babysitter publishes a repair (Issue
 * #4625). The scenarios live in `fixtures/fleet_pr_babysitter_validation_scenarios.ts`.
 * They patch `Deno.env`, `Deno.Command` and `fetch` while they run, so they
 * execute in a child `deno test` process and never in this one.
 *
 * This suite runs that child with the flags of the `test` task in `deno.json`,
 * then asserts that the child exited 0 and that every scenario title reported
 * `ok`. A deleted, failed or skipped scenario fails this test, and the child's
 * output is in the assertion message.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */
import { assertEquals } from "@std/assert";

const FIXTURE = new URL(
  "./fixtures/fleet_pr_babysitter_validation_scenarios.ts",
  import.meta.url,
);
/** The worker root: the directory the `test` task runs `deno test` from. */
const WORKER_ROOT = new URL("../", import.meta.url);

/** Every scenario title in the fixture. */
const SCENARIO_TITLES: readonly string[] = [
  "a failed repository gate blocks the push, keeps the attempt, and dismisses no review",
  "an unavailable repository gate cools down without a substantive attempt, then retries",
  "a passed repository gate pushes as before and dismisses the addressed review after the push",
  "a ready claim with a failed gate does not publish the head",
  "the gate runs on the committed head in the clone, with the loaded repository configs, before the push",
  "the repository configs come from the worker config, and a failed load is thrown",
  "a lock renewal that fails while the gate runs stops the push",
  "a repository config that cannot be loaded stops the repair before any agent runs or attempt is recorded",
  "a failed gate is a code failure whatever its output says, and counts one substantive attempt",
];

/**
 * The child's environment: enough to find deno, git and the module cache. The
 * fixture sets its own HOME inside the child, so the parent's values only locate
 * the cache.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { DENO_NO_UPDATE_CHECK: "1" };
  for (const key of ["PATH", "HOME", "DENO_DIR", "XDG_CACHE_HOME", "TMPDIR"]) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The status each TAP result line reports, keyed by scenario title. */
function tapStatuses(tap: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of tap.split("\n")) {
    const match = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (match) statuses.set(match[2]!, match[1]!);
  }
  return statuses;
}

Deno.test("the fleet PR babysitter repair-validation scenarios all pass in a child deno test run (Issue #4625)", async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--frozen",
      "--lock=deno.lock",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-write",
      "--allow-sys=hostname",
      "--reporter=tap",
      FIXTURE.pathname,
    ],
    cwd: WORKER_ROOT.pathname,
    clearEnv: true,
    env: childEnv(),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(300_000),
  }).output();
  const decoder = new TextDecoder();
  const stdout = decoder.decode(result.stdout);
  const report = `child deno test exited ${result.code}\n${stdout}${
    decoder.decode(result.stderr)
  }`;
  assertEquals(result.code, 0, report);
  const statuses = tapStatuses(stdout);
  for (const title of SCENARIO_TITLES) {
    assertEquals(
      statuses.get(title),
      "ok",
      `scenario did not report ok: ${title}\n${report}`,
    );
  }
});
