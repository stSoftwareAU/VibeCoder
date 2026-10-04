/**
 * Tests for the milestone not-planned doc references scan (Issue #3223).
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  addedLines,
  findIssueReferences,
  findNotPlannedDocReferences,
  NOT_PLANNED_DOCS_UNVERIFIED_NOTE,
  renderNotPlannedDocSection,
} from "../lib/milestone_not_planned_refs.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const REPO = "owner/repo";

function patchAdding(startLine: number, lines: string[]): string {
  const header = `@@ -1,0 +${startLine},${lines.length} @@`;
  const body = lines.map((l) => `+${l}`).join("\n");
  return `${header}\n${body}`;
}

// ---------------------------------------------------------------------------
// findNotPlannedDocReferences - happy paths
// ---------------------------------------------------------------------------

Deno.test("findNotPlannedDocReferences - member closed not_planned, doc names it", async () => {
  let compareCalls = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 20,
          title: "Dropped feature",
          state: "closed",
          state_reason: "not_planned",
          body: "",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      compareCalls++;
      return JSON.stringify({
        files: [
          {
            filename: "docs/x.md",
            status: "modified",
            patch: patchAdding(5, [
              "line one unrelated",
              "this feature ships via #20",
            ]),
          },
        ],
      });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(compareCalls, 1);
  assertEquals(result.value.references.length, 1);
  const ref = result.value.references[0]!;
  assertEquals(ref.issueNumber, 20);
  assertEquals(ref.title, "Dropped feature");
  assertEquals(ref.file, "docs/x.md");
  // Line 5 is unrelated, line 6 names #20.
  assertEquals(ref.lines, [6]);
});

Deno.test("findNotPlannedDocReferences - completed-closed member is ignored", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 21,
          title: "Shipped feature",
          state: "closed",
          state_reason: "completed",
          body: "",
        },
      ]);
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references, []);
  assertEquals(result.value.unchecked, []);
});

Deno.test("findNotPlannedDocReferences - declared dependency outside the milestone, closed not_planned", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 30, title: "Member", body: "Depends on #99" },
      ]);
    }
    if (key.includes("/issues/99")) {
      return JSON.stringify({
        number: 99,
        title: "Dropped dependency",
        state: "closed",
        state_reason: "not_planned",
      });
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          {
            filename: "docs/y.md",
            status: "added",
            patch: patchAdding(1, ["depends on #99 for real"]),
          },
        ],
      });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references.length, 1);
  assertEquals(result.value.references[0]!.issueNumber, 99);
});

Deno.test("findNotPlannedDocReferences - declared dependency outside the milestone, closed completed, is not a candidate", async () => {
  let compareCalls = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 31, title: "Member", body: "Depends on #98" },
      ]);
    }
    if (key.includes("/issues/98")) {
      return JSON.stringify({
        number: 98,
        title: "Shipped dependency",
        state: "closed",
        state_reason: "completed",
      });
    }
    if (key.includes("/compare/")) {
      compareCalls++;
      return JSON.stringify({ files: [] });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references, []);
  assertEquals(compareCalls, 0);
});

Deno.test("findNotPlannedDocReferences - no candidates means compare is never called", async () => {
  let compareCalls = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 40, title: "Open issue", state: "open", body: "" },
      ]);
    }
    if (key.includes("/compare/")) {
      compareCalls++;
      return JSON.stringify({ files: [] });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  assertEquals(compareCalls, 0);
});

// ---------------------------------------------------------------------------
// findIssueReferences
// ---------------------------------------------------------------------------

Deno.test("findIssueReferences - rejects cross-repo, hex colour, HTML entity and bare 'foo#N'", () => {
  assertEquals(findIssueReferences("owner/other#20", REPO), []);
  assertEquals(findIssueReferences("colour #20ff", REPO), []);
  assertEquals(findIssueReferences("em dash &#20;", REPO), []);
  assertEquals(findIssueReferences("foo#20", REPO), []);
});

Deno.test("findIssueReferences - accepts bare, parenthesised and spelt-out same-repo refs", () => {
  assertEquals(findIssueReferences("(#20)", REPO), [20]);
  assertEquals(findIssueReferences("see #20 above", REPO), [20]);
  assertEquals(findIssueReferences(`see ${REPO}#20`, REPO), [20]);
});

// ---------------------------------------------------------------------------
// addedLines
// ---------------------------------------------------------------------------

Deno.test("addedLines - removed and context lines are not matched as added", () => {
  const patch = [
    "@@ -1,3 +1,3 @@",
    " context line",
    "-removed line #5",
    "+added line #6",
  ].join("\n");
  const added = addedLines(patch);
  assertEquals(added.length, 1);
  assertEquals(added[0]!.text, "added line #6");
  assertEquals(added[0]!.line, 2);
});

Deno.test("addedLines - lines before the first hunk are ignored", () => {
  const patch =
    "diff --git a/x b/x\n+not counted\n@@ -1,0 +1,1 @@\n+#5 counted";
  const added = addedLines(patch);
  assertEquals(added.length, 1);
  assertEquals(added[0]!.text, "#5 counted");
});

// ---------------------------------------------------------------------------
// Markdown / non-Markdown files, missing patch, 300-file cap
// ---------------------------------------------------------------------------

Deno.test("findNotPlannedDocReferences - removed Markdown file is not scanned", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 55,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          {
            filename: "docs/removed.md",
            status: "removed",
            patch: patchAdding(1, ["names #55 in a removed file"]),
          },
        ],
      });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references, []);
  assertEquals(result.value.unchecked, []);
});

Deno.test("findNotPlannedDocReferences - non-Markdown file ignored", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 50,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          {
            filename: "src/code.ts",
            status: "modified",
            patch: patchAdding(1, ["references #50"]),
          },
        ],
      });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references, []);
});

Deno.test("findNotPlannedDocReferences - Markdown file without patch is unchecked", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 51,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({
        files: [
          { filename: "docs/big.md", status: "modified" },
        ],
      });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.references, []);
  assertEquals(result.value.unchecked, ["docs/big.md"]);
});

Deno.test("findNotPlannedDocReferences - 300 files triggers a truncation entry", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 52,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      const files = Array.from({ length: 300 }, (_, i) => ({
        filename: `file${i}.txt`,
        status: "modified",
      }));
      return JSON.stringify({ files });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.unchecked.includes(
      "files beyond the first 300 the compare API returns",
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

Deno.test("findNotPlannedDocReferences - member-list failure is ok:false", async () => {
  const ghFn = async (): Promise<string> => {
    throw new Error("rate limited");
  };
  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("findNotPlannedDocReferences - dependency-lookup failure is ok:false", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 60, title: "Member", body: "Depends on #61" },
      ]);
    }
    if (key.includes("/issues/61")) {
      throw new Error("not found");
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("findNotPlannedDocReferences - compare failure is ok:false", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 70,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      throw new Error("gone");
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("findNotPlannedDocReferences - compare non-array files is ok:false", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        {
          number: 71,
          title: "Dropped",
          state: "closed",
          state_reason: "not_planned",
        },
      ]);
    }
    if (key.includes("/compare/")) {
      return JSON.stringify({ files: "not-an-array" });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("findNotPlannedDocReferences - invalid repo is ok:false", async () => {
  const ghFn = async (): Promise<string> => "[]";
  const result = await findNotPlannedDocReferences({
    repo: "not-a-slug",
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "milestone/v1",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

Deno.test("findNotPlannedDocReferences - invalid branch is ok:false", async () => {
  const ghFn = async (): Promise<string> => "[]";
  const result = await findNotPlannedDocReferences({
    repo: REPO,
    milestoneNumber: 1,
    defaultBranch: "main",
    milestoneBranch: "../escape",
    ghCommandFn: ghFn,
  });
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// renderNotPlannedDocSection
// ---------------------------------------------------------------------------

Deno.test("renderNotPlannedDocSection - empty scan renders nothing", () => {
  assertEquals(
    renderNotPlannedDocSection({ references: [], unchecked: [] }),
    "",
  );
});

Deno.test("renderNotPlannedDocSection - lists issue, file and lines", () => {
  const section = renderNotPlannedDocSection({
    references: [
      {
        issueNumber: 20,
        title: "Dropped feature",
        file: "docs/x.md",
        lines: [6, 7],
      },
    ],
    unchecked: [],
  });
  assertStringIncludes(section, "Docs cite issues closed as not planned");
  assertStringIncludes(section, "#20 Dropped feature");
  assertStringIncludes(section, "`docs/x.md`");
  assertStringIncludes(section, "6, 7");
});

Deno.test("renderNotPlannedDocSection - unchecked-only scan still renders", () => {
  const section = renderNotPlannedDocSection({
    references: [],
    unchecked: ["docs/big.md"],
  });
  assertStringIncludes(
    section,
    "Docs not checked for issues closed as not planned",
  );
  assertStringIncludes(section, "docs/big.md");
});

Deno.test("NOT_PLANNED_DOCS_UNVERIFIED_NOTE - names the fallback reason", () => {
  assertStringIncludes(
    NOT_PLANNED_DOCS_UNVERIFIED_NOTE,
    "Docs not checked for issues closed as not planned",
  );
});

// ---------------------------------------------------------------------------
// Hostile-input linear-growth cases
// ---------------------------------------------------------------------------

Deno.test("findIssueReferences - scales linearly on a long run of 'a' then '#5'", () => {
  assertLinearGrowth(
    "findIssueReferences long prefix",
    (chars) => "a".repeat(chars) + "#5",
    (input) => findIssueReferences(input, REPO),
    { baseChars: 5000 },
  );
});

Deno.test("findIssueReferences - scales linearly on a long run of '#'", () => {
  assertLinearGrowth(
    "findIssueReferences long hash run",
    (chars) => "#".repeat(chars),
    (input) => findIssueReferences(input, REPO),
    { baseChars: 5000 },
  );
});

Deno.test("addedLines - scales linearly on an unterminated hunk header", () => {
  assertLinearGrowth(
    "addedLines unterminated hunk header",
    (chars) => "@@ -" + "1".repeat(chars),
    (input) => addedLines(input),
    { baseChars: 5000 },
  );
});
