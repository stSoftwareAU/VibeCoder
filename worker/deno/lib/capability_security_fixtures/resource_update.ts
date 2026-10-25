/**
 * Behavioural fixture for resource and tenant authorisation (Issue #4365).
 *
 * The entry point is `updateResource`. Authorisation and the writable-field
 * allowlist run there. A caller that skips this function does not get the
 * control.
 */

export interface Actor {
  tenant: string;
}

export interface Resource {
  tenant: string;
  name: string;
  role: string;
}

export interface ResourcePatch {
  name?: string;
  role?: string;
}

export type ResourceUpdate =
  | { ok: true; resource: Resource }
  | { ok: false; reason: "unauthorised" | "forbidden-field" };

const WRITABLE_FIELDS = new Set<keyof ResourcePatch>(["name"]);

/**
 * Update a resource for `actor`. A different tenant is rejected. A field
 * outside {@link WRITABLE_FIELDS} is rejected. An authorised name change
 * succeeds.
 */
export function updateResource(
  actor: Actor,
  resource: Resource,
  patch: ResourcePatch,
): ResourceUpdate {
  if (actor.tenant !== resource.tenant) {
    return { ok: false, reason: "unauthorised" };
  }
  for (const field of Object.keys(patch) as (keyof ResourcePatch)[]) {
    if (patch[field] !== undefined && !WRITABLE_FIELDS.has(field)) {
      return { ok: false, reason: "forbidden-field" };
    }
  }
  return {
    ok: true,
    resource: {
      ...resource,
      name: patch.name ?? resource.name,
    },
  };
}
