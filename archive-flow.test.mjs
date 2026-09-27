import assert from "node:assert/strict";
import test from "node:test";

const { resolveArchivedTarget } = await import("./archive-flow.ts");

const row = (id, firstMessage) => ({ session: { id, firstMessage }, archivedAt: undefined, cwd: undefined });
const rows = [row("01a0aaa", "fix the auth flow"), row("01a0bbb", "fix the auth bug"), row("01a0ccc", "unrelated")];

test("an exact id resolves", () => {
  assert.equal(resolveArchivedTarget(rows, "01a0aaa").row?.session.id, "01a0aaa");
});

test("a duplicated exact id is refused instead of choosing the first archived file", () => {
  const duplicated = [row("same-id", "one"), row("same-id", "two")];
  const result = resolveArchivedTarget(duplicated, "same-id");
  assert.equal(result.ok, false);
  assert.match(result.message, /claimed by 2 archived files/);
  assert.equal(result.row, undefined);
});

test("a short id prefix resolves, with or without the # the rows show", () => {
  assert.equal(resolveArchivedTarget(rows, "01a0aaa").row?.session.id, "01a0aaa");
  assert.equal(resolveArchivedTarget(rows, "#01a0bbb").row?.session.id, "01a0bbb");
});

test("a unique text match resolves", () => {
  assert.equal(resolveArchivedTarget(rows, "unrelated").row?.session.id, "01a0ccc");
});

test("an ambiguous text match is refused and names the candidates", () => {
  const result = resolveArchivedTarget(rows, "fix the auth");
  assert.equal(result.ok, false);
  assert.match(result.message, /matches 2 sessions/);
  assert.match(result.message, /#01a0aaa/);
  assert.equal(result.row, undefined, "and never guesses");
});

test("an ambiguous short id prefix is refused instead of picking the first row", () => {
  const result = resolveArchivedTarget(rows, "#01a0");
  assert.equal(result.ok, false);
  assert.match(result.message, /matches 3 session ids/);
  assert.equal(result.row, undefined);
});

test("an unknown target is refused", () => {
  assert.equal(resolveArchivedTarget(rows, "nothing like this").ok, false);
  assert.equal(resolveArchivedTarget(rows, "  ").ok, false);
});
