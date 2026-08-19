/**
 * Tests for imgbb_upload.ts — ImgBB screenshot upload client (Issue #1232).
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createImgbbUploadFn, uploadToImgbb } from "../lib/imgbb_upload.ts";

// --- uploadToImgbb ---

Deno.test("imgbb_upload - successful upload returns display URL", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.stringify({
      data: {
        display_url: "https://i.ibb.co/abc123/screenshot.png",
      },
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const result = await uploadToImgbb({
    imageBase64: "aW1hZ2VkYXRh",
    apiKey: "test-api-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://i.ibb.co/abc123/screenshot.png");
  }
});

Deno.test("imgbb_upload - sends correct API key in form data", async () => {
  let capturedBody: FormData | undefined;

  const mockFetch = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as FormData;
    const body = JSON.stringify({
      data: { display_url: "https://i.ibb.co/test/img.png" },
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "my-secret-key",
    fetchFn: mockFetch,
  });

  assertEquals(capturedBody instanceof FormData, true);
  if (capturedBody) {
    assertEquals(capturedBody.get("key"), "my-secret-key");
    assertEquals(capturedBody.get("image"), "dGVzdA==");
  }
});

Deno.test("imgbb_upload - sends custom filename when provided", async () => {
  let capturedBody: FormData | undefined;

  const mockFetch = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as FormData;
    const body = JSON.stringify({
      data: { display_url: "https://i.ibb.co/test/custom.png" },
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "test-key",
    filename: "my-screenshot",
    fetchFn: mockFetch,
  });

  assertEquals(capturedBody instanceof FormData, true);
  if (capturedBody) {
    assertEquals(capturedBody.get("name"), "my-screenshot");
  }
});

Deno.test("imgbb_upload - handles HTTP error response", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(new Response("Unauthorized", { status: 401 }));
  };

  const result = await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "bad-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("401"), true);
  }
});

Deno.test("imgbb_upload - handles API error in JSON response", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.stringify({
      success: false,
      status: 400,
      error: { message: "Invalid image" },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const result = await uploadToImgbb({
    imageBase64: "not-a-real-image",
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("ImgBB API"), true);
  }
});

Deno.test("imgbb_upload - handles missing display_url in response", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.stringify({
      data: {},
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const result = await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("display_url"), true);
  }
});

Deno.test("imgbb_upload - handles network error", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.reject(new Error("Network connection failed"));
  };

  const result = await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("Network connection failed"),
      true,
    );
  }
});

Deno.test("imgbb_upload - handles malformed JSON response", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(new Response("not-json", { status: 200 }));
  };

  const result = await uploadToImgbb({
    imageBase64: "dGVzdA==",
    apiKey: "test-key",
    fetchFn: mockFetch,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("parse"), true);
  }
});

// --- createImgbbUploadFn ---

Deno.test("imgbb_upload - createImgbbUploadFn reads file and uploads", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testImagePath = `${tmpDir}/test-screenshot.png`;
  // Write some fake image data
  await Deno.writeFile(testImagePath, new Uint8Array([137, 80, 78, 71]));

  let capturedBody: FormData | undefined;
  const mockFetch = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as FormData;
    const body = JSON.stringify({
      data: { display_url: "https://i.ibb.co/uploaded/test.png" },
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const uploadFn = createImgbbUploadFn("test-api-key", mockFetch);
  const result = await uploadFn(testImagePath);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "https://i.ibb.co/uploaded/test.png");
  }

  // Verify the base64-encoded data was sent
  assertEquals(capturedBody instanceof FormData, true);
  if (capturedBody) {
    assertEquals(capturedBody.get("key"), "test-api-key");
    // The image data should be base64-encoded
    const imageData = capturedBody.get("image") as string;
    assertEquals(typeof imageData, "string");
    assertEquals(imageData.length > 0, true);
  }

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("imgbb_upload - createImgbbUploadFn handles file not found", async () => {
  const mockFetch = (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  const uploadFn = createImgbbUploadFn("test-api-key", mockFetch);
  const result = await uploadFn("/nonexistent/path/image.png");

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("read"), true);
  }
});

Deno.test("imgbb_upload - createImgbbUploadFn extracts filename for upload", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testImagePath = `${tmpDir}/my-evidence.png`;
  await Deno.writeFile(testImagePath, new Uint8Array([137, 80, 78, 71]));

  let capturedBody: FormData | undefined;
  const mockFetch = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as FormData;
    const body = JSON.stringify({
      data: { display_url: "https://i.ibb.co/test/evidence.png" },
      success: true,
      status: 200,
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  const uploadFn = createImgbbUploadFn("test-api-key", mockFetch);
  await uploadFn(testImagePath);

  assertEquals(capturedBody instanceof FormData, true);
  if (capturedBody) {
    // Filename should be the stem without extension
    assertEquals(capturedBody.get("name"), "my-evidence");
  }

  await Deno.remove(tmpDir, { recursive: true });
});

// --- Issue #3710: bounded outbound fetches ---

Deno.test("imgbb_upload - a hung API aborts on the timeout", async () => {
  const result = await uploadToImgbb({
    imageBase64: "aGVsbG8=",
    apiKey: "test-key",
    timeoutMs: 30,
    fetchFn: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "ImgBB upload failed");
  }
});

Deno.test("imgbb_upload - an oversized API response fails loud", async () => {
  const result = await uploadToImgbb({
    imageBase64: "aGVsbG8=",
    apiKey: "test-key",
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify({ pad: "z".repeat(300 * 1024) }), {
          status: 200,
        }),
      ),
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "exceeded");
  }
});
