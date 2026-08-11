export type CommandMap = {
  play: { url: string; callback?: () => void };
  stop: { callback?: () => void };
};

export function send<K extends keyof CommandMap>(cmd: K, params: Omit<CommandMap[K], 'callback'>): unknown {
  return [cmd, params];
}

export function demo(): unknown {
  return send('play', { url: 'x' });
}
