import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Две страницы: игра и админка статистики.
    rollupOptions: { input: { main: 'index.html', admin: 'admin.html' } },
  },
});
