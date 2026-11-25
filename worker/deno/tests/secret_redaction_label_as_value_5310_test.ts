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
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";
import { capturingWriter, readerFor } from "./support/gh_body_fixtures.ts";

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
// closes within 4,096 characters. Since #5329 the 4,096 bound only matters for
// a value the probe cannot read (see below).
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

// Since #5329 the window probe reads the cut-off quoted value as unterminated,
// so the full-text match masks it.
Deno.test("#5310/#5329: a double-quoted inner value over 4,096 characters is masked whole", () => {
  const once = redactSecrets(
    `credentials: DEPLOY_TOKEN = "${longValue(4097)}"`,
  );
  assertEquals(once, `credentials: DEPLOY_TOKEN = "${R}"`);
  assertEquals(redactSecrets(once), once);
  assertEquals(containsSecret(once), false);
});

Deno.test("#5310 control: a line-broken double-quoted inner value over 4,096 characters keeps the base behaviour", () => {
  // The documented limit (SECURITY.md) still applies: the window probe cannot
  // read a value that opens with a line break, so the label is masked as the
  // earlier label's value and the inner value is published, as on base.
  const value = longValue(4097);
  assertEquals(
    redactSecrets(`credentials: DEPLOY_TOKEN = "\n${value}"`),
    `credentials: ${R} = "\n${value}"`,
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

// The pattern's key group accepts `API-KEY`, `ACCESS-KEY` and `PRIVATE-KEY`, so
// a lead-in label followed by one of those spellings must still mask the inner
// value, keeping the label (PR #5322 review round 6). The inner label starts
// where the pattern's key would: `api` in `x-api-key`.
for (
  const [input, expected, values] of [
    [
      `Rotate these credentials: api-key = ${V}`,
      `Rotate these credentials: api-key = ${R}`,
      [V],
    ],
    [
      `Rotate these credentials:\napi-key = ${V}`,
      `Rotate these credentials:\napi-key = ${R}`,
      [V],
    ],
    [`The secret:\napi-key: ${V}`, `The secret:\napi-key: ${R}`, [V]],
    [`secrets:\n  access-key: ${V}`, `secrets:\n  access-key: ${R}`, [V]],
    ["The secret: api-key: pw42", `The secret: api-key: ${R}`, ["pw42"]],
    [
      "credentials: private-key = hunter2",
      `credentials: private-key = ${R}`,
      ["hunter2"],
    ],
    [`credentials: x-api-key: ${V}`, `credentials: x-api-key: ${R}`, [V]],
  ] as const
) {
  Deno.test(`#5310 masks after a hyphenated keyword label: ${JSON.stringify(input.slice(0, 36))}`, () => {
    assertFinal(input, expected, values);
  });
}

// A quoted inner value that ends in a second label and a spaced separator,
// with the real value straight after the closing quote: the value after the
// quote must be masked (PR #5322 review round 6; main masked it).
for (
  const [input, expected] of [
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN = '${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = "API_TOKEN = "${V}"`,
      `credentials: DEPLOY_TOKEN = "${R}"${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN ='${V}`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN= '${V}`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN: 'API_TOKEN: '${V}`,
      `credentials: DEPLOY_TOKEN: '${R}'${R}`,
    ],
    [
      `credentials:\nDEPLOY_TOKEN = 'API_TOKEN = '${V}'`,
      `credentials:\nDEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'API_TOKEN: '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: '${R}'${R}`,
    ],
  ] as const
) {
  Deno.test(`#5310 masks past a quoted value ending in a spaced label: ${JSON.stringify(input.slice(0, 44))}`, () => {
    assertFinal(input, expected, [V]);
  });
}

// `--` anywhere before the inner label is a CLI flag, not label text, so the
// outer value keeps its mask and the `secret-cli-flag` rule has nothing left
// to rewrite on a second pass (PR #5322 review round 6).
for (
  const [input, expected, values] of [
    [`credentials: x--token = ${V}`, `credentials: ${R} = ${R}`, [V]],
    ["password:\n  DEPLOY_TOKEN--token = abc", `password:\n  ${R} = ${R}`, [
      "abc",
    ]],
    [`credentials: my-tool--token = "${V}"`, `credentials: ${R} = "${R}"`, [
      V,
    ]],
    ["secret: a.--token = hunter2", `secret: ${R} = ${R}`, ["hunter2"]],
  ] as const
) {
  Deno.test(`#5310 idempotent on a flag after label text: ${JSON.stringify(input.slice(0, 36))}`, () => {
    assertFinal(input, expected, values);
  });
}

// An inner label whose value is a credential flag with its own value after
// whitespace: the outer value keeps its mask and the `secret-cli-flag` rule
// masks the flag's value, as on main (PR #5322 review round 7). Masking the
// flag as the inner value hid it from that rule and published the value.
for (
  const [input, expected, values] of [
    [
      `Rotate these credentials: DEPLOY_TOKEN = --token ${V}`,
      `Rotate these credentials: ${R} = --token ${R}`,
      [V],
    ],
    [
      `Rotate these credentials:\nDEPLOY_TOKEN = --token ${V}`,
      `Rotate these credentials:\n${R} = --token ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: --token ${V}`,
      `secrets:\n  DEPLOY_TOKEN: --token ${R}`,
      [V],
    ],
    [
      "secrets:\n  token: --password hunter2",
      `secrets:\n  token: --password ${R}`,
      ["hunter2"],
    ],
    [
      `credentials: api_key: --api-key ${V}`,
      `credentials: ${R} --api-key ${R}`,
      [
        V,
      ],
    ],
    [
      `credentials: api-key: --api-key ${V}`,
      `credentials: ${R} --api-key ${R}`,
      [
        V,
      ],
    ],
    [
      `The secret: credentials: --token ${V}`,
      `The secret: ${R} --token ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN: --api-key "${V}"`,
      `credentials: ${R} --api-key ${R}`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 masks a flag's value when the flag is an inner label's value: ${JSON.stringify(input.slice(0, 44))}`, () => {
    assertFinal(input, expected, values);
  });
}

// A quoted inner value ending in a label whose separator holds a line break,
// a CRLF or more than 32 spaces: the value after the closing quote is masked
// (PR #5322 review round 7). The separator's whitespace is the pattern's own
// `\s`, bounded by the walk's span.
for (
  const [input, expected] of [
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN =\n'${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN:\n  '${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = "API_TOKEN:\n  "${V}"`,
      `credentials: DEPLOY_TOKEN = "${R}"${R}`,
    ],
    [
      `credentials:\nDEPLOY_TOKEN = 'API_TOKEN\n= '${V}'`,
      `credentials:\nDEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'API_TOKEN:\n    '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN =\r\n'${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN${" ".repeat(33)}= '${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN =${" ".repeat(33)}'${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
    ],
  ] as const
) {
  Deno.test(`#5310 masks past a quoted value ending in a label with a line-break or long separator: ${JSON.stringify(input.slice(0, 44))}`, () => {
    assertFinal(input, expected, [V]);
  });
}

// Wherever main's own scan would read past the inner value, main's result
// stands (PR #5322 review round 8): a label or a credential flag inside a
// quoted inner value followed by more text, a bare inner value that the
// decode-then-rescan pass joins to the next line, and the earlier flag and
// spaced-separator shapes past their whitespace bounds.
for (
  const [input, expected, values] of [
    [
      `credentials: DEPLOY_TOKEN = 'token:x'${V}`,
      `credentials: ${R} = 'token:${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN = abc'${V}'`,
      `credentials: ${R} = 'API_TOKEN = ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN: abc'${V}`,
      `credentials: ${R} = 'API_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'api-key =x'${V}`,
      `secrets:\n  DEPLOY_TOKEN: 'api-key =${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = '--token '${V}'`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = "--token "${V}"`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      `Rotate these credentials: DB_SECRET_ARGS = '--token '${V}`,
      `Rotate these credentials: DB_SECRET_ARGS = ${R}`,
      [V],
    ],
    [
      `Rotate these credentials:\nDB_SECRET_ARGS = '--token '${V}`,
      `Rotate these credentials:\nDB_SECRET_ARGS = ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: "--token " ${V}"`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = "--token abc"${V}`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: API_TOKEN=\nhunter2",
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      ["hunter2"],
    ],
    [
      "credentials: DEPLOY_TOKEN = API_TOKEN=\nhunter2",
      `credentials: ${R} = ${R}`,
      ["hunter2"],
    ],
    [
      `credentials: DEPLOY_TOKEN = --token${" ".repeat(255)}${V}`,
      `credentials: ${R} = --token${" ".repeat(255)}${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = --token${" ".repeat(256)}${V}`,
      `credentials: ${R} = --token${" ".repeat(256)}${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = --token${" ".repeat(255)}\n${V}`,
      `credentials: ${R} = --token${" ".repeat(255)}\n${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN =${" ".repeat(256)}'${V}'`,
      `credentials: DEPLOY_TOKEN = '${R}'${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN =${" ".repeat(257)}'${V}'`,
      `credentials: ${R} = 'API_TOKEN =${" ".repeat(257)}'${R}'`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = 'API_TOKEN${" ".repeat(257)}= '${V}'`,
      `credentials: ${R} = 'API_TOKEN${" ".repeat(257)}= '${R}'`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = "API_TOKEN =${" ".repeat(300)}"${V}"`,
      `credentials: ${R} = "API_TOKEN =${" ".repeat(300)}"${R}"`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'API_TOKEN:${" ".repeat(300)}'${V}'`,
      `secrets:\n  DEPLOY_TOKEN: '${R}'${R}'`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 keeps main's result where main reads past the inner value: ${JSON.stringify(input.slice(0, 48))}`, () => {
    assertFinal(input, expected, values);
  });
}

// PR #5322 review round 9. A chain whose last value main reads past gets
// main's result; a quoted inner value that stopped the outer bare value at a
// `"` keeps the outer mask, so a flag after it stays masked; an inner value
// that already holds the placeholder after other text keeps main's result on
// a second pass; and every flag inside a quoted inner value counts.
for (
  const [input, expected, values] of [
    [
      "credentials: DEPLOY_TOKEN = API_TOKEN: hunter2,--token x",
      `credentials: DEPLOY_TOKEN = API_TOKEN: ${R}--token ${R}`,
      ["hunter2"],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: API_TOKEN: ${V},--token x`,
      `secrets:\n  DEPLOY_TOKEN: API_TOKEN: ${R}--token ${R}`,
      [V],
    ],
    [
      `Rotate these credentials:\nDEPLOY_TOKEN = API_TOKEN: ${V};--password x`,
      `Rotate these credentials:\nDEPLOY_TOKEN = API_TOKEN: ${R}--password ${R}`,
      [V],
    ],
    [
      `The secret: credentials: api_key: ${V},--token x`,
      `The secret: credentials: api_key: ${R}--token ${R}`,
      [V],
    ],
    [
      "credentials: DEPLOY_TOKEN = API_TOKEN: 'hunter2 --token 'x",
      `credentials: DEPLOY_TOKEN = API_TOKEN: ${R}`,
      ["hunter2"],
    ],
    [
      `credentials: DEPLOY_TOKEN = API_TOKEN: '${V} token:x'y`,
      `credentials: ${R} = API_TOKEN: '${R}'y`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN='"abc"'--token ${V}`,
      `credentials: ${R}${R}--token ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN='"abc"'--password hunter2`,
      `credentials: ${R}${R}--password ${R}`,
      ["hunter2"],
    ],
    [
      `Rotate these credentials:\nDEPLOY_TOKEN='"abc"'--token ${V}`,
      `Rotate these credentials:\n${R}${R}--token ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN:'"abc"'--api-key ${V}`,
      `credentials: ${R}${R}--api-key ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN='"'--token ${V}`,
      `credentials: ${R}${R}--token ${R}`,
      [V],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: ,API_TOKEN=\nhunter2",
      `secrets:\n  DEPLOY_TOKEN: ,${R}`,
      ["hunter2"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: x.API_TOKEN=\nhunter2",
      `secrets:\n  DEPLOY_TOKEN: x.${R}`,
      ["hunter2"],
    ],
    [
      "Rotate these credentials:\napi-key: ,tokenhunter2=\nsecret = token",
      `Rotate these credentials:\napi-key: ,${R} = ${R}`,
      ["hunter2"],
    ],
    [
      `credentials: DEPLOY_TOKEN = '--token a --password '${V}'`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = '--token a --password '${V}`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = "--token a --password "${V}"`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: '--token a --password '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = '--api-key k1 --secret s2 --token '${V}`,
      `credentials: DEPLOY_TOKEN = ${R}`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 round 9: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

// Hostile sizes for the inner-value check (PR #5322 review round 9). No
// stopwatch, as in secret_redaction_redos_test.ts: a quadratic check does not
// overrun a budget on these, it does not return in a test run's lifetime.
Deno.test("#5310 a 2.8 MB run of label-as-value lines is masked line by line", () => {
  const line = "credentials: DEPLOY_TOKEN = abcdefgh12345678\n";
  assertEquals(
    redactSecrets(line.repeat(64_000)),
    `credentials: DEPLOY_TOKEN = ${R}\n`.repeat(64_000),
  );
});

Deno.test("#5310 a 512 KB inner value of TOKEN=x, pairs keeps main's result", () => {
  const input = "credentials: DEPLOY_TOKEN = " + "TOKEN=x,".repeat(65_536);
  assertEquals(redactSecrets(input), `credentials: ${R} = TOKEN=${R}`);
});

// PR #5322 review round 10: the decode-then-rescan pass's run is read from
// where it starts on main (the separator's `=`, the label's line), and a flag
// after an unclosed quote is read on a second pass as the first read it.
for (
  const [input, expected, values] of [
    [
      "secrets:\n  token=\nabcdefgh1234\nZk4Qw8Rt2Lm6Xv0B",
      `secrets:\n  ${R}`,
      ["Zk4Qw8Rt2Lm6Xv0B"],
    ],
    [
      "Rotate these credentials:\ntoken=\nabcdefgh1234\nZk4Qw8Rt2Lm6Xv0B",
      `Rotate these credentials:\n${R}`,
      ["Zk4Qw8Rt2Lm6Xv0B"],
    ],
    [
      `secrets:\n  passwd=\n${V.slice(0, 20)}\n${V.slice(20)}`,
      `secrets:\n  ${R}`,
      [V.slice(20)],
    ],
    [
      `The secret:\nsecret=\n${V.slice(0, 20)}\n${V.slice(20)}`,
      `The secret:\n${R}`,
      [V.slice(20)],
    ],
    [
      "credentials: DEPLOY_TOKEN =istoken=\nhunter2",
      `credentials: ${R} ${R}`,
      ["hunter2"],
    ],
    [
      "Rotate these credentials:\nDEPLOY_TOKEN =dbtoken=\nhunter2",
      `Rotate these credentials:\n${R} ${R}`,
      ["hunter2"],
    ],
    [
      "The secret: app.token=\nDEPLOY_TOKEN = hunter2",
      `The secret: ${R}\nDEPLOY_TOKEN = ${R}`,
      ["hunter2"],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'cmd --password '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: '--token --password ':",
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [],
    ],
  ] as const
) {
  Deno.test(`#5310 round 10: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

Deno.test("#5310 a 1 MB wrapped run of label-as-value lines keeps main's result", () => {
  const input = "credentials: DEPLOY_TOKEN = token=\n" +
    "abcdefgh12345678\n".repeat(60_000);
  assertEquals(
    redactSecrets(input),
    `credentials: ${R} = token=\n${R}\n` +
      "abcdefgh12345678\n".repeat(59_999),
  );
});

// PR #5322 review round 11: a label followed by `=` and a line break keeps its
// value masked; a flag after several words or a line break in an unclosed
// quote keeps the first pass final; a match inside the inner value that runs
// past it counts whether or not it is masked; and the line-break chain form.
for (
  const [input, expected, values] of [
    [`credentials: DEPLOY_TOKEN=\n${V}`, `credentials: DEPLOY_TOKEN=\n${R}`, [
      V,
    ]],
    [
      `Rotate these credentials:\nDEPLOY_TOKEN=\n${V}`,
      `Rotate these credentials:\nDEPLOY_TOKEN=\n${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy now --token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy -v --token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy x--token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'a b c --token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy\n--token '${V}'`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = API_TOKEN: ${V},DB_PASSWORD=\nhunter2`,
      `credentials: ${R} = API_TOKEN: ${R}\nhunter2`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = API_TOKEN =\ntoken: x--token ${V}`,
      `credentials: ${R} = API_TOKEN =\ntoken: ${R}--token ${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = API_TOKEN\n = --token: --password ${V}`,
      `credentials: ${R} = API_TOKEN\n = --token: --password ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: API_TOKEN =\ntoken: abc'--token ${V}`,
      `secrets:\n  DEPLOY_TOKEN: API_TOKEN =\ntoken: ${R}--token ${R}`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 round 11: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

// PR #5322 review round 12: the label-`=`-line-break forms, the unclosed quote
// with `=`, `:`, `*` or the other quote before the flag, and a chain longer
// than the look-ahead after an earlier wrapped run.
for (
  const [input, expected, values] of [
    [`The secret:\napi_key=\n${V}`, `The secret:\napi_key=\n${R}`, [V]],
    [`secrets:\n  API_TOKEN=\n${V}`, `secrets:\n  API_TOKEN=\n${R}`, [V]],
    [`credentials: DEPLOY_TOKEN\n=${V}`, `credentials: DEPLOY_TOKEN\n=${R}`, [
      V,
    ]],
    [`credentials=\nDEPLOY_TOKEN = ${V}`, `${R} = ${R}`, [V]],
    ["credentials: token=\nabcdefgh1", `credentials: token=\n${R}`, [
      "abcdefgh1",
    ]],
    ["credentials: token=\nabcdefgh12", `credentials: token=\n${R}`, [
      "abcdefgh12",
    ]],
    [
      `secrets:\n  DEPLOY_TOKEN: 'curl https://example.test --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy --env=prod --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy k=v --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy a:b --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy *.txt --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: 'deploy "x" --token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
    [
      `secrets:\n  DEPLOY_TOKEN: '"--token '${V}`,
      `secrets:\n  DEPLOY_TOKEN: ${R}`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 round 12: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

Deno.test("#5310 a chain longer than the look-ahead gives the same output after an earlier wrapped run", () => {
  const prefix = "secrets:\n  token=\nabcdefgh1234\nZk4Qw8Rt2Lm6Xv0B\n\n";
  for (const links of [18, 30]) {
    const chain = "credentials: " +
      Array.from({ length: links }, (_, i) => `k${i}_token: `).join("") + V;
    const alone = redactSecrets(chain);
    const after = redactSecrets(prefix + chain);
    assertEquals(after, redactSecrets(prefix) + alone, `${links} links`);
    assertEquals(redactSecrets(alone), alone);
    assertEquals(containsSecret(alone), false);
    assertEquals(alone.includes(V), false);
  }
});

// PR #5322 review round 13, finding 1. A credential flag's single-quoted
// value that opens before the lead-in label and closes at a quote in the
// outer or inner value: the flag rule pairs the quotes of the text the walk
// leaves, so main's result stands and the whole quoted run stays masked. The
// same holds when the quote sits inside the inner value (`ab'cd`), inside
// the outer value (`DEPLOY_TOKEN'`), or after a quote an earlier mask took.
for (
  const [input, expected, values] of [
    [
      `deploy --token 'alpha ${V} credentials: DEPLOY_TOKEN = 'tail`,
      `deploy --token ${R}tail`,
      [V],
    ],
    [
      `deploy --password 'alpha ${V} The secret: api_key: 'tail`,
      `deploy --password ${R}tail`,
      [V],
    ],
    [
      `deploy --api-key 'alpha ${V} Rotate these credentials:\nDEPLOY_TOKEN = 'tail`,
      `deploy --api-key ${R}tail`,
      [V],
    ],
    [
      `deploy --token 'alpha ${V}\nsecrets:\n  api_key: 'tail`,
      `deploy --token ${R}tail`,
      [V],
    ],
    [
      "run --password 'correct horse battery credentials: token: 'x",
      `run --password ${R}x`,
      ["horse battery"],
    ],
    [
      `deploy --token 'alpha ${V} credentials: DEPLOY_TOKEN = ab'cd`,
      `deploy --token ${R}cd`,
      [V],
    ],
    [
      "run --password '  = secrets:\n  DEPLOY_TOKEN': --env=prod hunter2abc'alpha ",
      `run --password ${R}alpha `,
      ["hunter2abc"],
    ],
    [
      "deploy --token 'credentials: x' = hunter2abc-H x-api-key:secrets:\n  '--env=prod abc123def456;",
      `deploy --token ${R}--env=prod abc123def456;`,
      ["hunter2abc"],
    ],
    [
      `deploy --token 'alpha ${V}*.txt app.token=password: 'credentials:  = )--password 'Rotate these credentials:\n`,
      `deploy --token ${R}credentials:  = )--password ${R} these credentials:\n`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 round 13 flag before the lead-in: ${JSON.stringify(input.slice(0, 48))}`, () => {
    assertFinal(input, expected, values);
  });
}

// PR #5322 review round 13, finding 2. A flag inside a quoted inner value
// whose value takes the closing quote is now masked with the inner value on
// the first call, so the output no longer holds an unclosed quote for a
// second call to read differently: a masked assignment before the flag, a
// long run of spaces or words, a URL-ish header, all give one final mask.
for (
  const input of [
    `secrets:\n  DEPLOY_TOKEN: 'deploy token=abc123def --token '${V}`,
    `secrets:\n  DEPLOY_TOKEN: 'a password=hunter2 --token '${V}`,
    `secrets:\n  DEPLOY_TOKEN: 'deploy password: hunter2abc --token '${V}'`,
    `secrets:\n  DEPLOY_TOKEN: 'curl -H x-api-key:abc123def --token '${V}`,
    `secrets:\n  DEPLOY_TOKEN: 'deploy${" ".repeat(260)}--token '${V}`,
    `secrets:\n  DEPLOY_TOKEN: 'deploy ${"now ".repeat(60)}--token '${V}`,
  ]
) {
  Deno.test(`#5310 round 13 masked through the flag: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, `secrets:\n  DEPLOY_TOKEN: ${R}`, [V, "hunter2"]);
  });
}

Deno.test("#5310 round 13: the Rotate-these-credentials form is masked through the flag", () => {
  assertFinal(
    `Rotate these credentials:\nDEPLOY_TOKEN: 'deploy token=abc123def --token '${V}`,
    `Rotate these credentials:\nDEPLOY_TOKEN: ${R}`,
    [V, "abc123def"],
  );
});

// Main's own output for those shapes, or text that already holds it, is
// final: the second-call search reads past an earlier placeholder and has
// no length bound (PR #5322 review round 13).
for (
  const input of [
    `secrets:\n  DEPLOY_TOKEN: 'deploy token=${R} --token ${R}`,
    `secrets:\n  DEPLOY_TOKEN: 'a password=${R} --token ${R}`,
    `secrets:\n  DEPLOY_TOKEN: 'curl -H x-api-key:${R} --token ${R}`,
    `secrets:\n  DEPLOY_TOKEN: 'deploy${" ".repeat(260)}--token ${R}`,
    `secrets:\n  DEPLOY_TOKEN: 'deploy ${"now ".repeat(60)}--token ${R}`,
  ]
) {
  Deno.test(`#5310 round 13 main's output stays final: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertEquals(redactSecrets(input), input);
    assertEquals(containsSecret(input), false);
  });
}

// Round 13: the mask taken through a flag never cuts a later flag or a
// match main masks inside the flag's value, and an unclosed-quote inner value
// that is itself the chain's next label is read as the chain on both calls.
for (
  const [input, expected, values] of [
    [
      "secrets:\n  DEPLOY_TOKEN: ')--password 'credentials:  abc123def456,DEPLOY_TOKENtail",
      `secrets:\n  DEPLOY_TOKEN: ')--password ${R}  ${R}`,
      ["abc123def456"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: ',k=v token=abc123def456--api-key \"tail'--api-key hunter2abc",
      `secrets:\n  DEPLOY_TOKEN: ${R} token=${R}`,
      ["abc123def456", "hunter2abc"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: '--token token='x\n'#hunter2abc deployapi_key: ",
      `secrets:\n  DEPLOY_TOKEN: ${R} deployapi_key: `,
      ["hunter2abc"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: 'hunter2abc--token ' : ;credentials: tail('\nabc123def456'",
      `secrets:\n  DEPLOY_TOKEN: 'hunter2abc--token ${R}`,
      ["abc123def456"],
    ],
    [
      "#token=secrets:\n  'api_key: secrets:\n  = --password (,secrets:\n  The secret: ",
      `#token=secrets:\n  'api_key: ${R}\n  = --password ${R}\n  The secret: `,
      [],
    ],
  ] as const
) {
  Deno.test(`#5310 round 13 neighbours of the mask: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

// Hostile sizes for the round-13 checks (Issue #3942: exact outputs, no
// stopwatch). The quote look-back, the unclosed-run search and the mask
// through a flag are read once per position in a walk.
Deno.test("#5310 round 13: 64,000 flag-before-lead-in lines are each masked as main masks them", () => {
  const line = "deploy --token 'alpha credentials: DEPLOY_TOKEN = 'tail\n";
  assertEquals(
    redactSecrets(line.repeat(64_000)),
    `deploy --token ${R}tail\n`.repeat(64_000),
  );
});

Deno.test("#5310 round 13: one flag's quoted value over 64,000 lead-in labels keeps main's result", () => {
  const input = "deploy --token 'alpha " +
    "credentials: DEPLOY_TOKEN = abc ".repeat(64_000) + "x: 'tail";
  assertEquals(redactSecrets(input), `deploy --token ${R}tail`);
});

Deno.test("#5310 round 13: 32,000 masked-through lines and a 1 MiB quoted run", () => {
  const line = `secrets:\n  DEPLOY_TOKEN: 'deploy --token '${V}'\n`;
  assertEquals(
    redactSecrets(line.repeat(32_000)),
    `secrets:\n  DEPLOY_TOKEN: ${R}\n`.repeat(32_000),
  );
  assertEquals(
    redactSecrets(
      `secrets:\n  DEPLOY_TOKEN: 'deploy${" ".repeat(1 << 20)}--token '${V}`,
    ),
    `secrets:\n  DEPLOY_TOKEN: ${R}`,
  );
});

Deno.test("#5310 round 13: 64,000 unclosed-quote lines and a 1 MiB unclosed run stay final", () => {
  const lines = `secrets:\n  DEPLOY_TOKEN: 'x --token ${R}\n`.repeat(64_000);
  assertEquals(redactSecrets(lines), lines);
  const run = `secrets:\n  DEPLOY_TOKEN: 'deploy ${
    "x ".repeat(512_000)
  }--token ${R}`;
  assertEquals(redactSecrets(run), run);
});

// PR #5322 review round 14, finding 1. A quote that closes an earlier flag's
// value (`--token 'x --password '`) opens no flag value, so the inner label
// is read again and the issue's own leak stays fixed; a closed quoted inner
// value keeps both quotes when masked, so its opening quote does not count.
for (
  const [input, expected, values] of [
    [
      `deploy --token 'x --password ' then\nRotate these credentials:\nDEPLOY_TOKEN = '${V}'`,
      `deploy --token ${R} then\nRotate these credentials:\nDEPLOY_TOKEN = '${R}'`,
      [V],
    ],
    [
      `deploy --token 'x --password ' then\nThe secret: api_key: '${V}'`,
      `deploy --token ${R} then\nThe secret: api_key: '${R}'`,
      [V],
    ],
    [
      `deploy --token 'x --password ' then\nsecrets:\n  API_TOKEN: '${V}'`,
      `deploy --token ${R} then\nsecrets:\n  API_TOKEN: '${R}'`,
      [V],
    ],
    [
      `deploy --token 'x --password ' then\nsecrets:\n  API_TOKEN: "${V}"`,
      `deploy --token ${R} then\nsecrets:\n  API_TOKEN: "${R}"`,
      [V],
    ],
    [
      "run --password 'a --token ' secrets:\n  credentials: 'abc",
      `run --password ${R} secrets:\n  credentials: ${R}`,
      ["'abc"],
    ],
    [
      `deploy --token 'x credentials: DEPLOY_TOKEN = '${V}'`,
      `deploy --token ${R}${R}'`,
      [V],
    ],
    [
      `deploy --token 'x --password ' then\n${
        "filler line\n".repeat(4_000)
      }Rotate these credentials:\nDEPLOY_TOKEN = '${V}'`,
      `deploy --token ${R} then\n${
        "filler line\n".repeat(4_000)
      }Rotate these credentials:\nDEPLOY_TOKEN = '${R}'`,
      [V],
    ],
  ] as const
) {
  Deno.test(`#5310 round 14 closed flag value before the lead-in: ${JSON.stringify(input.slice(0, 48))}`, () => {
    assertFinal(input, expected, values);
  });
}

// PR #5322 review round 14, finding 2. Where a credential keyword in the
// flag's value keeps main's result, text after the flag's placeholder
// (`;`, `/v1`, `,`, a key) no longer hides it from a second call.
for (
  const [input, expected, values] of [
    [
      "secrets:\n  DEPLOY_TOKEN: 'deploy --token '$API_TOKEN';",
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R};`,
      ["$API_TOKEN"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: 'deploy --token '$API_TOKEN'/v1",
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R}/v1`,
      ["$API_TOKEN"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: 'deploy --token 'my-secret-value',",
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R},`,
      ["my-secret-value"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: 'deploy --password 'my_password_1';",
      `secrets:\n  DEPLOY_TOKEN: 'deploy --password ${R};`,
      ["my_password_1"],
    ],
    [
      "secrets:\n  DEPLOY_TOKEN: 'alpha --token 'token'api_key",
      `secrets:\n  DEPLOY_TOKEN: 'alpha --token ${R}api_key`,
      [],
    ],
    [
      "Rotate these credentials:\nDEPLOY_TOKEN: 'deploy --password 'secret123';",
      `Rotate these credentials:\nDEPLOY_TOKEN: 'deploy --password ${R};`,
      ["secret123"],
    ],
  ] as const
) {
  Deno.test(`#5310 round 14 text after the flag's placeholder: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected, values);
  });
}

Deno.test("#5310 round 14: main's output with text after the flag's placeholder is final", () => {
  for (
    const input of [
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R};`,
      `secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R}/v1`,
      `Rotate these credentials:\nDEPLOY_TOKEN: 'deploy --password ${R};`,
    ]
  ) {
    assertEquals(redactSecrets(input), input);
    assertEquals(containsSecret(input), false);
  }
});

// PR #5322 review round 15, finding 1. Main's decode-then-rescan pass runs
// after its assignment rule, so a value that rule masks on the line after the
// inner value ends the wrapped run at its separator (`API_KEY=`); the pass
// then masks nothing and the inner label is read, so the inner value is
// masked. Each lead-in below published its inner value at the previous head.
for (
  const [input, expected, values] of [
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nAPI_KEY=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nAPI_KEY=${R}`,
      [V],
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\r\nAPI_KEY=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\r\nAPI_KEY=${R}`,
      [V],
    ],
    [
      `credentials: DEPLOY_TOKEN = ${V}\nDB_PASSWORD=abcdefgh1234`,
      `credentials: DEPLOY_TOKEN = ${R}\nDB_PASSWORD=${R}`,
      [V],
    ],
    [
      `The secret: api_key: ${V}\npassword=abcdefgh1234`,
      `The secret: api_key: ${R}\npassword=${R}`,
      [V],
    ],
    [
      `Use this password: DEPLOY_TOKEN = ${V}\ntoken=abcdefgh1234 and more`,
      `Use this password: DEPLOY_TOKEN = ${R}\ntoken=${R} and more`,
      [V],
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nprivate-key=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nprivate-key=${R}`,
      [V],
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nPASSWORD_FILE=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nPASSWORD_FILE=${R}`,
      [V],
    ],
    [
      "Rotate these credentials: DEPLOY_TOKEN = pw42x9z\nAPI_KEY=abcdefgh1234",
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nAPI_KEY=${R}`,
      ["pw42x9z"],
    ],
  ] as const
) {
  Deno.test(`#5310 round 15 assignment on the next line: ${JSON.stringify(input.slice(0, 60))}`, () => {
    assertFinal(input, expected, values);
  });
}

// The same inner value with a next line that main's rule leaves unmasked
// (`API_KEY=`, `API_KEY=true`, `USER=bob`, a blank line then a key, a key on
// the same line, a colon key) is masked as before this round.
for (
  const [input, expected] of [
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nAPI_KEY=`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nAPI_KEY=`,
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nAPI_KEY=true`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nAPI_KEY=true`,
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\nUSER=bob`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\nUSER=bob`,
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\n\nAPI_KEY=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\n\nAPI_KEY=${R}`,
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V} API_KEY=abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R} API_KEY=${R}`,
    ],
    [
      `Rotate these credentials: DEPLOY_TOKEN = ${V}\napi_key: abcdefgh1234`,
      `Rotate these credentials: DEPLOY_TOKEN = ${R}\napi_key: ${R}`,
    ],
  ] as const
) {
  Deno.test(`#5310 round 15 next line main leaves alone: ${JSON.stringify(input.split(V)[1])}`, () => {
    assertFinal(input, expected, [V]);
  });
}

// Where the assignment rule leaves the next line's value for the decode pass
// (a bare run, no key), main's result stands: the pass joins the inner value
// with it and masks the whole run.
Deno.test("#5310 round 15 control: a bare next line keeps main's result", () => {
  assertFinal(
    "Rotate these credentials: DEPLOY_TOKEN = API_TOKEN=\nhunter2zzzz",
    `Rotate these credentials: ${R} = API_TOKEN=\n${R}`,
    ["hunter2zzzz"],
  );
});

// PR #5322 review round 15, finding 2: a chain of flags that each take a
// quote and reach past the last made every candidate rescan the rest of the
// text. 100,001 repeats (3.4 MB) never return when that read is quadratic, as
// in secret_redaction_redos_test.ts; the mask is the one main gives, which
// takes each pair of repeats as one `DEPLOY_TOKEN = ... --token ...` run.
Deno.test("#5310 round 15 hostile: 100,001 chained quoted flags are read linearly", () => {
  const pairs = 50_000;
  const input = "\"DEPLOY_TOKEN = secrets:'x --token ".repeat(2 * pairs + 1);
  const expected = '"' + `DEPLOY_TOKEN = ${R} --token ${R}`.repeat(pairs) +
    `DEPLOY_TOKEN = ${R} --token `;
  const once = redactSecrets(input);
  assertEquals(once === expected, true);
  assertEquals(containsSecret(once), false);
});

// PR #5322 review round 16, finding 1. A wrapped run whose decoded text
// reaches the wrapped-run check again: the loop steps a copy of its regex,
// so the nested walk cannot reset it and `redactSecrets` returns.
Deno.test("#5310 round 16: a decoded run that reaches the wrapped-run check again returns", () => {
  const fixture = btoa(`secrets:\n  DEPLOY_TOKEN: 'deploy --token ${R}`);
  const input = `credentials: DEPLOY_TOKEN = ${fixture.slice(0, 24)}\n${
    fixture.slice(24)
  }`;
  assertFinal(input, `credentials: DEPLOY_TOKEN = ${R}\n${R}`, [
    fixture.slice(0, 24),
    fixture.slice(24),
  ]);
});

Deno.test("#5310 round 16: a decoded run that is itself a label-as-value shape is masked", () => {
  const encoded = btoa(`credentials: DEPLOY_TOKEN = ${V}`);
  const input = `credentials: DEPLOY_TOKEN = ${encoded.slice(0, 24)}\n${
    encoded.slice(24)
  }`;
  assertFinal(input, `credentials: ${R} = ${R}`, [
    encoded.slice(0, 24),
    encoded.slice(24),
  ]);
});

// PR #5322 review round 16, finding 2. Main's decode pass runs after the
// `secret-cli-flag` and `hex32-credential` rules too, so the wrapped run is
// cut at the first value they mask and the inner label is read.
const HEX = "9f86d081884c7d659a2feaa0c55ad015";
for (
  const [index, [input, expected, values]] of ([
    [
      `credentials: DEPLOY_TOKEN = ${V}\nmd5=${HEX}`,
      `credentials: DEPLOY_TOKEN = ${R}\nmd5=${R}`,
      [V, HEX],
    ],
    [
      `Rotate these credentials:\nDEPLOY_TOKEN = ${V}\ntrace_id=${HEX}`,
      `Rotate these credentials:\nDEPLOY_TOKEN = ${R}\ntrace_id=${R}`,
      [V, HEX],
    ],
    [
      `Rotate these credentials:\r\nDEPLOY_TOKEN = ${V}\r\ntrace_id=${HEX}`,
      `Rotate these credentials:\r\nDEPLOY_TOKEN = ${R}\r\ntrace_id=${R}`,
      [V, HEX],
    ],
    [
      `credentials: DEPLOY_TOKEN = ${V}\r\ntrace_id=${HEX}`,
      `credentials: DEPLOY_TOKEN = ${R}\r\ntrace_id=${R}`,
      [V, HEX],
    ],
    [
      `The secret: api_key: ${V}\nsession=${HEX} (expires soon)`,
      `The secret: api_key: ${R}\nsession=${R} (expires soon)`,
      [V, HEX],
    ],
    [
      `credentials: DEPLOY_TOKEN = pw42x9z\nmd5=${HEX}`,
      `credentials: DEPLOY_TOKEN = ${R}\nmd5=${R}`,
      ["pw42x9z", HEX],
    ],
    [
      `credentials: DEPLOY_TOKEN = ${V}\n--password\nUSER=bob`,
      `credentials: DEPLOY_TOKEN = ${R}\n--password\n${R}`,
      [V],
    ],
    [
      `secrets:\n  api_key: ${V}\ntrace_id=${HEX}`,
      `secrets:\n  api_key: ${R}\ntrace_id=${R}`,
      [V, HEX],
    ],
    // Round-15 inputs with the lead-in on its own line, LF and CRLF.
    [
      `Rotate these credentials:\nDEPLOY_TOKEN = ${V}\nAPI_KEY=abcdefgh1234`,
      `Rotate these credentials:\nDEPLOY_TOKEN = ${R}\nAPI_KEY=${R}`,
      [V, "abcdefgh1234"],
    ],
    [
      `Rotate these credentials:\r\nDEPLOY_TOKEN = ${V}\r\nAPI_KEY=abcdefgh1234`,
      `Rotate these credentials:\r\nDEPLOY_TOKEN = ${R}\r\nAPI_KEY=${R}`,
      [V, "abcdefgh1234"],
    ],
  ] as const).entries()
) {
  Deno.test(
    `#5310 round 16 a later rule masks the next line (${index + 1}): ${
      JSON.stringify(input.slice(0, 48))
    }`,
    () => {
      assertFinal(input, expected, values);
    },
  );
}

// Round 16: the run is still cut only where a rule really masks. A
// placeholder already there, a spaced `md5: <hex>` the assignment rule
// masks, and a further plain line all mask the value as before.
for (
  const [index, [input, expected]] of ([
    [
      `credentials: DEPLOY_TOKEN = ${V}\nmd5=${R}`,
      `credentials: DEPLOY_TOKEN = ${R}\nmd5=${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = ${V}\nmd5: ${HEX}`,
      `credentials: DEPLOY_TOKEN = ${R}\nmd5: ${R}`,
    ],
    [
      `credentials: DEPLOY_TOKEN = ${V}\nmd5=${HEX}\nmore`,
      `credentials: DEPLOY_TOKEN = ${R}\nmd5=${R}\nmore`,
    ],
  ] as const).entries()
) {
  Deno.test(
    `#5310 round 16 controls (${index + 1}): ${
      JSON.stringify(input.slice(68))
    }`,
    () => {
      assertFinal(input, expected, [V]);
    },
  );
}

// Round 16: the cut after the inner value reads at most MAX_INNER_PROBES (8)
// credential keys; past that the run is read whole and main's result stands
// (stated in SECURITY.md and under "Not done or not checked").
Deno.test("#5310 round 16: more than 8 credential words after the inner value keep main's result", () => {
  const words = [
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "PYPI_TOKEN",
    "AWS_TOKEN",
    "GCP_TOKEN",
    "AZ_TOKEN",
    "DO_TOKEN",
    "CF_TOKEN",
  ];
  const tail = `\n${words.join("\n")}\nADMIN_TOKEN=abcdefgh1234`;
  const input = `credentials: DEPLOY_TOKEN = ${V}${tail}`;
  assertEquals(
    redactSecrets(input),
    `credentials: ${R} = ${V}\n${words.join("\n")}\nADMIN_TOKEN=${R}`,
  );
  const seven = `credentials: DEPLOY_TOKEN = ${V}\n${
    words.slice(0, 7).join("\n")
  }\nADMIN_TOKEN=abcdefgh1234`;
  assertFinal(
    seven,
    `credentials: DEPLOY_TOKEN = ${R}\n${
      words.slice(0, 7).join("\n")
    }\nADMIN_TOKEN=${R}`,
    [V, "abcdefgh1234"],
  );
});

// Round 16 (the round-15 timing finding's test ask): the three units whose
// flag values run into the next unit, 64,000 repeats each, exact outputs.
// Each flag's double-quoted value takes the following unit, so two input
// units give one output unit (Issue #3942: exact outputs, no stopwatch).
for (
  const [unit, out] of [
    [
      "credentials: api_key: 'x --token \"y ",
      `credentials: ${R} 'x --token ${R}y `,
    ],
    [
      `--token "a secrets:\n  DEPLOY_TOKEN: 'b --password ${R}; `,
      `--token ${R}a secrets:\n  DEPLOY_TOKEN: 'b --password ${R}; `,
    ],
    [
      "credentials: credentials: 'x deploy --token \"",
      `credentials: ${R} 'x deploy --token ${R}`,
    ],
  ] as const
) {
  Deno.test(`#5310 round 16 hostile size: 64,000 × ${JSON.stringify(unit)}`, () => {
    const once = redactSecrets(unit.repeat(64_000));
    assertEquals(once, out.repeat(32_000));
    assertEquals(redactSecrets(once), once);
  });
}

// Round 17: a credential label's value glued to a run the decode pass masks
// with its label (`app.password<base64>`). The walk read that run as the inner
// value; once the decode pass masks it, what stays of the outer value is a
// plain value, so `redactSecrets` walks the assignments once more after that
// pass and the first call's output is final. The expected outputs are
// literals; base is `credentials:app.***REDACTED***: ***REDACTED***`, which a
// second call changed.
const GLUED_RUN = btoa("password=hunter2hunter2hunter2");
for (
  const [input, expected] of [
    [
      `credentials:app.password${GLUED_RUN}: secret:`,
      `credentials:${R} ${R}`,
    ],
    [`password: app.password${GLUED_RUN} = x`, `password: ${R} = ${R}`],
    [`password: hunter2.password${GLUED_RUN} = x`, `password: ${R} = ${R}`],
    [
      `credentials:app.hunter2.password${GLUED_RUN}: api_key`,
      `credentials:${R} ${R}`,
    ],
  ] as const
) {
  Deno.test(
    `#5310 round 17 decode pass masks the glued run: ${
      JSON.stringify(input.slice(0, 40))
    }`,
    () => {
      assertFinal(input, expected, ["app.", "hunter2.", GLUED_RUN]);
    },
  );
}

// Round 17 control: the same text with the run not glued to a label leaves
// the outer value to the walk alone, and the post-decode walk changes
// nothing, so the output is unchanged by it.
Deno.test("#5310 round 17 control: a lone label value is masked as before", () => {
  assertEquals(
    redactSecrets("password: app.hunter2value = x"),
    `password: ${R} = x`,
  );
});

// Round 17: `gh api --input` masks the body, masks the re-serialised text
// again and refuses when that changes it. With the first call's output final,
// the glued-run body is posted masked instead of refused.
Deno.test("#5310 round 17 gh api --input posts a glued-run body masked", () => {
  const { writer, written } = capturingWriter();
  const out = redactGhBodyArgs(
    ["api", "repos/o/r/issues/1/comments", "--input", "/tmp/c.json"],
    readerFor({
      "/tmp/c.json": JSON.stringify({
        body: `password: app.password${GLUED_RUN} = x`,
      }),
    }),
    writer,
  );
  assertEquals(out[2], "--input");
  assertEquals(JSON.parse(written[0] ?? "{}").body, `password: ${R} = ${R}`);
});
