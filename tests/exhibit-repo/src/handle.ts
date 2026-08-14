/**
 * The 0.3.0 review's imperative handle: the callee types that position from
 * the literal itself, so the checker cannot be asked what it expects. What it
 * does prove is that no `PanelHandle` can be written there — so this write is
 * no evidence about `reset`, and `reset` is dead.
 */
export interface PanelHandle {
  reset(): void;
  focus(): void;
}

export function attach(ref: unknown, panel: PanelHandle): void {
  panel.focus();
  useImperativeHandle(ref, () => ({ reset: 1 }));
}
