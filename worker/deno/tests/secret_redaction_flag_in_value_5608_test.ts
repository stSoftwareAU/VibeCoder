// Issue #5608: a credential flag's name ending an outer label's value is left to secret-cli-flag.
import { assertEquals } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

const V = "q7Lm2Xv9Rk4Tz8Pw1Hn6Bc3Df5Gj0Ys2Ua7Ne4Mi";
const R = REDACTION_PLACEHOLDER;

function assertFinal(input: string, expected: string): void {
  const once = redactSecrets(input);
  assertEquals(once, expected);
  assertEquals(redactSecrets(once), once);
  assertEquals(containsSecret(once), false);
  assertEquals(containsSecret(input), true);
  assertEquals(once.includes(V), false, `${V} published: ${once}`);
}

const CASES: [string, string][] = [
  [`password: token=--token ${V}`, `password: ${R}--token ${R}`],
  [`password:\ntoken=--token ${V}`, `password:\ntoken=--token ${R}`],
  [
    `credentials: DEPLOY_TOKEN=--api-token ${V}`,
    `credentials: ${R}--api-token ${R}`,
  ],
  [
    `credentials:\nDEPLOY_TOKEN=--api-token ${V}`,
    `credentials:\n${R}--api-token ${R}`,
  ],
  [`password: token:--token ${V}`, `password: ${R}--token ${R}`],
  [`password=token=--token ${V}`, `password=${R}--token ${R}`],
  [
    `password: secret=password=--password ${V}`,
    `password: ${R}--password ${R}`,
  ],
  [`password: abc--token ${V}`, `password: ${R}--token ${R}`],
  [`password:\ttoken=--token\t${V}`, `password:\t${R}--token\t${R}`],
  [`API_KEY: token=--api-key ${V}`, `API_KEY: ${R}--api-key ${R}`],
  // A flag whose value is an unclosed quote running into a second flag name is
  // not cut, so the outer value keeps its mask, as a #5310 round 13 fixture
  // pins.
  [
    `password: token=--token "tail'--api-key ${V}`,
    `password: ${R} "tail'--api-key ${R}`,
  ],
  [
    `password: token=abc123--api-key "tail'--api-key ${V}`,
    `password: ${R} "tail'--api-key ${R}`,
  ],
  // Control: no outer label, so the flag name is left as before.
  [`token=--token ${V}`, `token=--token ${R}`],
];

for (const [input, expected] of CASES) {
  Deno.test(`#5608: ${JSON.stringify(input.slice(0, 52))}`, () => {
    assertFinal(input, expected);
  });
}

Deno.test(
  "#5608: a flag name with no value after it is still masked as the label's value",
  () => {
    const cases: [string, string][] = [
      [`password: token=--token`, `password: ${R}`],
      [`password: token=--token --verbose`, `password: ${R} --verbose`],
      [`password: token=--token = ${V}`, `password: ${R} = ${R}`],
      [`password: token=--verbose hello`, `password: ${R} hello`],
    ];
    for (const [input, expected] of cases) {
      const once = redactSecrets(input);
      assertEquals(once, expected);
      assertEquals(redactSecrets(once), once);
    }
  },
);

Deno.test(
  "#5608 hostile sizes: long flag-name runs inside the outer value stay bounded",
  () => {
    const a = redactSecrets(`password: token=${"--token".repeat(20000)} ${V}`);
    assertEquals(a.includes(V), false);
    assertEquals(a.startsWith(`password: ${R}--token`), true);
    assertEquals(a.endsWith(`--token ${R}`), true);
    assertEquals(redactSecrets(a), a);

    const b = redactSecrets(`password: x=${"-".repeat(50000)}token ${V}`);
    assertEquals(b.includes(V), false);
    assertEquals(b.endsWith(`token ${R}`), true);
    assertEquals(b.startsWith(`password: ${R}-`), true);
    assertEquals(redactSecrets(b), b);
  },
);
