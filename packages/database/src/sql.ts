/**
 * Helpers for passing arrays through both `pg` and PGlite.
 *
 * Both drivers serialise a JS `[]` inconsistently (pg emits `{}`, PGlite may leave the type
 * unknown and Postgres then errors with "could not determine data type of parameter"), so
 * status filters are always sent as an explicit Postgres array literal.
 */
export function pgTextArray(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return '{}';
  const escaped = values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}
