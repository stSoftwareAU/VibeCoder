/**
 * A credential label must not be taken as the value of the label before it
 * (Issue #5310).
 *
 * `credentials: DEPLOY_TOKEN = <value>` matched with `DEPLOY_TOKEN` as the
 * first label's value; the bare-value branch stops at whitespace, so only the
 * label was masked, the scan resumed after it and the real value was
 * published. Tests drive the public chokepoints so they keep holding if the
 * rule is restructured.
 */

import { assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

const V = "q7Lm2Xv9Rk4Tz8Pw1Hn6Bc3Df5Gj0Ys2Ua7Ne4Mi";
const R = "***REDACTED***";

/** Every leak fixture, so the idempotence check covers each one. */
const LEAKS: string[] = [];

function leak(name: string, input: string, expected: string): void {
  LEAKS.push(input);
  Deno.test(`#5310 masks: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), true);
  });
}

function keep(
  name: string,
  input: string,
  expected: string,
  flagged: boolean,
): void {
  Deno.test(`#5310 control: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), flagged);
  });
}

leak(
  "same line, long value",
  `Rotate these credentials: DEPLOY_TOKEN = ${V}`,
  `Rotate these credentials: DEPLOY_TOKEN = ${R}`,
);
leak(
  "next line, long value",
  `Rotate these credentials:\nDEPLOY_TOKEN = ${V}`,
  `Rotate these credentials:\nDEPLOY_TOKEN = ${R}`,
);
leak(
  "same line colon, short value",
  "The secret: api_key: pw42",
  `The secret: api_key: ${R}`,
);
leak(
  "next line colon, short value",
  "The secret:\napi_key: pw42",
  `The secret:\napi_key: ${R}`,
);
leak(
  "same line colon, long value",
  `The secret: api_key: ${V}`,
  `The secret: api_key: ${R}`,
);
leak(
  "next line colon, long value",
  `The secret:\napi_key: ${V}`,
  `The secret:\napi_key: ${R}`,
);
leak(
  "YAML child holding a credential",
  `secrets:\n  API_TOKEN: ${V}`,
  `secrets:\n  API_TOKEN: ${R}`,
);
leak(
  "double-quoted inner value",
  `credentials: DEPLOY_TOKEN="${V}"`,
  `credentials: DEPLOY_TOKEN="${R}"`,
);
leak(
  "chain of labels",
  `credentials: secret: DEPLOY_TOKEN = ${V}`,
  `credentials: secret: DEPLOY_TOKEN = ${R}`,
);

keep(
  "password with credential word and colon",
  "password=MySecret:2024x",
  `password=${R}`,
  true,
);
keep(
  "no whitespace: whole run is the value",
  `credentials: DEPLOY_TOKEN=${V}`,
  `credentials: ${R}`,
  true,
);
keep(
  "expression child is untouched",
  "secrets:\n  GH_TOKEN: ${{ secrets.GH_TOKEN }}",
  "secrets:\n  GH_TOKEN: ${{ secrets.GH_TOKEN }}",
  false,
);
keep("bare parent key", "secrets:\n  deploy:", "secrets:\n  deploy:", false);
keep(
  "standalone assignment",
  `DEPLOY_TOKEN = ${V}`,
  `DEPLOY_TOKEN = ${R}`,
  true,
);

Deno.test("#5310 hostile: long run before a label stays linear and publishes nothing", () => {
  const input = "credentials: " + "x".repeat(200_000) + "_TOKEN" +
    " ".repeat(40) + "!";
  const expected = "credentials: " + R + " ".repeat(40) + "!";
  assertEquals(redactSecrets(input), expected);
});

Deno.test("#5310 control: label within the 64-character bound is masked", () => {
  const input = `credentials: ${"A".repeat(60)}_TOKEN = ${V}`;
  assertEquals(
    redactSecrets(input),
    `credentials: ${"A".repeat(60)}_TOKEN = ${R}`,
  );
  assertEquals(containsSecret(input), true);
});

