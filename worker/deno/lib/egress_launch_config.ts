/**
 * The egress inputs the host-side launch reads from `.config.json` (Issue
 * #4047).
 *
 * The launcher runs on the host, before the worker has loaded its
 * configuration, so it cannot ask `loadConfig` for the egress allowlist. This
 * module reads the two raw keys the allowlist depends on — `imgbb_api_key` and
 * `egress_allow_hosts` — and hands them to `resolveEgressAllowlist`, so the
 * launcher's proxy and the worker name the same hosts. The derivation itself
 * stays in `egress_allowlist.ts`; this file only reads the file.
 *
 * Fail loud (Issue #3234): an unreadable or unparseable file, or an
 * `imgbb_api_key` of the wrong shape, stops the launch with the file named. An
 * absent key is the default. `egress_allow_hosts` is returned raw, unvalidated,
 * so `resolveEgressAllowlist` checks it and names the entry that is wrong.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** The egress-relevant inputs `.config.json` states. */
export interface ConfiguredEgressInputs {
  /**
   * True when the file's `imgbb_api_key` is a non-empty string. The ImgBB
   * environment variable is a second source and is OR-ed in by the caller, as
   * `lib/config.ts` does.
   */
  imgbbConfigured: boolean;
  /**
   * The raw `egress_allow_hosts` value, or `undefined` when the key is absent.
   * Not validated here: `resolveEgressAllowlist` rejects a non-array or an
   * invalid entry and names it.
   */
  extraHosts: unknown;
}

/**
 * Read the egress inputs out of `.config.json`.
 *
 * @param configFile - Host path of the worker configuration file.
 * @returns Whether ImgBB is configured in the file, and the raw extra hosts.
 * @throws When the file is unreadable or not a JSON object, or
 *   `imgbb_api_key` is present but not a string.
 */
export async function readConfiguredEgressInputs(
  configFile: string,
): Promise<ConfiguredEgressInputs> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    throw new Error(
      `Cannot launch: ${configFile} is unreadable ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot launch: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot launch: ${configFile} does not hold a JSON object.`,
    );
  }

  const file = parsed as Record<string, unknown>;
  const imgbb = file["imgbb_api_key"];
  // `null` reads as absent, exactly as `lib/config.ts` treats it (`?? ""`).
  if (imgbb !== undefined && imgbb !== null && typeof imgbb !== "string") {
    throw new Error(
      `Cannot launch: ${configFile} key "imgbb_api_key" must be a string.`,
    );
  }

  return {
    imgbbConfigured: typeof imgbb === "string" && imgbb.trim() !== "",
    extraHosts: file["egress_allow_hosts"],
  };
}
