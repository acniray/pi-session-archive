/**
 * Session pickers shared by archive/restore flows.
 *
 * Pi's normal `ui.select` is intentionally single-choice. In RPC mode (Pi Web)
 * that is the only interactive list primitive available, so multi-select is
 * implemented as a small "selection basket": choosing a row toggles it, and
 * nothing is mutated until the explicit "Archive selected" action is chosen.
 *
 * In TUI mode we can use `ui.custom`, so the same model becomes a true
 * single-screen multi-select: arrows move, Space toggles, Enter commits.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface PagedSelectOptions {
  /** Rows per page. */
  pageSize?: number;
  /** Extra label appended to the title, e.g. a filter or a count. */
  titleSuffix?: string;
  /** Shown as the last row of page 1 when there is more than one page. */
  nextLabel?: string;
  previousLabel?: string;
  /** Returned when the user leaves without choosing. */
  cancelled?: string;
  /** Shown when a page has nothing on it. */
  emptyLabel?: string;
}

export interface PagedSelectResult {
  /** The chosen row, or undefined when the user left. */
  value?: string;
  /** Which page it came from (1-based). */
  page?: number;
  /** How many pages there were. */
  pages?: number;
}

const NEXT = "››";
const PREVIOUS = "‹‹";

/**
 * Show `rows` a page at a time until the user picks one or leaves.
 *
 * `map` converts a row into its label and back is unnecessary here because the
 * caller keeps its own rows and matches on the label, which is what the archive
 * and unarchive pickers do.
 */
export async function selectPaged(
  ctx: { ui: { select(title: string, options: string[], opts?: unknown): Promise<string | undefined> } },
  title: string,
  rows: readonly string[],
  options: PagedSelectOptions = {},
): Promise<PagedSelectResult> {
  const pageSize = Math.max(1, options.pageSize ?? 20);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  if (rows.length === 0) {
    await ctx.ui.select(options.titleSuffix ? `${title} — ${options.titleSuffix}` : title, [options.emptyLabel ?? "(nothing to choose)"]);
    return {};
  }

  let page = 1;
  for (;;) {
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    const controls: string[] = [];
    if (page > 1) controls.push(`${PREVIOUS} previous page`);
    if (page < pages) controls.push(`${NEXT} next page (${pages} pages)`);
    const heading = `${title}${options.titleSuffix ? ` — ${options.titleSuffix}` : ""} · page ${page}/${pages}`;
    const picked = await ctx.ui.select(heading, [...slice, ...controls]);

    if (picked === undefined || picked === options.cancelled) return {};
    if (picked === `${NEXT} next page (${pages} pages)`) {
      page += 1;
      continue;
    }
    if (picked === `${PREVIOUS} previous page`) {
      page -= 1;
      continue;
    }
    return { value: picked, page, pages };
  }
}

export interface MultiSelectItem {
  /** Stable identity returned to the caller. */
  value: string;
  /** Human-readable session row. */
  label: string;
  /** Disabled rows remain visible for context but cannot be selected. */
  disabled?: boolean;
  disabledReason?: string;
}

export interface MultiSelectOptions {
  pageSize?: number;
  titleSuffix?: string;
  emptyLabel?: string;
  commitVerb?: string;
}

type MultiSelectContext = {
  mode?: string;
  ui: {
    select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
    custom?<T>(
      factory: (
        tui: { requestRender(): void },
        theme: {
          fg(kind: string, text: string): string;
          bold(text: string): string;
        },
        keybindings: unknown,
        done: (value: T) => void,
      ) => unknown,
      opts?: unknown,
    ): Promise<T | undefined>;
  };
};

function heading(title: string, suffix: string | undefined): string {
  return suffix ? `${title} — ${suffix}` : title;
}

function selectedValues(items: readonly MultiSelectItem[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => selected.has(item.value)).map((item) => item.value);
}

/**
 * RPC fallback for Pi Web.
 *
 * The protocol only supports one returned value per `select`, so each click
 * toggles a stable basket entry and redraws the same list. No archive happens
 * during selection; one explicit commit action applies the whole batch.
 */
async function selectManyRpc(
  ctx: MultiSelectContext,
  title: string,
  items: readonly MultiSelectItem[],
  options: MultiSelectOptions,
): Promise<string[]> {
  const pageSize = Math.max(1, options.pageSize ?? 20);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const selected = new Set<string>();
  const commitVerb = options.commitVerb ?? "Archive";
  let page = 1;

  for (;;) {
    const slice = items.slice((page - 1) * pageSize, page * pageSize);
    const rendered = slice.map((item) => {
      const state = item.disabled ? "[-]" : selected.has(item.value) ? "[x]" : "[ ]";
      const reason = item.disabled && item.disabledReason ? ` · ${item.disabledReason}` : "";
      return `${state} ${item.label}${reason}`;
    });

    const controls: string[] = [];
    if (selected.size > 0) controls.push(`✓ ${commitVerb} selected (${selected.size})`);
    if (page > 1) controls.push(`${PREVIOUS} previous page`);
    if (page < pages) controls.push(`${NEXT} next page (${pages} pages)`);
    controls.push("Cancel");

    const titleText = `${heading(title, options.titleSuffix)} · page ${page}/${pages} · ${selected.size} selected`;
    const picked = await ctx.ui.select(titleText, [...rendered, ...controls]);
    if (!picked || picked === "Cancel") return [];

    if (picked === `${PREVIOUS} previous page`) {
      page = Math.max(1, page - 1);
      continue;
    }
    if (picked === `${NEXT} next page (${pages} pages)`) {
      page = Math.min(pages, page + 1);
      continue;
    }
    if (picked === `✓ ${commitVerb} selected (${selected.size})`) {
      return selectedValues(items, selected);
    }

    const index = rendered.indexOf(picked);
    if (index < 0) continue;
    const item = slice[index]!;
    if (item.disabled) {
      ctx.ui.notify?.(item.disabledReason ?? "That session cannot be selected.", "warning");
      continue;
    }
    if (selected.has(item.value)) selected.delete(item.value);
    else selected.add(item.value);
  }
}

