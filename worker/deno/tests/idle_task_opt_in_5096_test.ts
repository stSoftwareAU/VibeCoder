/**
 * Tests for the opt-in idle-task gate (Issue #5096).
 *
 * `test-audit` is a whole-repo coverage-gap scan. It must never run as
 * automatic idle work unless the owner asked for it: by naming it in
 * `.config.json`, by filing the wrapper, or by an explicit operator request
 * (the requested marker). These tests exercise the real pure functions in
 * `lib/idle_task_opt_in.ts`, and the real route in
 * `lib/idle_task_process_issue_route.ts` with stubbed side-effect seams.
 *
 * Australian English spelling used throughout.
 */

import { raiseSingleIdleTaskCommand } from "../commands/raise_single_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  authorisedOptInTemplates,
  decideOptInClaim,
  hasIdleTaskRequestedMarker,
  IDLE_TASK_REQUESTED_MARKER,
  idleRouteOptInInput,
  isAutoEnabledIdleTaskTemplate,
  OPT_IN_IDLE_TASK_TEMPLATES,
  verifyOwnerRequestedIdleTask,
} from "../lib/idle_task_opt_in.ts";
import {
  routeIdleTaskInProcessIssue,
  type RouteIdleTaskInput,
} from "../lib/idle_task_process_issue_route.ts";
import { createTestAuditTemplate } from "../lib/idle_task_templates/test_audit_template.ts";
import { getTemplate, registerTemplate } from "../lib/idle_task_template.ts";
import { getIdleTaskRunContext } from "../lib/idle_task_claude_budget.ts";
import type { CadenceTemplatePolicy } from "../lib/idle_task_cadence.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLEET_AUTHOR = "vibe-coder";
const FLEET_AUTHORS = [FLEET_AUTHOR];
const NO_AUTHORISED: ReadonlySet<string> = new Set();
const PLAIN_BODY = "Audit `owner/widget` for coverage gaps.";

interface LogRecord {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: unknown;
}

function makeLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger: Logger = {
    info: (m, c) => records.push({ level: "info", message: m, context: c }),
    warn: (m, c) => records.push({ level: "warn", message: m, context: c }),
    error: (m, c) => records.push({ level: "error", message: m, context: c }),
    debug: (m, c) => records.push({ level: "debug", message: m, context: c }),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, records };
}

/** Claim stub: this host holds the wrapper. */
const okClaim = () =>
  Promise.resolve({ claimed: true as const, workerId: "vibe-coder-1" });

/** Route input for a wrapper; the title selects the real registered template. */
function wrapperInput(
  overrides: {
    issueTitle: string;
    issueAuthor: string;
    issueBody?: string;
    ownerRequested?: boolean;
    authorisedOptInTemplates?: ReadonlySet<string>;
  },
) {
  return {
    repo: "owner/widget",
    issueNumber: 5096,
    issueLabels: ["idle-task"],
    issueBody: overrides.issueBody ?? PLAIN_BODY,
    workDir: "/tmp/widget",
    githubUser: FLEET_AUTHOR,
    fleetAuthors: FLEET_AUTHORS,
    fleetIdentityLogins: FLEET_AUTHORS,
    pushCapableAuthors: FLEET_AUTHORS,
    issueTitle: overrides.issueTitle,
    issueAuthor: overrides.issueAuthor,
    ownerRequested: overrides.ownerRequested,
    authorisedOptInTemplates: overrides.authorisedOptInTemplates ??
      NO_AUTHORISED,
  };
}

/**
 * Run the real route with stubbed seams and record what side effects happened.
 * `handleIdleTaskFn` is the scan; `ensureCloneFn` is the clone; `ghCommandFn`
 * is the `gh` runner the wrapper closure writes through.
 */
