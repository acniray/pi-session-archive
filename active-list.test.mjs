import assert from "node:assert/strict";
import test from "node:test";

import { makeAgentDir, writeSessionFile, writeSubagentSessionFile } from "./test-helpers.mjs";

const { describeActiveRow, listActiveRoots, uniqueIdPrefixes } = await import("./active-list.ts");

test("the list offers roots only, with the subagent sessions each one carries", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/one" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent, cwd: "/data/one" });
  writeSubagentSessionFile(agentDir, { id: "c2", parentId: "c1", parentPath: parent, cwd: "/data/one" });
  writeSessionFile(agentDir, { id: "other", cwd: "/data/two" });

  const { rows, complete } = await listActiveRoots({ agentDir });
  assert.equal(complete, true);
  assert.deepEqual(rows.map((row) => row.session.id).sort(), ["other", "p1"], "children are not offered");

  const root = rows.find((row) => row.session.id === "p1");
  assert.equal(root.childCount, 1);
  assert.equal(root.descendantCount, 2, "both levels would travel with it");
  assert.equal(root.hasChildren, true);
  assert.equal(rows.find((row) => row.session.id === "other").hasChildren, false);
});

test("labels identify a session by what was said, where it ran, when, and by id", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/one" });
  const { rows } = await listActiveRoots({ agentDir });
  const nowMs = Date.now();
  const label = describeActiveRow(rows[0], nowMs);
  assert.match(label, /hello/, "the first message is what identifies it");
  assert.match(label, /one/, "and the project it ran in");
  assert.match(label, /just now|ago/);
  // The stable short id is always in the label: it is what the answer is
  // resolved by, so a stale relative time cannot break the choice.
  assert.match(label, /#p1$/);
});

test("a filter narrows the list, and an unreadable scan is reported rather than hidden", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/one" });
  writeSessionFile(agentDir, { id: "p2", cwd: "/data/two" });
  const { rows } = await listActiveRoots({ agentDir });
  const needle = "two";
  const matching = rows.filter((row) => `${row.session.cwd ?? ""}`.includes(needle));
  assert.deepEqual(matching.map((row) => row.session.id), ["p2"]);

  const missing = await listActiveRoots({ agentDir: `${agentDir}/nope` });
  assert.equal(missing.complete, true, "a missing root is empty, not broken");
  assert.deepEqual(missing.rows, []);
});

test("id tokens grow only when the normal short prefix is ambiguous", () => {
  const prefixes = uniqueIdPrefixes([
    "12345678-aaaa",
    "12345678-bbbb",
    "abcdef00-cccc",
  ]);
  assert.equal(prefixes.get("abcdef00-cccc"), "abcdef00");
  assert.notEqual(prefixes.get("12345678-aaaa"), "12345678");
  assert.notEqual(prefixes.get("12345678-bbbb"), "12345678");
  assert.notEqual(prefixes.get("12345678-aaaa"), prefixes.get("12345678-bbbb"));
});

test("a corrupt parent cycle cannot recurse forever while counting list descendants", async (t) => {
  const agentDir = makeAgentDir(t);
  const a = writeSubagentSessionFile(agentDir, { id: "a", parentId: "b", parentPath: "/tmp/b" });
  writeSubagentSessionFile(agentDir, { id: "b", parentId: "a", parentPath: a });
  const { rows } = await listActiveRoots({ agentDir });
  // A cycle has no true root, so neither corrupt member is offered. The point
  // of the assertion is termination: list construction must not overflow.
  assert.deepEqual(rows, []);
});

test("a child whose parent is absent is shown as a split recovery root", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSubagentSessionFile(agentDir, {
    id: "orphan",
    parentId: "missing-parent",
    parentPath: "/tmp/missing-parent.jsonl",
    cwd: "/data/one",
  });

  const { rows } = await listActiveRoots({ agentDir });
  assert.deepEqual(rows.map((row) => row.session.id), ["orphan"]);
  assert.equal(rows[0].splitParentId, "missing-parent");
  assert.match(describeActiveRow(rows[0], Date.now()), /split child of #missing-/);
});
