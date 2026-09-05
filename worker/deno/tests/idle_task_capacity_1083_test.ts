/**
 * Idle-task capacity: fill every idle slot, one wrapper per repository
 * (Issue #1083).
 *
 * Three independent caps stacked on idle-task raising, each of which alone
 * held the fleet at one open wrapper while six slots sat idle:
 *
 *   1. `findAnyOpenIdleTaskWrapper` — one open wrapper across the **whole**
 *      monitored set. Idle capacity beyond the first slot could not be
 *      filled by design.
 *   2. `IdleFilerLatch` — one filer call per idle **episode per host**,
 *      whatever the number of idle slots. Its own comment treated "N slots
 *      going idle would file N issues" as the defect; under the operator's
 *      rule that is the requirement.
 *   3. The fleet-global startable-work gate — **one** startable issue
 *      anywhere suppressed **all** idle filing everywhere. A startable
 *      issue occupies one slot, not eight.
 *
 * The replacement is one question asked three times: *how many slots are
 * idle right now, and how many repositories can take an idle task?* — file
 * `min(idle slots, eligible repos)`, one per repository, pseudo-randomly
 * chosen, at most one per tick so no single tick fans out (the #2089
 * protection these caps were really built for).
 *
 * The gates under test run their **real** implementations here, driven by a
 * `gh` fake that models the API's own rules; only the surrounding
 * per-repo gates (cooldown, backlog, milestone, label) are stubbed, so a
 * regression in the capacity logic cannot hide behind a stubbed verdict.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  registerTemplate,
} from "../lib/idle_task_template.ts";
import type { IdleTaskMilestone } from "../lib/idle_task_milestone.ts";
import type { Result } from "../types.ts";
import { findOpenIdleTaskWrappers } from "../lib/idle_task_issue.ts";
import { countReposWithStartableWork } from "../lib/repo_busy_for_idle_task.ts";
import { IdleFilerLatch } from "../lib/slot_idle_accounting.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TEMPLATE_NAME = "idle-capacity-1083-template";

const testTemplate: IdleTaskTemplate = {
  name: TEMPLATE_NAME,
  description: "Test-only idle-task template for the Issue #1083 suite.",
  buildIssueTitle: (repo) => `Run ${TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) => `# ${TEMPLATE_NAME} on ${opts.repo}`,
  runTask: () => Promise.resolve({ ok: true, summary: `${TEMPLATE_NAME} ran` }),
};

if (getTemplate(TEMPLATE_NAME) === undefined) registerTemplate(testTemplate);

/** The live shape the issue measured: fourteen empty repositories. */
const FOURTEEN_REPOS: readonly string[] = Array.from(
  { length: 14 },
  (_v, i) => `org/repo-${String(i + 1).padStart(2, "0")}`,
);

interface FleetFixture {
  /** Repos holding an open `idle-task` wrapper → its issue number. */
  wrappers?: Record<string, number>;
  /** Repos holding an open, startable `work-on` issue → its number. */
  startable?: Record<string, number>;
}

interface GhFake {
  fn: (args: string[]) => Promise<string>;
  creates: string[];
}

/**
 * A `gh` fake that answers by the CLI's own rules rather than by replaying a
 * script: the label-filtered wrapper query, the unfiltered open-issue list
 * the startable-work gate reads, and `issue create`. Anything else answers
 * with an empty list, which every caller reads as "nothing here".
 */
