// Issue #4392 — the module `deno cache` resolves to pre-warm the image cache.
// It only names the dependencies; nothing here runs.
import "@playwright/mcp";
import "@std/assert";
import "@std/yaml/parse";
import "@std/internal";
