import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { collectReviewContext, readRegularFileNoFollow, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const [mode, options] of [["inline", {}], ["lightweight", { maxInlineFiles: 0 }]]) {
  test(`branch review keeps one commit snapshot when HEAD and base change during ${mode} collection`, (t) => {
    const cwd = makeTempDir();
    const git = (args) => {
      const result = run("git", args, { cwd, shell: false });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    initGitRepo(cwd);
    fs.writeFileSync(path.join(cwd, "base.js"), "export const base = true;\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    git(["checkout", "-b", "feature/reviewed"]);
    fs.writeFileSync(path.join(cwd, "reviewed.js"), "export const value = 'REVIEWED_CHANGE';\n");
    git(["add", "."]);
    git(["commit", "-m", "reviewed change"]);
    const reviewedHead = git(["rev-parse", "HEAD"]);
    git(["checkout", "-b", "feature/other"]);
    fs.writeFileSync(path.join(cwd, "reviewed.js"), "export const value = 'OTHER_BRANCH_CONTEXT';\n");
    fs.writeFileSync(path.join(cwd, "other.js"), "export const value = 'OTHER_BRANCH_CHANGE';\n");
    git(["add", "."]);
    git(["commit", "-m", "other branch change"]);
    git(["checkout", "feature/reviewed"]);

    const spawnSync = childProcess.spawnSync;
    let switched = false;
    t.mock.method(childProcess, "spawnSync", (command, args, commandOptions) => {
      const result = spawnSync(command, args, commandOptions);
      // This fork runs git as `git -c core.quotePath=false <args>` (#817); look past that prefix.
      const gitArgs = args[0] === "-c" ? args.slice(2) : args;
      if (!switched && command === "git" && gitArgs[0] === "diff" && gitArgs[1] === "--name-only") {
        switched = true;
        const checkout = spawnSync("git", ["checkout", "feature/other"], {
          cwd, encoding: "utf8", shell: false, windowsHide: true
        });
        assert.equal(checkout.status, 0, checkout.stderr);
        const updateBase = spawnSync("git", ["update-ref", "refs/heads/main", "HEAD"], {
          cwd, encoding: "utf8", shell: false, windowsHide: true
        });
        assert.equal(updateBase.status, 0, updateBase.stderr);
      }
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const context = collectReviewContext(cwd, { mode: "branch", baseRef: "main" }, options);

    assert.equal(switched, true);
    assert.equal(git(["branch", "--show-current"]), "feature/other");
    assert.deepEqual(context.changedFiles, ["reviewed.js"]);
    assert.equal(git(["diff", "--name-only", context.comparison.reviewRange]), "reviewed.js");
    assert.equal(context.branch, "feature/reviewed");
    assert.match(context.summary, /Reviewing branch feature\/reviewed /);
    assert.doesNotMatch(context.content, /other branch change|other\.js|OTHER_BRANCH_CHANGE|OTHER_BRANCH_CONTEXT/);
    assert.match(fs.readFileSync(path.join(cwd, "reviewed.js"), "utf8"), /OTHER_BRANCH_CONTEXT/);
    assert.ok(context.collectionGuidance.includes(context.comparison.commitRange));
    assert.ok(context.collectionGuidance.includes(`git show ${reviewedHead}:<path>`));
    assert.equal(context.comparison.headCommit, reviewedHead);
    assert.match(git(["show", `${context.comparison.headCommit}:reviewed.js`]), /REVIEWED_CHANGE/);
    assert.doesNotMatch(git(["show", `${context.comparison.headCommit}:reviewed.js`]), /OTHER_BRANCH_CONTEXT/);
    if (mode === "inline") {
      assert.match(context.content, /REVIEWED_CHANGE/);
    }
  });
}

test("branch review peels annotated base tags to commit snapshots", () => {
  const cwd = makeTempDir();
  const git = (args) => {
    const result = run("git", args, { cwd, shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  git(["tag", "-a", "review-base", "-m", "annotated base"]);
  const tagObject = git(["rev-parse", "review-base"]);
  assert.notEqual(tagObject, baseCommit);
  assert.equal(git(["cat-file", "-t", tagObject]), "tag");
  git(["checkout", "-b", "feature/reviewed"]);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('reviewed');\n");
  git(["add", "."]);
  git(["commit", "-m", "reviewed change"]);
  const headCommit = git(["rev-parse", "HEAD"]);

  const context = collectReviewContext(cwd, { mode: "branch", baseRef: "review-base" }, { maxInlineFiles: 0 });

  assert.equal(context.comparison.reviewRange, `${baseCommit}...${headCommit}`);
  assert.equal(context.comparison.commitRange, `${baseCommit}..${headCommit}`);
  assert.equal(git(["cat-file", "-t", context.comparison.reviewRange.split("...")[0]]), "commit");
  assert.equal(git(["diff", "--name-only", context.comparison.reviewRange]), "app.js");
});

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", (t) => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  try {
    fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Windows requires Developer Mode or elevated privileges to create this symlink fixture.");
      return;
    }
    throw error;
  }

  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd }).stdout;
  if (!untracked.split(/\r?\n/).includes("broken-link")) {
    t.skip("Git does not report broken symlinks as untracked in this environment.");
    return;
  }

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link\n\(skipped: symlink\)/);
});

