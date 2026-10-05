/**
 * Shared Tailwind class strings.
 *
 * Tailwind's main trade-off is repetition, so the handful of controls that
 * appear on more than one screen are defined once here.
 *
 * Note: the button variants are written out in full rather than sharing a base
 * string. Two conflicting utilities of the same type (e.g. `text-base` and
 * `text-sm`) resolve by stylesheet order, not by their order in the class
 * attribute, so layering them would be unpredictable.
 */
export const PANEL = 'flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5';

export const HEADING = 'text-sm font-semibold text-slate-200';

export const LABEL = 'text-[0.7rem] font-semibold uppercase tracking-wider text-slate-400';

export const MUTED = 'text-sm text-slate-400';

export const INPUT =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-base text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-50';

export const BTN_PRIMARY =
  'rounded-lg bg-red-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50';

export const BTN_GHOST =
  'rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

export const BTN_DANGER =
  'rounded-lg border border-red-900 px-4 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-50';

// Page shells. One wide (the room), one narrow (the landing screen).
export const SHELL = 'mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-10';
export const SHELL_NARROW = 'mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8 sm:px-6 sm:py-14';

export const BADGE = 'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold';

// Small status dot, used next to the connection label.
export const DOT = 'inline-block h-2 w-2 shrink-0 rounded-full';

// Compact neutral button, for secondary actions inside a list row.
export const BTN_ROW =
  'rounded-md border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

// Compact destructive button, for actions that live inside a list row.
export const BTN_REMOVE =
  'rounded-md border border-red-900 px-2.5 py-1 text-xs font-semibold text-red-300 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-50';
