export function updateResource(
  _actor: { tenant: string },
  _resource: { tenant: string; name: string; role: string },
  _patch: { name?: string; role?: string },
) {
  return { ok: false as const, reason: "unauthorised" };
}
