/**
 * Canonical JSON serialization — BTreeMap-equivalent key sorting for deterministic hashing.
 *
 * Implementation follows ADR 02 P0-D corrected form:
 * - sortedValue() returns a JS value tree (NOT a string)
 * - canonicalJson() calls JSON.stringify exactly ONCE on the fully-sorted tree
 *
 * WARNING: Do NOT map canonicalJson over arrays — that causes double-encoding (Pitfall 1).
 * @see docs/ADR_v4.md §ADR 02
 */

/**
 * Recursively sort object keys at every depth.
 * Arrays are preserved as-is (elements are individually sorted if they are objects).
 * Primitives are returned unchanged.
 */
function sortedValue(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(sortedValue);
  }
  if (payload !== null && typeof payload === 'object') {
    return Object.fromEntries(
      Object.keys(payload as object)
        .sort()
        .map((k) => [k, sortedValue((payload as Record<string, unknown>)[k])])
    );
  }
  return payload;
}

/**
 * Serialize payload to a deterministic JSON string with sorted keys at every depth.
 * JSON.stringify is called exactly once on the fully-sorted value tree.
 */
export function canonicalJson(payload: unknown): string {
  return JSON.stringify(sortedValue(payload));
}

/**
 * Produce the canonical JSON string for hash input by stripping _meta and schema_version
 * before serializing. Both fields are application metadata — not part of the hashable domain.
 *
 * @see CONTEXT.md §Version Hash — "hashable domain = payload minus _meta minus schema_version"
 */
export function hashablePayload(payload: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _meta, schema_version, ...rest } = payload;
  return canonicalJson(rest);
}
