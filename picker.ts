/**
 * Picking more than one thing, and more rows than a picker shows.
 *
 * `ui.select` takes a flat list of strings and returns one choice, so both
 * problems - "there are 500 sessions and I can only see the first screen", and
 * "archiving one closes the dialog, so I have to type the command again" - are
 * solved the same way: drive the picker in a loop from here, so the interaction
 * stays on screen instead of returning to the prompt after every choice.
 */

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

export interface LoopChoice {
  action: "again" | "done" | "quit";
  /** The row the user picked this round, if any. */
  value?: string;
  page?: number;
}

/**
 * Keep listing and archiving until the user is finished, so one `/archive` can
 * tidy a dozen sessions instead of a dozen invocations.
 */
export async function archiveManyInOneGo(
  ctx: {
    ui: {
      select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  },
  options: {
    title: string;
    /** Rows currently available; called again after each archive. */
    rows: () => Promise<{ rows: string[] }>;
    /** Do the work for the picked row. Return whether it happened. */
    archive: (label: string) => Promise<boolean>;
    /** Summarise one archived row. */
    describe: (label: string) => string;
    pageSize?: number;
    titleSuffix?: string;
    emptyLabel?: string;
  },
): Promise<{ archived: number }> {
  let archived = 0;
  for (let round = 0; round < 200; round += 1) {
    // Re-read every round: the list shrinks as sessions leave the active root.
    const { rows } = await options.rows();
    if (rows.length === 0) {
      ctx.ui.notify(options.emptyLabel ?? "Nothing left to archive.");
      return { archived };
    }

    const picked = await selectPaged(ctx, options.title, rows, {
      pageSize: options.pageSize,
      titleSuffix: options.titleSuffix,
    });
    if (!picked.value) return { archived };

    const done = await options.archive(picked.value);
    if (done) {
      archived += 1;
      ctx.ui.notify(options.describe(picked.value));
    }

    // Staying in the loop is the whole point: no command to retype.
    const next = await ctx.ui.select("Archive more?", [
      `Yes - archive another (${archived} done so far)`,
      "No - I'm done",
    ]);
    if (!next?.startsWith("Yes")) return { archived };
  }
  ctx.ui.notify("Stopped after 200 sessions in one go.");
  return { archived };
}
