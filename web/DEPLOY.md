# StepDraw Web - GitHub Pages 部署指南

## 快速开始

### 1. 安装依赖

```bash
cd web
npm install
```

### 2. 本地预览构建结果

```bash
npm run build
npm run preview
```

### 3. 推送到 GitHub 自动部署

将代码推送到 `master` 分支后，GitHub Actions 会自动构建并部署到 GitHub Pages。

```bash
git add .
git commit -m "deploy: update web app"
git push origin master
```

## 配置 GitHub Pages

### 步骤 1: 创建 GitHub 仓库

1. 在 GitHub 上创建一个新仓库（例如 `StepDraw` 或 `stepdraw.github.io`）
2. 将本地仓库推送到 GitHub

### 步骤 2: 启用 GitHub Pages

1. 进入仓库的 **Settings** > **Pages**
2. 在 **Build and deployment** 下：
   - **Source**: 选择 `GitHub Actions`
3. 保存设置

### 步骤 3: 访问你的网站

部署成功后，访问：
- **用户/组织站点**: `https://<username>.github.io/`
- **项目站点**: `https://<username>.github.io/<repo-name>/`

## 自定义部署路径

如果要将网站部署到子目录（例如 `https://<username>.github.io/<repo-name>/`）：

```bash
# 设置环境变量
set VITE_BASE_URL=/StepDraw/
npm run build
```

然后修改 `.github/workflows/deploy.yml` 中的路径配置。

## 手动触发部署

如果自动部署没有触发，可以在 GitHub 上手动触发：

1. 进入仓库的 **Actions** 标签
2. 选择 "Deploy to GitHub Pages" workflow
3. 点击 **Run workflow**
4. 选择分支并点击 **Run workflow**

## 故障排查

### 构建失败

检查 `web/package.json` 中的依赖是否正确安装。

### 页面显示空白

1. 打开浏览器开发者工具，检查控制台错误
2. 确认 `vite.config.ts` 中的 `base` 路径配置正确
3. 检查资源文件路径是否正确

### 404 错误

确认 GitHub Pages 的源设置正确，并且构建已成功完成。
