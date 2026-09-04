/**
 * The message a call threw, for tests that assert on a refusal's wording.
 *
 * A fail-loud module is judged by what it says, not only by the fact that it
 * threw: the operator acts on the message. Shared so the suites that check
 * one do not each carry their own copy.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Run a call and return the message it threw.
 *
 * @param call - The call under test
 * @returns The thrown message, or `""` when the call did not throw
 */
export async function messageFrom(
  call: () => Promise<unknown>,
): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
