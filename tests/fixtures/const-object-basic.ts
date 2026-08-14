export const Timeouts = {
  SAVE_DEBOUNCE: 1000,
  DIAGRAM_UPDATE_DELAY: 300,
} as const;

export function saveDelay(): number {
  return Timeouts.SAVE_DEBOUNCE;
}
