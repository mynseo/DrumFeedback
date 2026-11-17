import { defineConfig } from 'vite';

export default defineConfig({
  // 상대 경로로 빌드해서 GitHub Pages(/DrumFeedback/)나 다른 하위 경로에서도 그대로 동작하게 한다
  base: './',
});
