import assert from "node:assert/strict";
import test from "node:test";

const { selectMany } = await import("./picker.ts");
const { Key } = await import("@earendil-works/pi-tui");

function theme() {
  return {
    fg: (_kind, text) => text,
    bold: (text) => text,
  };
}

test("TUI multi-select stays in one custom component until Enter commits", async () => {
  let customCalls = 0;
  let renderRequests = 0;
  const ctx = {
    mode: "tui",
    ui: {
      select: async () => {
        throw new Error("TUI multi-select must not fall back to ui.select");
      },
      custom: async (factory) => {
        customCalls += 1;
        return new Promise((resolve) => {
          const component = factory(
            { requestRender: () => { renderRequests += 1; } },
            theme(),
            {},
            resolve,
          );
          component.handleInput(Key.space);
          component.handleInput(Key.down);
          component.handleInput(Key.space);
          component.handleInput(Key.enter);
        });
      },
    },
  };

  const selected = await selectMany(ctx, "Archive sessions", [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ]);

  assert.equal(customCalls, 1);
  assert.deepEqual(selected, ["a", "b"]);
  assert.ok(renderRequests >= 3);
});

test("RPC selection basket toggles several rows before one commit", async () => {
  const calls = [];
  const answers = ["[ ] Alpha", "[ ] Beta", "✓ Archive selected (2)"];
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (title, options) => {
        calls.push({ title, options });
        const expected = answers.shift();
        return options.find((option) => option.startsWith(expected));
      },
    },
  };

  const selected = await selectMany(ctx, "Archive sessions", [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ]);

  assert.deepEqual(selected, ["a", "b"]);
  assert.equal(calls.length, 3);
  assert.match(calls[2].title, /2 selected/);
});

test("disabled rows remain visible but cannot enter the selection", async () => {
  const notices = [];
  let call = 0;
  const ctx = {
    mode: "rpc",
    ui: {
      notify: (message) => notices.push(message),
      select: async (_title, options) => {
        call += 1;
        if (call === 1) return options.find((option) => option.includes("Current"));
        return "No - I'm done";
      },
    },
  };

  const selected = await selectMany(ctx, "Archive sessions", [
    { value: "current", label: "Current", disabled: true, disabledReason: "current session" },
    { value: "other", label: "Other" },
  ]);

  assert.deepEqual(selected, []);
  assert.ok(notices.some((message) => /current session/.test(message)));
});
