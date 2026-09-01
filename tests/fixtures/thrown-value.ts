/**
 * A value that leaves through `throw`. Whoever catches it reads the members,
 * and `catch (error)` types that value `unknown` — so not one of those reads
 * has a reference to show for it.
 */
interface SpillError {
  ladle: string;
  message: string;
}

const spill = (message: string): SpillError => ({ ladle: 'copper', message });

export function pour(full: boolean): string {
  if (full) throw spill('the pot is full');
  return 'poured';
}

/** The same departure, written out one line at a time. */
interface ScorchError {
  pan: string;
  minutes: number;
}

export function bake(burnt: boolean): string {
  if (burnt) {
    const scorch: ScorchError = { pan: 'iron', minutes: 40 };
    throw scorch;
  }
  return 'baked';
}

/** The control: the same shape, handed around and never thrown. */
interface StirNote {
  deadWhisk: string;
  turns: number;
}

export function stir(note: StirNote): number {
  return note.turns;
}
