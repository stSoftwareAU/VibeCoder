/**
 * Tests for the busy-repo check used by the idle-task filer (Issue #2054).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  anyRepoHasUnblockedRealWork,
  APPROVED_WORK_LABELS,
  BLOCKED_LABELS,
  isRepoBusyForIdleTask,
  REAL_WORK_LABELS,
} from "../lib/repo_busy_for_idle_task.ts";

interface GhCall {
  args: string[];
}

function makeRecorder(responder: (label: string) => string) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const labelIdx = args.indexOf("--label");
    const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "") : "";
    return Promise.resolve(responder(label));
  };
  return { fn, calls };
}

/**
 * Recorder that varies the gh response by both repo and label, used by the
 * fleet-global existence tests (Issue #2813).
 */
function makeRepoRecorder(responder: (repo: string, label: string) => string) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? (args[repoIdx + 1] ?? "") : "";
    const labelIdx = args.indexOf("--label");
    const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "") : "";
    return Promise.resolve(responder(repo, label));
  };
  return { fn, calls };
}

Deno.test(
  "isRepoBusyForIdleTask - returns false when no approved-work labels are present",
  async () => {
    const recorder = makeRecorder((_label) => "[]");
    const busy = await isRepoBusyForIdleTask({
      repo: "org/idle-a",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, false);
    // Every label must have been probed since none returned a hit.
    assertEquals(recorder.calls.length, APPROVED_WORK_LABELS.length);
    for (const c of recorder.calls) {
      assertEquals(c.args[0], "issue");
      assertEquals(c.args[1], "list");
      const repoIdx = c.args.indexOf("--repo");
      assertEquals(c.args[repoIdx + 1], "org/idle-a");
      const stateIdx = c.args.indexOf("--state");
      assertEquals(c.args[stateIdx + 1], "open");
    }
  },
);

Deno.test(
  "isRepoBusyForIdleTask - returns true when work-on label has an open issue",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "work-on" ? '[{"number":42}]' : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/busy",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
    // The observable outcome is `busy === true`. We deliberately do NOT
    // assert the exact call count: that would pin the implementation to
    // probing labels one-at-a-time in a specific order and
    // short-circuiting at a fixed index (Issue #2690). A
    // behaviour-preserving refactor — re-ordering the probes or batching
    // them into one query — returns the same verdict and must keep
    // passing.
  },
);

