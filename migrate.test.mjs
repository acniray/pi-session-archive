import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, projectDirFor, writeSessionFile, writeSubagentSessionFile } from "./test-helpers.mjs";

const {
  archiveSessionTree,
  listArchivedSessions,
  loadArchiveIndex,
  restoreSessionTree,
} = await import("./migrate.ts");
const { archiveRoot, sessionsRoot } = await import("./paths.ts");
const { reconcileArchive } = await import("./reconcile.ts");

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

/** A parent with two nested subagent children, plus an unrelated fork sibling. */
function seedTree(agentDir) {
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  writeSubagentSessionFile(agentDir, { id: "c2", parentId: "c1", parentPath: parent });
  writeSessionFile(agentDir, { id: "f1", cwd: "/data/proj" });
  return { parent };
}

const deps = (agentDir, over = {}) => ({ agentDir, now: () => NOW, ...over });

test("archiving a session takes its subagent descendants and leaves forks alone", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);

  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true);
  // Descendants first, root last.
  assert.deepEqual(result.affected, ["c2", "c1", "p1"]);

  assert.equal(fs.existsSync(archiveRoot(agentDir) + path.sep + "2026-09-24T10-00-00-000Z_p1.jsonl"), true);
  assert.equal(fs.existsSync(projectDirFor(agentDir, "/data/proj") + path.sep + "2026-09-24T10-00-00-000Z_f1.jsonl"), true);
  assert.equal(fs.existsSync(projectDirFor(agentDir, "/data/proj") + path.sep + "2026-09-24T10-00-00-000Z_p1.jsonl"), false);
});

test("restoring brings the tree back to the directory its own cwd implies", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  await archiveSessionTree("p1", deps(agentDir));

  const result = await restoreSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true);
  // Root first on the way back.
  assert.deepEqual(result.affected, ["p1", "c1", "c2"]);

  for (const id of ["p1", "c1", "c2"]) {
    assert.equal(
      fs.existsSync(path.join(projectDirFor(agentDir, "/data/proj"), `2026-09-24T10-00-00-000Z_${id}.jsonl`)),
      true,
      `${id} is back in its project directory`,
    );
  }
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), false);
});

test("a subagent child cannot be archived on its own", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  const result = await archiveSessionTree("c1", deps(agentDir));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-a-root");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl")), false);
});

test("the session the host is running is refused, and nothing moves", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  const moved = [];
  const result = await archiveSessionTree(
    "p1",
    deps(agentDir, {
      // The host's own file, compared by path - the only ownership rule there is.
      isHostActiveFile: (path) => path.endsWith("_p1.jsonl"),
      renameFile: (from) => moved.push(from),
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked-by-runtime");
  assert.deepEqual(result.blockers, ["p1"]);
  assert.deepEqual(moved, [], "a refusal must not move anything");
});

test("another process holding a session does NOT stop the archive", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  // Deliberately no claim, no liveness probe, no freshness veto: pi does not
  // check this for delete either, so neither do we.
  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")),
    true,
  );
});

test("a session written moments ago archives like any other", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "p1", mtime: new Date().toISOString() });
  const result = await archiveSessionTree("p1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, true, "recency is not a proxy for a writer, so it must not veto");
  assert.equal(fs.existsSync(file), false);
});

test("a destination collision is refused before anything moves", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  const squatter = path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c2.jsonl");
  fs.writeFileSync(squatter, "{}", { flag: "wx" });

  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "destination-exists");
  assert.equal(result.conflictPath, squatter);
  assert.equal(fs.readFileSync(squatter, "utf8"), "{}", "the existing file is never overwritten");
  assert.equal(fs.existsSync(path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_p1.jsonl")), true);
});