test("collectReviewContext never inlines the target of an untracked symlink", { skip: process.platform === "win32" }, () => {
  const root = makeTempDir();
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(root, "outside.txt"), "OUTSIDE_SECRET_MARKER\n");
  fs.symlinkSync(path.join("..", "outside.txt"), path.join(cwd, "notes.txt"));
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});
  // The lightweight path (includeDiff: false) still inlines untracked files.
  for (const options of [{ includeDiff: true }, { includeDiff: false }]) {
    const context = collectReviewContext(cwd, target, options);
    assert.match(context.content, /### notes\.txt\n\(skipped: symlink\)/);
    assert.doesNotMatch(context.content, /OUTSIDE_SECRET_MARKER/);
  }
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("collectReviewContext keeps the first status column and non-ASCII file names", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "one\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "two\n");
  fs.writeFileSync(path.join(cwd, "café.js"), "const café = 1;\n");

  const context = collectReviewContext(cwd, { mode: "working-tree", label: "working tree diff" });

  // The index column of the first entry is blank; trimming the section used to drop it.
  assert.match(context.content, /## Git Status\n\n M a\.js\n\?\? café\.js\n/);
  assert.ok(context.changedFiles.includes("café.js"), JSON.stringify(context.changedFiles));
  assert.match(context.content, /const café = 1;/);
});

test("readRegularFileNoFollow refuses a symlink by itself, without the lstat in front of it", { skip: process.platform === "win32" }, () => {
  // formatUntrackedFile checks with lstat first, but the file can be swapped for a symlink between
  // that check and the read, so the read must refuse the link on its own.
  const dir = makeTempDir();
  const outside = path.join(makeTempDir(), "secret.txt");
  fs.writeFileSync(outside, "secret contents\n");
  const target = path.join(dir, "notes.txt");
  fs.symlinkSync(outside, target);

  assert.deepEqual(readRegularFileNoFollow(target, 1024, dir), { skipped: "symlink" });

  fs.unlinkSync(target);
  fs.writeFileSync(target, "plain\n");
  assert.equal(String(readRegularFileNoFollow(target, 1024, dir).buffer), "plain\n");
  assert.deepEqual(readRegularFileNoFollow(target, 2, dir), { skipped: "6 bytes exceeds 2 byte limit" });
  assert.deepEqual(readRegularFileNoFollow(dir, 1024, dir), { skipped: "not a regular file" });
  assert.deepEqual(readRegularFileNoFollow(path.join(dir, "missing"), 1024, dir), { skipped: "unreadable file" });
});

test("readRegularFileNoFollow refuses a file reached through a directory swapped for a symlink", { skip: process.platform === "win32" }, () => {
  // O_NOFOLLOW only covers the last component: git listed realdir/f.txt, then realdir became a
  // link to a directory outside the repository.
  const repo = makeTempDir();
  const outsideDir = makeTempDir();
  fs.writeFileSync(path.join(outsideDir, "f.txt"), "PARENT_SECRET\n");
  fs.symlinkSync(outsideDir, path.join(repo, "realdir"));

  assert.deepEqual(readRegularFileNoFollow(path.join(repo, "realdir", "f.txt"), 1024, repo), {
    skipped: "outside the repository"
  });
});

test("readRegularFileNoFollow does not hang on a FIFO", { skip: process.platform === "win32" }, () => {
  const dir = makeTempDir();
  const fifo = path.join(dir, "pipe");
  if (run("mkfifo", [fifo]).status !== 0) {
    return;
  }
  // Without O_NONBLOCK the open blocks until a writer appears, and it blocks this whole process
  // with it, so no in-process timeout could ever fire. Run it in a child that can be timed out.
  const gitModule = path.join(REPO_ROOT, "plugins", "codex", "scripts", "lib", "git.mjs");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { readRegularFileNoFollow } = await import(${JSON.stringify(pathToFileURL(gitModule).href)});` +
        `process.stdout.write(JSON.stringify(readRegularFileNoFollow(${JSON.stringify(fifo)}, 1024, ${JSON.stringify(dir)})));`
    ],
    { encoding: "utf8", timeout: 5000 }
  );
  assert.equal(child.error?.code, undefined, "the read must not block on a FIFO");
  assert.deepEqual(JSON.parse(child.stdout), { skipped: "not a regular file" });
});

test("collectReviewContext refuses an untracked file whose directory is swapped for a symlink before it is read", { skip: process.platform === "win32" }, (t) => {
  const root = makeTempDir();
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.mkdirSync(path.join(cwd, "realdir"));
  fs.writeFileSync(path.join(cwd, "realdir", "f.txt"), "inside\n");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "f.txt"), "PARENT_SECRET_MARKER\n");

  // git has listed realdir/f.txt; swap the directory for a link just as the file is checked. lstat
  // only declines to follow the last component, so it still sees a regular file.
  const lstatSync = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, "lstatSync", (file, ...rest) => {
    if (!swapped && String(file) === path.join(cwd, "realdir", "f.txt")) {
      swapped = true;
      fs.rmSync(path.join(cwd, "realdir"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(cwd, "realdir"));
    }
    return lstatSync(file, ...rest);
  });

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { includeDiff: true });
  assert.equal(swapped, true);
  assert.match(context.content, /### realdir\/f\.txt\n\(skipped: outside the repository\)/);
  assert.doesNotMatch(context.content, /PARENT_SECRET_MARKER/);
});

test("readRegularFileNoFollow never reads past the limit when the file grows after the size check", (t) => {
  const dir = makeTempDir();
  const file = path.join(dir, "growing.txt");
  fs.writeFileSync(file, "x".repeat(100));
  // The size check saw a small file; by the time it is read, it is larger than the limit.
  const fstatSync = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd, ...rest) => ({ ...fstatSync(fd, ...rest), isFile: () => true, size: 4 }));

  assert.deepEqual(readRegularFileNoFollow(file, 10, dir), { skipped: "grew past the 10 byte limit while being read" });
});