Deno.test(
  "isRepoBusyForIdleTask - returns true when top-priority label is present",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "top-priority" ? '[{"number":1}]' : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/busy",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - returns true when low-priority label is present",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "low-priority" ? '[{"number":11}]' : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/busy",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - returns true when idle-task label is present",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "idle-task" ? '[{"number":7}]' : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/busy",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - low-priority + failed is not busy (blocked)",
  async () => {
    // The only approved-work issue also carries `failed`, so the worker
    // cannot pick it up — repo must NOT register as busy (Issue #2440).
    const recorder = makeRecorder((label) =>
      label === "low-priority"
        ? '[{"number":11,"labels":[{"name":"low-priority"},{"name":"failed"}]}]'
        : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/blocked",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, false);
    // Every label probed since none yielded an unblocked issue.
    assertEquals(recorder.calls.length, APPROVED_WORK_LABELS.length);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - low-priority + needs-human is not busy (blocked)",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "low-priority"
        ? '[{"number":12,"labels":[{"name":"low-priority"},{"name":"needs-human"}]}]'
        : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/blocked",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, false);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - blocked low-priority plus a bare top-priority is busy",
  async () => {
    // A blocked `low-priority` issue does not qualify, but a separate
    // bare `top-priority` issue does — repo is busy on the unblocked one.
    const recorder = makeRecorder((label) => {
      if (label === "top-priority") {
        return '[{"number":1,"labels":[{"name":"top-priority"}]}]';
      }
      if (label === "low-priority") {
        return '[{"number":11,"labels":[{"name":"low-priority"},{"name":"failed"}]}]';
      }
      return "[]";
    });
    const busy = await isRepoBusyForIdleTask({
      repo: "org/mixed",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - busy when an unblocked issue sits alongside a blocked one under the same label",
  async () => {
    // The page contains both a blocked and an unblocked low-priority
    // issue; at least one survives the filter, so the repo is busy.
    const recorder = makeRecorder((label) =>
      label === "low-priority"
        ? '[{"number":11,"labels":[{"name":"low-priority"},{"name":"planning"}]},' +
          '{"number":13,"labels":[{"name":"low-priority"}]}]'
        : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/mixed-page",
      ghCommandFn: recorder.fn,
    });
    assertEquals(busy, true);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - unblocked issue beyond the first page still makes the repo busy (Issue #2474)",
  async () => {
    // Regression test for the pagination boundary bug. Build 12
    // low-priority issues: the first 10 are blocked (`failed`) and the
    // last two are unblocked, sitting beyond the old 10-issue page
    // boundary. The mock gh honours `--limit` by truncating, faithfully
    // reproducing the server-side pagination that caused the false
    // "not busy" verdict.
    const lowPriorityIssues: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      lowPriorityIssues.push({
        number: i + 1,
        labels: [{ name: "low-priority" }, { name: "failed" }],
      });
    }
    lowPriorityIssues.push({ number: 11, labels: [{ name: "low-priority" }] });
    lowPriorityIssues.push({ number: 12, labels: [{ name: "low-priority" }] });

    const calls: GhCall[] = [];
    const fn = (args: string[]): Promise<string> => {
      calls.push({ args: [...args] });
      const labelIdx = args.indexOf("--label");
      const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "") : "";
      const limitIdx = args.indexOf("--limit");
      const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? "0") : 30;
      if (label === "low-priority") {
        return Promise.resolve(
          JSON.stringify(lowPriorityIssues.slice(0, limit)),
        );
      }
      return Promise.resolve("[]");
    };

    const busy = await isRepoBusyForIdleTask({
      repo: "org/paged",
      ghCommandFn: fn,
    });
    // Old code fetched only the first 10 (all blocked) and reported
    // not-busy; the fix fetches the full set and finds the unblocked
    // issues beyond the boundary.
    assertEquals(busy, true);
    // The fetch must request well beyond the old 10-issue page.
    const lowCall = calls.find((c) => {
      const i = c.args.indexOf("--label");
      return i >= 0 && c.args[i + 1] === "low-priority";
    });
    assert(lowCall !== undefined);
    const limitIdx = lowCall!.args.indexOf("--limit");
    assert(Number(lowCall!.args[limitIdx + 1]) > 10);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - logs per-label unblocked/blocked counts (Issue #2474)",
  async () => {
    const logs: string[] = [];
    const recorder = makeRecorder((label) =>
      label === "low-priority"
        ? '[{"number":11,"labels":[{"name":"low-priority"},{"name":"failed"}]},' +
          '{"number":13,"labels":[{"name":"low-priority"}]}]'
        : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/counted",
      ghCommandFn: recorder.fn,
      logFn: (m) => logs.push(m),
    });
    assertEquals(busy, true);
    // A structured, greppable count line for the low-priority label.
    const line = logs.find(
      (l) => l.includes("label=low-priority") && l.includes("unblocked="),
    );
    assert(line !== undefined);
    assert(line!.includes("repo=org/counted"));
    assert(line!.includes("unblocked=1"));
    assert(line!.includes("blocked=1"));
  },
);

Deno.test(
  "isRepoBusyForIdleTask - logs a warning when a label's fetch hits the cap (Issue #2474)",
  async () => {
    // 500 unblocked low-priority issues — exactly the fetch cap — must
    // trigger the truncation warning so the bounded coverage is visible.
    const issues: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 500; i++) {
      issues.push({ number: i + 1, labels: [{ name: "low-priority" }] });
    }
    const logs: string[] = [];
    const recorder = makeRecorder((label) =>
      label === "low-priority" ? JSON.stringify(issues) : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/capped",
      ghCommandFn: recorder.fn,
      logFn: (m) => logs.push(m),
    });
    assertEquals(busy, true);
    const warn = logs.find((l) => l.includes("reason=fetch_cap_reached"));
    assert(warn !== undefined);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - logs a warning on malformed gh output (Issue #2474)",
  async () => {
    const logs: string[] = [];
    const recorder = makeRecorder((label) =>
      label === "top-priority" ? "not json" : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/bad",
      ghCommandFn: recorder.fn,
      logFn: (m) => logs.push(m),
    });
    assertEquals(busy, false);
    const warn = logs.find((l) => l.includes("reason=malformed_gh_output"));
    assert(warn !== undefined);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - BLOCKED_LABELS covers the non-pickable labels",
  () => {
    assertEquals(
      [...BLOCKED_LABELS].sort(),
      [
        "failed",
        "failed-once",
        "needs-human",
        "planning",
      ],
    );
  },
);

Deno.test(
  "isRepoBusyForIdleTask - tolerates malformed gh output and continues",
  async () => {
    const recorder = makeRecorder((label) =>
      label === "top-priority" ? "not json" : "[]"
    );
    const busy = await isRepoBusyForIdleTask({
      repo: "org/idle",
      ghCommandFn: recorder.fn,
    });
    // Malformed response for one label does not flag busy; the rest
    // are empty, so overall non-busy.
    assertEquals(busy, false);
  },
);

Deno.test(
  "isRepoBusyForIdleTask - covers exactly the canonical busy labels",
  () => {
    // Regression guard against accidental label drift. Issue #2077
    // retired `idle-task-pending`, so the canonical set is four
    // labels — this test fails loudly if a future change deletes or
    // renames one without updating the design.
    assertEquals(
      [...APPROVED_WORK_LABELS].sort(),
      [
        "idle-task",
        "low-priority",
        "top-priority",
        "work-on",
      ],
    );
  },
);

Deno.test(
  "isRepoBusyForIdleTask - surfaces gh errors to the caller",
  async () => {
    const fn = (_args: string[]): Promise<string> => {
      return Promise.reject(new Error("gh boom"));
    };
    let caught: Error | null = null;
    try {
      await isRepoBusyForIdleTask({ repo: "org/x", ghCommandFn: fn });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    assert(caught !== null);
    assertEquals(caught!.message, "gh boom");
  },
);

// ---------------------------------------------------------------------------
// Fleet-global existence gate (Issue #2813)
// ---------------------------------------------------------------------------

Deno.test(
  "REAL_WORK_LABELS - is APPROVED_WORK_LABELS minus idle-task",
  () => {
    // The fleet existence gate excludes `idle-task` (an in-flight wrapper
    // is caught earlier by the cross-repo dedup); only real work suppresses
    // fresh idle filing.
    assertEquals(
      [...REAL_WORK_LABELS].sort(),
      [
        "low-priority",
        "top-priority",
        "work-on",
      ],
    );
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - false when no repo has real work",
  async () => {
    const recorder = makeRepoRecorder((_repo, _label) => "[]");
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: ["org/a", "org/b"],
      ghCommandFn: recorder.fn,
    });
    assertEquals(hasWork, false);
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - true when a work-on issue exists in repo A (suppresses quiet repo B)",
  async () => {
    // Repo A holds an unblocked work-on issue; repo B is empty. The fleet
    // gate must report work exists so the filer skips filing into quiet
    // repo B — the AC2 cross-repo suppression case.
    //
    // Issue #1050: the gate now reads one unfiltered open-issue list per
    // repo (work-stream occupancy is a property of the whole stream, and
    // the issue that occupies it need carry no discovery label), so the
    // stub answers per repo and the row carries its own labels.
    const recorder = makeRepoRecorder((repo, _label) =>
      repo === "org/a"
        ? '[{"number":7,"labels":[{"name":"work-on"}],"assignees":[]}]'
        : "[]"
    );
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: ["org/a", "org/b"],
      ghCommandFn: recorder.fn,
    });
    assertEquals(hasWork, true);
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - a deferred (unclaimed) work-on issue still counts as work",
  async () => {
    // The issue carries only `work-on` and no blocking label and no
    // assignee — it was simply deferred this cycle (nice/rotation/cooldown)
    // rather than claimed. Existence alone must register as work (AC1).
    const recorder = makeRepoRecorder((repo, _label) =>
      repo === "org/deferred"
        ? '[{"number":99,"labels":[{"name":"work-on"}],"assignees":[]}]'
        : "[]"
    );
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: ["org/quiet", "org/deferred"],
      ghCommandFn: recorder.fn,
    });
    assertEquals(hasWork, true);
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - a blocked work-on issue does not count",
  async () => {
    // The only work-on issue also carries `failed`, so the worker cannot
    // pick it up — it must NOT register as fleet work (Issue #2440 filter
    // reused).
    const recorder = makeRepoRecorder((repo, _label) =>
      repo === "org/blocked"
        ? '[{"number":5,"labels":[{"name":"work-on"},{"name":"failed"}],' +
          '"assignees":[]}]'
        : "[]"
    );
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: ["org/blocked"],
      ghCommandFn: recorder.fn,
    });
    assertEquals(hasWork, false);
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - idle-task label alone does not count",
  async () => {
    // An open idle-task wrapper is handled by the cross-repo dedup, not by
    // this existence gate — REAL_WORK_LABELS excludes idle-task.
    const recorder = makeRepoRecorder((repo, _label) =>
      repo === "org/idle"
        ? '[{"number":3,"labels":[{"name":"idle-task"}],"assignees":[]}]'
        : "[]"
    );
    const hasWork = await anyRepoHasUnblockedRealWork({
      repos: ["org/idle"],
      ghCommandFn: recorder.fn,
    });
    assertEquals(hasWork, false);
  },
);

Deno.test(
  "anyRepoHasUnblockedRealWork - surfaces gh errors to the caller",
  async () => {
    const fn = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("gh boom"));
    let caught: Error | null = null;
    try {
      await anyRepoHasUnblockedRealWork({
        repos: ["org/x"],
        ghCommandFn: fn,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    assert(caught !== null);
    assertEquals(caught!.message, "gh boom");
  },
);
