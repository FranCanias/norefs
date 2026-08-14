// Nothing reads `key` through a Ticket. The two written type arguments below
// do: `Ticket` only satisfies `T extends { key: string }` because it has one.
export interface Ticket {
  key: string;
  summary: string;
  deadRank: number;
}

export function firstOpen<T extends { key: string }>(items: T[]): T | undefined {
  return items.find(item => item.key !== '');
}

export type Indexed<T extends { key: string }> = Map<string, T>;

export function summarize(board: Indexed<Ticket>): string {
  const found = firstOpen<Ticket>([...board.values()]);
  return found ? found.summary : '';
}
