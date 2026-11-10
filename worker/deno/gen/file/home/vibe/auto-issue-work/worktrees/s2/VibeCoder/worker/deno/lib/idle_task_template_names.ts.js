/**
 * Canonical idle-task template names (Issue #4011).
 *
 * `idle_task_backfill.ts` already derives the same set from its wrapper-title
 * map, but that module pulls in the whole `gh` stack — far too heavy for config
 * load, where a cycle through `config_defaults.ts` breaks module initialisation.
 * This module is therefore deliberately **import-free**: anything that only
 * needs to know "is this a real template name?" — such as the `.config.json`
 * cadence parser — depends on this instead.
 *
 * `tests/idle_task_template_names_test.ts` pins this list against
 * `IDLE_TASK_WRAPPER_TEMPLATE_NAMES`, so the two cannot drift apart: adding a
 * template without extending this set fails that test.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ /** Every registered idle-task template name, in registration order. */ export const IDLE_TASK_TEMPLATE_NAMES = new Set([
  "security-scan",
  "test-audit",
  "best-practices",
  "github-actions-audit",
  "supply-chain-readiness",
  "orphan-deps",
  "dead-code",
  "doc-coverage",
  "format-drift",
  "deprecated-api",
  "bash-script-refs",
  "bash-syntax-audit",
  "documentation-audit",
  "alert-feed",
  "workflow-annotation-scan",
  "private-repo-reference-audit",
  "duplicated-knowledge",
  "retro",
  "gate-skip-drift",
  "ponytail-debt"
]);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pZGxlX3Rhc2tfdGVtcGxhdGVfbmFtZXMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDYW5vbmljYWwgaWRsZS10YXNrIHRlbXBsYXRlIG5hbWVzIChJc3N1ZSAjNDAxMSkuXG4gKlxuICogYGlkbGVfdGFza19iYWNrZmlsbC50c2AgYWxyZWFkeSBkZXJpdmVzIHRoZSBzYW1lIHNldCBmcm9tIGl0cyB3cmFwcGVyLXRpdGxlXG4gKiBtYXAsIGJ1dCB0aGF0IG1vZHVsZSBwdWxscyBpbiB0aGUgd2hvbGUgYGdoYCBzdGFjayDigJQgZmFyIHRvbyBoZWF2eSBmb3IgY29uZmlnXG4gKiBsb2FkLCB3aGVyZSBhIGN5Y2xlIHRocm91Z2ggYGNvbmZpZ19kZWZhdWx0cy50c2AgYnJlYWtzIG1vZHVsZSBpbml0aWFsaXNhdGlvbi5cbiAqIFRoaXMgbW9kdWxlIGlzIHRoZXJlZm9yZSBkZWxpYmVyYXRlbHkgKippbXBvcnQtZnJlZSoqOiBhbnl0aGluZyB0aGF0IG9ubHlcbiAqIG5lZWRzIHRvIGtub3cgXCJpcyB0aGlzIGEgcmVhbCB0ZW1wbGF0ZSBuYW1lP1wiIOKAlCBzdWNoIGFzIHRoZSBgLmNvbmZpZy5qc29uYFxuICogY2FkZW5jZSBwYXJzZXIg4oCUIGRlcGVuZHMgb24gdGhpcyBpbnN0ZWFkLlxuICpcbiAqIGB0ZXN0cy9pZGxlX3Rhc2tfdGVtcGxhdGVfbmFtZXNfdGVzdC50c2AgcGlucyB0aGlzIGxpc3QgYWdhaW5zdFxuICogYElETEVfVEFTS19XUkFQUEVSX1RFTVBMQVRFX05BTUVTYCwgc28gdGhlIHR3byBjYW5ub3QgZHJpZnQgYXBhcnQ6IGFkZGluZyBhXG4gKiB0ZW1wbGF0ZSB3aXRob3V0IGV4dGVuZGluZyB0aGlzIHNldCBmYWlscyB0aGF0IHRlc3QuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbi8qKiBFdmVyeSByZWdpc3RlcmVkIGlkbGUtdGFzayB0ZW1wbGF0ZSBuYW1lLCBpbiByZWdpc3RyYXRpb24gb3JkZXIuICovXG5leHBvcnQgY29uc3QgSURMRV9UQVNLX1RFTVBMQVRFX05BTUVTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwic2VjdXJpdHktc2NhblwiLFxuICBcInRlc3QtYXVkaXRcIixcbiAgXCJiZXN0LXByYWN0aWNlc1wiLFxuICBcImdpdGh1Yi1hY3Rpb25zLWF1ZGl0XCIsXG4gIFwic3VwcGx5LWNoYWluLXJlYWRpbmVzc1wiLFxuICBcIm9ycGhhbi1kZXBzXCIsXG4gIFwiZGVhZC1jb2RlXCIsXG4gIFwiZG9jLWNvdmVyYWdlXCIsXG4gIFwiZm9ybWF0LWRyaWZ0XCIsXG4gIFwiZGVwcmVjYXRlZC1hcGlcIixcbiAgXCJiYXNoLXNjcmlwdC1yZWZzXCIsXG4gIFwiYmFzaC1zeW50YXgtYXVkaXRcIixcbiAgXCJkb2N1bWVudGF0aW9uLWF1ZGl0XCIsXG4gIFwiYWxlcnQtZmVlZFwiLFxuICBcIndvcmtmbG93LWFubm90YXRpb24tc2NhblwiLFxuICBcInByaXZhdGUtcmVwby1yZWZlcmVuY2UtYXVkaXRcIixcbiAgXCJkdXBsaWNhdGVkLWtub3dsZWRnZVwiLFxuICBcInJldHJvXCIsXG4gIFwiZ2F0ZS1za2lwLWRyaWZ0XCIsXG4gIFwicG9ueXRhaWwtZGVidFwiLFxuXSk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBRUQscUVBQXFFLEdBQ3JFLE9BQU8sTUFBTSwyQkFBZ0QsSUFBSSxJQUFJO0VBQ25FO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRCxFQUFFIn0=
// denoCacheMetadata=13553013942727387025,15120511189088682136