Deno.test("#5310 hostile: many TOKEN words then a rejected character", () => {
  const input = "credentials: " + "TOKEN".repeat(20_000) + "!";
  const expected = "credentials: " + R;
  assertEquals(redactSecrets(input), expected);
});

// The inner-label probe must stay linear on a labelled run of repeated
// keywords (pre-PR verifier; the Issue #3942 linearity rule). The pattern's
// key group is quadratic on such a run, so a probe that re-scanned it as a
// key took ~26 s here; the bounded probe never does. No stopwatch, as in
// `secret_redaction_redos_test.ts`: the hostile size is the detector. A run
// this long is no label (longer than `INNER_LABEL_MAX`), so the base output
// applies: the run is masked as the outer value and the scan resumes after it.
for (
  const [tail, rest] of [["!", ""], ["", ""], [": x", " x"], [" = x", " = x"]]
) {
  Deno.test(`#5310 hostile: 500 kB labelled TOKEN run is linear (tail ${JSON.stringify(tail)})`, () => {
    const input = "credentials: " + "TOKEN".repeat(100_000) + tail;
    assertEquals(redactSecrets(input), "credentials: " + R + rest);
  });
}

// Inner labels that do not open with a plain word run (pre-PR verifier):
// a hyphen, a dot or an opening quote before the keyword.
leak(
  "hyphenated inner label, same line",
  `Rotate these credentials: DEPLOY-TOKEN = ${V}`,
  `Rotate these credentials: DEPLOY-TOKEN = ${R}`,
);
leak(
  "dotted inner label, same line",
  `credentials: app.DEPLOY_TOKEN = ${V}`,
  `credentials: app.DEPLOY_TOKEN = ${R}`,
);
leak(
  "double-quoted inner label, same line",
  `credentials: "DEPLOY_TOKEN" = ${V}`,
  `credentials: "DEPLOY_TOKEN" = ${R}`,
);
leak(
  "single-quoted inner label, same line",
  `credentials: 'DEPLOY_TOKEN' = ${V}`,
  `credentials: 'DEPLOY_TOKEN' = ${R}`,
);
leak(
  "hyphenated inner label, next line",
  `credentials: DEPLOY-TOKEN:\n  ${V}`,
  `credentials: DEPLOY-TOKEN:\n  ${R}`,
);

leak(
  "single-quoted inner value holding a space",
  "credentials: DEPLOY_TOKEN='q7Lm2Xv9 Rk4Tz8Pw1Hn6'",
  `credentials: DEPLOY_TOKEN='${R}'`,
);

// A real value that merely contains a keyword keeps the base's mask when no
// inner assignment masks a value (pre-PR verifier).
for (
  const [name, tail] of [
    ["trailing space then newline", " \n"],
    ["end of text", ""],
    ["dangling equals", " ="],
    ["dangling colon", " :"],
    ["equals then newline", " = \n"],
    ["switch word after", " is the old one"],
  ]
) {
  keep(
    `keyword-bearing value keeps its mask: ${name}`,
    `password: abcTOKENxyz${tail}`,
    `password: ${R}${tail}`,
    true,
  );
}
keep(
  "keyword-bearing value keeps its mask: cross-line prose value",
  "password: abcTOKENxyz:\nThe next line text",
  `password: ${R}\nThe next line text`,
  true,
);

// A keyword elsewhere in the value is not a label (pre-PR verifier). A
// signature rule masks the token first, so the value after the separator is
// already the placeholder; the outer value must keep its own mask.
const GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
keep(
  "keyword mid-value before a masked token: equals",
  `password: TOKENab#c1 = ${GHP}`,
  `password: ${R} = ${R}`,
  true,
);
keep(
  "keyword mid-value before a masked token: spaced colon",
  `password: abc-TOKEN.x9 : ${GHP}`,
  `password: ${R} : ${R}`,
  true,
);
keep(
  "keyword mid-value before a masked token: quoted",
  `password: "a TOKEN b" = "${GHP}"`,
  `password: "${R}" = "${R}"`,
  true,
);