function makeGhFake(fixture: FleetFixture): GhFake {
  const creates: string[] = [];
  const wrappers = fixture.wrappers ?? {};
  const startable = fixture.startable ?? {};
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      const repoIndex = args.indexOf("--repo");
      const repo = repoIndex >= 0 ? args[repoIndex + 1]! : "unknown";
      creates.push(repo);
      return Promise.resolve(`https://github.com/${repo}/issues/4242\n`);
    }
    if (args[0] === "issue" && args[1] === "list") {
      const repoIndex = args.indexOf("--repo");
      const repo = repoIndex >= 0 ? args[repoIndex + 1]! : "";
      if (args.includes("--label")) {
        // The wrapper dedup query: `--label idle-task --json number,url`.
        const number = wrappers[repo];
        return Promise.resolve(
          number === undefined ? "[]" : JSON.stringify([{
            number,
            url: `https://github.com/${repo}/issues/${number}`,
          }]),
        );
      }
      // The startable-work gate's unfiltered open-issue list.
      const number = startable[repo];
      return Promise.resolve(
        number === undefined ? "[]" : JSON.stringify([{
          number,
          title: "Real work",
          labels: [{ name: "work-on" }],
          assignees: [],
          body: "",
        }]),
      );
    }
    return Promise.resolve("[]");
  };
  return { fn, creates };
}

/** Deterministic chooser so "pseudo-random" is assertable (Issue #1083). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG — deterministic, uniform enough to spread.
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface TickResult {
  action: string;
  reason?: string;
  repo?: string;
}

/**
 * Run one idle tick of the filer against `fixture`. Every gate outside the
 * three under test is stubbed to "permitted" so a failure names the cap it
 * came from.
 */
async function runTick(opts: {
  repos: readonly string[];
  fixture: FleetFixture;
  idleSlots: number;
  randomFn?: () => number;
  log?: string[];
  gh?: GhFake;
}): Promise<{ result: TickResult; gh: GhFake; log: string[] }> {
  const gh = opts.gh ?? makeGhFake(opts.fixture);
  const log = opts.log ?? [];
  const busyRepos = new Set(Object.keys(opts.fixture.startable ?? {}));
  const outcome = await maybeFileIdleTaskCommand.execute(
    {
      "monitored-repos": opts.repos.join(","),
      "github-user": "VibeBot",
      "idle-slots": String(opts.idleSlots),
      __testDeps: {
        ghCommandFn: gh.fn,
        pickTemplateFn: () => testTemplate,
        // Placement gate (#2054): a repo holding real work is busy.
        isRepoBusyFn: (o: { repo: string }) =>
          Promise.resolve(busyRepos.has(o.repo)),
        isRepoCooledDownFn: () => Promise.resolve(false),
        countOutputLabelOpenIssuesFn: () => Promise.resolve(0),
        dueScansFn: () => Promise.resolve([]),
        verifyLabelsFn: () => Promise.resolve(["idle-task"]),
        ensureLabelFn: () =>
          Promise.resolve({ ok: true, value: undefined } as Result<void>),
        ensureMilestoneFn: (o: { repo: string; template: string }) =>
          Promise.resolve(
            {
              number: 17,
              title: `idle-task: ${o.template}`,
            } as IdleTaskMilestone,
          ),
        nowFn: () => new Date("2026-09-05T00:00:00.000Z"),
        randomFn: opts.randomFn ?? seededRandom(7),
        log: (line: string) => log.push(line),
      },
    },
    buildDefaultWorkerConfig(),
  );
  return {
    result: (outcome.data ?? { action: "none" }) as TickResult,
    gh,
    log,
  };
}

// ---------------------------------------------------------------------------
// 1. The live shape — 14 empty repos, 6 idle slots, one holding a wrapper
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - a repo holding a wrapper is skipped and another repo is filed (Issue #1083)",
  async () => {
    const holder = FOURTEEN_REPOS[3]!;
    const { result, gh, log } = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: { wrappers: { [holder]: 991 } },
      idleSlots: 6,
    });

    assertEquals(
      result.action,
      "filed",
      "six idle slots and thirteen clean repositories must produce a filing",
    );
    assert(
      result.repo !== undefined && result.repo !== holder,
      `expected a repo other than the wrapper holder ${holder}, got ${result.repo}`,
    );
    assertEquals(gh.creates.length, 1);

    // The refusal must be visible: the absence of this line is why the cap
    // took a week to notice.
    const refusal = log.find((l) =>
      l.includes("reason=existing_wrapper_open") && l.includes(`repo=${holder}`)
    );
    assert(
      refusal !== undefined,
      `expected a refusal line naming ${holder}; got:\n${log.join("\n")}`,
    );
    assertStringIncludes(refusal!, "issue=991");
    assertStringIncludes(refusal!, "scope=repo");
  },
);

