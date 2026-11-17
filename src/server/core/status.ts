// The four point statuses, their look, and which moves between them are allowed.

export const STATUSES = ['Complete', 'WIP', 'In progress', 'Discarded'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_META: Record<Status, { sym: string; cls: string; colour: string; strike: boolean; help: string }> = {
  Complete: { sym: '✔', cls: 's-complete', colour: '#14794a', strike: true, help: 'Finished. Lovely work.' },
  WIP: { sym: '◐', cls: 's-wip', colour: '#b7791f', strike: false, help: 'Being prepared, not started yet.' },
  'In progress': { sym: '▶', cls: 's-prog', colour: '#1d58c4', strike: false, help: 'Someone is on it right now.' },
  Discarded: { sym: '✖', cls: 's-disc', colour: '#6b7280', strike: true, help: 'Set aside on purpose. Kept for the record.' },
};

/**
 * Allowed moves. Closed points (Complete / Discarded) can only be re-opened one careful step,
 * so a finished point is never silently flipped to something unrelated.
 */
const NEXT: Record<Status, readonly Status[]> = {
  WIP: ['In progress', 'Complete', 'Discarded'],
  'In progress': ['WIP', 'Complete', 'Discarded'],
  Complete: ['In progress'],
  Discarded: ['WIP'],
};

export const isStatus = (s: unknown): s is Status => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);
export const allowedNext = (from: Status): readonly Status[] => NEXT[from];
export const canTransition = (from: Status, to: Status): boolean => from !== to && NEXT[from].includes(to);
export const isClosed = (s: Status): boolean => s === 'Complete' || s === 'Discarded';
/** Complete and Discarded points are shown struck through. */
export const isStruck = (s: Status): boolean => STATUS_META[s].strike;