test("ARCHIVE FAILURE: a mid-way failure rolls the earlier moves back", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  const ops = [];
  const result = await archiveSessionTree(
    "p1",
    deps(agentDir, {
      // The stub moves files for real and only fails where a filesystem would,
      // otherwise "where did the file end up" assertions would be fiction.
      renameFile: (from, to) => {
        ops.push([from, to]);
        if (from === path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_p1.jsonl")) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        fs.renameSync(from, to);
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "io-failure");
  assert.deepEqual(
    ops.slice(3).map(([from]) => from),
    [
      path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl"),
      path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c2.jsonl"),
    ],
    "the two children were moved back out of the archive",
  );
  for (const id of ["p1", "c1", "c2"]) {
    assert.equal(
      fs.existsSync(path.join(projectDirFor(agentDir, "/data/proj"), `2026-09-24T10-00-00-000Z_${id}.jsonl`)),
      true,
      `${id} is back in the active tree`,
    );
  }
});

test("ARCHIVE FAILURE: a rollback that cannot finish reports where every file is", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  const project = projectDirFor(agentDir, "/data/proj");
  const result = await archiveSessionTree(
    "p1",
    deps(agentDir, {
      renameFile: (from, to) => {
        if (from === path.join(project, "2026-09-24T10-00-00-000Z_c1.jsonl")) throw new Error("boom");
        if (to.includes(`${path.sep}sessions${path.sep}`)) throw new Error("rollback blocked");
        fs.renameSync(from, to);
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "recovery-required");
  assert.equal(result.actualPaths.c2, path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c2.jsonl"));
  assert.equal(result.actualPaths.c1, path.join(project, "2026-09-24T10-00-00-000Z_c1.jsonl"));
  assert.equal(result.actualPaths.p1, path.join(project, "2026-09-24T10-00-00-000Z_p1.jsonl"));
});

test("a cross-device move is refused rather than half-done", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  const result = await archiveSessionTree(
    "p1",
    deps(agentDir, { renameFile: () => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cross-device");
});

test("RESTORE FAILURE: a collision at the destination is refused with zero moves", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  await archiveSessionTree("p1", deps(agentDir));
  const project = projectDirFor(agentDir, "/data/proj");
  const squatter = path.join(project, "2026-09-24T10-00-00-000Z_p1.jsonl");
  fs.writeFileSync(squatter, "{}", { flag: "wx" });

  const renamed = [];
  const result = await restoreSessionTree("p1", deps(agentDir, { renameFile: (from) => renamed.push(from) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "destination-exists");
  assert.equal(result.conflictPath, squatter);
  assert.deepEqual(renamed, []);
});

test("RESTORE FAILURE: a mid-restore failure attempts the reverse and reports honestly", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "p1" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: file });
  await archiveSessionTree("p1", deps(agentDir));

  const result = await restoreSessionTree(
    "p1",
    deps(agentDir, {
      renameFile: (from, to) => {
        if (to.endsWith("c1.jsonl")) throw new Error("EACCES");
        fs.renameSync(from, to);
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "io-failure");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), true, "p1 was returned to the archive");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl")), true);
});

test("RESTORE FAILURE: a member that vanishes mid-flight fails the restore", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  await archiveSessionTree("p1", deps(agentDir));

  // A relation lives only in the child file, so a child deleted from the archive
  // beforehand is unknowable - the tree simply does not mention it and the
  // restore succeeds. What must not happen is silently dropping a member that
  // the scan did see and that then disappears before its move.
  const childPath = path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl");
  const result = await restoreSessionTree(
    "p1",
    deps(agentDir, {
      renameFile: (from, to) => {
        if (from === childPath) {
          // Gone between the scan and the move: a real rename would fail.
          fs.rmSync(from);
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        }
        fs.renameSync(from, to);
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "io-failure");
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")),
    true,
    "the parent was rolled back into the archive",
  );
});

test("restoring something that is not archived says so", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  const result = await restoreSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-archived");
});

test("the decorative index records when and from where, and survives deletion", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  await archiveSessionTree("p1", deps(agentDir));

  const loaded = loadArchiveIndex(agentDir);
  assert.equal(loaded.writable, true);
  assert.equal(loaded.entries.get("p1").archivedAt, new Date(NOW).toISOString());
  assert.equal(loaded.entries.get("p1").cwd, "/data/proj");
  // v2 records where the file came from, so a restore never has to re-derive it.
  assert.equal(
    loaded.entries.get("p1").originalPath,
    path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_p1.jsonl"),
  );
  assert.equal(loaded.entries.get("p1").originalSessionDir, projectDirFor(agentDir, "/data/proj"));

  // The index is decoration: deleting it must not change what works.
  fs.rmSync(path.join(archiveRoot(agentDir), "index.json"));
  assert.equal(loadArchiveIndex(agentDir).entries.size, 0);
  const restored = await restoreSessionTree("p1", deps(agentDir));
  assert.equal(restored.ok, true);
});

test("a corrupt index stays readable but is not written over", async (t) => {
  const agentDir = makeAgentDir(t);
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  const file = path.join(archiveRoot(agentDir), "index.json");
  fs.writeFileSync(file, "{ not json");
  const loaded = loadArchiveIndex(agentDir);
  assert.equal(loaded.writable, false, "we cannot prove what is in there");
  assert.match(loaded.reason, /not readable JSON/);

  // Archiving still works - the files are the truth - and says the index was left alone.
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.warnings.some((warning) => /index/.test(warning)), JSON.stringify(result.warnings));
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "and the file is untouched");
});

test("an index from a newer version is readable but never overwritten", async (t) => {
  const agentDir = makeAgentDir(t);
  fs.mkdirSync(archiveRoot(agentDir), { recursive: true });
  const file = path.join(archiveRoot(agentDir), "index.json");
  const future = JSON.stringify({
    version: 99,
    entries: { s: { archivedAt: "2026-09-24T00:00:00.000Z", cwd: "/y", extra: 1 } },
  });
  fs.writeFileSync(file, future);

  const loaded = loadArchiveIndex(agentDir);
  assert.equal(loaded.writable, false);
  assert.match(loaded.reason, /newer version/);
  assert.equal(loaded.entries.size, 1, "its entries are still readable");

  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), future, "the future schema survives");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), true);
});