// ---------------------------------------------------------------------------
// 2. The #2089 direction — one per tick, next tick re-decides
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - a single tick files at most one wrapper and the next tick re-decides (Issue #2089)",
  async () => {
    // Ten empty repositories and ten idle slots: the tick still files once.
    const gh = makeGhFake({});
    const first = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: {},
      idleSlots: 10,
      gh,
    });
    assertEquals(first.result.action, "filed");
    assertEquals(
      gh.creates.length,
      1,
      "one tick must not fan wrappers out across the fleet",
    );

    // The next tick decides again from fresh state — the repo just filed
    // into now holds a wrapper, so a different one is chosen.
    const filed = first.result.repo!;
    const second = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: { wrappers: { [filed]: 1001 } },
      idleSlots: 10,
    });
    assertEquals(second.result.action, "filed");
    assert(
      second.result.repo !== filed,
      "the next tick must re-decide from fresh state, not re-file into the same repo",
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Per-repo exclusivity
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - a repo with an open idle task is never given a second (Issue #1083)",
  async () => {
    const { result, gh } = await runTick({
      repos: ["org/only"],
      fixture: { wrappers: { "org/only": 55 } },
      idleSlots: 6,
    });
    assertEquals(result.action, "skipped");
    assertEquals(result.reason, "existing_wrapper_open");
    assertEquals(gh.creates.length, 0, "no repo may carry two open wrappers");
  },
);

// ---------------------------------------------------------------------------
// 4. The quiet fleet — no idle slots, nothing filed
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - no idle slots files nothing however many repos are empty (Issue #1083)",
  async () => {
    const { result, gh } = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: {},
      idleSlots: 0,
    });
    assertEquals(result.action, "skipped");
    assertEquals(result.reason, "no_idle_capacity");
    assertEquals(gh.creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// 5. Pseudo-random selection spreads across eligible repositories
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - repeated ticks spread the choice across eligible repos (Issue #1083)",
  async () => {
    const chosen = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const { result } = await runTick({
        repos: FOURTEEN_REPOS,
        fixture: {},
        idleSlots: 6,
        randomFn: seededRandom(seed * 7919),
      });
      assertEquals(result.action, "filed");
      chosen.add(result.repo!);
    }
    assert(
      chosen.size > 1,
      `selection must spread across eligible repos, always chose ${
        [...chosen].join(",")
      }`,
    );
  },
);

// ---------------------------------------------------------------------------
// 6. One startable issue anywhere does not suppress filing everywhere
// ---------------------------------------------------------------------------

Deno.test(
  "idle capacity - one startable issue occupies one slot, not the whole fleet (Issue #1083)",
  async () => {
    const busy = FOURTEEN_REPOS[0]!;
    const { result, gh } = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: { startable: { [busy]: 77 } },
      idleSlots: 6,
    });
    assertEquals(
      result.action,
      "filed",
      "one startable issue must not suppress idle filing in thirteen other repos",
    );
    assert(result.repo !== busy, "the repo holding real work is not a target");
    assertEquals(gh.creates.length, 1);
  },
);

Deno.test(
  "idle capacity - enough startable work for every idle slot files nothing (Issue #1083)",
  async () => {
    const startable: Record<string, number> = {};
    for (let i = 0; i < 6; i++) startable[FOURTEEN_REPOS[i]!] = 100 + i;
    const { result, gh } = await runTick({
      repos: FOURTEEN_REPOS,
      fixture: { startable },
      idleSlots: 6,
    });
    assertEquals(result.action, "skipped");
    assertEquals(result.reason, "approved_work_in_flight");
    assertEquals(gh.creates.length, 0);
  },
);

// ---------------------------------------------------------------------------
// The per-repo wrapper scan itself
// ---------------------------------------------------------------------------

