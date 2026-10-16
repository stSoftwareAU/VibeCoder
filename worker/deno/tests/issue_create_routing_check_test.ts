/**
 * Tests for the direct `gh issue create` routing quality-gate check (Issue
 * #3746).
 *
 * The content scanner is exercised behaviourally over literal inputs. The
 * directory walk and the stale-entry audit run over real temporary
 * directories, and the gate itself runs over the real repository tree. No
 * source-text grepping: every assertion runs the real scanner over inputs the
 * test supplies or over the tree as it stands.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  findStaleAllowlistEntries,
  formatIssueCreateRoutingViolations,
  ISSUE_CREATE_ROUTING_ALLOWLIST,
  scanContentForDirectIssueCreate,
  scanDirectoriesForDirectIssueCreate,
} from "../lib/issue_create_routing_check.ts";

/** Repo root, resolved the same way the sibling tests resolve it. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** Repo-relative directories the gate scans. */
const SCANNED_DIRS = ["worker/deno/lib", "worker/deno/commands"];

/** A new direct multi-line `gh issue create` call site; `"issue",` is line 3. */
const NEW_DIRECT_FILER = [
  "async function fileNewFinding(repo: string, title: string) {",
  "  const out = await ghCommand([",
  '    "issue",',
  '    "create",',
  '    "--repo",',
  "    repo,",
  '    "--title",',
  "    title,",
  "  ]);",
  "  return out;",
  "}",
].join("\n");

/** A file whose only `gh issue` call lists issues, so it files nothing. */
const LISTING_ONLY = [
  "const raw = await ghCommand([",
  '  "issue",',
  '  "list",',
  '  "--repo",',
  "  repo,",
  "]);",
].join("\n");