test("the archived view folds children into the root row", async (t) => {
  const agentDir = makeAgentDir(t);
  seedTree(agentDir);
  await archiveSessionTree("p1", deps(agentDir));

  const { rows } = await listArchivedSessions(deps(agentDir));
  assert.equal(rows.length, 1, "children do not get their own row");
  assert.equal(rows[0].session.id, "p1");
  assert.equal(rows[0].childCount, 1, "c1 is a direct child");
  assert.equal(rows[0].descendantCount, 2, "c2 is folded in through c1");
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[0].archivedAt, new Date(NOW).toISOString());
});

test("archiving twice is refused, and so is a foreign layout", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  assert.equal((await archiveSessionTree("p1", deps(agentDir))).ok, true);
  const again = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(again.ok, false);
  assert.equal(again.reason, "not-found", "it is no longer in the active tree");

  const outside = path.join(agentDir, "elsewhere", "x.jsonl");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, `${JSON.stringify({ type: "session", version: 3, id: "zz", cwd: "/data/proj" })}\n`);
  const foreign = await archiveSessionTree("zz", deps(agentDir, { scanActive: () => ({ complete: true, sessions: [{ id: "zz", path: outside, mtimeMs: 0, size: 1, idFromFileName: false }], problems: [] }) }));
  assert.equal(foreign.reason, "unsupported-layout");
});

test("the archive root is the only directory the extension creates", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1" });
  const result = await archiveSessionTree("p1", deps(agentDir));
  assert.equal(result.ok, true, JSON.stringify(result));

  const created = fs.readdirSync(archiveRoot(agentDir));
  assert.deepEqual(created.sort(), [
    "2026-09-24T10-00-00-000Z_p1.jsonl",
    "index.json",
  ]);
  // Nothing is added to the sessions tree, and no per-session lease directories.
  const projectDir = projectDirFor(agentDir, "/data/proj");
  assert.deepEqual(
    fs.readdirSync(projectDir).filter((name) => !name.endsWith(".jsonl")),
    [],
  );
});


test("a subagent child cannot be restored on its own, in either direction", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  await archiveSessionTree("p1", deps(agentDir));

  // The child was archived with its root, but asking for it alone must not
  // quietly pull half a tree back into the active list.
  const result = await restoreSessionTree("c1", deps(agentDir));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-a-root");
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl")),
    true,
    "and the child stays in the archive",
  );

  // The root brings it back, as one unit.
  const whole = await restoreSessionTree("p1", deps(agentDir));
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.affected, ["p1", "c1"]);
});

