/**
 * Short model aliases the plugin expands before a value reaches Codex.
 *
 * Kept in its own module so tests can read the real map instead of parsing it back
 * out of `codex-companion.mjs`, which executes its CLI entry point on import.
 */
export const MODEL_ALIASES = new Map([
  ["spark", "gpt-5.3-codex-spark"],
  ["sol", "gpt-6-sol"],
  ["luna", "gpt-6-luna"],
  ["astra", "gpt-6-astra"]
]);

/**
 * Resolve a requested model to what Codex should receive: an alias is expanded,
 * anything else is passed through as typed, and a blank value means "unset".
 *
 * @param {string|null|undefined} model
 * @returns {string|null}
 */
export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}
