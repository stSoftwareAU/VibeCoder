/**
 * Tests for the provider-outage alert (Issue #2613): one open alert per
 * provider while it refuses requests, updated in place, closed on recovery.
 */
import { assert, assertEquals } from "@std/assert";
import type { AgentFailure } from "../lib/agent_output.ts";
import {
  createProviderOutageAlerter,
  formatProviderOutageBody,
  installProviderOutageAlerter,
  isProviderOutageAlertable,
  noteProviderRunOutcome,
  PROVIDER_OUTAGE_TARGET_REPO,
  raiseProviderOutageAlert,
  resolveProviderOutageAlert,
} from "../lib/provider_outage_alert.ts";

const FLEET = ["vibe-bot"];
const T0 = Date.UTC(2026, 8, 25, 1, 0, 0);
const T1 = Date.UTC(2026, 8, 25, 3, 30, 0);

function failure(
  category: AgentFailure["category"],
  message: string,
  httpStatus?: number,
): AgentFailure {
  return {
    category,
    message,
    evidence: "prose",
    terminal: true,
    errors: [],
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

const BALANCE = failure(
  "quota-exhausted",
  "Claude's subscription window is exhausted: API Error: 402 Insufficient Balance",
  402,
);

/** A fake `gh` over an in-memory issue list, recording every call. */
function fakeGh(
  issues: Array<{ number: number; body: string; login: string }> = [],
  opts: { failList?: boolean } = {},
) {
  const calls: string[][] = [];
  let next = 900;
  const open = new Set(issues.map((i) => i.number));
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const [noun, verb] = args;
    if (noun === "issue" && verb === "list") {
      if (opts.failList) return Promise.reject(new Error("HTTP 502"));
      return Promise.resolve(JSON.stringify(
        issues.filter((i) => open.has(i.number)).map((i) => ({
          number: i.number,
          body: i.body,
          author: { login: i.login },
        })),
      ));
    }
    if (noun === "issue" && verb === "create") {
      const body = args[args.indexOf("--body") + 1]!;
      const number = next++;
      issues.push({ number, body, login: "vibe-bot" });
      open.add(number);
      return Promise.resolve(
        `https://github.com/${PROVIDER_OUTAGE_TARGET_REPO}/issues/${number}\n`,
      );
    }
    if (noun === "issue" && verb === "edit") {
      const issue = issues.find((i) => i.number === Number(args[2]))!;
      issue.body = args[args.indexOf("--body") + 1]!;
      return Promise.resolve("");
    }
    if (noun === "issue" && verb === "close") {
      open.delete(Number(args[2]));
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  const openAlerts = () => issues.filter((i) => open.has(i.number));
  return { ghFn, calls, openAlerts };
}

const quiet = () => {};

Deno.test("isProviderOutageAlertable - a spent balance, a refused credential", () => {
  assert(isProviderOutageAlertable(BALANCE));
  assert(isProviderOutageAlertable(
    failure("quota-exhausted", "API Error: 402 Payment Required"),
  ));
  assert(isProviderOutageAlertable(
    failure("authentication", "Invalid API key", 401),
  ));
});

Deno.test("isProviderOutageAlertable - a routine window or a task failure is not an outage", () => {
  // A subscription window resets on its own; alerting on it would be noise.
  assert(!isProviderOutageAlertable(
    failure("quota-exhausted", "5-hour limit reached ∙ resets 3pm"),
  ));
  assert(!isProviderOutageAlertable(failure("unknown", "tests failed")));
  assert(!isProviderOutageAlertable(undefined));
});

Deno.test("raiseProviderOutageAlert - files one alert naming provider, error and first-seen", async () => {
  const gh = fakeGh();
  const decision = await raiseProviderOutageAlert({
    provider: "claude",
    error: BALANCE.message,
    nowMs: T0,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision, { action: "filed", issue: 900 });
  const [alert] = gh.openAlerts();
  assert(alert!.body.includes("`claude`"));
  assert(alert!.body.includes("402 Insufficient Balance"));
  assert(alert!.body.includes("2026-09-25T01:00:00.000Z"));
  const create = gh.calls.find((c) => c[1] === "create")!;
  assertEquals(create[create.indexOf("--repo") + 1], "stSoftwareAU/VibeCoder");
});

Deno.test("raiseProviderOutageAlert - a second failure updates the same alert in place", async () => {
  const gh = fakeGh();
  const opts = { provider: "claude", ghFn: gh.ghFn, fleetAuthors: FLEET, log: quiet };
  await raiseProviderOutageAlert({ ...opts, error: BALANCE.message, nowMs: T0 });
  const decision = await raiseProviderOutageAlert({
    ...opts,
    error: "API Error: 402 Payment Required",
    nowMs: T1,
  });
  assertEquals(decision, { action: "updated", issue: 900 });
  assertEquals(gh.openAlerts().length, 1);
  const body = gh.openAlerts()[0]!.body;
  // First-seen survives; last-seen and the error move on.
  assert(body.includes("2026-09-25T01:00:00.000Z"));
  assert(body.includes("2026-09-25T03:30:00.000Z"));
  assert(body.includes("402 Payment Required"));
});

Deno.test("raiseProviderOutageAlert - a failed search files nothing", async () => {
  const gh = fakeGh([], { failList: true });
  const decision = await raiseProviderOutageAlert({
    provider: "claude",
    error: BALANCE.message,
    nowMs: T0,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision.action, "gh-failed");
  assertEquals(gh.calls.filter((c) => c[1] === "create").length, 0);
});

Deno.test("raiseProviderOutageAlert - a marker a stranger wrote is not adopted", async () => {
  const forged = formatProviderOutageBody({
    provider: "claude",
    error: "x",
    firstSeenMs: T0,
    lastSeenMs: T0,
  });
  const gh = fakeGh([{ number: 5, body: forged, login: "mallory" }]);
  const decision = await raiseProviderOutageAlert({
    provider: "claude",
    error: BALANCE.message,
    nowMs: T1,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision, { action: "filed", issue: 900 });
  assertEquals(gh.calls.filter((c) => c[1] === "edit").length, 0);
});

Deno.test("raiseProviderOutageAlert - another provider's alert is not reused", async () => {
  const other = formatProviderOutageBody({
    provider: "codex",
    error: "x",
    firstSeenMs: T0,
    lastSeenMs: T0,
  });
  const gh = fakeGh([{ number: 7, body: other, login: "vibe-bot" }]);
  const decision = await raiseProviderOutageAlert({
    provider: "claude",
    error: BALANCE.message,
    nowMs: T1,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision, { action: "filed", issue: 900 });
});

Deno.test("raiseProviderOutageAlert - an unsafe provider id is refused", async () => {
  const gh = fakeGh();
  const decision = await raiseProviderOutageAlert({
    provider: 'claude" --> <script>',
    error: BALANCE.message,
    nowMs: T0,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision.action, "invalid");
  assertEquals(gh.calls.length, 0);
});

Deno.test("formatProviderOutageBody - the error cannot break out of its fence", () => {
  const body = formatProviderOutageBody({
    provider: "claude",
    error: "```\n# injected heading\n" + "x".repeat(5_000),
    firstSeenMs: T0,
    lastSeenMs: T0,
  });
  assertEquals(body.split("```").length, 3);
  assert(body.length < 3_000);
});

Deno.test("resolveProviderOutageAlert - closes the open alert with a recovery comment", async () => {
  const gh = fakeGh();
  const opts = { provider: "claude", ghFn: gh.ghFn, fleetAuthors: FLEET, log: quiet };
  await raiseProviderOutageAlert({ ...opts, error: BALANCE.message, nowMs: T0 });
  const decision = await resolveProviderOutageAlert({ ...opts, nowMs: T1 });
  assertEquals(decision, { action: "closed", issues: [900] });
  assertEquals(gh.openAlerts().length, 0);
  const close = gh.calls.find((c) => c[1] === "close")!;
  assert(close[close.indexOf("--comment") + 1]!.includes("2026-09-25T03:30:00.000Z"));
});

Deno.test("resolveProviderOutageAlert - nothing open is a no-op", async () => {
  const gh = fakeGh();
  const decision = await resolveProviderOutageAlert({
    provider: "claude",
    nowMs: T1,
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
  });
  assertEquals(decision, { action: "none" });
  assertEquals(gh.calls.filter((c) => c[1] === "close").length, 0);
});

Deno.test("createProviderOutageAlerter - one alert across failures, closed on the next success", async () => {
  const gh = fakeGh();
  let now = T0;
  const alerter = createProviderOutageAlerter({
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
    now: () => now,
  });
  // Two concurrent failures must not race into two alerts.
  await Promise.all([
    alerter.observe("claude", { succeeded: false, failure: BALANCE }),
    alerter.observe("claude", { succeeded: false, failure: BALANCE }),
  ]);
  assertEquals(gh.openAlerts().length, 1);
  now = T1;
  await alerter.observe("claude", { succeeded: true });
  assertEquals(gh.openAlerts().length, 0);
  // Recovered and known clear: a further success costs no gh call.
  const before = gh.calls.length;
  await alerter.observe("claude", { succeeded: true });
  assertEquals(gh.calls.length, before);
});

Deno.test("createProviderOutageAlerter - a first success closes an alert a previous process left open", async () => {
  const leftover = formatProviderOutageBody({
    provider: "claude",
    error: "402",
    firstSeenMs: T0,
    lastSeenMs: T0,
  });
  const gh = fakeGh([{ number: 12, body: leftover, login: "vibe-bot" }]);
  const alerter = createProviderOutageAlerter({
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
    now: () => T1,
  });
  await alerter.observe("claude", { succeeded: true });
  assertEquals(gh.openAlerts().length, 0);
});

Deno.test("createProviderOutageAlerter - a task failure neither raises nor closes", async () => {
  const gh = fakeGh();
  const alerter = createProviderOutageAlerter({
    ghFn: gh.ghFn,
    fleetAuthors: FLEET,
    log: quiet,
    now: () => T0,
  });
  await alerter.observe("claude", {
    succeeded: false,
    failure: failure("unknown", "tests failed"),
  });
  assertEquals(gh.calls.length, 0);
});

Deno.test("noteProviderRunOutcome - a no-op until an alerter is installed", async () => {
  const gh = fakeGh();
  installProviderOutageAlerter(undefined);
  await noteProviderRunOutcome("claude", { succeeded: false, failure: BALANCE });
  assertEquals(gh.calls.length, 0);
  installProviderOutageAlerter(
    createProviderOutageAlerter({
      ghFn: gh.ghFn,
      fleetAuthors: FLEET,
      log: quiet,
      now: () => T0,
    }),
  );
  try {
    await noteProviderRunOutcome("claude", { succeeded: false, failure: BALANCE });
    assertEquals(gh.openAlerts().length, 1);
  } finally {
    installProviderOutageAlerter(undefined);
  }
});