Deno.test("issue_create_routing_check - flags a new multi-line direct create", () => {
  const violations = scanContentForDirectIssueCreate(
    NEW_DIRECT_FILER,
    "worker/deno/lib/new_filer.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 3);
  assertEquals(violations[0]?.text, '"issue",');
  assertEquals(violations[0]?.file, "worker/deno/lib/new_filer.ts");

  const message = formatIssueCreateRoutingViolations(violations);
  assert(
    message.includes("worker/deno/lib/new_filer.ts:3:"),
    `formatted message must name file and line, got: ${message}`,
  );
});

Deno.test("issue_create_routing_check - detects every direct create form", () => {
  const cases: Array<[string, string, number[]]> = [
    ["multi-line", NEW_DIRECT_FILER, [3]],
    [
      "inline",
      'const out = await gh(["issue", "create", "--repo", repo]);',
      [1],
    ],
    [
      "gh-prefixed inline",
      'const args = ["gh", "issue", "create", "--repo", repo];',
      [1],
    ],
    [
      "single-quoted inline",
      "const args = ['issue', 'create', '--repo', repo];",
      [1],
    ],
    [
      "single-quoted multi-line",
      "const args = [\n  'issue',\n  'create',\n];",
      [2],
    ],
    [
      "blank line between issue and create",
      ["const args = [", '  "issue",', "", '  "create",', "];"].join("\n"),
      [2],
    ],
    [
      "two create argvs on one line",
      'gh(["issue", "create"], ["issue", "create"]);',
      [1],
    ],
    [
      "url string before argv",
      'gh(["--url", "https://x", "issue", "create"]);',
      [1],
    ],
  ];
  for (const [name, content, expected] of cases) {
    const lines = scanContentForDirectIssueCreate(
      content,
      "worker/deno/lib/case.ts",
    ).map((v) => v.line);
    assertEquals(lines, expected, `form: ${name}`);
  }
});

Deno.test("issue_create_routing_check - detects the new alias and a repo flag before the verb", () => {
  // gh runs `issue new` as `issue create` and accepts -R/--repo before the verb.
  const cases: Array<[string, string, number[]]> = [
    [
      "new alias inline",
      'gh(["issue", "new", "--repo", repo, "--title", t]);',
      [1],
    ],
    [
      "new alias multi-line",
      ["gh([", '  "issue",', '  "new",', '  "--title",', "  t,", "]);"].join(
        "\n",
      ),
      [2],
    ],
    [
      "--repo before verb inline",
      'gh(["issue", "--repo", repo, "create"]);',
      [1],
    ],
    ["-R before verb inline", 'gh(["issue", "-R", repo, "create"]);', [1]],
    [
      "--repo before verb multi-line",
      ["gh([", '  "issue",', '  "--repo",', "  repo,", '  "create",', "]);"]
        .join("\n"),
      [2],
    ],
    [
      "--repo=value before verb",
      'gh(["issue", "--repo=owner/repo", "create"]);',
      [1],
    ],
    ["-Rvalue before verb", 'gh(["issue", "-Rowner/repo", "create"]);', [1]],
    [
      "repo flag with call expression value",
      'gh(["issue", "-R", slug(a, b), "new"]);',
      [1],
    ],
    [
      "repo flag with template value",
      'gh(["issue", "--repo", `${owner}/${name}`, "new"]);',
      [1],
    ],
    [
      "repo flag then new, multi-line",
      ["gh([", '  "issue",', '  "-R",', "  repo,", '  "new",', "]);"].join(
        "\n",
      ),
      [2],
    ],
  ];
  for (const [name, content, expected] of cases) {
    const lines = scanContentForDirectIssueCreate(
      content,
      "worker/deno/lib/case.ts",
    ).map((v) => v.line);
    assertEquals(lines, expected, `form: ${name}`);
  }
});

Deno.test("issue_create_routing_check - a repo flag before a read verb is not a create", () => {
  const lookalikes: Array<[string, string]> = [
    ["--repo then list", 'gh(["issue", "--repo", repo, "list"]);'],
    ["-R then view", 'gh(["issue", "-R", repo, "view", "1"]);'],
    ["--repo=value then edit", 'gh(["issue", "--repo=o/r", "edit", "1"]);'],
    [
      "repo flag with value then list, multi-line",
      ["gh([", '  "issue",', '  "--repo",', "  repo,", '  "list",', "]);"]
        .join("\n"),
    ],
    // The value after -R is consumed, so a literal value is not read as a verb.
    ["literal repo value is not a verb", 'gh(["issue", "-R", "new", "list"]);'],
    ["repo flag ends the argv", 'gh(["issue", "--repo"]);'],
    ["non-literal after issue", 'gh(["issue", ...rest]); gh(["new"]);'],
  ];
  for (const [name, content] of lookalikes) {
    assertEquals(
      scanContentForDirectIssueCreate(content, "worker/deno/lib/list.ts"),
      [],
      `look-alike: ${name}`,
    );
  }
});

Deno.test("issue_create_routing_check - detects a template-literal repo flag before the verb", () => {
  const cases: Array<[string, string, number[]]> = [
    [
      "--repo=${repo} then create",
      'gh(["issue", `--repo=${repo}`, "create"]);',
      [1],
    ],
    [
      "-R${repo} then create",
      'gh(["issue", `-R${repo}`, "create"]);',
      [1],
    ],
    [
      "--repo=${repo} then new",
      'gh(["issue", `--repo=${repo}`, "new"]);',
      [1],
    ],
    ["-R${repo} then new", 'gh(["issue", `-R${repo}`, "new"]);', [1]],
    [
      "--repo=${repo} multi-line",
      ["gh([", '  "issue",', "  `--repo=${repo}`,", '  "create",', "]);"].join(
        "\n",
      ),
      [2],
    ],
    [
      "-R${repo} multi-line",
      ["gh([", '  "issue",', "  `-R${repo}`,", '  "new",', "]);"].join("\n"),
      [2],
    ],
    [
      "nested template inside the flag",
      'gh(["issue", `--repo=${pick(`a,${b}`, 1)}`, "create"]);',
      [1],
    ],
    [
      "interpolation-free template verb",
      'gh(["issue", `create`, "--repo", repo]);',
      [1],
    ],
    [
      "interpolation-free template repo flag",
      'gh(["issue", `--repo`, repo, `new`]);',
      [1],
    ],
  ];
  for (const [name, content, expected] of cases) {
    const lines = scanContentForDirectIssueCreate(
      content,
      "worker/deno/lib/case.ts",
    ).map((v) => v.line);
    assertEquals(lines, expected, `form: ${name}`);
  }
});

Deno.test("issue_create_routing_check - a template-literal repo flag before a read verb is not a create", () => {
  const lookalikes: Array<[string, string]> = [
    [
      "--repo=${repo} then list",
      'gh(["issue", `--repo=${repo}`, "list"]);',
    ],
    ["-R${repo} then view", 'gh(["issue", `-R${repo}`, "view", "1"]);'],
    [
      "-R${repo} then list, multi-line",
      ["gh([", '  "issue",', "  `-R${repo}`,", '  "list",', "]);"].join("\n"),
    ],
    // An interpolated verb cannot be read, and is not a repo flag: not flagged.
    ["interpolated verb", 'gh(["issue", `${verb}`, "create"]);'],
    ["non-flag template prefix", 'gh(["issue", `x-${repo}`, "create"]);'],
    ["interpolation-free read verb", 'gh(["issue", `list`]);'],
  ];
  for (const [name, content] of lookalikes) {
    assertEquals(
      scanContentForDirectIssueCreate(content, "worker/deno/lib/list.ts"),
      [],
      `look-alike: ${name}`,
    );
  }
});

Deno.test("issue_create_routing_check - detects issue creation through gh api", () => {
  const cases: Array<[string, string, number[]]> = [
    [
      "REST fields imply POST",
      'gh(["api", `repos/${repo}/issues`, "-f", "title=x"]);',
      [1],
    ],
    [
      "REST explicit -X POST",
      'gh(["api", "-X", "POST", `repos/${repo}/issues`, "-f", "title=x"]);',
      [1],
    ],
    [
      "REST --method POST, endpoint first",
      'gh(["api", "repos/o/r/issues", "--method", "POST"]);',
      [1],
    ],
    ["REST -XPOST inline", 'gh(["api", "repos/o/r/issues", "-XPOST"]);', [1]],
    [
      "REST -X=POST with -f",
      'gh(["api", "-X=POST", `repos/${repo}/issues`, "-f", "title=x"]);',
      [1],
    ],
    [
      "REST -X=POST with --input",
      'gh(["api", "-X=POST", `repos/${repo}/issues`, "--input", "-"]);',
      [1],
    ],
    [
      "REST --method=post inline, lower case",
      'gh(["api", "repos/o/r/issues", "--method=post"]);',
      [1],
    ],
    [
      "REST -F typed field",
      'gh(["api", "repos/o/r/issues", "-F", "labels[]=bug"]);',
      [1],
    ],
    [
      "REST --raw-field",
      'gh(["api", "repos/o/r/issues", "--raw-field", "title=x"]);',
      [1],
    ],
    [
      "REST --input body file",
      'gh(["api", "repos/o/r/issues", "--input", "body.json"]);',
      [1],
    ],
    [
      "REST -ftitle=x combined",
      'gh(["api", "repos/o/r/issues", "-ftitle=x"]);',
      [1],
    ],
    [
      "REST leading slash and full URL",
      'gh(["api", "https://api.github.com/repos/o/r/issues", "-f", "t=x"]);',
      [1],
    ],
    [
      "REST concatenated endpoint",
      'gh(["api", "repos/" + repo + "/issues", "-f", "title=x"]);',
      [1],
    ],
    [
      "REST non-literal method cannot be ruled out",
      'gh(["api", "-X", method, `repos/${repo}/issues`]);',
      [1],
    ],
    [
      "REST spread fields, no method",
      'gh(["api", `repos/${repo}/issues`, ...fields]);',
      [1],
    ],
    [
      "REST inline flatMap spread, no method (one line)",
      'gh(["api", `repos/${repo}/issues`, ...Object.entries(b).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);',
      [1],
    ],
    [
      "REST inline flatMap spread, no method (multi-line)",
      [
        "gh([",
        '  "api",',
        "  `repos/${repo}/issues`,",
        "  ...Object.entries(b).flatMap(([k, v]) => [",
        '    "-f",',
        "    `${k}=${v}`,",
        "  ]),",
        "]);",
      ].join("\n"),
      [2],
    ],
    [
      "REST variable flag element, no method",
      'gh(["api", `repos/${repo}/issues`, flag, "title=x"]);',
      [1],
    ],
    [
      "REST multi-line argv",
      [
        "gh([",
        '  "api",',
        '  "-H",',
        '  "Accept: application/vnd.github+json",',
        "  `repos/${repo}/issues`,",
        '  "-f",',
        '  "title=x",',
        "]);",
      ].join("\n"),
      [2],
    ],
    [
      "GraphQL createIssue in a template query",
      [
        "const query = `mutation { createIssue(input: {}) { issue { number } } }`;",
        'gh(["api", "graphql", "-f", `query=${query}`]);',
      ].join("\n"),
      [2],
    ],
    [
      "GraphQL createIssue inline in the argv",
      'gh(["api", "graphql", "-f", "query=mutation { createIssue(input: {}) { clientMutationId } }"]);',
      [1],
    ],
  ];
  for (const [name, content, expected] of cases) {
    const lines = scanContentForDirectIssueCreate(
      content,
      "worker/deno/lib/case.ts",
    ).map((v) => v.line);
    assertEquals(lines, expected, `form: ${name}`);
  }
});

Deno.test("issue_create_routing_check - gh api reads and other writes are not an issue create", () => {
  const lookalikes: Array<[string, string]> = [
    ["plain GET list", 'gh(["api", `repos/${repo}/issues`]);'],
    [
      "GET list with a query string",
      'gh(["api", `repos/${repo}/issues?state=open&per_page=100`]);',
    ],
    [
      "GET list with explicit method and fields",
      'gh(["api", "-X", "GET", `repos/${repo}/issues`, "-f", "state=open"]);',
    ],
    [
      "GET list with -X GET and a spread",
      'gh(["api", "-X", "GET", `repos/${repo}/issues`, ...fields]);',
    ],
    [
      "GET list with a non-literal endpoint and no fields",
      'gh(["api", base + "/issues"]);',
    ],
    [
      "GET list with a non-literal header value",
      'gh(["api", "-H", header, `repos/${repo}/issues`]);',
    ],
    [
      "GET list with -X=GET and fields",
      'gh(["api", "-X=GET", `repos/${repo}/issues`, "-f", "state=open"]);',
    ],
    [
      "GET list with --method=GET inline and fields",
      'gh(["api", "--method=GET", "repos/o/r/issues", "-f", "state=open"]);',
    ],
    [
      "comment on an existing issue",
      'gh(["api", `repos/${repo}/issues/${n}/comments`, "-f", "body=x"]);',
    ],
    [
      "edit an existing issue",
      'gh(["api", "-X", "PATCH", `repos/${repo}/issues/${n}`, "-f", "state=closed"]);',
    ],
    [
      "search issues with a field and no explicit method",
      'gh(["api", "search/issues", "-f", "q=is:open"]);',
    ],
    [
      "search issues",
      'gh(["api", "-X", "GET", "search/issues", "-f", "q=is:open"]);',
    ],
    [
      "field value that merely ends in /issues",
      'gh(["api", `repos/${repo}/pulls`, "-f", "body=see /issues"]);',
    ],
    [
      "GraphQL read, file never names createIssue",
      'gh(["api", "graphql", "-f", `query=${query}`]);',
    ],
    ["createIssue name without a graphql call", "const createIssue = () => 1;"],
  ];
  for (const [name, content] of lookalikes) {
    assertEquals(
      scanContentForDirectIssueCreate(content, "worker/deno/lib/list.ts"),
      [],
      `look-alike: ${name}`,
    );
  }
});

Deno.test("issue_create_routing_check - ignores read verbs and other subcommands", () => {
  const lookalikes: Array<[string, string]> = [
    ["issue list (multi-line)", LISTING_ONLY],
    ["issue list (inline)", 'gh(["issue", "list", "--repo", repo]);'],
    ["issue edit (inline)", 'gh(["issue", "edit", "42", "--repo", repo]);'],
    ["pr create (inline)", 'gh(["pr", "create", "--repo", repo]);'],
    ["pr create (multi-line)", '["pr",\n  "create",\n];'],
  ];
  for (const [name, content] of lookalikes) {
    assertEquals(
      scanContentForDirectIssueCreate(content, "worker/deno/lib/list.ts"),
      [],
      `look-alike: ${name}`,
    );
  }
});

Deno.test("issue_create_routing_check - ignores create argv inside comments", () => {
  const commented = [
    '// const args = ["issue", "create", "--repo", repo];',
    '/* const args = ["issue", "create", "--repo", repo]; */',
    "/**",
    ' * Historically this filer built ["issue", "create"] by hand.',
    " */",
    '    // "issue",',
    '    // "create",',
  ].join("\n");
  assertEquals(
    scanContentForDirectIssueCreate(commented, "worker/deno/lib/doc.ts"),
    [],
  );
});

Deno.test("issue_create_routing_check - string containing a block-comment opener does not hide a create", () => {
  // The "/*" inside the string is not a comment opener, so the create on line
  // 2 is still scanned; the real block comment on line 3 is blanked.
  const probe = [
    'const marker = "/*";',
    'gh(["issue", "create"]);',
    "/* a real block comment */",
  ].join("\n");
  assertEquals(
    scanContentForDirectIssueCreate(probe, "worker/deno/lib/probe.ts").map(
      (v) => v.line,
    ),
    [2],
  );
});

Deno.test("issue_create_routing_check - multi-line template containing a block-comment opener does not hide a create", () => {
  // The shape of workflow_definitions.ts: YAML in a multi-line template holds
  // `milestone/*`. It is template text, not a comment opener, so the create
  // on line 4 is still scanned.
  const probe = [
    "const yaml = `",
    "branches: [Develop, main, milestone/*]",
    "`;",
    'gh(["issue", "create"]);',
    "/* a real block comment */",
  ].join("\n");
  assertEquals(
    scanContentForDirectIssueCreate(probe, "worker/deno/lib/probe.ts").map(
      (v) => v.line,
    ),
    [4],
  );
});

Deno.test("issue_create_routing_check - template interpolations are scanned as code", () => {
  const cases: Array<[string, string, number[]]> = [
    [
      // The backtick pair inside `${…}` is a nested template; it neither ends
      // nor reopens the outer one, so `/*` stays template text.
      "nested template in an interpolation",
      [
        "const text = `head ${flag ? `inner` : ''}",
        "glob: milestone/*",
        "`;",
        'gh(["issue", "create"]);',
      ].join("\n"),
      [4],
    ],
    [
      // A comment inside `${…}` is code-side, so it is blanked.
      "comment in an interpolation",
      [
        "const text = `head ${",
        '  // ["issue", "create"]',
        "  value",
        "} tail`;",
      ].join("\n"),
      [],
    ],
    [
      // A backtick inside a regular-expression literal opens no template, so
      // the real template below keeps its `/*` as text.
      "backtick in a regex literal",
      [
        "const re = /[`]/;",
        "const yaml = `",
        "glob: milestone/*",
        "`;",
        'gh(["issue", "create"]);',
      ].join("\n"),
      [5],
    ],
  ];
  for (const [name, content, expected] of cases) {
    const lines = scanContentForDirectIssueCreate(
      content,
      "worker/deno/lib/case.ts",
    ).map((v) => v.line);
    assertEquals(lines, expected, `case: ${name}`);
  }
});

Deno.test("issue_create_routing_check - ignores prose and template strings", () => {
  const prose = [
    "throw new Error(`gh issue create failed: ${e}`);",
    'log("run gh issue create by hand if the chokepoint is down");',
    'const label = "gh issue create";',
  ].join("\n");
  assertEquals(
    scanContentForDirectIssueCreate(prose, "worker/deno/lib/prose.ts"),
    [],
  );
});

Deno.test("issue_create_routing_check - ignores the issue literal in a comparison", () => {
  // The shape of gh_body_redaction.ts (flagMaskedInstructionOnIssueCreate):
  // "issue" is followed by `||`, not a comma, so it is not an argv element.
  const comparison = [
    "function flagMaskedInstructionOnIssueCreate(out: string[]): void {",
    '  if (out[0] !== "issue" || out[1] !== "create") return;',
    "}",
  ].join("\n");
  assertEquals(
    scanContentForDirectIssueCreate(
      comparison,
      "worker/deno/lib/gh_body_redaction.ts",
    ),
    [],
  );
});

Deno.test("issue_create_routing_check - directory scan reports unlisted offenders only", async () => {
  const root = await Deno.makeTempDir();
  try {
    const libDir = `${root}/worker/deno/lib`;
    const commandsDir = `${root}/worker/deno/commands`;
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.mkdir(commandsDir, { recursive: true });
    await Deno.writeTextFile(`${libDir}/new_filer.ts`, NEW_DIRECT_FILER);
    await Deno.writeTextFile(`${libDir}/clean.ts`, LISTING_ONLY);
    // The routed chokepoint is allowlisted, so its direct call is skipped.
    await Deno.writeTextFile(
      `${libDir}/issue_routing_filing.ts`,
      NEW_DIRECT_FILER,
    );
    await Deno.writeTextFile(`${commandsDir}/cli.ts`, LISTING_ONLY);

    const result = await scanDirectoriesForDirectIssueCreate(
      root,
      SCANNED_DIRS,
    );

    // clean.ts, new_filer.ts and cli.ts are scanned; the allowlisted
    // issue_routing_filing.ts is skipped and not counted.
    assertEquals(result.filesScanned, 3);
    assertEquals(
      result.violations.map((v) => v.file),
      ["worker/deno/lib/new_filer.ts"],
    );
    assertEquals(result.violations[0]?.line, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - fails closed on a missing scan directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    const err = await assertRejects(
      () => scanDirectoriesForDirectIssueCreate(root, ["worker/deno/missing"]),
      Error,
      "does not exist",
    );
    assert(
      err.message.includes('"worker/deno/missing"'),
      `message must name the directory, got: ${err.message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - fails closed when a scan path is a file", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/worker/deno`, { recursive: true });
    await Deno.writeTextFile(`${root}/worker/deno/lib`, "not a directory");
    await assertRejects(
      () => scanDirectoriesForDirectIssueCreate(root, ["worker/deno/lib"]),
      Error,
      "is not a directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - fails closed when no .ts file is scanned", async () => {
  const root = await Deno.makeTempDir();
  try {
    const libDir = `${root}/worker/deno/lib`;
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.writeTextFile(`${libDir}/README.md`, "no typescript here");
    await assertRejects(
      () => scanDirectoriesForDirectIssueCreate(root, ["worker/deno/lib"]),
      Error,
      "no .ts files were scanned",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - rethrows a non-missing stat error on a scan directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    // A regular file where a path component should be a directory: stat fails
    // with NotADirectory, which is not "missing", so it must not be mapped to
    // the does-not-exist message.
    await Deno.mkdir(`${root}/worker`, { recursive: true });
    await Deno.writeTextFile(`${root}/worker/deno`, "not a directory");
    const err = await assertRejects(
      () => scanDirectoriesForDirectIssueCreate(root, ["worker/deno/lib"]),
      Deno.errors.NotADirectory,
    );
    assert(
      !err.message.includes("does not exist"),
      `non-missing stat error must not be mapped, got: ${err.message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - real tree has no unlisted direct create call site", async () => {
  const result = await scanDirectoriesForDirectIssueCreate(
    REPO_ROOT,
    SCANNED_DIRS,
  );
  assertEquals(
    result.violations,
    [],
    formatIssueCreateRoutingViolations(result.violations),
  );
  // The tree holds well over five hundred .ts files; a scan that examined only
  // a handful means the walk has silently broken.
  assert(
    result.filesScanned > 500,
    `expected a full scan of the tree, got ${result.filesScanned} files`,
  );
});

Deno.test("issue_create_routing_check - allowlist entries are documented and specific", () => {
  assert(
    ISSUE_CREATE_ROUTING_ALLOWLIST.has(
      "worker/deno/lib/issue_routing_filing.ts",
    ),
    "the routed filing chokepoint must be allowlisted",
  );
  assert(
    ISSUE_CREATE_ROUTING_ALLOWLIST.has(
      "worker/deno/lib/repo_fast_failure_issue.ts",
    ),
    "the fleet-wide fast-failure tally must be allowlisted",
  );
  for (const [path, reason] of ISSUE_CREATE_ROUTING_ALLOWLIST) {
    assert(
      path.startsWith("worker/deno/") && path.endsWith(".ts"),
      `allowlist entry '${path}' must be a repo-relative source path`,
    );
    assert(
      reason.trim() !== "" && reason === reason.trim() &&
        !reason.includes("\n"),
      `allowlist entry '${path}' needs a non-empty, trimmed, one-line reason`,
    );
  }
});

Deno.test("issue_create_routing_check - real allowlist has no stale entries", async () => {
  assertEquals(await findStaleAllowlistEntries(REPO_ROOT), []);
});

Deno.test("issue_create_routing_check - stale entries are missing or clean files", async () => {
  const root = await Deno.makeTempDir();
  try {
    const libDir = `${root}/worker/deno/lib`;
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.writeTextFile(`${libDir}/no_call.ts`, LISTING_ONLY);
    await Deno.writeTextFile(`${libDir}/still_direct.ts`, NEW_DIRECT_FILER);
    const allowlist = new Map<string, string>([
      ["worker/deno/lib/gone.ts", "file was removed"],
      ["worker/deno/lib/no_call.ts", "call site was migrated away"],
      ["worker/deno/lib/still_direct.ts", "still files directly"],
    ]);

    assertEquals(
      await findStaleAllowlistEntries(root, allowlist),
      ["worker/deno/lib/gone.ts", "worker/deno/lib/no_call.ts"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("issue_create_routing_check - stale audit rethrows a non-missing read error", async () => {
  const root = await Deno.makeTempDir();
  try {
    // A regular file where a path component should be a directory: the read
    // fails with NotADirectory, which is not "missing", so it must propagate
    // rather than being recorded as a stale entry.
    await Deno.mkdir(`${root}/worker`, { recursive: true });
    await Deno.writeTextFile(`${root}/worker/deno`, "not a directory");
    const allowlist = new Map<string, string>([
      ["worker/deno/lib/x.ts", "reason"],
    ]);
    await assertRejects(
      () => findStaleAllowlistEntries(root, allowlist),
      Deno.errors.NotADirectory,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
