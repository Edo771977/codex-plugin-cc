import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

const REVIEW_CONFIG = {
  valueOptions: ["base", "scope", "model", "effort", "cwd"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: { m: "model" }
};

test("parseArgs reports an unrecognised long option instead of silently demoting it", () => {
  const { options, positionals, unknownOptions } = parseArgs(
    ["--model", "gpt-6-astra", "--nonsense", "value"],
    { valueOptions: ["model"], booleanOptions: [] }
  );

  assert.equal(options.model, "gpt-6-astra");
  // Behaviour is unchanged: the token still reaches positionals, because some
  // commands take free-form text after their flags.
  assert.deepEqual(positionals, ["--nonsense", "value"]);
  // But it is now reported, so a caller can warn rather than swallow it.
  assert.deepEqual(unknownOptions, ["--nonsense"]);
});

test("parseArgs reports nothing when every option is recognised", () => {
  const { unknownOptions } = parseArgs(["--model", "gpt-6-astra", "--json"], {
    valueOptions: ["model"],
    booleanOptions: ["json"]
  });

  assert.deepEqual(unknownOptions, []);
});

test("parseArgs does not treat text after -- as an unrecognised option", () => {
  const { positionals, unknownOptions } = parseArgs(["--", "--not-a-flag"], {
    valueOptions: [],
    booleanOptions: []
  });

  assert.deepEqual(positionals, ["--not-a-flag"]);
  assert.deepEqual(unknownOptions, []);
});

test("review commands accept --effort rather than folding it into the focus text", () => {
  const { options, positionals, unknownOptions } = parseArgs(
    ["--model", "gpt-6-astra", "--effort", "xhigh", "focus", "on", "auth"],
    REVIEW_CONFIG
  );

  assert.equal(options.model, "gpt-6-astra");
  assert.equal(options.effort, "xhigh");
  assert.deepEqual(unknownOptions, []);
  // The regression this guards: --effort and xhigh used to land here and be
  // joined into the prompt the reviewer was given.
  assert.deepEqual(positionals, ["focus", "on", "auth"]);
  assert.equal(positionals.join(" "), "focus on auth");
});

test("splitRawArgumentString keeps a quoted focus phrase together", () => {
  assert.deepEqual(
    splitRawArgumentString('--model gpt-6-astra --effort xhigh "the auth path"'),
    ["--model", "gpt-6-astra", "--effort", "xhigh", "the auth path"]
  );
});

// Imported from upstream PR #808. The fork already split at the first "=" (one parser rule
// since 3d6c7d9); these pin that behaviour so a later rewrite cannot regress it.

test("inline --key=value preserves every subsequent equals sign", () => {
  const { options, positionals } = parseArgs(
    ["review", "--base=feature=x=y", "--model=gpt-6=custom", "--cwd=/tmp/folder=one"],
    { valueOptions: ["base", "model", "cwd"] }
  );

  assert.deepEqual(options, {
    base: "feature=x=y",
    model: "gpt-6=custom",
    cwd: "/tmp/folder=one"
  });
  assert.deepEqual(positionals, ["review"]);
});

test("inline options accept a value consisting only of equals signs", () => {
  const { options } = parseArgs(
    ["--base==", "--model===foo"],
    { valueOptions: ["base", "model"] }
  );
  assert.deepEqual(options, { base: "=", model: "==foo" });
});

test("inline empty value stays empty and does not consume a following token", () => {
  const { options, positionals } = parseArgs(
    ["--base=", "not-the-value"],
    { valueOptions: ["base"] }
  );
  assert.deepEqual(options, { base: "" });
  assert.deepEqual(positionals, ["not-the-value"]);
});

test("unknown inline option is passed through verbatim", () => {
  const { options, positionals } = parseArgs(
    ["--unknown=foo=bar", "next"],
    { valueOptions: ["base"] }
  );
  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--unknown=foo=bar", "next"]);
});

test("named and aliased --key=value options preserve equals signs", () => {
  const result = parseArgs(
    ["--b=release=x", "--base", "a=b"],
    {
      valueOptions: ["base"],
      aliasMap: { b: "base" }
    }
  );
  assert.deepEqual(result.options, { base: "a=b" });
  assert.deepEqual(result.positionals, []);
});

test("boolean inline options retain their existing parsing behavior", () => {
  const { options } = parseArgs(
    ["--json", "--wait=false", "--background=true"],
    {
      booleanOptions: ["json", "wait", "background"]
    }
  );
  assert.deepEqual(options, {
    json: true,
    wait: false,
    background: true
  });
  // Upstream reads "false=extra" as true; the fork rejects anything but true/false, so a value
  // with a stray "=" is an error rather than a silent flip.
  assert.throws(
    () => parseArgs(["--debug=false=extra"], { booleanOptions: ["debug"] }),
    /Invalid value for --debug: expected true or false/
  );
});

test("bare value option still consumes the following token", () => {
  const result = parseArgs(
    ["--base", "feature=x=y", "--", "--model=left=right"],
    { valueOptions: ["base", "model"] }
  );
  assert.deepEqual(result.options, { base: "feature=x=y" });
  assert.deepEqual(result.positionals, ["--model=left=right"]);
});

test("a missing value still raises a useful error", () => {
  assert.throws(
    () => parseArgs(["--base"], { valueOptions: ["base"] }),
    /Missing value for --base/
  );
});

test("raw string splitting does not drop equals signs before parseArgs", () => {
  const args = splitRawArgumentString('--base="feature=x=y" --model=test=extra');
  const parsed = parseArgs(args, { valueOptions: ["base", "model"] });
  assert.deepEqual(parsed.options, { base: "feature=x=y", model: "test=extra" });
});
