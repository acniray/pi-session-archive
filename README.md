# pi-session-archive

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Archive [Pi](https://github.com/earendil-works/pi) sessions by moving their
JSONL files out of Pi's active session tree. Archived files live under
`<agentDir>/session-archive/`, so they disappear from Pi's active session
catalogue. PI WEB can optionally expose native row/batch archive controls;
those controls only appear when this extension is detected and delegate all
mutations back to the extension.

This package was extracted from
[pi-config](https://github.com/acniray/pi-config) with its full commit history
preserved.

## Features

- **Multi-select archive** — pick any set of active root sessions and archive
  each one together with the subagent sessions already present on disk.
- **Subagent cascades** — descendants move before the root on archive, and the
  root moves before descendants on restore, driven by the durable relation
  graph found at lock time.
- **Host integration** — a non-interactive `--ids` form for hosts such as
  PI WEB, plus a selection-basket fallback for generic RPC hosts.
- **Restore & export** — bring sessions back, or export one archived session
  to standalone HTML.
- **Diagnostics** — `/archive-check` reports split trees, duplicate files and
  malformed archive state without freezing clean sessions.
- **Safety by design** — the current session is never moved, mutations are
  serialized by a cross-process lease, and partial failures attempt rollback
  and report the exact recovery state.

## Install

```bash
pi install git:github.com/acniray/pi-session-archive
```

Or add `"git:github.com/acniray/pi-session-archive"` to the `packages` array
in your `settings.json`. The extension registers itself through the `pi`
field of `package.json`.

## Commands

- `/archive [filter]` - multi-select active root sessions and archive each
  selected root together with the subagent sessions already present on disk.
- `/archive --ids <id[,id...]>` - non-interactive integration form used by
  hosts such as PI WEB. It uses the same archive engine and safety checks.
- `/archived [filter]` - browse archived roots, then restore/open or export one.
- `/unarchive <id-or-text>` - restore an archived root and its archived
  descendants.
- `/archived-export <id-or-text> [--in <directory>]` - export one archived
  session to standalone HTML. The target may contain spaces.
- `/archive-check` - diagnostics for split trees, duplicate files and malformed
  archive state. Diagnostics never become a global gate for unrelated sessions.

Ctrl+Shift+A opens the archive picker in Pi TUI. In TUI the picker is a true
single-screen multi-select (Space toggles, Enter commits). Generic RPC hosts get
a selection-basket fallback. PI WEB's native session-list integration uses the
`--ids` form, so browser users do not bounce through extension dialogs.

## Safety model

The extension intentionally follows Pi's own session-management boundary:

1. The session file used by the current runtime is never moved.
2. Archive/restore operations are serialized by the extension's mutation lease.
3. A cascade contains the **durable relation graph that exists at the decisive
   lock-time scan**.
4. The extension does not infer children that do not yet have a session file,
   does not inspect historical background-start messages, and does not install a
   global input gate.
5. Damage or ambiguity in an unrelated session is reported by `/archive-check`
   but does not freeze a clean target tree.

For archive, descendants move before the root. For restore, the root moves
before descendants. If a filesystem failure occurs mid-plan, the extension
attempts the reverse move and reports `recovery-required` with the observed
location of every member if rollback is incomplete.

## What counts as a child

PI WEB writes a `pi-web:subagent` custom entry near the start of a child session
file. The scanner reads at most the first four complete lines, with a per-line
memory cap. It handles a final line without a trailing newline and preserves
UTF-8 characters split across read chunks.

Only sessions actually present on disk participate in the tree. A hypothetical
future child is outside the archive transaction until it has a durable session
file. If a child appears later for any reason, `/archive-check` can report the
resulting split; archive correctness does not depend on predicting it.

## Picker design

Rows are written for people first and machines second. In a generic picker,
selection state is rendered separately from the row content. Active rows look
like:

```text
Fix auth flow · sms-gateway · 12m ago · 2 subagents · #a1b2c3d4
```

The session the current runtime is using is marked `current session`, so it is
visible in context without pretending it can be archived from underneath itself.

Archived rows look like:

```text
Fix auth flow · sms-gateway · archived 2d ago · 2 subagents · #a1b2c3d4
```

The title/name and project are first, age and cascade size follow, and a stable
short id token is always last. Selection resolution requires a unique id prefix;
ambiguous prefixes are refused instead of choosing the first match. If a child
is already split from a parent that is not on the same storage side, it is shown
as `split child of #<parent>` instead of being hidden from the recovery UI.

## Storage

```text
<agentDir>/
  sessions/<project>/*.jsonl          active sessions
  session-archive/*.jsonl             archived sessions
  session-archive/index.json          archivedAt/originalPath metadata
  session-archive-mutation/owner.json cross-process mutation lease
```

The archive index is metadata, not the source of truth. Version 2 records the
original path so custom session directories round-trip exactly while that entry
is available. Unknown newer/corrupt index schemas remain readable but are not
overwritten; without `originalPath`, restore falls back to Pi's default
cwd-derived session location.

## Important limits

- Independent Pi processes are not coordinated beyond archive/restore mutations.
  This matches Pi's native delete semantics.
- A malformed target session whose own relation cannot be established is
  refused. A malformed unrelated session is diagnostic only.
- A child whose parent is present on the same storage side cannot be operated on
  independently; operate on its root. A child whose parent is absent is treated
  as a recovery root so an already-split tree can be repaired.
- Archived files are read without `SessionManager.open()` so listing/export does
  not rewrite or normalize them.

## Tests

```bash
npm install
npm test
```

The regression suite covers durable-tree cascades, unrelated-corruption
non-interference, target-local duplicate/multi-parent rejection, rollback,
mutation locking, custom session directories, stable picker identity, EOF
without newline, UTF-8 chunk boundaries, and archive index compatibility.

## License

[MIT](LICENSE)