async function runRoute(input: RouteIdleTaskInput) {
  const { logger, records } = makeLogger();
  const filed: number[] = [];
  const comments: string[] = [];
  let closed = false;
  const previous = getTemplate("test-audit")!;
  const deadline = Date.now() + 900_000;
  registerTemplate(createTestAuditTemplate({
    ghCommandFn: () =>
      Promise.resolve(
        JSON.stringify(
          filed.map((number) => ({
            number,
            title: "finding",
            body: "",
            author: { login: FLEET_AUTHOR },
          })),
        ),
      ),
    ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
    runScanFn: (opts) => {
      // External agent boundary: a finding exists only for the requested scope,
      // repository and forwarded budget. Losing any makes the outcome fail.
      if (
        opts.repo === input.repo && opts.issueBody === input.issueBody &&
        getIdleTaskRunContext().cycleDeadlineEpochMs === deadline
      ) filed.push(77);
      return Promise.resolve({ ok: true, value: true });
    },
  }));
  try {
    const outcome = await routeIdleTaskInProcessIssue({
      ...input,
      cycleDeadlineEpochMs: deadline,
    }, {
      logger,
      ensureCloneFn: () =>
        Promise.resolve({
          ok: true,
          repoPath: "/tmp/widget/widget",
          cloned: false,
        }),
      claimRouteFn: okClaim,
      ghCommandFn: (args) => {
        const body = args.find((arg) => arg.startsWith("body="));
        if (body) comments.push(body.slice(5));
        if (args.includes("state=closed")) closed = true;
        return Promise.resolve("");
      },
    });
    return { outcome, filed, comments, closed, records };
  } finally {
    registerTemplate(previous);
  }
}

// ---------------------------------------------------------------------------
// authorisedOptInTemplates
// ---------------------------------------------------------------------------

Deno.test("authorisedOptInTemplates - empty config authorises nothing", () => {
  assertEquals(authorisedOptInTemplates({}).size, 0);
});

Deno.test("authorisedOptInTemplates - a positive weight for test-audit authorises it", () => {
  const authorised = authorisedOptInTemplates({
    idleTaskTemplateWeights: { "test-audit": 2 },
  });
  assert(authorised.has("test-audit"));
});

Deno.test("authorisedOptInTemplates - a zero, negative or NaN weight does not authorise", () => {
  for (const weight of [0, -1, Number.NaN]) {
    const authorised = authorisedOptInTemplates({
      idleTaskTemplateWeights: { "test-audit": weight },
    });
    assertEquals(
      authorised.has("test-audit"),
      false,
      `weight ${weight} must not authorise test-audit`,
    );
  }
});

Deno.test("authorisedOptInTemplates - a cadence entry for test-audit authorises it", () => {
  const policy = {
    weeklyModel: "sonnet",
    monthlyModel: "sonnet",
  } as CadenceTemplatePolicy;
  const authorised = authorisedOptInTemplates({
    idleTaskCadence: { templates: { "test-audit": policy } },
  });
  assert(authorised.has("test-audit"));
});

Deno.test("authorisedOptInTemplates - config naming only security-scan authorises nothing", () => {
  const policy = {
    weeklyModel: "sonnet",
    monthlyModel: "sonnet",
  } as CadenceTemplatePolicy;
  const authorised = authorisedOptInTemplates({
    idleTaskTemplateWeights: { "security-scan": 3 },
    idleTaskCadence: { templates: { "security-scan": policy } },
  });
  assertEquals(authorised.size, 0);
});

// ---------------------------------------------------------------------------
// isAutoEnabledIdleTaskTemplate
// ---------------------------------------------------------------------------

Deno.test("isAutoEnabledIdleTaskTemplate - ordinary templates are auto-enabled with nothing authorised", () => {
  for (
    const name of [
      "security-scan",
      "supply-chain-readiness",
      "github-actions-audit",
    ]
  ) {
    assertEquals(
      isAutoEnabledIdleTaskTemplate(name, NO_AUTHORISED),
      true,
      `${name} must stay auto-enabled`,
    );
  }
});

Deno.test("isAutoEnabledIdleTaskTemplate - test-audit is off unless authorised", () => {
  assertEquals(
    isAutoEnabledIdleTaskTemplate("test-audit", NO_AUTHORISED),
    false,
  );
  assertEquals(
    isAutoEnabledIdleTaskTemplate("test-audit", new Set(["test-audit"])),
    true,
  );
});

