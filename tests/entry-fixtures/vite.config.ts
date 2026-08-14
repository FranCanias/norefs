export default {
  build: {
    rollupOptions: {
      input: { preload: 'src/preload.ts' },
    },
  },
};
