export function updateResource(
  _actor: { tenant: string },
  resource: { tenant: string; name: string; role: string },
  patch: { name?: string; role?: string },
) {
  return {
    ok: true as const,
    resource: {
      ...resource,
      name: patch.name ?? resource.name,
      role: patch.role ?? resource.role,
    },
  };
}
