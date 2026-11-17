import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 基础路径配置
// 对于 GitHub Pages (username.github.io)，使用 '/'
// 对于 项目页 (username.github.io/repo)，使用 '/repo-name/'
// 使用环境变量 VITE_BASE_URL 覆盖，默认 '/'
export const BASE_URL = process.env.VITE_BASE_URL || '/';

// https://vite.dev/config/
export default defineConfig({
  base: BASE_URL,
  plugins: [react()],
})