Deno.test("OPT_IN_IDLE_TASK_TEMPLATES - names test-audit as the opt-in template", () => {
  assert(OPT_IN_IDLE_TASK_TEMPLATES.has("test-audit"));
  assertEquals(OPT_IN_IDLE_TASK_TEMPLATES.size, 1);
});

// ---------------------------------------------------------------------------
// hasIdleTaskRequestedMarker
// ---------------------------------------------------------------------------

Deno.test("hasIdleTaskRequestedMarker - marker as the last line is true", () => {
  assertEquals(
    hasIdleTaskRequestedMarker(`Run it.\n\n${IDLE_TASK_REQUESTED_MARKER}`),
    true,
  );
});

Deno.test("hasIdleTaskRequestedMarker - marker followed by trailing blank lines is true", () => {
  assertEquals(
    hasIdleTaskRequestedMarker(
      `Run it.\n${IDLE_TASK_REQUESTED_MARKER}\n\n   \n`,
    ),
    true,
  );
});

Deno.test("hasIdleTaskRequestedMarker - marker in the middle followed by other text is false", () => {
  assertEquals(
    hasIdleTaskRequestedMarker(
      `Run it.\n${IDLE_TASK_REQUESTED_MARKER}\nThen some more text.`,
    ),
    false,
  );
});

Deno.test("hasIdleTaskRequestedMarker - marker inside a code span as the last line is false", () => {
  assertEquals(
    hasIdleTaskRequestedMarker(
      `Run it.\n\`${IDLE_TASK_REQUESTED_MARKER}\``,
    ),
    false,
  );
});

Deno.test("hasIdleTaskRequestedMarker - marker with trailing text on the same line is false", () => {
  assertEquals(
    hasIdleTaskRequestedMarker(
      `Run it.\n${IDLE_TASK_REQUESTED_MARKER} please`,
    ),
    false,
  );
});