Deno.test(
  "findOpenIdleTaskWrappers - reports every repo holding a wrapper, not just the first",
  async () => {
    const gh = makeGhFake({ wrappers: { "org/a": 1, "org/c": 3 } });
    const found = await findOpenIdleTaskWrappers(["org/a", "org/b", "org/c"], {
      ghCommandFn: gh.fn,
    });
    assertEquals(found.map((w) => w.repo), ["org/a", "org/c"]);
    assertEquals(found.map((w) => w.number), [1, 3]);
  },
);

Deno.test(
  "findOpenIdleTaskWrappers - a per-repo gh failure is warned and the scan continues",
  async () => {
    const warnings: string[] = [];
    const found = await findOpenIdleTaskWrappers(["org/bad", "org/good"], {
      ghCommandFn: (args: string[]) =>
        args.includes("org/bad")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve('[{"number":9,"url":"u"}]'),
      warn: (m: string) => warnings.push(m),
    });
    assertEquals(found.map((w) => w.repo), ["org/good"]);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "org/bad");
  },
);

// ---------------------------------------------------------------------------
// Counting startable work rather than short-circuiting on the first hit
// ---------------------------------------------------------------------------

Deno.test(
  "countReposWithStartableWork - counts every repo holding startable work",
  async () => {
    const gh = makeGhFake({ startable: { "org/a": 1, "org/c": 3 } });
    const count = await countReposWithStartableWork({
      repos: ["org/a", "org/b", "org/c"],
      ghCommandFn: gh.fn,
      logFn: () => {},
    });
    assertEquals(count, 2);
  },
);

Deno.test(
  "countReposWithStartableWork - stopAt short-circuits once the bound is met",
  async () => {
    const probed: string[] = [];
    const fake = makeGhFake({ startable: { "org/a": 1, "org/b": 2 } });
    const count = await countReposWithStartableWork({
      repos: ["org/a", "org/b", "org/c"],
      ghCommandFn: (args: string[]) => {
        const i = args.indexOf("--repo");
        if (i >= 0) probed.push(args[i + 1]!);
        return fake.fn(args);
      },
      logFn: () => {},
      stopAt: 1,
    });
    assertEquals(count, 1);
    assertEquals(probed, ["org/a"], "a met bound costs no further probes");
  },
);

// ---------------------------------------------------------------------------
// The filer latch — one filing per idle slot per episode, not one per host
// ---------------------------------------------------------------------------

Deno.test(
  "IdleFilerLatch - six idle slots on one host may file six idle tasks (Issue #1083)",
  () => {
    const latch = new IdleFilerLatch(() => 6);
    for (let i = 1; i <= 6; i++) {
      assertEquals(
        latch.tryConsume(`s${i}`),
        true,
        `slot s${i} is idle and must be allowed to file`,
      );
    }
    assertEquals(
      latch.tryConsume("s7"),
      false,
      "filing is bounded by idle capacity, never unbounded",
    );
  },
);

Deno.test(
  "IdleFilerLatch - one slot re-scanning files once per episode (Issue #925)",
  () => {
    const latch = new IdleFilerLatch(() => 6);
    assertEquals(latch.tryConsume("s1"), true);
    for (let i = 0; i < 74; i++) {
      assertEquals(
        latch.tryConsume("s1"),
        false,
        "74 re-scans are one episode",
      );
    }
    assertEquals(latch.filedCount, 1);
  },
);

Deno.test(
  "IdleFilerLatch - a fully occupied fleet has no idle capacity and files nothing",
  () => {
    const latch = new IdleFilerLatch(() => 0);
    assertEquals(latch.tryConsume("s1"), false);
    assertEquals(latch.fired, false);
  },
);

Deno.test(
  "IdleFilerLatch - a claim ends the episode so a later idle stretch may file again",
  () => {
    const latch = new IdleFilerLatch(() => 2);
    assertEquals(latch.tryConsume("s1"), true);
    latch.release();
    assertEquals(latch.fired, false);
    assertEquals(latch.tryConsume("s1"), true);
  },
);
