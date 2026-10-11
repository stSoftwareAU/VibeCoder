/**
 * Tests for the canonical `gh api` argv (Issue #3568).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  canonicaliseGhArgs,
  canonicaliseGhEndpoint,
} from "../lib/gh_argv_canonical.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";

const PR = "repos/acme/widgets/pulls/1219";

// --- canonicaliseGhEndpoint -------------------------------------------------

Deno.test("canonicaliseGhEndpoint - a plain path is unchanged", () => {
  assertEquals(canonicaliseGhEndpoint(PR), PR);
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels"),
    "repos/acme/widgets/labels",
  );
});

Deno.test("canonicaliseGhEndpoint - a multi-digit number keeps every digit", () => {
  // Regression: the leading-digits rule once backtracked `1219` to `121`.
  assertEquals(canonicaliseGhEndpoint(PR), PR);
  assertEquals(canonicaliseGhEndpoint(`${PR}/merge`), `${PR}/merge`);
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/issues/1219"),
    "repos/acme/widgets/issues/1219",
  );
});

Deno.test("canonicaliseGhEndpoint - leading, trailing and doubled slashes collapse", () => {
  assertEquals(canonicaliseGhEndpoint(`/${PR}/`), PR);
  assertEquals(canonicaliseGhEndpoint("repos//acme/widgets///pulls/1219"), PR);
});

Deno.test("canonicaliseGhEndpoint - the query and fragment are dropped (#3518)", () => {
  assertEquals(canonicaliseGhEndpoint(`${PR}?per_page=1`), PR);
  assertEquals(canonicaliseGhEndpoint(`${PR}#x`), PR);
  assertEquals(canonicaliseGhEndpoint(`${PR}/merge?a=b#c`), `${PR}/merge`);
});

Deno.test("canonicaliseGhEndpoint - GitHub's API origin is dropped in any letter case", () => {
  assertEquals(canonicaliseGhEndpoint(`https://api.github.com/${PR}`), PR);
  assertEquals(canonicaliseGhEndpoint(`HTTPS://API.GITHUB.COM/${PR}`), PR);
  assertEquals(canonicaliseGhEndpoint(`http://api.github.com/${PR}?x=1`), PR);
  assertEquals(canonicaliseGhEndpoint("https://api.github.com"), "");
  assertEquals(canonicaliseGhEndpoint("https://api.github.com?x=1"), "");
});

Deno.test("canonicaliseGhEndpoint - the {owner}/{repo} placeholder survives an absolute URL", () => {
  assertEquals(
    canonicaliseGhEndpoint(
      "https://api.github.com/repos/{owner}/{repo}/pulls/3",
    ),
    "repos/{owner}/{repo}/pulls/3",
  );
});

Deno.test("canonicaliseGhEndpoint - any other origin is left as written, so it stays unclassifiable", () => {
  for (
    const e of [
      `https://evil.example/${PR}`,
      `https://api.github.com@evil.example/${PR}`,
      `https://evil-api.github.com.attacker.example/${PR}`,
      `ftp://api.github.com/${PR}`,
      "https://[not-a-host/x",
    ]
  ) {
    assertEquals(canonicaliseGhEndpoint(e), e);
  }
});

Deno.test("canonicaliseGhEndpoint - percent-escapes decode, except %2F and %25 (#3600)", () => {
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels/top%2Dpriority"),
    "repos/acme/widgets/labels/top-priority",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels/a%2fb"),
    "repos/acme/widgets/labels/a%2Fb",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels/a%2541"),
    "repos/acme/widgets/labels/a%2541",
  );
});

Deno.test("canonicaliseGhEndpoint - a malformed escape is left as written", () => {
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels/a%zz"),
    "repos/acme/widgets/labels/a%zz",
  );
});

Deno.test("canonicaliseGhEndpoint - the number segment is cut to its leading digits (#3600)", () => {
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/pulls/12abc"),
    "repos/acme/widgets/pulls/12",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/pulls/12abc/merge"),
    "repos/acme/widgets/pulls/12/merge",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/issues/%31%32"),
    "repos/acme/widgets/issues/12",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/pulls/12%2Fx"),
    "repos/acme/widgets/pulls/12",
  );
});

Deno.test("canonicaliseGhEndpoint - only pull and issue numbers are cut", () => {
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/labels/12abc"),
    "repos/acme/widgets/labels/12abc",
  );
  assertEquals(
    canonicaliseGhEndpoint("repos/acme/widgets/pulls/abc"),
    "repos/acme/widgets/pulls/abc",
  );
});

Deno.test("canonicaliseGhEndpoint - every spelling of the GraphQL endpoint is `graphql`", () => {
  for (
    const e of [
      "graphql",
      "/graphql",
      "graphql/",
      "GraphQL",
      "graphql?x=1",
      "https://api.github.com/graphql",
    ]
  ) {
    assertEquals(canonicaliseGhEndpoint(e), "graphql", e);
  }
});

Deno.test("canonicaliseGhEndpoint - is idempotent", () => {
  for (
    const e of [
      `https://api.github.com/${PR}?x=1`,
      "repos/acme/widgets/labels/a%2541",
      "repos/acme/widgets/labels/a%2fb",
      "repos/acme/widgets/pulls/12abc",
      `https://evil.example/${PR}`,
    ]
  ) {
    const once = canonicaliseGhEndpoint(e);
    assertEquals(canonicaliseGhEndpoint(once), once, e);
  }
});

// --- canonicaliseGhArgs -----------------------------------------------------

Deno.test("canonicaliseGhArgs - a vector whose root is not api is only normalised", () => {
  assertEquals(canonicaliseGhArgs(["pr", "merge", "12", "-Racme/widgets"]), [
    "pr",
    "merge",
    "12",
    "-R",
    "acme/widgets",
  ]);
  assertEquals(canonicaliseGhArgs([]), []);
});

Deno.test("canonicaliseGhArgs - flags before api move after it, in order, so the last method still wins (#3572)", () => {
  assertEquals(
    canonicaliseGhArgs([
      "--method=DELETE",
      "-f",
      "a=1",
      "api",
      PR,
      "-X",
      "PATCH",
    ]),
    ["api", PR, "-X", "PATCH", "-f", "a=1"],
  );
  assertEquals(
    canonicaliseGhArgs(["-X", "PATCH", "api", PR, "--method", "DELETE"]),
    ["api", PR, "-X", "DELETE"],
  );
});

Deno.test("canonicaliseGhArgs - --flag=value splits; a boolean flag is kept as written", () => {
  assertEquals(
    canonicaliseGhArgs([
      "api",
      PR,
      "--raw-field=state=closed",
      "--paginate",
      "--silent=true",
    ]),
    [
      "api",
      PR,
      "-X",
      "PATCH",
      "--raw-field",
      "state=closed",
      "--paginate",
      "--silent=true",
    ],
  );
});

Deno.test("canonicaliseGhArgs - the method is explicit: GET without a body, POST with one", () => {
  assertEquals(canonicaliseGhArgs(["api", "user"]), [
    "api",
    "user",
    "-X",
    "GET",
  ]);
  assertEquals(
    canonicaliseGhArgs(["api", "repos/acme/widgets/issues", "-f", "title=x"]),
    ["api", "repos/acme/widgets/issues", "-X", "POST", "-f", "title=x"],
  );
  assertEquals(
    canonicaliseGhArgs(["api", "repos/acme/widgets/issues", "--input", "-"]),
    ["api", "repos/acme/widgets/issues", "-X", "POST", "--input", "-"],
  );
  assertEquals(canonicaliseGhArgs(["api", PR, "-X", "put"]), [
    "api",
    PR,
    "-X",
    "PUT",
  ]);
});

Deno.test("canonicaliseGhArgs - POST on a pull or issue update route is PATCH (#3531)", () => {
  assertEquals(
    canonicaliseGhArgs(["api", PR, "-f", "state=closed"]),
    ["api", PR, "-X", "PATCH", "-f", "state=closed"],
  );
  assertEquals(
    canonicaliseGhArgs([
      "api",
      "repos/acme/widgets/issues/9",
      "-X",
      "POST",
      "-f",
      "state=closed",
    ]),
    ["api", "repos/acme/widgets/issues/9", "-X", "PATCH", "-f", "state=closed"],
  );
});

Deno.test("canonicaliseGhArgs - POST elsewhere stays POST", () => {
  assertEquals(
    canonicaliseGhArgs(["api", `${PR}/reviews`, "-X", "POST"]),
    ["api", `${PR}/reviews`, "-X", "POST"],
  );
});

Deno.test("canonicaliseGhArgs - a method flag with no value leaves no method", () => {
  assertEquals(canonicaliseGhArgs(["api", PR, "-X"]), ["api", PR, "-X", ""]);
});

Deno.test("canonicaliseGhArgs - a value flag's value is never the endpoint (#3561)", () => {
  assertEquals(
    canonicaliseGhArgs([
      "api",
      "-p",
      "squirrel-girl",
      "--hostname",
      "github.com",
      PR,
      "-X",
      "PUT",
    ]),
    ["api", PR, "-X", "PUT", "-p", "squirrel-girl", "--hostname", "github.com"],
  );
});

Deno.test("canonicaliseGhArgs - an endpoint after -- is still the endpoint", () => {
  assertEquals(canonicaliseGhArgs(["api", "-X", "PUT", "--", `/${PR}/merge`]), [
    "api",
    `${PR}/merge`,
    "-X",
    "PUT",
  ]);
});

Deno.test("canonicaliseGhArgs - a boolean shorthand group ending in a value letter keeps its value", () => {
  assertEquals(canonicaliseGhArgs(["api", "-iq", ".id", "user"]), [
    "api",
    "user",
    "-X",
    "GET",
    "-iq",
    ".id",
  ]);
});

Deno.test("canonicaliseGhArgs - a trailing value flag with no value does not throw", () => {
  assertEquals(canonicaliseGhArgs(["api", "user", "--jq"]), [
    "api",
    "user",
    "-X",
    "GET",
    "--jq",
  ]);
  assertEquals(canonicaliseGhArgs(["api", "user", "-q"]), [
    "api",
    "user",
    "-X",
    "GET",
    "-q",
  ]);
  assertEquals(canonicaliseGhArgs(["api", "user", "-iq"]), [
    "api",
    "user",
    "-X",
    "GET",
    "-iq",
  ]);
  assertEquals(canonicaliseGhArgs(["api"]), ["api", "-X", "GET"]);
});

Deno.test("canonicaliseGhArgs - is idempotent", () => {
  for (
    const argv of [
      ["--method=DELETE", "api", "repos/acme/widgets/labels/top%2Dpriority"],
      ["-XPATCH", "api", "/repos/acme/widgets/issues/9?x=1", "-fstate=closed"],
      ["api", "graphql", "-F", "query=mutation { x }"],
      ["api", "-iq", ".id", "user"],
      ["pr", "merge", "12"],
    ]
  ) {
    const once = canonicaliseGhArgs(argv);
    assertEquals(canonicaliseGhArgs(once), once, argv.join(" "));
  }
});

// --- placeholder fields in the classifier (#3566) ---------------------------

for (
  const key of [
    "query",
    "operationName",
    "name",
    "new_name",
    "labels[]",
    "labels",
  ]
) {
  Deno.test(`classifyGhMutation - a -F ${key}= value with a gh placeholder is unreadable (#3566)`, () => {
    const info = classifyGhMutation([
      "api",
      "repos/acme/widgets/labels",
      "-X",
      "POST",
      "-F",
      `${key}=x{branch}`,
    ]);
    assertEquals(info?.unreadableBody, true);
  });
}

Deno.test("classifyGhMutation - every gh placeholder spelling counts, under --field= too (#3566)", () => {
  for (
    const placeholder of [
      "{owner}",
      "{repo}",
      "{branch}",
      ":owner",
      ":repo",
      ":branch",
    ]
  ) {
    const info = classifyGhMutation([
      "api",
      "graphql",
      `--field=query=query { x(s: "${placeholder}") }`,
    ]);
    assertEquals(info?.scope, "unknown", placeholder);
  }
});

Deno.test("classifyGhMutation - placeholder text under -f, in other keys, or without a placeholder is read as written (#3566)", () => {
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/acme/widgets/labels",
      "-X",
      "POST",
      "-f",
      "name=x{branch}",
    ])
      ?.unreadableBody,
    undefined,
  );
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/acme/widgets/pulls",
      "-X",
      "POST",
      "-F",
      "head={branch}",
    ])
      ?.unreadableBody,
    undefined,
  );
  assertEquals(
    classifyGhMutation([
      "api",
      "repos/acme/widgets/labels",
      "-X",
      "POST",
      "-F",
      "name=plain-label",
    ])
      ?.unreadableBody,
    undefined,
  );
  // A plain GraphQL read stays a read.
  assertEquals(
    classifyGhMutation([
      "api",
      "graphql",
      "-F",
      "query=query { viewer { login } }",
    ]),
    null,
  );
});
