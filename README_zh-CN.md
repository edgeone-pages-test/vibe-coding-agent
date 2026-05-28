# Web Dev Agent

语言：[English](./README.md) | 简体中文

一个基于 EdgeOne 沙箱的 Web 开发 Agent 模板，用于在沙箱中编写、预览、验证和迭代现代 Web 应用。

用户描述想要构建的内容后，Agent 会准备隔离的沙箱工作区，生成或修改项目文件，安装依赖，发布实时预览，并返回验证结果。

## 功能特性

### 基于沙箱的项目工作区

- 每个会话创建或复用一个项目工作区。
- 生成的项目文件保存在 `projects/<conversation_id>/app`。
- 文件操作、命令执行、浏览器访问和代码执行都通过 EdgeOne 沙箱 MCP 工具完成。

### Claude Agent SDK 集成

- 使用 `@anthropic-ai/claude-agent-sdk` 作为 Agent 运行时。
- 将 EdgeOne 沙箱工具加载为名为 `edgeone-sandbox` 的 MCP 服务。
- 通过 `permissionMode: 'dontAsk'` 和受限工具集运行模型，确保项目操作留在沙箱内。

### 多技术栈生成与迭代

- 可根据用户需求创建或修改轻量 Web 项目。
- 支持 Next.js、Vite/React、静态前端、Node 服务、Python Flask/FastAPI 服务以及类似 Web 应用技术栈。
- 后续对话会复用现有沙箱项目，并做聚焦修改，而不是每次重建整个项目。

### 通过 `/preview/` 实时预览

- 在沙箱内部 `3000` 端口启动生成项目。
- 通过沙箱公开 `9000` 端口和 `/preview/` 路径前缀暴露预览。
- 使用沙箱 `envdAccessToken` 拼接公开预览 URL，并交给前端 iframe 展示。

### 验证与自动修复反馈

- 当生成的 Node 项目包含 build 脚本时，执行 `npm run build`。
- 当存在 Python 文件时，执行 `python -m compileall .`。
- 找不到支持的验证目标时，返回 skipped 状态。
- Agent 成功运行后若验证失败，会尝试一轮自动修复。

### 文件与进度界面

- 将 Agent 过程以状态、工具调用、工具结果和日志的形式流式推送到前端。
- 展示沙箱项目文件树。
- 支持通过 `/file?path=<relative-path>` 预览文本文件。
- 前端界面内置中文和英文两套文案。

## 核心能力概览

### Agent 流程

1. 用户向 `/chat` 发送需求。
2. Chat pipeline 恢复对话历史和项目状态。
3. Coding Agent 准备沙箱项目工作区。
4. Agent 在沙箱中写入或更新项目文件，并安装依赖。
5. Agent 调用 `publish_preview` 启动开发服务并发布预览。
6. 运行时将文件树、验证结果、预览 URL 和最终回复通过流返回给前端。

### 预览流程

预览服务固定使用沙箱内部 `3000` 端口。公开访问地址由以下信息生成：

```text
sandbox.getHost(9000) + /preview/ + ?access_token=<envdAccessToken>
```

Vite 项目会使用临时预览配置适配沙箱路径：设置 `base: '/preview/'`，通过 `wss` 启用 websocket HMR，并在安装了 `@vitejs/plugin-react` 时保留 React Fast Refresh。

Next.js 项目必须提供 `next.config.js` 或 `next.config.mjs`，并包含：

```js
basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || ''
```

### 验证流程

- 如果存在 `package.json` 且包含 `scripts.build`，运行时执行 `npm run build`。
- 如果存在 Python 文件，运行时执行 `python -m compileall .`。
- 如果两类检查都不适用，验证结果为 skipped。
- 验证失败时，当前沙箱文件仍可在文件面板中查看，便于继续排查。

### 运行时约束

- 项目工作区限定在 `projects/<conversation_id>/app`。
- 生成的源码和配置文件应为 UTF-8 文本。
- 二进制资源、包管理器输出、构建产物、lockfile 和缓存目录会被阻止直接写入项目文件。
- EdgeOne Pages Agent Runtime 会注入沙箱 API，本模板不需要本地配置沙箱 API 凭证。

## 快速开始

### 前置条件

- Node.js
- npm

### 安装依赖

```bash
npm install
```

### 本地开发

```bash
npm run dev
```

打开开发服务器输出的本地 Next.js 地址即可查看应用。

### 生产构建

```bash
npm run build
npm run start
```

## 环境变量

### AI Gateway

模板会优先读取 AI Gateway 配置：

```bash
AI_GATEWAY_API_KEY=your-api-key
AI_GATEWAY_BASE_URL=your-gateway-base-url
AI_GATEWAY_MODEL=@makers/minimax-m2.7
```

模型请求会自动附加：

```text
X-Gateway-Quota-Bypass: true
X-Prompt-Log: true
```

### Anthropic 兼容变量

```bash
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_AUTH_TOKEN=your-auth-token
ANTHROPIC_MODEL=your-model
ANTHROPIC_BASE_URL=your-base-url
ANTHROPIC_CUSTOM_HEADERS=Header-Name: value
```

### DeepSeek 兼容变量

```bash
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=your-model
DEEPSEEK_BASE_URL=your-base-url
```

### 可选运行时覆盖

```bash
CLAUDE_CODE_EXECUTABLE_PATH=/path/to/claude
```

## 项目结构

```text
web-dev-agent/
├── app/                    # Next.js 前端界面
│   ├── layout.tsx          # 应用元数据和根布局
│   ├── page.tsx            # 对话、进度、预览和文件浏览界面
│   └── globals.css         # 全局样式
├── agents/                 # EdgeOne Pages Agent Runtime 路由和流水线
│   ├── chat.ts             # /chat 路由
│   ├── file.ts             # /file 路由
│   ├── _agent.ts           # Claude Agent SDK 集成
│   ├── _pipelines.ts       # 对话和文件读取流水线
│   ├── _project.ts         # 沙箱项目、预览和验证辅助逻辑
│   ├── tools/              # 自定义沙箱 MCP 工具
│   └── utils/              # 路径、文本和构建错误辅助逻辑
├── edgeone.json            # EdgeOne Pages Agent Runtime 配置
├── next.config.ts          # 模板应用的 Next.js 配置
├── package.json            # 脚本和依赖
└── tsconfig.json           # TypeScript 配置
```

## 运行时约定

- Agent 对话路由：`/chat`
- 文件预览路由：`/file?path=<relative-path>`
- Agent 框架：`claude-sdk`
- 沙箱 MCP 服务名：`edgeone-sandbox`
- 会话项目目录：`projects/<conversation_id>/app`
- 预览内部端口：`3000`
- 预览公开端口：`9000`
- 预览路径前缀：`/preview/`
- 默认模型：`@makers/minimax-m2.7`

## 部署

[![使用 EdgeOne Pages 部署](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/pages/new?template=vibe-coding-agent)

## 开发说明

- Agent 生成的用户项目文件应保存在沙箱工作区内，而不是本模板仓库中。
- 不要依赖本地文件系统直接写入生成项目。
- 预览启动和验证应优先使用确定性的运行时辅助逻辑；Agent 应调用 `publish_preview`，不要手动拼接公开预览 URL。
- 本仓库使用 Next.js canary 版本。修改 Next.js 应用代码前，请先阅读 `node_modules/next/dist/docs/` 下的相关本地文档。

## 致谢

- EdgeOne Pages Agent Runtime
- Claude Agent SDK
- Next.js
- React
- Tailwind CSS
