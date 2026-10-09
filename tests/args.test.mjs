import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

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
    ["--json", "--wait=false", "--background=true", "--debug=false=extra"],
    {
      booleanOptions: ["json", "wait", "background", "debug"]
    }
  );
  assert.deepEqual(options, {
    json: true,
    wait: false,
    background: true,
    debug: true
  });
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
