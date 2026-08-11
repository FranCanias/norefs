declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'declared-elsewhere' {
  export const value: number;
}
