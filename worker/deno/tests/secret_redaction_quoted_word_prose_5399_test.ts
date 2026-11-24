/**
 * Prose that quotes a credential word before a colon has the next word masked
 * (Issue #5399). This is an accepted false positive, kept on purpose because
 * the shape cannot be told apart from a YAML or JSON field with a bare value,
 * and a missed credential costs more than a corrupted word in a title. These
 * tests pin the mask so the choice is visible; see the secret-assignment
 * section of SECURITY.md.
 */

import { assertEquals } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

Deno.test("Issue #5399 - a quoted credential word and a colon in a title masks the next word", () => {
  const input =
    `Secret redaction masks ordinary prose after a word containing "Token": PR #5251's title reads wrongly`;
  assertEquals(
    redactSecrets(input),
    `Secret redaction masks ordinary prose after a word containing "Token": ${REDACTION_PLACEHOLDER} #5251's title reads wrongly`,
  );
  assertEquals(containsSecret(input), true);
});

Deno.test("Issue #5399 - a quoted plural credential word before a colon is masked the same way", () => {
  const plural = `The word "Tokens": counts are shown below`;
  assertEquals(
    redactSecrets(plural),
    `The word "Tokens": ${REDACTION_PLACEHOLDER} are shown below`,
  );
  assertEquals(containsSecret(plural), true);

  assertEquals(
    redactSecrets(`'Token': prose follows here`),
    `'Token': ${REDACTION_PLACEHOLDER} follows here`,
  );
});

Deno.test("Issue #5399 - the quoted shape matches a JSON or YAML field with a bare value", () => {
  assertEquals(
    redactSecrets(`"Token": hunter2value`),
    `"Token": ${REDACTION_PLACEHOLDER}`,
  );
});

Deno.test("Issue #5399 - quoting a product heading's key removes its prose exemption", () => {
  const bare = `TokenBudget: run the agreed trial`;
  assertEquals(redactSecrets(bare), bare);
  assertEquals(containsSecret(bare), false);

  assertEquals(
    redactSecrets(`"TokenBudget": run the agreed trial`),
    `"TokenBudget": ${REDACTION_PLACEHOLDER} the agreed trial`,
  );
});
