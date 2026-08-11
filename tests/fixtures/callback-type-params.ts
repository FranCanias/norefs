export interface WithCallback {
  onMove: (arg: { dx: number; dy: number }) => void;
}

export function fire(w: WithCallback): void {
  w.onMove({ dx: 1, dy: 2 });
}

export let seen = 0;

export const handler: WithCallback = {
  onMove: ({ dx }) => {
    seen = dx;
  },
};