// Text before the inner label is part of the outer value, so it stays masked
// (PR #5322 review): the outer candidate is given up unmasked only when its
// whole value is the label. Giving it up for any trailing label published
// `hunter2` in `password: hunter2,token: <value>`, which base masked. Each
// output below also masks what base published (`abc123` from `token: abc123`,
// `e8` from `'d9 e8'`).
for (
  const [name, input, expected, values] of [
    [
      "password then token after a comma",
      `password: hunter2,token: ${GHP}`,
      `password: ${R} ${R}`,
      ["hunter2", GHP],
    ],
    [
      "password then token after a semicolon",
      `db_password: Winter2026!;gh_token: ${GHP}`,
      `db_password: ${R} ${R}`,
      ["Winter2026!", GHP],
    ],
    [
      "inner value already the placeholder",
      `password: hunter2,token: ${R}`,
      `password: ${R} ${R}`,
      ["hunter2"],
    ],
    [
      "non-credential key before the pair",
      "user: bob,password: hunter2,token: abc123",
      `user: bob,password: ${R} ${R}`,
      ["hunter2", "abc123"],
    ],
    [
      "single-quoted inner value with a space",
      "TOKEN=abc123;SECRET='d9 e8'",
      `TOKEN=${R}${R}`,
      ["abc123", "d9", "e8"],
    ],
    [
      "value ending in a keyword run",
      `password: ab#c1TOKEN = ${GHP}`,
      `password: ${R} = ${R}`,
      ["ab#c1", "c1TOKEN", GHP],
    ],
    [
      "label, quote and masked token, then more of the same value",
      `credentials: TOKEN='${GHP}';db_pass=Winter2026`,
      `credentials: ${R}`,
      ["Winter2026", "db_pass", GHP],
    ],
    [
      "label, quote and placeholder, then more of the same value",
      `credentials: TOKEN='${R}';db_pass=Winter2026`,
      `credentials: ${R}`,
      ["Winter2026", "db_pass"],
    ],
    [
      "chain of three pairs",
      "a_password: x1,b_token: y2,c_secret: z3",
      `a_password: ${R} ${R} ${R}`,
      ["x1", "y2", "z3"],
    ],
  ] as const
) {
  leak(`text before an inner label stays masked: ${name}`, input, expected);
  Deno.test(`#5310 publishes no value: ${name}`, () => {
    const out = redactSecrets(input);
    for (const value of values) {
      assertEquals(out.includes(value), false, `${value} published: ${out}`);
    }
  });
}

// Redaction is idempotent on every leak form, and its output reads clean
// (pre-PR verifier): `api_key: pw42` once lost its label on a second pass.
for (const input of LEAKS) {
  Deno.test(`#5310 idempotent: ${JSON.stringify(input.slice(0, 40))}`, () => {
    const once = redactSecrets(input);
    assertEquals(redactSecrets(once), once);
    assertEquals(containsSecret(once), false);
  });
}

// The decode-then-rescan pass uses the same detection (Issue #188): an
// encoded label-as-value text is masked whole. On base the detection loop
// read `API_TOKEN:` and `api_key:` as the parent's value and never saw the
// credential, so the blob was published.
for (
  const [name, plain] of [
    ["YAML child", `secrets:\n  API_TOKEN: ${V}`],
    ["next-line colon", `The secret:\napi_key: ${V}`],
  ] as const
) {
  Deno.test(`#5310 masks base64 of the ${name} form`, () => {
    const input = `blob ${btoa(plain)} end`;
    assertEquals(redactSecrets(input), `blob ${R} end`);
    assertEquals(containsSecret(input), true);
  });
}