test("a split child is a recovery root when its parent is absent from that storage side", async (t) => {
  const agentDir = makeAgentDir(t);
  const child = writeSubagentSessionFile(agentDir, {
    id: "c1",
    parentId: "p1",
    parentPath: "/tmp/p1.jsonl",
  });

  // Parent is not active, so this is already a split state. The child must be
  // operable or /archive-check would diagnose a problem the UI cannot repair.
  const archived = await archiveSessionTree("c1", deps(agentDir));
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(fs.existsSync(child), false);

  // Parent is still absent from the archive as well, so restore must likewise
  // treat the child as a recovery root rather than trapping it forever.
  const listed = await listArchivedSessions(deps(agentDir));
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].session.id, "c1");
  assert.equal(listed.rows[0].splitParentId, "p1");

  const restored = await restoreSessionTree("c1", deps(agentDir));
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(fs.existsSync(child), true);
});

test("a custom sessionDir is honoured on the way out and on the way back", async (t) => {
  const agentDir = makeAgentDir(t);
  // A host started with --session-dir points somewhere else entirely.
  const customDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "custom-sessiondir-"));
  t.after(() => fs.rmSync(customDir, { recursive: true, force: true }));
  const projectDir = path.join(customDir, "my-project-dir");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "2026-09-24T10-00-00-000Z_s1.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" })}\n` +
      `${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-24T10:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1758700801000 } })}\n`,
  );

  // Give the fixture a deterministic mtime; liveness/freshness is deliberately
  // not part of archive eligibility.
  const old = new Date(NOW - 60 * 60_000);
  fs.utimesSync(file, old, old);

  const withDir = { agentDir, sessionRoots: [customDir], now: () => NOW };
  const archived = await archiveSessionTree("s1", withDir);
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_s1.jsonl")), true, "found in the archive");
  assert.equal(fs.existsSync(file), false, "and gone from the custom root");

  // The recorded origin, not a re-derived one, is where it comes back to.
  const entry = loadArchiveIndex(agentDir).entries.get("s1");
  assert.equal(entry.originalPath, file);
  assert.equal(entry.originalSessionDir, projectDir);
  const listed = await listArchivedSessions(withDir);
  assert.equal(listed.rows[0].originalPath, file, "the picker keeps the exact restore path for custom layouts");

  const restored = await restoreSessionTree("s1", withDir);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(fs.existsSync(file), true, "back at the exact path it came from");
  // And the default root stayed empty: no leakage through a derived path.
  assert.equal(fs.existsSync(path.join(sessionsRoot(agentDir), "--data-proj--")), false);
});

test("two concurrent archives both land in the index", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "a", cwd: "/data/proj" });
  writeSessionFile(agentDir, { id: "b", cwd: "/data/proj" });

  const [first, second] = await Promise.all([
    archiveSessionTree("a", deps(agentDir)),
    archiveSessionTree("b", deps(agentDir)),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));

  // The index read-modify-write runs inside the mutation lease, so a concurrent
  // pair cannot lose an entry by interleaving load/load/save/save.
  const loaded = loadArchiveIndex(agentDir);
  assert.equal(loaded.writable, true);
  assert.deepEqual([...loaded.entries.keys()].sort(), ["a", "b"]);
});

test("a large session archives on a definite answer, not a caveat", async (t) => {
  const agentDir = makeAgentDir(t);
  // Past the streaming budget, so its "no relation" is answered from the head
  // alone. pi writes the relation entry before the child session exists
  // (lib/subagent-runtime.ts: appendCustomEntry runs ahead of
  // createAgentSessionFromServices; measured at offset 286-372 on 117 real
  // child sessions), so a head without one is an answer, not a doubt - and this
  // must not be the session that cannot be archived.
  const file = writeSessionFile(agentDir, { id: "big", cwd: "/data/proj" });
  const padding = `${JSON.stringify({ type: "message", id: `p${"x".repeat(40)}`, parentId: "e1", timestamp: "2026-09-24T10:00:02.000Z", message: { role: "assistant", content: "y".repeat(4_000_000), timestamp: 1758700802000 } })}\n`;
  fs.appendFileSync(file, padding.repeat(1));
  assert.ok(fs.statSync(file).size > 1024 * 1024, "bigger than the fallback budget");

  const result = await archiveSessionTree("big", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.affected, ["big"]);
  assert.equal(fs.existsSync(file), false);
  // No caveat: the relation entry is read by whole lines, so a 4MB file gets a
  // real answer instead of the "we only looked at the head" warning this used to
  // carry. The file that cannot be read inside the budget is the one that
  // refuses, and it says so.
  assert.deepEqual(result.warnings, [], `nothing to hedge about: ${JSON.stringify(result.warnings)}`);
});

test("an unreadable unrelated file does not freeze a clean target tree", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const unreadable = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_hidden.jsonl");
  fs.mkdirSync(unreadable, { recursive: true });

  const result = await archiveSessionTree("p1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.affected, ["p1"]);
  assert.equal(fs.existsSync(parent), false, "the clean target moved");
  assert.equal(fs.existsSync(unreadable), true, "the unrelated broken path is untouched");
});

test("a large session elsewhere does not block an archive", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const unrelated = writeSessionFile(agentDir, { id: "big", cwd: "/data/other" });
  fs.appendFileSync(
    unrelated,
    `${JSON.stringify({ type: "message", id: "pbig", parentId: "e1", timestamp: "2026-09-24T10:00:02.000Z", message: { role: "assistant", content: "y".repeat(4_000_000), timestamp: 1758700802000 } })}\n`,
  );

  const result = await archiveSessionTree("p1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.affected, ["p1"]);
});

test("a split-write fragment elsewhere in the tree does not block archiving", async (t) => {
  // The reported failure: one headerless file under the active root made the
  // scan "incomplete", and then *every* archive refused with "the session list
  // could not be read completely". A fragment is not a session and cannot hide
  // a child, so it must not be able to freeze the whole command - it still has
  // to be reported as a diagnostic.
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "parent1", cwd: "/data/proj" });
  const child = writeSubagentSessionFile(agentDir, {
    id: "child1",
    parentId: "parent1",
    parentPath: parent,
    cwd: "/data/proj",
  });
  const fragment = path.join(path.dirname(parent), "2026-09-26T17-06-08-519Z_frag.jsonl");
  fs.writeFileSync(
    fragment,
    `${JSON.stringify({ type: "message", id: "d3715231", parentId: "5cc38770", message: { role: "toolResult" } })}\n`,
  );

  const deps = { agentDir, sessionRoots: [sessionsRoot(agentDir)] };
  const result = await archiveSessionTree("parent1", deps);
  assert.equal(result.ok, true);
  assert.equal(result.affected.length, 2);
  assert.equal(fs.existsSync(fragment), true, "the fragment is somebody else's business, not ours to move");
  assert.equal(fs.existsSync(parent), false);
  assert.equal(fs.existsSync(child), false);

  // Still visible as a diagnostic, and still not silently ignored.
  const after = await reconcileArchive({ agentDir, sessionRoots: [sessionsRoot(agentDir)] });
  assert.ok(
    after.diagnostics.some((d) => d.kind === "unclassified-fragment" && d.paths.includes(fragment)),
    "the fragment must be reported by /archive-check",
  );
});

test("a duplicated session id is refused, naming every file that claims it", async (t) => {
  // The graph is keyed by id, so two files claiming the same id merge into one
  // node, and `findSession` then takes whichever the scan happened to list
  // first. That moved a bystander and left the real child in the active root.
  const agentDir = makeAgentDir(t);
  const dir = projectDirFor(agentDir, "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const parent = writeSessionFile(agentDir, { id: "parent1", cwd: "/data/proj" });
  // The real child: it is the one that declares the relation.
  const real = path.join(dir, "2026-09-24T10-00-00-000Z_a_child.jsonl");
  fs.writeFileSync(
    real,
    [
      JSON.stringify({ type: "session", version: 3, id: "child1", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "go", timestamp: 1 } }),
      JSON.stringify({
        type: "custom",
        id: "meta1",
        parentId: "e1",
        timestamp: "2026-09-24T10:00:02.000Z",
        customType: "pi-web:subagent",
        data: { version: 1, parentSessionId: "parent1", parentSessionPath: parent },
      }),
    ].join("\n") + "\n",
  );
  // An unrelated session whose header carries the same id.
  const impostor = path.join(dir, "2026-09-24T10-00-00-000Z_z_other.jsonl");
  fs.writeFileSync(
    impostor,
    `${JSON.stringify({ type: "session", version: 3, id: "child1", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/other" })}\n${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "unrelated", timestamp: 1 } })}\n`,
  );

  const result = await archiveSessionTree("parent1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "duplicate-id");
  assert.ok(
    result.message.includes(real) && result.message.includes(impostor),
    `both files must be named, not just the one we would have picked: ${result.message}`,
  );
  for (const file of [parent, real, impostor]) {
    assert.equal(fs.existsSync(file), true, "nothing moved");
  }
});
test("an unrelated session with an unreadable relation does not freeze archiving", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "parent1", cwd: "/data/proj" });
  const bystander = writeSessionFile(agentDir, { id: "bystander", cwd: "/data/other" });
  const realReader = (await import("./scanner.ts")).readSubagentMeta;

  const result = await archiveSessionTree(
    "parent1",
    deps(agentDir, {
      now: () => Date.now(),
      readSubagentMeta: async (filePath) =>
        filePath === bystander ? { kind: "unreadable", error: new Error("injected") } : realReader(filePath),
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.affected, ["parent1"]);
  assert.equal(fs.existsSync(parent), false);
  assert.equal(fs.existsSync(bystander), true);
});

