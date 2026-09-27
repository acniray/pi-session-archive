import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, projectDirFor, writeSessionFile, writeSubagentSessionFile } from "./test-helpers.mjs";

const { reconcileArchive, summarizeDiagnostics } = await import("./reconcile.ts");
const { archiveSessionTree } = await import("./migrate.ts");
const { archiveRoot, sessionsRoot } = await import("./paths.ts");

const NOW = () => Date.parse("2026-09-24T12:00:00.000Z");
const name = (id) => `2026-09-24T10-00-00-000Z_${id}.jsonl`;

test("a clean archive reports nothing", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  await archiveSessionTree("p1", { agentDir, now: NOW });

  const report = await reconcileArchive({ agentDir });
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.complete, true);
  assert.equal(summarizeDiagnostics(report), "Archive looks consistent.");
});

test("an active file whose id is also archived is reported as a split", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "p1" });
  await archiveSessionTree("p1", { agentDir, now: NOW });
  // A writer recreated the old path, as pi's append-by-path would.
  fs.copyFileSync(path.join(archiveRoot(agentDir), name("p1")), file);

  const report = await reconcileArchive({ agentDir });
  const split = report.diagnostics.find((diagnostic) => diagnostic.kind === "split-session");
  assert.ok(split, "the split must be reported");
  assert.deepEqual(split.sessionIds, ["p1"]);
  assert.match(split.message, /appended to the old path after it was moved/);
  // Nothing was merged or moved as a side effect of looking.
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), name("p1"))), true);
  assert.equal(fs.existsSync(file), true);
});

test("a headerless fragment is reported even though pi skips it", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  // What a split write leaves behind: a bare entry, no session header.
  const fragment = path.join(projectDirFor(agentDir, "/data/proj"), name("frag"));
  fs.writeFileSync(fragment, `${JSON.stringify({ type: "message", id: "e9", parentId: "e8" })}\n`);

  const report = await reconcileArchive({ agentDir });
  const found = report.diagnostics.find((diagnostic) => diagnostic.kind === "unclassified-fragment");
  assert.ok(found, "pi's own scan filters this out, so we must look for it ourselves");
  assert.deepEqual(found.paths, [fragment]);
  // Reported, yes - and still not a reason to refuse every archive: we read this
  // file, it is not a session, and a session we could not read would be the
  // thing that makes a listing untrustworthy.
  assert.equal(report.complete, true);
});

test("an active child of an archived parent is reported, not moved", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  // Archive only the parent, standing in for any split durable tree.
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  fs.renameSync(parent, path.join(archiveRoot(agentDir), name("p1")));

  const report = await reconcileArchive({ agentDir });
  const cascade = report.diagnostics.find((diagnostic) => diagnostic.kind === "incomplete-cascade");
  assert.ok(cascade, "a split tree must be visible");
  assert.deepEqual(cascade.sessionIds, ["c1", "p1"]);
  assert.match(cascade.message, /durable tree is split/);
  assert.equal(
    fs.existsSync(path.join(projectDirFor(agentDir, "/data/proj"), name("c1"))),
    true,
    "the child is left exactly where it is",
  );
});

test("an archived child of an active parent is reported too", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  const child = writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  fs.renameSync(child, path.join(archiveRoot(agentDir), name("c1")));

  const report = await reconcileArchive({ agentDir });
  const cascade = report.diagnostics.find(
    (diagnostic) => diagnostic.kind === "incomplete-cascade" && diagnostic.sessionIds[0] === "c1",
  );
  assert.ok(cascade, "the opposite split direction is visible as well");
  assert.match(cascade.message, /archived but belongs to active parent p1/);
});

test("a healthy cascade produces no cascade diagnostic", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  await archiveSessionTree("p1", { agentDir, now: NOW });
  const report = await reconcileArchive({ agentDir });
  assert.deepEqual(report.diagnostics, [], `a completed cascade leaves nothing behind: ${JSON.stringify(report.diagnostics)}`);
});

test("a corrupt archive index does not make the report fail", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  await archiveSessionTree("p1", { agentDir, now: NOW });
  fs.writeFileSync(path.join(archiveRoot(agentDir), "index.json"), "{ not json");
  const report = await reconcileArchive({ agentDir });
  assert.equal(report.archived.length, 1, "the location is still the truth");
  assert.deepEqual(report.diagnostics, []);
});

test("the summary groups diagnostics by kind", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  const file = path.join(projectDirFor(agentDir, "/data/proj"), name("p1"));
  const archived = path.join(archiveRoot(agentDir), name("p1"));
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "p1", cwd: "/data/proj" })}\n`);
  fs.copyFileSync(file, archived);

  const summary = summarizeDiagnostics(await reconcileArchive({ agentDir }));
  assert.match(summary, /1 split-session/);
});

test("a relation that could not be read makes the report incomplete, not consistent", async (t) => {
  // /archive-check reads relations with the same parser the archive uses, so it
  // is not an independent check on the parser. It is a check on the outcome -
  // which means it must report "unknown" when a relation could not be read, and
  // not answer "the archive looks consistent" about a tree it could not see.
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  const dir = path.join(sessionsRoot(agentDir), "--data-proj--");
  fs.mkdirSync(dir, { recursive: true });
  // A child whose second line carries the marker but is not a readable entry -
  // truncated by a split write. Inside the four-line window, so this is unknown
  // rather than absent, and unknown is what the report has to say.
  fs.writeFileSync(
    path.join(dir, "2026-09-24T10-00-00-000Z_c.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "c", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      '{"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSess',
    ].join("\n") + "\n",
  );
  // The parent is archived and the child is not: the split /archive-check exists
  // to report.
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  fs.renameSync(parent, path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl"));

  const report = await reconcileArchive({ agentDir });
  assert.equal(report.complete, false, "an unreadable relation is not a consistent tree");
  assert.ok(
    report.scanProblems.some((problem) => problem.path.endsWith("_c.jsonl")),
    `and the file is named: ${JSON.stringify(report.scanProblems.map((p) => p.path))}`,
  );
  assert.notEqual(summarizeDiagnostics(report), "Archive looks consistent.");
});

test("a relation that cannot be read on the archived side is reported too", async (t) => {
  // Round three fixed the active side only. The archived side is where a restore
  // would read it, so an unreadable relation there is just as unknown - and the
  // report was answering "the archive looks consistent" about it.
  const agentDir = makeAgentDir(t);
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  // An archived session whose second line carries the marker but is truncated.
  fs.writeFileSync(
    path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_a.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      '{"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSess',
    ].join("\n") + "\n",
  );
  const report = await reconcileArchive({ agentDir });
  assert.equal(report.complete, false, "an unreadable archived relation is not a consistent archive");
  assert.notEqual(summarizeDiagnostics(report), "Archive looks consistent.");
  const finding = report.diagnostics.find((d) => d.paths.some((p) => p.endsWith("_a.jsonl")));
  assert.ok(finding, `the file is named: ${JSON.stringify(report.diagnostics)}`);
  assert.equal(finding.kind, "relation-unknown", "and it is not mislabelled as a damaged file");
  assert.doesNotMatch(finding.message, /not recognise/i, "it is a real session with an unreadable relation");
});
