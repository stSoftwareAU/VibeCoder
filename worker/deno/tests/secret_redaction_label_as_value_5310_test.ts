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

Deno.test("#5310 control: a 66-character label, within the 128-character bound, is masked", () => {
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

// A single-quoted inner value holding a space that runs straight into more
// text: its mask removes the space, so a second pass would read label,
// placeholder and tail as one outer value and mask it whole. The first pass
// keeps the outer mask, so a second changes nothing (PR #5322 review round 3).
leak(
  "single-quoted inner value running into punctuation",
  "credentials: DEPLOY_TOKEN='a b'.",
  `credentials: ${R}${R}.`,
);
leak(
  "single-quoted inner value running into another assignment",
  "credentials: DEPLOY_TOKEN='a b';x=1",
  `credentials: ${R}${R};x=1`,
);

// The inner label's separator and value must start within 256 characters of
// the outer value's end (PR #5322 review round 3). The first pass masks a
// value starting inside that span, so its placeholder can run past the span's
// end; a second pass must still see the whole placeholder. Before the fix a
// 13-gap band at the edge of each shape was masked again on a second pass,
// and `containsSecret` reported a secret in the redacted text.
for (
  const [name, at] of [
    [
      "spaces before =",
      (n: number) => `credentials: DEPLOY_TOKEN${" ".repeat(n)}= ${V}`,
    ],
    [
      "spaces after =",
      (n: number) => `credentials: DEPLOY_TOKEN =${" ".repeat(n)}${V}`,
    ],
    [
      "newlines after api_key:",
      (n: number) => `The secret: api_key:${"\n".repeat(n)}${V}`,
    ],
  ] as const
) {
  Deno.test(`#5310 idempotent across the 256-character span edge: ${name}`, () => {
    for (let n = 0; n <= 300; n++) {
      const once = redactSecrets(at(n));
      assertEquals(redactSecrets(once), once, `gap ${n}`);
      assertEquals(containsSecret(once), false, `gap ${n}`);
    }
  });
}

Deno.test("#5310 control: an inner = 253 spaces away is still judged as a label", () => {
  const gap = " ".repeat(253);
  const once = redactSecrets(`credentials: DEPLOY_TOKEN${gap}= ${V}`);
  assertEquals(once, `credentials: DEPLOY_TOKEN${gap}= ${R}`);
  assertEquals(redactSecrets(once), once);
  assertEquals(containsSecret(once), false);
});

Deno.test("#5310 control: an inner = 254 spaces away keeps the base behaviour", () => {
  // The documented limit (SECURITY.md): past the span the label is masked as
  // the earlier label's value and the inner value is published, as on base.
  const gap = " ".repeat(254);
  assertEquals(
    redactSecrets(`credentials: DEPLOY_TOKEN${gap}= ${V}`),
    `credentials: ${R}${gap}= ${V}`,
  );
});

// A double-quoted inner value matches only with its closing quote, which a
// long value puts past the 256-character window (PR #5322 review round 4):
// the value was published. It now counts when it opens inside the window and
// closes within 4,096 characters.
const longValue = (n: number) => "Ab3".repeat(Math.ceil(n / 3)).slice(0, n);
for (
  const [name, at, expected] of [
    [
      "same line",
      (v: string) => `Rotate these credentials: DEPLOY_TOKEN = "${v}"`,
      `Rotate these credentials: DEPLOY_TOKEN = "${R}"`,
    ],
    [
      "next line",
      (v: string) => `Rotate these credentials:\nDEPLOY_TOKEN = "${v}"`,
      `Rotate these credentials:\nDEPLOY_TOKEN = "${R}"`,
    ],
    [
      "next-line api_key",
      (v: string) => `The secret: api_key: "${v}"`,
      `The secret: api_key: "${R}"`,
    ],
    [
      "YAML child",
      (v: string) => `secrets:\n  API_TOKEN: "${v}"`,
      `secrets:\n  API_TOKEN: "${R}"`,
    ],
  ] as const
) {
  for (const length of [252, 300, 4096]) {
    Deno.test(`#5310 masks a ${length}-character double-quoted inner value: ${name}`, () => {
      const once = redactSecrets(at(longValue(length)));
      assertEquals(once, expected);
      assertEquals(redactSecrets(once), once);
      assertEquals(containsSecret(once), false);
    });
  }
}

Deno.test("#5310 control: a double-quoted inner value over 4,096 characters keeps the base behaviour", () => {
  // The documented limit (SECURITY.md): the label is masked as the earlier
  // label's value and the inner value is published, as on base.
  const value = longValue(4097);
  assertEquals(
    redactSecrets(`credentials: DEPLOY_TOKEN = "${value}"`),
    `credentials: ${R} = "${value}"`,
  );
});

// A quoted outer value that ends in the inner label's separator, with the
// inner value straight after it (PR #5322 review rounds 4 and 5). Masking only
// the inner value would join the quoted run and the placeholder into one outer
// value, which the next call masks whole, so the walk keeps the outer mask.
// `secrets: TOKEN'='d9 e8'` keeps its label: a second pass finds it before the
// third-last quote of `TOKEN'='***REDACTED***'`.
function assertFinal(
  input: string,
  expected: string,
  values: readonly string[],
) {
  const once = redactSecrets(input);
  assertEquals(once, expected);
  assertEquals(redactSecrets(once), once);
  assertEquals(containsSecret(once), false);
  assertEquals(containsSecret(input), true);
  for (const value of values) {
    assertEquals(once.includes(value), false, `${value} published: ${once}`);
  }
}

for (
  const [input, expected, values] of [
    [`credentials: 'DEPLOY_TOKEN='${V}`, `credentials: '${R}'${R}`, [V]],
    ["export CREDENTIALS='password='hunter2", `export CREDENTIALS='${R}'${R}`, [
      "hunter2",
    ]],
    [`DB_SECRET_ARGS='--token='${V}`, `DB_SECRET_ARGS='${R}'${R}`, [V]],
    ["secrets: 'Password:'hunter2", `secrets: '${R}'${R}`, ["hunter2"]],
    ["secrets: TOKEN'='d9 e8'", `secrets: TOKEN'='${R}'`, ["d9", "e8"]],
  ] as const
) {
  Deno.test(`#5310 idempotent on a quoted outer value ending in a separator: ${JSON.stringify(input.slice(0, 32))}`, () => {
    assertFinal(input, expected, values);
  });
}

// The walk decides the shape, not the bounded re-walk in redactAssignments, so
// repeating it past that cap changes nothing (PR #5322 review round 5).
for (
  const unit of [
    "'DEPLOY_TOKEN=",
    "'T_TOKEN=",
    "'T_TOKEN:",
    "T_TOKEN='",
    "T_TOKEN:'",
  ]
) {
  for (const repeats of [4, 5, 8]) {
    Deno.test(`#5310 idempotent on ${repeats} repeats of ${JSON.stringify(unit)}`, () => {
      const expected = unit.startsWith("'")
        ? `credentials: '${R}'${R.repeat(repeats - 1)}`
        : `credentials: ${R}`;
      assertFinal(`credentials: ${unit.repeat(repeats)}${V}`, expected, [V]);
    });
  }
}

// A CLI flag before the inner separator is text before the label, not the
// label, so the outer value keeps its mask (PR #5322 review round 5). Given up,
// it left `--token = ***REDACTED***` for the `secret-cli-flag` rule, which read
// `=` as the flag's value, and the next call masked `--token`.
for (
  const [input, expected] of [
    [`credentials: --token = ${V}`, `credentials: ${R} = ${R}`],
    [
      `Rotate these credentials: --api-token = ${V}`,
      `Rotate these credentials: ${R} = ${R}`,
    ],
    [`Use this password: --password : ${V}`, `Use this password: ${R} : ${R}`],
    [`The secret: --client-secret\n  = ${V}`, `The secret: ${R}\n  = ${R}`],
    [`credentials: --token = "${V}"`, `credentials: ${R} = "${R}"`],
  ] as const
) {
  Deno.test(`#5310 idempotent on a flag-shaped outer value: ${JSON.stringify(input.slice(0, 36))}`, () => {
    assertFinal(input, expected, [V]);
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
