/**
 * Tests for `lib/ci_fix_attempt_markers.ts` (Issue #1877, parent #1861).
 *
 * The CI-fix lane records its attempts and deferrals as PR comment markers,
 * so every host in the fleet reads the same tally off the PR itself rather
 * than from its own `.ci_check_state` volume. These tests cover the two
 * things that makes safe: the markers round-trip through build and parse,
 * and a marker anybody outside the fleet wrote is never counted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildCiFixAttemptMarker,
  buildCiFixDeferralMarker,
  CI_FIX_ATTEMPT_MARKER_NAME,
  CI_FIX_DEFERRAL_MARKER_NAME,
  type CiFixMarkerComment,
  collectFleetCiFixMarkers,
  countAttempts,
  findDeferral,
  findNoChangeComment,
  parseCiFixAttemptMarkers,
  parseCiFixDeferralMarkers,
} from "../lib/ci_fix_attempt_markers.ts";

const SIGNATURE = "0123456789abcdef";
const HEAD = "a".repeat(40);
const FLEET = ["stservice", "VibeCoderST"];

function comment(
  overrides: Partial<CiFixMarkerComment> = {},
): CiFixMarkerComment {
  return {
    id: 1,
    author: "stservice",
    createdAt: "2026-09-10T01:02:03Z",
    body: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Build / parse round-trip
// ---------------------------------------------------------------------------

Deno.test("ci_fix_attempt_markers - an attempt marker round-trips", () => {
  const marker = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "Project Validation",
    head: HEAD,
    attempt: 2,
    outcome: "pushed",
  });

  assertEquals(parseCiFixAttemptMarkers(marker), [{
    signature: SIGNATURE,
    checkName: "Project Validation",
    head: HEAD,
    attempt: 2,
    outcome: "pushed",
  }]);
});

Deno.test("ci_fix_attempt_markers - a deferral marker round-trips", () => {
  const marker = buildCiFixDeferralMarker({
    signature: SIGNATURE,
    checkName: "Project Validation",
    dependsOn: "stSoftwareAU/NEAT-AI-Backpropagation#149",
  });

  assertEquals(parseCiFixDeferralMarkers(marker), [{
    signature: SIGNATURE,
    checkName: "Project Validation",
    dependsOn: "stSoftwareAU/NEAT-AI-Backpropagation#149",
  }]);
});

Deno.test("ci_fix_attempt_markers - both emitted markers are canonical", () => {
  // The shape `marker_grammar_test.ts` calls canonical, applied to what the
  // builders actually emit: a bare `vibe-` prefix, no colon payload, and
  // `key="value"` attributes throughout.
  const emitted = [
    buildCiFixAttemptMarker({
      signature: SIGNATURE,
      checkName: "build",
      head: HEAD,
      attempt: 1,
      outcome: "pushed",
    }),
    buildCiFixDeferralMarker({
      signature: SIGNATURE,
      checkName: "build",
      dependsOn: "owner/repo#7",
    }),
  ];

  for (const marker of emitted) {
    const match = /^<!-- (vibe-[A-Za-z0-9:_-]+)((?: [a-z-]+="[^"]*")+) -->$/
      .exec(marker);
    assert(match !== null, `not a canonical marker: ${marker}`);
    const name = match![1]!;
    assert(/^vibe-[a-z0-9-]+$/.test(name), `${name} deviates from the grammar`);
    assert(!name.endsWith(":"), `${name} carries a colon payload`);
  }
});

Deno.test("ci_fix_attempt_markers - a suffixed or re-cased marker name is a different marker", () => {
  const attributes =
    `signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="1" outcome="pushed"`;

  assertEquals(
    parseCiFixAttemptMarkers(
      `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME}-v2 ${attributes} -->`,
    ),
    [],
  );
  assertEquals(
    parseCiFixAttemptMarkers(
      `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME.toUpperCase()} ${attributes} -->`,
    ),
    [],
  );
});

Deno.test("ci_fix_attempt_markers - two markers in one comment both parse", () => {
  const body = [
    "No change required for Project Validation.",
    buildCiFixAttemptMarker({
      signature: SIGNATURE,
      checkName: "build",
      head: HEAD,
      attempt: 1,
      outcome: "no-change",
    }),
    buildCiFixAttemptMarker({
      signature: "beefbeefbeefbeef",
      checkName: "lint",
      head: HEAD,
      attempt: 3,
      outcome: "pushed",
    }),
  ].join("\n");

  const parsed = parseCiFixAttemptMarkers(body);
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0]?.checkName, "build");
  assertEquals(parsed[1]?.attempt, 3);
});

// ---------------------------------------------------------------------------
// Validation — build fails loud, parse discards
// ---------------------------------------------------------------------------

Deno.test("ci_fix_attempt_markers - building with an invalid field fails loud", () => {
  assertThrows(
    () =>
      buildCiFixAttemptMarker({
        signature: "not-a-signature",
        checkName: "build",
        head: HEAD,
        attempt: 1,
        outcome: "pushed",
      }),
    Error,
    "signature",
  );
  assertThrows(
    () =>
      buildCiFixAttemptMarker({
        signature: SIGNATURE,
        checkName: "build",
        head: "cafe",
        attempt: 1,
        outcome: "pushed",
      }),
    Error,
    "head",
  );
  assertThrows(
    () =>
      buildCiFixAttemptMarker({
        signature: SIGNATURE,
        checkName: "build",
        head: HEAD,
        attempt: 0,
        outcome: "pushed",
      }),
    Error,
    "attempt",
  );
  assertThrows(
    () =>
      buildCiFixDeferralMarker({
        signature: SIGNATURE,
        checkName: "build",
        dependsOn: "not a ref",
      }),
    Error,
    "depends-on",
  );
  assertThrows(
    () =>
      buildCiFixAttemptMarker({
        signature: SIGNATURE,
        checkName: "   ",
        head: HEAD,
        attempt: 1,
        outcome: "pushed",
      }),
    Error,
    "check",
  );
});

Deno.test("ci_fix_attempt_markers - a hostile check name cannot break out of the comment", () => {
  const marker = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    // Every breakout the attribute has to survive: the comment terminator,
    // a quote that would end the value, and an injected tag. Spelled with a
    // benign tag name so the fixture is not itself a SAST finding.
    checkName: 'build --> " <img src=x onerror=y>',
    head: HEAD,
    attempt: 1,
    outcome: "pushed",
  });

  // Exactly one HTML comment, and nothing escapes it.
  assertEquals(marker.split("-->").length, 2);
  assert(!marker.includes("<img"));
  // The quote closed no attribute: the five the marker declares are all there.
  assertEquals(marker.split('="').length - 1, 5);
  const parsed = parseCiFixAttemptMarkers(marker);
  assertEquals(parsed.length, 1);
  assert(!parsed[0]!.checkName.includes(">"));
  assert(!parsed[0]!.checkName.includes('"'));
});

Deno.test("ci_fix_attempt_markers - malformed markers are ignored", () => {
  const bodies = [
    // Bad signature alphabet.
    `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="zzzz" check="build" head="${HEAD}" attempt="1" outcome="pushed" -->`,
    // Head is not a 40-character SHA.
    `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="abc" attempt="1" outcome="pushed" -->`,
    // Unknown outcome.
    `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="1" outcome="deleted-the-repo" -->`,
    // Attempt is not a positive integer.
    `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="-2" outcome="pushed" -->`,
    // Partial — no outcome at all.
    `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="1" -->`,
  ];
  for (const body of bodies) {
    assertEquals(parseCiFixAttemptMarkers(body), [], body);
  }

  assertEquals(
    parseCiFixDeferralMarkers(
      `<!-- ${CI_FIX_DEFERRAL_MARKER_NAME} signature="${SIGNATURE}" check="build" depends-on="../../etc#1" -->`,
    ),
    [],
  );
  assertEquals(
    parseCiFixDeferralMarkers(
      `<!-- ${CI_FIX_DEFERRAL_MARKER_NAME} signature="${SIGNATURE}" check="build" -->`,
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// Fleet-author verification
// ---------------------------------------------------------------------------

Deno.test("ci_fix_attempt_markers - a marker outside the fleet is never counted", () => {
  const body = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "build",
    head: HEAD,
    attempt: 1,
    outcome: "pushed",
  });
  const collected = collectFleetCiFixMarkers(
    [
      comment({ id: 7, author: "drive-by-contributor", body }),
      comment({ id: 8, author: "stservice", body }),
    ],
    FLEET,
  );

  assertEquals(countAttempts(collected, SIGNATURE), 1);
  assertEquals(
    collected.attempts.get(SIGNATURE)?.map((a) => a.commentId),
    [8],
  );
});

Deno.test("ci_fix_attempt_markers - an author differing only in case is still the fleet", () => {
  const body = buildCiFixDeferralMarker({
    signature: SIGNATURE,
    checkName: "build",
    dependsOn: "owner/repo#7",
  });
  const collected = collectFleetCiFixMarkers(
    [comment({ id: 3, author: "VIBECODERST", body })],
    FLEET,
  );

  assertEquals(findDeferral(collected, SIGNATURE)?.dependsOn, "owner/repo#7");
});

Deno.test("ci_fix_attempt_markers - an unresolved fleet set counts nothing, loudly", () => {
  const body = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "build",
    head: HEAD,
    attempt: 1,
    outcome: "pushed",
  });
  const logged: string[] = [];
  const collected = collectFleetCiFixMarkers(
    [comment({ id: 4, author: "stservice", body })],
    [],
    (message) => logged.push(message),
  );

  assertEquals(countAttempts(collected, SIGNATURE), 0);
  assertEquals(collected.attempts.size, 0);
  // The zero is not mistaken for "no attempt has been made".
  assertEquals(collected.fleetResolved, false);
  assertEquals(logged.length, 1);
  assert(logged[0]!.includes("fleet author set unresolved"));
});

Deno.test("ci_fix_attempt_markers - discarded outside-fleet markers are reported", () => {
  const body = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "build",
    head: HEAD,
    attempt: 1,
    outcome: "pushed",
  });
  const logged: string[] = [];
  const collected = collectFleetCiFixMarkers(
    [
      comment({ id: 5, author: "drive-by-contributor", body }),
      comment({ id: 6, author: "another-stranger", body }),
      comment({ id: 7, author: "passer-by", body: "no marker here" }),
    ],
    FLEET,
    (message) => logged.push(message),
  );

  assertEquals(collected.fleetResolved, true);
  assertEquals(collected.ignoredOutsideFleet, 2);
  assertEquals(logged.length, 1);
  assert(logged[0]!.includes("ignored 2 CI-fix marker"));
});

Deno.test("ci_fix_attempt_markers - an empty comment list yields zero", () => {
  const logged: string[] = [];
  const collected = collectFleetCiFixMarkers(
    [],
    FLEET,
    (message) => logged.push(message),
  );

  assertEquals(logged, []);
  assertEquals(collected.fleetResolved, true);
  assertEquals(collected.attempts.size, 0);
  assertEquals(collected.deferrals.size, 0);
  assertEquals(countAttempts(collected, SIGNATURE), 0);
  assertEquals(findNoChangeComment(collected, SIGNATURE), undefined);
  assertEquals(findDeferral(collected, SIGNATURE), undefined);
});

// ---------------------------------------------------------------------------
// Grouping, context and the helpers
// ---------------------------------------------------------------------------

Deno.test("ci_fix_attempt_markers - markers are grouped by signature", () => {
  const other = "beefbeefbeefbeef";
  const collected = collectFleetCiFixMarkers(
    [
      comment({
        id: 1,
        body: buildCiFixAttemptMarker({
          signature: SIGNATURE,
          checkName: "build",
          head: HEAD,
          attempt: 1,
          outcome: "pushed",
        }),
      }),
      comment({
        id: 2,
        body: buildCiFixAttemptMarker({
          signature: other,
          checkName: "lint",
          head: HEAD,
          attempt: 1,
          outcome: "pushed",
        }),
      }),
      comment({
        id: 3,
        body: buildCiFixAttemptMarker({
          signature: SIGNATURE,
          checkName: "build",
          head: HEAD,
          attempt: 2,
          outcome: "no-change",
        }),
      }),
    ],
    FLEET,
  );

  assertEquals(countAttempts(collected, SIGNATURE), 2);
  assertEquals(countAttempts(collected, other), 1);
  assertEquals(countAttempts(collected, "0000000000000000"), 0);
  assertEquals(findNoChangeComment(collected, SIGNATURE)?.commentId, 3);
  assertEquals(findNoChangeComment(collected, other), undefined);
});

Deno.test("ci_fix_attempt_markers - the first non-marker line becomes the diagnosis", () => {
  const collected = collectFleetCiFixMarkers(
    [
      comment({
        id: 11,
        createdAt: "2026-09-01T00:00:00Z",
        body: [
          "",
          `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="1" outcome="no-change" -->`,
          "   ",
          "No change required — the base branch is red for the same reason.",
          "Second line, ignored.",
        ].join("\n"),
      }),
    ],
    FLEET,
  );

  const record = findNoChangeComment(collected, SIGNATURE);
  assertEquals(
    record?.diagnosed,
    "No change required — the base branch is red for the same reason.",
  );
  assertEquals(record?.createdAt, "2026-09-01T00:00:00Z");
  assertEquals(record?.commentId, 11);
});

Deno.test("ci_fix_attempt_markers - marker text never leaks into the diagnosis", () => {
  const attempt = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "build",
    head: HEAD,
    attempt: 1,
    outcome: "no-change",
  });
  const collected = collectFleetCiFixMarkers(
    [
      // Trailing the sentence rather than on its own line.
      comment({
        id: 40,
        body: `Base branch is red for the same reason. ${attempt}`,
      }),
      // Wrapped across lines — which the parser accepts.
      comment({
        id: 41,
        body: attempt.replace(` head="`, `\n     head="`) +
          "\nSecond diagnosis, wrapped marker above.",
      }),
    ],
    FLEET,
  );

  assertEquals(
    collected.attempts.get(SIGNATURE)?.map((record) => record.diagnosed),
    [
      "Base branch is red for the same reason.",
      "Second diagnosis, wrapped marker above.",
    ],
  );
});

Deno.test("ci_fix_attempt_markers - an over-long check name is truncated whole", () => {
  const marker = buildCiFixAttemptMarker({
    signature: SIGNATURE,
    checkName: "x".repeat(119) + "\u{1F600}build",
    head: HEAD,
    attempt: 1,
    outcome: "pushed",
  });
  const checkName = parseCiFixAttemptMarkers(marker)[0]!.checkName;

  assertEquals(checkName, "x".repeat(119));
  // No half of a surrogate pair survived the cut.
  assertEquals(checkName, [...checkName].join(""));
});

Deno.test("ci_fix_attempt_markers - an attempt beyond the cap is refused both ways", () => {
  assertThrows(
    () =>
      buildCiFixAttemptMarker({
        signature: SIGNATURE,
        checkName: "build",
        head: HEAD,
        attempt: 1000,
        outcome: "pushed",
      }),
    Error,
    "attempt",
  );
  assertEquals(
    parseCiFixAttemptMarkers(
      `<!-- ${CI_FIX_ATTEMPT_MARKER_NAME} signature="${SIGNATURE}" check="build" head="${HEAD}" attempt="1000" outcome="pushed" -->`,
    ),
    [],
  );
});

Deno.test("ci_fix_attempt_markers - a body that is only markers has an empty diagnosis", () => {
  const collected = collectFleetCiFixMarkers(
    [
      comment({
        id: 12,
        body: buildCiFixDeferralMarker({
          signature: SIGNATURE,
          checkName: "build",
          dependsOn: "owner/repo#9",
        }),
      }),
    ],
    FLEET,
  );

  assertEquals(findDeferral(collected, SIGNATURE)?.diagnosed, "");
});

Deno.test("ci_fix_attempt_markers - the earliest deferral wins", () => {
  const collected = collectFleetCiFixMarkers(
    [
      comment({
        id: 20,
        body: buildCiFixDeferralMarker({
          signature: SIGNATURE,
          checkName: "build",
          dependsOn: "owner/repo#1",
        }),
      }),
      comment({
        id: 21,
        body: buildCiFixDeferralMarker({
          signature: SIGNATURE,
          checkName: "build",
          dependsOn: "owner/repo#2",
        }),
      }),
    ],
    FLEET,
  );

  assertEquals(findDeferral(collected, SIGNATURE)?.commentId, 20);
  assertEquals(collected.deferrals.get(SIGNATURE)?.length, 2);
});

Deno.test("ci_fix_attempt_markers - a comment with no body or author is skipped", () => {
  const collected = collectFleetCiFixMarkers(
    [
      { id: 30, author: null, createdAt: null, body: null },
      { id: 31, author: "stservice", createdAt: null, body: null },
    ],
    FLEET,
  );

  assertEquals(collected.attempts.size, 0);
  assertEquals(collected.deferrals.size, 0);
});
