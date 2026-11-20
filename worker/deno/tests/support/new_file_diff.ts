/** Unified-diff builders for the dummy-test scan tests (Issue #5236). */

/** A diff that adds `path` with `body` as its whole content. */
export function added(path: string, body: string): string {
  const lines = body.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n") + "\n";
}
