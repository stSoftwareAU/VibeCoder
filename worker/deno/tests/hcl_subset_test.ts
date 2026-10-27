/**
 * Tests for lib/hcl_subset.ts (Issue #4416).
 *
 * Each case calls the real parser on a small inline HCL string and asserts on
 * the blocks, values and errors it returns. Nothing in these inputs is ever
 * evaluated, so the expected values are the statically read ones.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type HclBlock,
  type HclValue,
  isHclRef,
  isHclUnknown,
  parseHcl,
} from "../lib/hcl_subset.ts";

function only(blocks: HclBlock[]): HclBlock {
  const [block] = blocks;
  assert(block !== undefined, "expected one top-level block");
  return block;
}

function attr(block: HclBlock, name: string): HclValue {
  const v = block.attrs[name];
  assert(v !== undefined, `expected attribute ${name}`);
  return v;
}

Deno.test("parseHcl - reads a resource's labels, attributes and line numbers", () => {
  const r = parseHcl(
    `
resource "aws_iam_role" "deploy" {
  name = "deploy"
  path = "/"
}
`,
  );
  assertEquals(r.errors, []);
  assertEquals(r.blocks.length, 1);
  const block = only(r.blocks);
  assertEquals(block.type, "resource");
  assertEquals(block.labels, ["aws_iam_role", "deploy"]);
  assertEquals(block.line, 2);
  assertEquals(block.attrs, { name: "deploy", path: "/" });
  assertEquals(block.attrLines, { name: 3, path: 4 });
  assertEquals(block.blocks, []);
});

Deno.test("parseHcl - nests statement, principals and condition blocks in source order", () => {
  const r = parseHcl(
    `
resource "aws_iam_role_policy" "p" {
  statement {
    principals {
      type = "AWS"
      identifiers = ["arn:aws:iam::123456789012:root"]
    }
    condition {
      test = "StringEquals"
      variable = "aws:SourceAccount"
      values = ["123456789012"]
    }
  }
}
`,
  );
  assertEquals(r.errors, []);
  const statement = only(only(r.blocks).blocks);
  assertEquals(statement.type, "statement");
  assertEquals(statement.labels, []);
  const [principals, condition] = statement.blocks;
  assertEquals(principals?.type, "principals");
  assertEquals(principals?.attrs, {
    type: "AWS",
    identifiers: ["arn:aws:iam::123456789012:root"],
  });
  assertEquals(condition?.type, "condition");
  assertEquals(condition?.attrs, {
    test: "StringEquals",
    variable: "aws:SourceAccount",
    values: ["123456789012"],
  });
});

Deno.test("parseHcl - accepts a block whose attributes share one line", () => {
  const r = parseHcl(
    `statement { principals { type = "AWS" identifiers = ["x"] } }\n`,
  );
  assertEquals(r.errors, []);
  const [principals] = only(r.blocks).blocks;
  assertEquals(principals?.attrs, { type: "AWS", identifiers: ["x"] });
});

Deno.test("parseHcl - a jsonencode object is a plain object with its refs kept", () => {
  const r = parseHcl(
    `
resource "aws_iam_policy" "p" {
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = aws_s3_bucket.b.arn
    }]
  })
}
`,
  );
  assertEquals(r.errors, []);
  assertEquals(attr(only(r.blocks), "policy"), {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: { ref: "aws_s3_bucket.b.arn" },
    }],
  });
});

Deno.test("parseHcl - a heredoc JSON policy is its body text, and parsing resumes after it", () => {
  const r = parseHcl(
    `
resource "aws_iam_policy" "p" {
  policy = <<-EOT
    {
      "Version": "2012-10-17"
    }
    EOT
  name = "p"
}
`,
  );
  assertEquals(r.errors, []);
  const block = only(r.blocks);
  assertEquals(attr(block, "policy"), '{\n  "Version": "2012-10-17"\n}\n');
  assertEquals(attr(block, "name"), "p");
  assertEquals(block.attrLines, { policy: 3, name: 8 });
});

Deno.test("parseHcl - a plain <<EOT heredoc keeps its body and does not decode escapes", () => {
  const r = parseHcl(`
resource "aws_iam_policy" "p" {
  body = <<EOT
hello "world" \\n
EOT
}
`);
  assertEquals(r.errors, []);
  assertEquals(attr(only(r.blocks), "body"), 'hello "world" \\n\n');
});

Deno.test("parseHcl - a reference, a single interpolation, a mixed string and unsupported expressions are told apart", () => {
  const r = parseHcl(
    `
resource "aws_iam_policy" "p" {
  a = aws_iam_role.deploy.arn
  b = "\${var.role_arn}"
  c = "arn:\${var.partition}:iam::123:role/x"
  d = var.roles[0]
  e = "plain"
  f = lookup(var.m, "k", "d")
  g = var.flag ? "yes" : "no"
  h = [for s in var.list : s]
  i = var.list[*].id
  j = 1 + 2
  k = jsondecode("{}")
}
`,
  );
  assertEquals(r.errors, []);
  const block = only(r.blocks);
  assertEquals(attr(block, "a"), { ref: "aws_iam_role.deploy.arn" });
  assertEquals(attr(block, "b"), { ref: "var.role_arn" });
  assertEquals(attr(block, "c"), {
    unknown: "arn:${var.partition}:iam::123:role/x",
  });
  assertEquals(attr(block, "d"), { ref: "var.roles[0]" });
  assertEquals(attr(block, "e"), "plain");
  assertEquals(attr(block, "f"), { unknown: 'lookup(var.m, "k", "d")' });
  assertEquals(attr(block, "g"), { unknown: 'var.flag ? "yes" : "no"' });
  assertEquals(attr(block, "h"), { unknown: "[for s in var.list : s]" });
  assertEquals(attr(block, "i"), { unknown: "var.list[*].id" });
  assertEquals(attr(block, "j"), { unknown: "1 + 2" });
  assertEquals(attr(block, "k"), { unknown: 'jsondecode("{}")' });
});

Deno.test("parseHcl - comments of every form are skipped", () => {
  const r = parseHcl(
    `
# hash comment
// slash comment
/* block
   comment */
