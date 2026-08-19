/**
 * ImgBB screenshot upload client (Issue #1232).
 *
 * Provides the HTTP upload implementation for sending screenshots
 * to the ImgBB API. Replaces the shell `upload_screenshot_to_imgbb()`
 * function from the pre-migration `pr_manager.sh`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  discardBody,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";

/**
 * Cap on the ImgBB JSON response (256 KiB — Issue #3710). The document is a
 * few hundred bytes of metadata; anything larger is a broken or hostile API.
 */
const MAX_IMGBB_RESPONSE_BYTES = 256 * 1024;

/**
 * Timeout for an ImgBB upload (60 seconds — Issue #3710). Longer than the
 * shared default because the request carries the screenshot payload.
 */
const IMGBB_TIMEOUT_MS = 2 * DEFAULT_FETCH_TIMEOUT_MS;

/**
 * Encode binary data (Uint8Array) as a base64 string.
 *
 * Uses the built-in `btoa` function after converting bytes to a
 * binary string. This avoids external dependencies.
 */
function encodeBinaryBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** ImgBB API endpoint for image uploads. */
const IMGBB_API_URL = "https://api.imgbb.com/1/upload";

/** Environment variable carrying the ImgBB API key. */
export const IMGBB_API_KEY_ENV = "VIBE_IMGBB_API_KEY";

/**
 * Read the ImgBB API key from the environment (Issue #3707).
 *
 * The key used to arrive as `--imgbb-api-key <key>` on the `pr-manager` /
 * `pr-completion-phase` command lines, where any local user could read it out
 * of `ps`. `load_config` already exports the configured key as
 * {@link IMGBB_API_KEY_ENV}, so the commands read it from there instead and
 * the secret never appears in argv.
 *
 * @param env - Environment reader (injectable for testing).
 * @returns The trimmed key, or an empty string when it is unset or blank.
 */
export function readImgbbApiKeyFromEnv(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  return (env(IMGBB_API_KEY_ENV) ?? "").trim();
}

/** Options for uploading an image to ImgBB. */
export interface ImgbbUploadOptions {
  /** Base64-encoded image data */
  imageBase64: string;
  /** ImgBB API key */
  apiKey: string;
  /** Optional filename (without extension) for the uploaded image */
  filename?: string;
  /** Injectable fetch function (defaults to global fetch) */
  fetchFn?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * Hard timeout for the upload, in milliseconds (Issue #3710). Defaults to
   * 60 seconds so a hung ImgBB cannot wedge the worker.
   */
  timeoutMs?: number;
}

/**
 * Expected shape of the ImgBB API response.
 *
 * Only the fields we use are typed here; the actual response
 * contains additional metadata we do not need.
 */
interface ImgbbApiResponse {
  data?: {
    display_url?: string;
  };
  success?: boolean;
  status?: number;
  error?: {
    message?: string;
  };
}

/**
 * Upload a base64-encoded image to ImgBB.
 *
 * Sends a multipart form data POST to the ImgBB API and returns
 * the display URL on success.
 *
 * @param options - Upload options including image data and API key
 * @returns Result with the display URL on success, or an Error on failure
 */
export async function uploadToImgbb(
  options: ImgbbUploadOptions,
): Promise<Result<string, Error>> {
  const {
    imageBase64,
    apiKey,
    filename,
    fetchFn = globalThis.fetch,
    timeoutMs = IMGBB_TIMEOUT_MS,
  } = options;

  const formData = new FormData();
  formData.append("key", apiKey);
  formData.append("image", imageBase64);
  if (filename) {
    formData.append("name", filename);
  }

  let response: Response;
  try {
    response = await fetchFn(
      IMGBB_API_URL,
      withRequestTimeout({ method: "POST", body: formData }, timeoutMs),
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `ImgBB upload failed: ${describeFetchFailure(error, timeoutMs)}`,
      ),
    };
  }

  if (!response.ok) {
    await discardBody(response);
    return {
      ok: false,
      error: new Error(
        `ImgBB upload failed with HTTP ${response.status}: ${response.statusText}`,
      ),
    };
  }

  const bodyResult = await readTextBounded(response, MAX_IMGBB_RESPONSE_BYTES);
  if (!bodyResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to read ImgBB API response: ${bodyResult.error}`,
      ),
    };
  }

  let json: ImgbbApiResponse;
  try {
    json = JSON.parse(bodyResult.value) as ImgbbApiResponse;
  } catch {
    return {
      ok: false,
      error: new Error("Failed to parse ImgBB API response as JSON"),
    };
  }

  if (!json.success) {
    const apiMessage = json.error?.message ?? "unknown error";
    return {
      ok: false,
      error: new Error(`ImgBB API returned failure: ${apiMessage}`),
    };
  }

  const displayUrl = json.data?.display_url;
  if (!displayUrl) {
    return {
      ok: false,
      error: new Error("ImgBB API response missing display_url"),
    };
  }

  return { ok: true, value: displayUrl };
}

/**
 * Create an upload function compatible with `ProcessEvidenceOptions.uploadFn`.
 *
 * Reads a screenshot file from disk, base64-encodes it, and uploads
 * to ImgBB. Returns the display URL on success. This is the concrete
 * implementation that bridges the injectable `uploadFn` callback in
 * `processScreenshotEvidence()` with the ImgBB HTTP client.
 *
 * @param apiKey - ImgBB API key
 * @param fetchFn - Optional injectable fetch function (for testing)
 * @returns A function that accepts a file path and returns a Result with the upload URL
 */
export function createImgbbUploadFn(
  apiKey: string,
  fetchFn?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): (path: string) => Promise<Result<string, Error>> {
  return async (filePath: string): Promise<Result<string, Error>> => {
    let fileData: Uint8Array;
    try {
      fileData = await Deno.readFile(filePath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: new Error(`Failed to read screenshot file: ${message}`),
      };
    }

    const imageBase64 = encodeBinaryBase64(fileData);

    // Extract filename stem (without extension) for the upload name
    const fullName = filePath.split("/").pop() ?? "screenshot";
    const dotIndex = fullName.lastIndexOf(".");
    const filename = dotIndex > 0 ? fullName.substring(0, dotIndex) : fullName;

    return uploadToImgbb({
      imageBase64,
      apiKey,
      filename,
      fetchFn,
    });
  };
}
