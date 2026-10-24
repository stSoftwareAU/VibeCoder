/**
 * Test helper: whether a needle sits inside a genuine untrusted-content fence
 * (Issue #4234). This is the single copy, used by
 * `worker/deno/tests/summary_rule_gate_retry_test.ts` and
 * `worker/deno/tests/summary_rule_gate_retry_4234_test.ts`, so the recovery-turn
 * tests assert fencing against one definition instead of a pasted copy.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Whether `needle` sits inside a genuine `BOUNDARY_<id>` fence: the last
 * BEGIN marker before it has no END marker between it and `needle`, and some
 * END marker follows `needle`.
 */
export function insideFence(
  prompt: string,
  needle: string,
  id: string,
): boolean {
  const needleIndex = prompt.indexOf(needle);
  if (needleIndex < 0) return false;
  const begin = `---BEGIN UNTRUSTED USER CONTENT BOUNDARY_${id}---`;
  const end = `---END UNTRUSTED USER CONTENT BOUNDARY_${id}---`;
  const lastBegin = prompt.lastIndexOf(begin, needleIndex);
  if (lastBegin < 0) return false;
  const endAfterBegin = prompt.indexOf(end, lastBegin);
  return endAfterBegin > needleIndex;
}