resource "aws_iam_role" "r" { # trailing
  name = "x" // why
  /* inline */ path = "/"
  tags = { a = 1 } # note
}
`,
  );
  assertEquals(r.errors, []);
  assertEquals(attr(only(r.blocks), "name"), "x");
  assertEquals(attr(only(r.blocks), "path"), "/");
  assertEquals(attr(only(r.blocks), "tags"), { a: 1 });
});

Deno.test("parseHcl - object members, escapes and literals decode", () => {
  const r = parseHcl(
    `
resource "aws_iam_role" "r" {
  map = { a = 1, "b" = 2, c: 3 }
  text = "a\\"b\\n\\u00e9"
  t = true
  f = false
  n = null
  e = 1.5e2
}
`,
  );
  assertEquals(r.errors, []);
  const block = only(r.blocks);
  assertEquals(attr(block, "map"), { a: 1, b: 2, c: 3 });
  assertEquals(attr(block, "text"), 'a"b\n\u00e9');
  assertEquals(attr(block, "t"), true);
  assertEquals(attr(block, "f"), false);
  assertEquals(attr(block, "n"), null);
  assertEquals(attr(block, "e"), 150);
});

Deno.test("parseHcl - an unterminated string reports an error and does not throw", () => {
  const r = parseHcl(
    `resource "aws_iam_role" "x" {\n  name = "unterminated\n}\n`,
  );
  assert(r.errors.length > 0);
  assert(r.errors.some((e) => e.includes("unterminated string")));
});

Deno.test("parseHcl - an unclosed block and an unclosed comment report errors", () => {
  const unclosedBlock = parseHcl(
    `resource "aws_iam_role" "x" {\n  name = "x"\n`,
  );
  assert(unclosedBlock.errors.some((e) => e.includes("unterminated block")));
  assertEquals(attr(only(unclosedBlock.blocks), "name"), "x");

  const unclosedComment = parseHcl(`/* never closed`);
  assert(
    unclosedComment.errors.some((e) => e.includes("unterminated /* comment")),
  );
});

Deno.test("parseHcl - a stray closing brace and garbage never throw", () => {
  const r = parseHcl(`}}}]]](((=== "\n\u0000 resource "a" "b" {}\n`);
  assert(r.errors.length > 0);
});

Deno.test("parseHcl - 5000 nested brackets return a nesting error instead of overflowing the stack", () => {
  const deepList = parseHcl(
    `resource "a" "b" {\n  x = ${"[".repeat(5000)}\n}\n`,
  );
  assert(deepList.errors.some((e) => e.includes("nested deeper than 64")));

  const deepCall = parseHcl(
    `resource "a" "b" {\n  x = f(${"[".repeat(5000)}\n}\n`,
  );
  assert(deepCall.errors.some((e) => e.includes("nested deeper than 64")));
});

Deno.test("parseHcl - a long run of attribute accesses is one reference, read in linear time", () => {
  const r = parseHcl(
    `resource "a" "b" {\n  x = ${"a.".repeat(100_000)}b\n}\n`,
  );
  assertEquals(r.errors, []);
  const x = attr(only(r.blocks), "x");
  assert(isHclRef(x));
  assertEquals(x.ref.length, 200_001);
});

Deno.test("parseHcl - a long run of an unclosed interpolation opener finishes with an error", () => {
  const r = parseHcl(
    `resource "a" "b" {\n  x = "${"${".repeat(50_000)}\n}\n`,
  );
  assert(r.errors.length > 0);
});

Deno.test("parseHcl - input over 1,000,000 characters is rejected without parsing", () => {
  const r = parseHcl("a".repeat(1_000_001));
  assertEquals(r.blocks, []);
  assertEquals(r.errors.length, 1);
  assert(r.errors[0]?.includes("limit is 1000000"));
});

Deno.test("parseHcl - isHclRef and isHclUnknown tell their own shapes apart", () => {
  assert(isHclRef({ ref: "var.x" }));
  assertFalse(isHclRef({ a: 1 }));
  assertFalse(isHclRef({ ref: "var.x", other: 1 }));
  assertFalse(isHclRef(undefined));
  assert(isHclUnknown({ unknown: "f()" }));
  assertFalse(isHclUnknown({ ref: "var.x" }));
  assertFalse(isHclUnknown("f()"));
});
