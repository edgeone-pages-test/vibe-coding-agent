# Web Dev Agent

Language: English | [简体中文](./README_zh-CN.md)

A sandbox-based web development agent template for writing, previewing, validating, and iterating on modern web apps with EdgeOne Pages Agent Runtime.

Users describe what they want to build, and the agent prepares an isolated sandbox workspace, creates or updates project files, installs dependencies, publishes a live preview, and reports verification results.

## Features

### Sandbox-based project workspace

- Starts a fresh project workspace from the home page and reuses it for follow-up turns in the coding view.
- Keeps generated project files under `projects/<conversation_id>/app`.
- Runs file operations, commands, and code execution through the EdgeOne sandbox MCP tools.

### Claude Agent SDK integration

- Uses `@anthropic-ai/claude-agent-sdk` as the agent runtime.
- Loads the EdgeOne sandbox tools as an MCP server named `edgeone-sandbox`.
- Runs the model with `permissionMode: 'dontAsk'` and a restricted tool set so project work stays inside the sandbox.

### Multi-stack project generation and iteration

- Can create or modify lightweight web projects based on the user's request.
- Supports Next.js, Vite/React, static frontend projects, Node services, Python Flask/FastAPI services, and similar web app stacks.
- Starts fresh when a new request is submitted from the home page, then reuses the existing sandbox project on later turns in the coding view and applies focused changes.

### Live preview through `/preview/`

- Starts the generated project on the sandbox internal port `3000`.
- Exposes the preview through sandbox public port `9000` with the `/preview/` path prefix.
- Passes the public preview URL to the frontend iframe after adding the sandbox `envdAccessToken`.

### Verification and auto-fix feedback

- Runs `npm run build` when a generated Node project has a build script.
- Runs `python -m compileall .` for Python projects when Python files are present.
- Skips verification when no supported verification target is found.
- Attempts one automatic repair pass when verification fails after a successful agent run.

### Files and progress UI

- Streams agent progress to the frontend as status updates, tool calls, tool results, and logs.
- Shows a file tree for the sandbox project.
- Lets users preview text files through `/file?path=<relative-path>`.
- Provides a bilingual interface with Chinese and English UI copy.

## Core Features Overview

### Agent workflow

1. The user sends a request to `/chat`.
2. The chat pipeline restores the conversation history and project state.
3. The coding agent prepares the sandbox project workspace.
4. The agent writes or updates project files and installs dependencies inside the sandbox.
5. The agent calls `publish_preview` to start the dev server and publish the preview.
6. The runtime pushes the file tree, verification result, preview URL, and final reply back to the frontend stream.

### Preview workflow

The preview server always targets the sandbox internal port `3000`. Public access is built from:

```text
sandbox.getHost(9000) + /preview/ + ?access_token=<envdAccessToken>
```

Vite projects are adapted with a temporary preview config that sets `base: '/preview/'`, enables websocket HMR through `wss`, and keeps React Fast Refresh available when `@vitejs/plugin-react` is installed.

Next.js projects must include a `next.config.js` or `next.config.mjs` file with:

```js
basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || ''
```

### Verification workflow

- If `package.json` exists and has `scripts.build`, the runtime runs `npm run build`.
- If Python files are present, the runtime runs `python -m compileall .`.
- If neither check applies, verification is reported as skipped.
- Failed verification keeps the current sandbox files available for inspection in the file panel.

### Runtime constraints

- The project workspace is scoped to `projects/<conversation_id>/app`.
- Generated source and configuration files should be UTF-8 text.
- Binary assets, package manager output, build output, lockfiles, and cache directories are blocked from direct project-file writes.
- The EdgeOne Pages Agent Runtime injects the sandbox APIs; this template does not require local sandbox API credentials.

## Quick Start

### Prerequisites

- Node.js
- npm

### Installation

```bash
npm install
```

### Local development

```bash
npm run dev
```

Open the local Next.js app from the URL printed by the dev server.

### Production build

```bash
npm run build
npm run start
```

## Environment Variables

### AI Gateway

The template reads AI Gateway configuration first:

```bash
AI_GATEWAY_API_KEY=your-api-key
AI_GATEWAY_BASE_URL=your-gateway-base-url
AI_GATEWAY_MODEL=@makers/minimax-m2.7
```

Model requests automatically include:

```text
X-Gateway-Quota-Bypass: true
X-Prompt-Log: true
```

### Anthropic-compatible fallback

```bash
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_AUTH_TOKEN=your-auth-token
ANTHROPIC_MODEL=your-model
ANTHROPIC_BASE_URL=your-base-url
ANTHROPIC_CUSTOM_HEADERS=Header-Name: value
```

### DeepSeek-compatible fallback

```bash
DEEPSEEK_API_KEY=your-api-key
DEEPSEEK_MODEL=your-model
DEEPSEEK_BASE_URL=your-base-url
```

### Optional runtime override

```bash
CLAUDE_CODE_EXECUTABLE_PATH=/path/to/claude
```

## Project Structure

```text
web-dev-agent/
├── app/                    # Next.js frontend UI
│   ├── layout.tsx          # App metadata and root layout
│   ├── page.tsx            # Chat, progress, preview, and file browser UI
│   └── globals.css         # Global styles
├── agents/                 # EdgeOne Pages Agent Runtime routes and pipeline
│   ├── chat.ts             # /chat route
│   ├── file.ts             # /file route
│   ├── _agent.ts           # Claude Agent SDK integration
│   ├── _pipelines.ts       # Chat and file-read pipelines
│   ├── _project.ts         # Sandbox project, preview, and verification helpers
│   ├── tools/              # Custom sandbox MCP tools
│   └── utils/              # Path, text, and build-error helpers
├── edgeone.json            # EdgeOne Pages Agent Runtime configuration
├── next.config.ts          # Next.js configuration for this template app
├── package.json            # Scripts and dependencies
└── tsconfig.json           # TypeScript configuration
```

## Runtime Conventions

- Agent chat route: `/chat`
- File preview route: `/file?path=<relative-path>`
- Agent framework: `claude-sdk`
- Sandbox MCP server name: `edgeone-sandbox`
- Session project directory: `projects/<conversation_id>/app`
- Preview internal port: `3000`
- Preview public port: `9000`
- Preview path prefix: `/preview/`
- Default model: `@makers/minimax-m2.7`

## Deploy

[![Deploy with EdgeOne Pages](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/pages/new?template=vibe-coding-agent)

## Development Notes

- Keep agent-generated project files inside the sandbox workspace, not in this template repository.
- Do not rely on direct local filesystem writes for generated user projects.
- Prefer deterministic runtime helpers for preview startup and verification; the agent should call `publish_preview` instead of manually building a public preview URL.
- This repository uses a Next.js canary version. Before changing Next.js app code, read the relevant local docs under `node_modules/next/dist/docs/`.

## Acknowledgments

- EdgeOne Pages Agent Runtime
- Claude Agent SDK
- Next.js
- React
- Tailwind CSS
