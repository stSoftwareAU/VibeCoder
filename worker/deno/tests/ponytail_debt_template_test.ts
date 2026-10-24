/**
 * Report-only SIMPLE-ON-PURPOSE debt ledger (Issue #4027).
 *
 * The task posts or refreshes one ledger issue. It does not commit and it
 * does not open a pull request. A scanner error is loud.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import {
  createPonytailDebtTemplate,
  PONYTAIL_DEBT_ISSUE_TITLE,
  PONYTAIL_DEBT_LABEL,
  PONYTAIL_DEBT_REPORT_TITLE,
  ponytailDebtTemplate,
  renderPonytailDebtBody,
  renderPonytailDebtSummary,
} from "../lib/idle_task_templates/ponytail_debt_template.ts";
import type { SimpleOnPurposeMarker } from "../lib/simple_on_purpose_scanner.ts";
import type { Logger } from "../types.ts";

const MARKER =
  "// SIMPLE-ON-PURPOSE: linear scan, fine to 10 rows — upgrade when a table exceeds 10 rows";

function okLabel(): Promise<{ ok: true; value: undefined }> {
  return Promise.resolve({ ok: true, value: undefined });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=ponytail-debt@example.com",
      "-c",
      "user.name=Ponytail Debt",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (out.code !== 0) throw new Error(stderr || stdout);
  return stdout;
}

function bodyOf(args: string[]): string {
  const index = args.indexOf("--body");
  return index < 0 ? "" : args[index + 1] ?? "";
}

function writesCommitOrPullRequest(args: string[]): boolean {
  if (args.includes("commit")) return true;
  return args[0] === "pr" && args[1] === "create";
}

Deno.test("ponytail-debt - registered at module load", () => {
  const template = getTemplate("ponytail-debt");
  assert(template !== undefined);
  assert(listTemplates().some((item) => item.name === "ponytail-debt"));
  assertEquals(
    template.buildIssueTitle("acme/widget"),
    PONYTAIL_DEBT_ISSUE_TITLE,
  );
  assertEquals(ponytailDebtTemplate.skipMilestone, true);
  assertEquals(ponytailDebtTemplate.requiresStructuredOutput, true);
  assertEquals(ponytailDebtTemplate.outputLabel, PONYTAIL_DEBT_LABEL);
});

Deno.test("renderPonytailDebtBody - flags a missing upgrade when and a malformed marker", () => {
  const markers: SimpleOnPurposeMarker[] = [
    {
      path: "src/a.ts",
      line: 4,
      ceiling: "linear scan, fine to 10 rows",
      upgradeWhen: "a table exceeds 10 rows",
      flag: "ok",
    },
    {
      path: "src/b.ts",
      line: 2,
      ceiling: "one page",
      upgradeWhen: "",
      flag: "missing-upgrade-when",
    },
    {
      path: "src/c.ts",
      line: 1,
      ceiling: "",
      upgradeWhen: "",
      flag: "malformed",
    },
  ];
  const body = renderPonytailDebtBody(markers, "footer");
  assertStringIncludes(body, "`src/a.ts:4`");
  assertStringIncludes(body, "ceiling: linear scan, fine to 10 rows");
  assertStringIncludes(body, "upgrade when: a table exceeds 10 rows");
  assertStringIncludes(body, "`src/b.ts:2`");
  assertStringIncludes(body, "**flagged: missing upgrade when**");
  assertStringIncludes(body, "`src/c.ts:1`");
  assertStringIncludes(body, "**flagged: malformed**");
  assertStringIncludes(body, "3 markers, 2 flagged.");
});

Deno.test("renderPonytailDebtSummary - names a post and a refresh", () => {
  const markers: SimpleOnPurposeMarker[] = [];
  assertEquals(
    renderPonytailDebtSummary("posted", 42, markers),
    "Posted the SIMPLE-ON-PURPOSE debt ledger as #42. 0 markers, 0 flagged.",
  );
  assertEquals(
    renderPonytailDebtSummary("refreshed", 9, markers),
    "Refreshed the SIMPLE-ON-PURPOSE debt ledger #9. 0 markers, 0 flagged.",
  );
});

Deno.test("ponytail-debt runTask - posts one report and writes no commit", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ponytail-debt-run-" });
  const checkout = `${dir}/repo`;
  await Deno.mkdir(`${checkout}/src`, { recursive: true });
  await Deno.writeTextFile(`${checkout}/src/cut.ts`, `${MARKER}\n`);
  await git(checkout, ["init", "-q"]);
  await git(checkout, ["add", "."]);
  await git(checkout, ["commit", "-qm", "fixture"]);
  const before = await git(checkout, ["rev-parse", "HEAD"]);

  const calls: string[][] = [];
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    ghCommandFn: (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve("https://github.com/acme/repo/issues/42\n");
      }
      return Promise.reject(new Error(`unexpected ${args.join(" ")}`));
    },
  });

  const result = await template.runTask({
    repo: "acme/repo",
    workDir: dir,
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true, result.summary);
  assertStringIncludes(result.summary, "Posted");
  assertStringIncludes(result.summary, "#42");
  const creates = calls.filter((args) => args[1] === "create");
  assertEquals(creates.length, 1);
  const body = bodyOf(creates[0]!);
  assertStringIncludes(body, "`src/cut.ts:1`");
  assertStringIncludes(body, "ceiling: linear scan, fine to 10 rows");
  assertStringIncludes(body, "upgrade when: a table exceeds 10 rows");
  assertEquals(creates[0]?.includes(PONYTAIL_DEBT_LABEL), true);
  assertEquals(calls.some(writesCommitOrPullRequest), false);
  assertEquals(await git(checkout, ["rev-parse", "HEAD"]), before);
  assertEquals(await git(checkout, ["status", "--porcelain"]), "");
  assertEquals(
    await Deno.readTextFile(`${checkout}/src/cut.ts`),
    `${MARKER}\n`,
  );

  await Deno.remove(dir, { recursive: true });
});

Deno.test("ponytail-debt runTask - refreshes the open ledger and does not create another", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ponytail-debt-refresh-" });
  const checkout = `${dir}/repo`;
  await Deno.mkdir(checkout, { recursive: true });
  await Deno.writeTextFile(
    `${checkout}/cut.ts`,
    "// SIMPLE-ON-PURPOSE:\n",
  );

  const calls: string[][] = [];
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    ghCommandFn: (args) => {
      calls.push(args);
      if (args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 9,
          title: PONYTAIL_DEBT_REPORT_TITLE,
        }]));
      }
      if (args[1] === "edit") return Promise.resolve("");
      return Promise.reject(new Error(`unexpected ${args.join(" ")}`));
    },
  });

  const result = await template.runTask({
    repo: "acme/repo",
    workDir: dir,
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true, result.summary);
  assertStringIncludes(result.summary, "Refreshed");
  assertStringIncludes(result.summary, "#9");
  assertEquals(calls.some((args) => args[1] === "create"), false);
  assertEquals(calls.some(writesCommitOrPullRequest), false);
  const edit = calls.find((args) => args[1] === "edit");
  assert(edit !== undefined);
  assertEquals(edit[2], "9");
  assertStringIncludes(bodyOf(edit), "`cut.ts:1`");
  assertStringIncludes(bodyOf(edit), "**flagged: malformed**");

  await Deno.remove(dir, { recursive: true });
});

Deno.test("ponytail-debt runTask - a scanner error fails loud and posts nothing", async () => {
  const calls: string[][] = [];
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve("[]");
    },
    scanFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("cannot scan src/locked.ts: Permission denied"),
      }),
  });

  const result = await template.runTask({
    repo: "acme/repo",
    workDir: "/work",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "Scanner error:");
  assertStringIncludes(result.summary, "Permission denied");
  assertEquals(calls.length, 0);
  assertEquals(/\bno findings\b/i.test(result.summary), false);
});

Deno.test("ponytail-debt runTask - a thrown scanner never throws out of runTask", async () => {
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    scanFn: () => Promise.reject(new Error("boom")),
  });
  const result = await template.runTask({
    repo: "acme/repo",
    workDir: "/work",
    idleTaskIssueNumber: 7,
  });
  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "ponytail-debt threw: boom");
});

Deno.test("ponytail-debt runTask - the scanner reads the repo checkout, not the parent work dir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ponytail-debt-checkout-" });
  await Deno.writeTextFile(
    `${dir}/parent.ts`,
    "// SIMPLE-ON-PURPOSE: parent only — upgrade when the parent is scanned\n",
  );
  await Deno.mkdir(`${dir}/repo`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/repo/child.ts`,
    "// SIMPLE-ON-PURPOSE: child only — upgrade when the checkout is scanned\n",
  );

  const calls: string[][] = [];
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    ghCommandFn: (args) => {
      calls.push(args);
      if (args[1] === "list") return Promise.resolve("[]");
      if (args[1] === "create") {
        return Promise.resolve("https://github.com/acme/repo/issues/3\n");
      }
      return Promise.reject(new Error(args.join(" ")));
    },
  });

  const result = await template.runTask({
    repo: "acme/repo",
    workDir: dir,
    idleTaskIssueNumber: 1,
  });
  assertEquals(result.ok, true, result.summary);
  const body = bodyOf(calls.find((args) => args[1] === "create") ?? []);
  assertStringIncludes(body, "`child.ts:1`");
  assertEquals(body.includes("parent.ts"), false);
  assertEquals(body.includes("parent only"), false);

  await Deno.remove(dir, { recursive: true });
});

Deno.test("ponytail-debt shouldFile - an empty title search does not veto", async () => {
  const template = createPonytailDebtTemplate({
    ghCommandFn: () => Promise.resolve("[]"),
    dedupAuthors: { fleetAuthors: ["vibe-coder"] },
  });
  assertEquals(await template.shouldFile!({ repo: "acme/widget" }), true);
});

Deno.test("ponytail-debt - claim handler dispatches the wrapper to runTask", async () => {
  const template = createPonytailDebtTemplate({
    ensureLabelFn: okLabel,
    ghCommandFn: (args) => {
      if (args[1] === "list") return Promise.resolve("[]");
      if (args[1] === "create") {
        return Promise.resolve("https://github.com/acme/widget/issues/8\n");
      }
      return Promise.reject(new Error(args.join(" ")));
    },
    scanFn: () => Promise.resolve({ ok: true, value: [] }),
  });
  const noop = () => {};
  const deps: HandleIdleTaskIssueDeps = {
    logger: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      security: noop,
      skipReason: noop,
      timing: noop,
      scanSummary: noop,
      workerSummary: noop,
    } satisfies Logger,
    listTemplatesFn: () => [template],
  };
  const result = await handleIdleTaskIssue({
    repo: "acme/widget",
    issueNumber: 7,
    issueTitle: PONYTAIL_DEBT_ISSUE_TITLE,
    issueLabels: ["idle-task"],
    issueBody: "",
    workDir: "/tmp/widget",
  }, deps);
  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertStringIncludes(result.summary ?? "", "Posted");
});
