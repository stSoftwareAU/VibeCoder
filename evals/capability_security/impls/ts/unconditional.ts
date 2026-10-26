export function updateResource(
  _actor: { tenant: string },
  resource: { tenant: string; name: string; role: string },
  _patch: { name?: string; role?: string },
) {
  return { ok: true as const, resource };
}