Deno.test("hasIdleTaskRequestedMarker - long hostile bodies are decided by the final line only", () => {
  assertEquals(hasIdleTaskRequestedMarker(" ".repeat(100_000) + "x"), false);
  assertEquals(
    hasIdleTaskRequestedMarker(
      "\n".repeat(100_000) + "<!-- vibe-idle-task-requested -->x",
    ),
    false,
  );
  assertEquals(
    hasIdleTaskRequestedMarker(
      " \n".repeat(100_000) + "<!-- vibe-idle-task-requested -->",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// decideOptInClaim
// ---------------------------------------------------------------------------

Deno.test("decideOptInClaim - a template that is not opt-in is allowed as not_opt_in", () => {
  const decision = decideOptInClaim({
    template: "security-scan",
    issueAuthor: "",
    issueBody: PLAIN_BODY,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(decision, { allowed: true, basis: "not_opt_in" });
});

Deno.test("decideOptInClaim - a configured template is allowed as configured", () => {
  const decision = decideOptInClaim({
    template: "test-audit",
    issueAuthor: FLEET_AUTHOR,
    issueBody: PLAIN_BODY,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: new Set(["test-audit"]),
  });
  assertEquals(decision, { allowed: true, basis: "configured" });
});

Deno.test("decideOptInClaim - a wrapper filed by a non-fleet login is allowed as owner_filed", () => {
  const decision = decideOptInClaim({
    template: "test-audit",
    issueAuthor: "alice",
    issueBody: PLAIN_BODY,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(decision, { allowed: true, basis: "owner_filed" });
});

Deno.test("decideOptInClaim - a fleet wrapper with the marker as its last line is allowed as requested", () => {
  const decision = decideOptInClaim({
    template: "test-audit",
    issueAuthor: FLEET_AUTHOR,
    issueBody: `${PLAIN_BODY}\n\n${IDLE_TASK_REQUESTED_MARKER}`,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(decision, { allowed: true, basis: "requested" });
});

Deno.test("decideOptInClaim - a fleet wrapper with no marker and nothing authorised is refused with a reason", () => {
  const decision = decideOptInClaim({
    template: "test-audit",
    issueAuthor: FLEET_AUTHOR,
    issueBody: PLAIN_BODY,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(decision.allowed, false);
  if (decision.allowed) return;
  assertStringIncludes(decision.reason, "test-audit");
  assertStringIncludes(decision.reason, "Issue #5096");
  assertStringIncludes(decision.reason, "raise-single-idle-task");
});

Deno.test("decideOptInClaim - an empty author is refused even with the marker", () => {
  const decision = decideOptInClaim({
    template: "test-audit",
    issueAuthor: "   ",
    issueBody: `${PLAIN_BODY}\n${IDLE_TASK_REQUESTED_MARKER}`,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(decision.allowed, false);
  if (decision.allowed) return;
  assertStringIncludes(decision.reason, "test-audit");
});

Deno.test("decideOptInClaim - the fleet match is case-insensitive", () => {
  const withoutMarker = decideOptInClaim({
    template: "test-audit",
    issueAuthor: "VIBE-Coder",
    issueBody: PLAIN_BODY,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(withoutMarker.allowed, false);

  const withMarker = decideOptInClaim({
    template: "test-audit",
    issueAuthor: "VIBE-Coder",
    issueBody: `${PLAIN_BODY}\n${IDLE_TASK_REQUESTED_MARKER}`,
    fleetIdentityLogins: FLEET_AUTHORS,
    authorised: NO_AUTHORISED,
  });
  assertEquals(withMarker, { allowed: true, basis: "requested" });
});

// ---------------------------------------------------------------------------
// Route gate through routeIdleTaskInProcessIssue
// ---------------------------------------------------------------------------

Deno.test(
  "route gate - a fleet-filed test-audit wrapper with nothing authorised is closed, not run (Issue #5096)",
  async () => {
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: FLEET_AUTHOR,
      }),
    );

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, []);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "without an owner request");

    const info = run.records.find((r) =>
      r.level === "info" &&
      r.message.includes("Issue #5096")
    );
    assert(info, "the refusal must be logged at info");
  },
);

Deno.test(
  "route gate - the same test-audit wrapper filed by a non-fleet login runs the scan",
  async () => {
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: "alice",
      }),
    );

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, [77]);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
  },
);

Deno.test(
  "route gate - a fleet-filed test-audit wrapper runs when the owner config authorises it",
  async () => {
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: FLEET_AUTHOR,
        authorisedOptInTemplates: new Set(["test-audit"]),
      }),
    );

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, [77]);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
  },
);

Deno.test(
  "route gate - a fleet-filed test-audit wrapper with the marker as its final line runs the scan",
  async () => {
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: FLEET_AUTHOR,
        issueBody: `${PLAIN_BODY}\n\n${IDLE_TASK_REQUESTED_MARKER}\n`,
      }),
    );

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, [77]);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
  },
);

// ---------------------------------------------------------------------------
// idleRouteOptInInput (Issue #5096)
// ---------------------------------------------------------------------------

/** Owner config: one human owner, one sibling fleet login, one service account. */
const OWNER_CONFIG = {
  allowedAuthors: ["owner-human"],
  fleetPrAuthors: ["fleet-sibling"],
  serviceAccounts: ["svc-bot"],
  idleTaskTemplateWeights: {},
  idleTaskCadence: { templates: {} },
};

Deno.test(
  "idleRouteOptInInput - fleet identity logins hold this host, fleet_pr_authors and service_accounts, never allowed_authors",
  () => {
    const input = idleRouteOptInInput({
      githubUser: "vibe-host",
      issueAuthor: null,
      config: OWNER_CONFIG,
    });

    assert(input.fleetIdentityLogins.includes("vibe-host"));
    assert(input.fleetIdentityLogins.includes("fleet-sibling"));
    assert(input.fleetIdentityLogins.includes("svc-bot"));
    assertEquals(input.fleetIdentityLogins.includes("owner-human"), false);
    assertEquals(input.issueAuthor, "");
  },
);

/**
 * Route input for a test-audit wrapper filed by `issueAuthor`, built through
 * `idleRouteOptInInput` so the production composition is exercised. The claim
 * set (`fleetAuthors`) lists the owner, as the production claim set does; the
 * opt-in gate must still count the owner as a request.
 */
