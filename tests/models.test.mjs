import test from "node:test";
import assert from "node:assert/strict";

import { MODEL_ALIASES, normalizeRequestedModel } from "../plugins/codex/scripts/lib/models.mjs";

test("every alias expands to its full slug", () => {
  assert.deepEqual(
    [...MODEL_ALIASES.entries()],
    [
      ["spark", "gpt-5.3-codex-spark"],
      ["sol", "gpt-6-sol"],
      ["luna", "gpt-6-luna"],
      ["astra", "gpt-6-astra"]
    ]
  );
  for (const [alias, slug] of MODEL_ALIASES) {
    assert.equal(normalizeRequestedModel(alias), slug);
  }
});

test("alias lookup ignores casing and surrounding whitespace", () => {
  assert.equal(normalizeRequestedModel("Astra"), "gpt-6-astra");
  assert.equal(normalizeRequestedModel("SPARK"), "gpt-5.3-codex-spark");
  assert.equal(normalizeRequestedModel("  sol  "), "gpt-6-sol");
});

test("expanding an alias is idempotent", () => {
  // A slug that is itself an alias key would expand twice and land somewhere else.
  for (const [, slug] of MODEL_ALIASES) {
    assert.equal(normalizeRequestedModel(slug), slug, `${slug} must not be an alias key`);
    assert.equal(normalizeRequestedModel(normalizeRequestedModel(slug)), slug);
  }
});

test("anything that is not an alias reaches Codex as typed", () => {
  assert.equal(normalizeRequestedModel("gpt-6-sol"), "gpt-6-sol");
  assert.equal(normalizeRequestedModel("gpt-5.4-mini"), "gpt-5.4-mini");
  // Casing is only normalized for the alias lookup: a slug is passed through untouched,
  // because the plugin keeps no list of valid models and a custom provider may be case-sensitive.
  assert.equal(normalizeRequestedModel("GPT-6-Astra"), "GPT-6-Astra");
  assert.equal(normalizeRequestedModel("  my-local-model "), "my-local-model");
});

test("a missing or blank model means unset rather than an empty string", () => {
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel(undefined), null);
  assert.equal(normalizeRequestedModel(""), null);
  assert.equal(normalizeRequestedModel("   "), null);
});
