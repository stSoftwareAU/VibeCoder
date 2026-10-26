export function updateResource(
  actor: { tenant: string },
  resource: { tenant: string; name: string; role: string },
  patch: { name?: string; role?: string },
) {
  if (actor.tenant !== resource.tenant) {
    return { ok: false as const, reason: "unauthorised" };
  }
  if (patch.role !== undefined) {
    return { ok: false as const, reason: "forbidden-field" };
  }
  return {
    ok: true as const,
    resource: { ...resource, name: patch.name ?? resource.name },
  };
}