function routeInputFiledBy(issueAuthor: string) {
  return {
    repo: "owner/widget",
    issueNumber: 5096,
    issueTitle: "Run a test-audit scan",
    issueLabels: ["idle-task"],
    issueBody: PLAIN_BODY,
    workDir: "/tmp/widget",
    githubUser: "vibe-host",
    fleetAuthors: ["vibe-host", "owner-human"],
    pushCapableAuthors: ["vibe-host"],
    ...idleRouteOptInInput({
      githubUser: "vibe-host",
      issueAuthor,
      config: OWNER_CONFIG,
    }),
  };
}

Deno.test(
  "route gate - a test-audit wrapper filed by an allowed_authors owner runs the scan (Issue #5096)",
  async () => {
    const run = await runRoute(routeInputFiledBy("owner-human"));

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, [77]);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
  },
);

Deno.test(
  "route gate - a test-audit wrapper filed by this host's own login is closed, not run (Issue #5096)",
  async () => {
    const run = await runRoute(routeInputFiledBy("vibe-host"));

    assertEquals(run.outcome, { routed: true, success: true });
    assertEquals(run.filed, []);
    assert(run.closed);
  },
);

Deno.test("route gate honours a verified owner request on an existing fleet wrapper", async () => {
  const run = await runRoute(
    wrapperInput({
      issueTitle: "Run a test-audit scan",
      issueAuthor: FLEET_AUTHOR,
      issueBody: "Audit only worker/deno/lib/idle_task_opt_in.ts",
      ownerRequested: true,
    }),
  );
  assertEquals(run.filed, [77]);
  assert(run.closed);
  assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
});

Deno.test("only live owner approval authorises an existing fleet wrapper", async () => {
  for (const actor of ["owner-human", FLEET_AUTHOR, "stranger"]) {
    const ownerRequested = await verifyOwnerRequestedIdleTask({
      repo: "owner/widget",
      issueNumber: 5096,
      labels: ["work-on"],
      workOnLabel: "work-on",
      trustedAuthors: ["owner-human", FLEET_AUTHOR],
      fleetIdentityLogins: FLEET_AUTHORS,
      gh: () =>
        Promise.resolve(
          JSON.stringify([{
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: actor },
            created_at: "2026-11-16T00:00:00Z",
          }]),
        ),
    });
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: FLEET_AUTHOR,
        issueBody: "Audit only the opt-in dispatch changes",
        ownerRequested,
      }),
    );
    assertEquals(run.filed, actor === "owner-human" ? [77] : []);
    assert(run.closed);
  }
});

Deno.test("raise-single reuses and authorises an existing wrapper through claim dispatch", async () => {
  for (const force of [false, true]) {
    let body = "Audit only the opt-in dispatch changes";
    let creates = 0;
    const result = await raiseSingleIdleTaskCommand.execute({
      template: "test-audit",
      repo: "owner/widget",
      force,
      __testDeps: {
        log: () => {},
        ensureLabelFn: () => Promise.resolve({ ok: true, value: undefined }),
        findOpenIdleTaskIssuesFn: () =>
          Promise.resolve([{
            number: 5096,
            title: "Run a test-audit scan",
            url: "https://github.com/owner/widget/issues/5096",
          }]),
        ghCommandFn: (args: string[]) => {
          if (args[0] === "issue" && args[1] === "view") {
            return Promise.resolve(JSON.stringify({ body }));
          }
          if (args[0] === "issue" && args[1] === "edit") {
            body = args[args.indexOf("--body") + 1]!;
          }
          if (args[0] === "issue" && args[1] === "create") creates++;
          return Promise.resolve("");
        },
      },
    }, buildDefaultWorkerConfig());
    assert(result.success, result.message);
    assertEquals(creates, 0);
    assertStringIncludes(body, "Audit only the opt-in dispatch changes");
    const run = await runRoute(
      wrapperInput({
        issueTitle: "Run a test-audit scan",
        issueAuthor: FLEET_AUTHOR,
        issueBody: body,
      }),
    );
    assertEquals(run.filed, [77]);
    assert(run.closed);
    assertStringIncludes(run.comments.join("\n"), "Filed 1 issues: #77");
  }
});