test("restore ignores unrelated relation damage but refuses a duplicate inside the target tree", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "parent1", cwd: "/data/proj" });
  writeSubagentSessionFile(agentDir, { id: "child1", parentId: "parent1", parentPath: parent });
  const archived = await archiveSessionTree("parent1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(archived.ok, true, JSON.stringify(archived));

  // A file in the archive whose relation cannot be read.
  const realReader = (await import("./scanner.ts")).readSubagentMeta;
  const unreadable = path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_other.jsonl");
  fs.writeFileSync(
    unreadable,
    `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/other" })}\n${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "x", timestamp: 1 } })}\n`,
  );
  const restoredPastBystander = await restoreSessionTree(
    "parent1",
    deps(agentDir, {
      now: () => Date.now(),
      readSubagentMeta: async (filePath) =>
        filePath === unreadable ? { kind: "unreadable", error: new Error("injected") } : realReader(filePath),
    }),
  );
  assert.equal(restoredPastBystander.ok, true, JSON.stringify(restoredPastBystander));
  assert.equal(fs.existsSync(parent), true, "the target tree restores despite unrelated damage");

  // Archive it again, then add a duplicate id inside the target tree.
  const rearchived = await archiveSessionTree("parent1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(rearchived.ok, true, JSON.stringify(rearchived));

  // A duplicate id in the target tree is still refused by name.
  fs.writeFileSync(
    path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_zz_dup.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "child1", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/other" })}\n${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "dup", timestamp: 1 } })}\n`,
  );
  const duplicate = await restoreSessionTree("parent1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(duplicate.ok, false, JSON.stringify(duplicate));
  assert.equal(duplicate.reason, "duplicate-id");
  assert.ok(duplicate.message.includes("child1"));
  assert.equal(fs.existsSync(parent), false, "still archived");
  // Both members are still in the archive, under their archived names: a
  // refused duplicate moves nothing, rather than moving "half" of a tree.
  const inArchive = fs.readdirSync(archiveRoot(agentDir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(inArchive.length, 4, `parent, child and the two id-claimants: ${inArchive.join(", ")}`);
  assert.ok(inArchive.some((name) => name.includes("child1")), "the child is still there");
});

test("an unrelated ambiguous id does not freeze a clean archive target", async (t) => {
  const agentDir = makeAgentDir(t);
  const clean = writeSessionFile(agentDir, { id: "clean-root", cwd: "/data/clean" });

  // Two unrelated files claim the same id. This used to trip the global
  // graph.ambiguous[0] gate and reject `clean-root` even though neither file is
  // reachable from it.
  writeSessionFile(agentDir, { id: "dup", cwd: "/data/other", firstMessage: "one" });
  const otherDir = projectDirFor(agentDir, "/data/other-two");
  fs.mkdirSync(otherDir, { recursive: true });
  const duplicate = path.join(otherDir, "2026-09-24T10-00-00-000Z_dup.jsonl");
  fs.writeFileSync(
    duplicate,
    `${JSON.stringify({ type: "session", version: 3, id: "dup", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/other-two" })}\n${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "two", timestamp: 1 } })}\n`,
  );

  const result = await archiveSessionTree("clean-root", deps(agentDir, { now: () => Date.now() }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.affected, ["clean-root"]);
  assert.equal(fs.existsSync(clean), false, "the requested clean root moved");
  assert.equal(fs.existsSync(duplicate), true, "the unrelated conflict stayed untouched");
});

/** A deliberately corrupt child file that declares more than one parent. */
function twoLineClaim(agentDir, { childId, parents }) {
  const dir = projectDirFor(agentDir, "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: childId,
      timestamp: "2026-09-24T10:00:00.000Z",
      cwd: "/data/proj",
    }),
  ];
  for (const [index, parent] of parents.entries()) {
    lines.push(
      JSON.stringify({
        type: "custom",
        id: `m${index}`,
        parentId: "e1",
        timestamp: "2026-09-24T10:00:02.000Z",
        customType: "pi-web:subagent",
        data: { version: 1, parentSessionId: parent },
      }),
    );
  }
  const file = path.join(dir, `2026-09-24T10-00-00-000Z_${childId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("a child claiming two parents stops the archive of *either* of them", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  writeSessionFile(agentDir, { id: "p2", cwd: "/data/proj" });
  const child = twoLineClaim(agentDir, { childId: "kid", parents: ["p1", "p2"] });

  // The traversal used to follow only the first parent, so archiving the second
  // one never saw the child at all: the parent moved and the child stayed.
  for (const target of ["p1", "p2"]) {
    const result = await archiveSessionTree(target, deps(agentDir, { now: () => Date.now() }));
    assert.equal(result.ok, false, `${target} must refuse: ${JSON.stringify(result)}`);
    assert.equal(result.reason, "duplicate-id", `for ${target}`);
    for (const id of ["p1", "p2"]) {
      assert.equal(
        fs.existsSync(path.join(projectDirFor(agentDir, "/data/proj"), `2026-09-24T10-00-00-000Z_${id}.jsonl`)),
        true,
        `${id} must stay where it is`,
      );
    }
    assert.equal(fs.existsSync(child), true, "and the child stays with them");
  }
});

test("a restore refuses a conflict that a single-parent archive could not have", async (t) => {
  // Build the conflict inside the archive: a clean archive of p1 with its child,
  // then the child's file gains a second parent while archived. The restore is
  // the direction that would put the child back with only one parent, so it is
  // the direction that must notice.
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const child = writeSubagentSessionFile(agentDir, { id: "kid", parentId: "p1", parentPath: parent });
  const archived = await archiveSessionTree("p1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.deepEqual(archived.affected, ["kid", "p1"], "descendants first");

  // The conflict appears in the archive: same child, now also claiming p2.
  const archivedChild = path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_kid.jsonl");
  const lines = fs.readFileSync(archivedChild, "utf8").trimEnd().split("\n");
  lines.push(
    JSON.stringify({
      type: "custom",
      id: "m-extra",
      parentId: "e1",
      timestamp: "2026-09-24T10:00:04.000Z",
      customType: "pi-web:subagent",
      data: { version: 1, parentSessionId: "p2" },
    }),
  );
  fs.writeFileSync(archivedChild, lines.join("\n") + "\n");

  const restored = await restoreSessionTree("p1", deps(agentDir, { now: () => Date.now() }));
  assert.equal(restored.ok, false, JSON.stringify(restored));
  assert.equal(
    fs.readdirSync(archiveRoot(agentDir)).filter((n) => n.endsWith(".jsonl")).length,
    2,
    "nothing restored, in either direction",
  );
});

