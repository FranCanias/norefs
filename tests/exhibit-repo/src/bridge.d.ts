interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}
declare const api: Bridge;
declare function useMemo<T>(factory: () => T, deps: unknown[]): T;
declare function useImperativeHandle<T>(ref: unknown, factory: () => T): void;
declare function theme(name: string): string;