/**
 * Native TUI multi-select. This is one component from open to commit, so the
 * user never bounces through a series of dialogs.
 */
async function selectManyTui(
  ctx: MultiSelectContext,
  title: string,
  items: readonly MultiSelectItem[],
  options: MultiSelectOptions,
): Promise<string[]> {
  if (typeof ctx.ui.custom !== "function") return selectManyRpc(ctx, title, items, options);

  const pageSize = Math.max(1, options.pageSize ?? 20);
  const commitVerb = options.commitVerb ?? "Archive";
  const result = await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
    let cursor = 0;
    let scroll = 0;
    const selected = new Set<string>();

    const moveToSelectable = (direction: 1 | -1): void => {
      if (items.length === 0) return;
      let next = cursor;
      for (let tries = 0; tries < items.length; tries += 1) {
        next = Math.max(0, Math.min(items.length - 1, next + direction));
        cursor = next;
        if (!items[cursor]?.disabled) break;
        if (next === 0 || next === items.length - 1) break;
      }
      if (cursor < scroll) scroll = cursor;
      if (cursor >= scroll + pageSize) scroll = cursor - pageSize + 1;
    };

    const toggleCurrent = (): void => {
      const item = items[cursor];
      if (!item || item.disabled) return;
      if (selected.has(item.value)) selected.delete(item.value);
      else selected.add(item.value);
    };

    const render = (width: number): string[] => {
      const w = Math.max(1, width);
      const lines: string[] = [];
      const titleText = heading(title, options.titleSuffix);
      lines.push(truncateToWidth(theme.fg("accent", theme.bold(titleText)), w));
      lines.push(truncateToWidth(theme.fg("dim", `${selected.size} selected`), w));

      const end = Math.min(items.length, scroll + pageSize);
      for (let index = scroll; index < end; index += 1) {
        const item = items[index]!;
        const pointer = index === cursor ? theme.fg("accent", "›") : " ";
        const state = item.disabled ? "[-]" : selected.has(item.value) ? "[x]" : "[ ]";
        const reason = item.disabled && item.disabledReason ? ` · ${item.disabledReason}` : "";
        const row = `${pointer} ${state} ${item.label}${reason}`;
        lines.push(truncateToWidth(index === cursor ? theme.fg("accent", row) : row, w));
      }

      if (items.length > pageSize) {
        lines.push(truncateToWidth(theme.fg("dim", `rows ${scroll + 1}-${end} of ${items.length}`), w));
      }
      lines.push(
        truncateToWidth(
          theme.fg("dim", `↑↓ move · Space toggle · A all/none · Enter ${commitVerb.toLowerCase()} selected · Esc cancel`),
          w,
        ),
      );
      return lines;
    };

    const handleInput = (data: string): void => {
      if (matchesKey(data, Key.up)) {
        moveToSelectable(-1);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        moveToSelectable(1);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.space)) {
        toggleCurrent();
        tui.requestRender();
        return;
      }
      if (data.toLowerCase() === "a") {
        const enabled = items.filter((item) => !item.disabled);
        const allSelected = enabled.length > 0 && enabled.every((item) => selected.has(item.value));
        selected.clear();
        if (!allSelected) for (const item of enabled) selected.add(item.value);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        if (selected.size > 0) done(selectedValues(items, selected));
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done(null);
      }
    };

    return {
      render,
      invalidate() {},
      handleInput,
    };
  });

  return result ?? [];
}

/**
 * Pick zero or more session rows and return their stable ids.
 *
 * TUI gets a true single-screen multi-select. RPC/Pi Web gets the same selection
 * model over its single-value protocol, with no mutation until final commit.
 */
export async function selectMany(
  ctx: MultiSelectContext,
  title: string,
  items: readonly MultiSelectItem[],
  options: MultiSelectOptions = {},
): Promise<string[]> {
  if (items.length === 0) {
    ctx.ui.notify?.(options.emptyLabel ?? "Nothing to choose.", "info");
    return [];
  }
  if (ctx.mode === "tui") return selectManyTui(ctx, title, items, options);
  return selectManyRpc(ctx, title, items, options);
}
