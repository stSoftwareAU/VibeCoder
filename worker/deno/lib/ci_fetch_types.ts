/**
 * Vendor-neutral fetch seam for the CI-log extension point (Issue #986).
 *
 * This type used to be defined by one vendor's client module, which meant
 * the generic extension point — `ci_log_provider.ts` — could not compile
 * without that vendor present. An integration core cannot build without is
 * not a plugin; it is part of the plugin system, and that is how a single
 * deployment's tooling became structural here.
 *
 * Core owns the seam. A provider — the built-in default, or one supplied by
 * a private extension (`docs/PRIVATE-EXTENSIONS.md`) — owns everything
 * behind it, and core learns nothing about what that is.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

/**
 * Injectable `fetch`, so a provider's HTTP calls can be replaced in tests
 * without touching the network. Structurally identical to `globalThis.fetch`.
 */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
