import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("parseArgs keeps everything after the first = as an inline value", () => {
  const { options } = parseArgs(["--prompt-file=notes=v2.txt", "--model=my-model"], { valueOptions: ["prompt-file", "model"] });
  assert.deepEqual(options, { "prompt-file": "notes=v2.txt", model: "my-model" });
});

test("apostrophes in ordinary text stay literal and do not swallow later flags", () => {
  assert.deepEqual(splitRawArgumentString("fix the user's bug --model flash"), ["fix", "the", "user's", "bug", "--model", "flash"]);
  assert.deepEqual(splitRawArgumentString("look at the users' sessions"), ["look", "at", "the", "users'", "sessions"]);
  assert.deepEqual(splitRawArgumentString("'tis an unclosed quote"), ["'tis", "an", "unclosed", "quote"]);
  assert.deepEqual(splitRawArgumentString("it's \"done\" now"), ["it's", "done", "now"]);
});

test("quotes group words when they open a token or follow =", () => {
  assert.deepEqual(splitRawArgumentString('say "hello world" twice'), ["say", "hello world", "twice"]);
  assert.deepEqual(splitRawArgumentString("--base main 'quoted focus text' rest"), ["--base", "main", "quoted focus text", "rest"]);
  assert.deepEqual(splitRawArgumentString('--prompt-file="my notes.txt" go'), ["--prompt-file=my notes.txt", "go"]);
  assert.deepEqual(splitRawArgumentString('empty "" arg'), ["empty", "", "arg"]);
});

test("backslashes only escape quotes, spaces, and backslashes", () => {
  assert.deepEqual(splitRawArgumentString("regex like \\d+ and C:\\repo\\x"), ["regex", "like", "\\d+", "and", "C:\\repo\\x"]);
  assert.deepEqual(splitRawArgumentString('escaped \\"quote\\" here'), ["escaped", '"quote"', "here"]);
  assert.deepEqual(splitRawArgumentString("two\\ words"), ["two words"]);
});

test("whitespace is collapsed and empty input gives no tokens", () => {
  assert.deepEqual(splitRawArgumentString("  spaced   out  "), ["spaced", "out"]);
  assert.deepEqual(splitRawArgumentString(""), []);
  assert.deepEqual(splitRawArgumentString(null), []);
});
