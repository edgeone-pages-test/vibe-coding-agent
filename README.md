# Web Dev Agent

一个用于 EdgeOne Pages Agent Runtime 的多技术栈开发模板。用户描述需求后，Agent 会在沙箱中准备项目工作区、生成或修改完整项目文件、安装依赖、启动实时预览，并生成可下载的源码包。

## 本地开发

```bash
npm install
npm run dev
```

## 运行时约定

- Agent 对话路由：`/chat`
- 文件预览路由：`/file?path=<relative-path>`
- Agent 框架：`claude-sdk`
- 单会话单项目：`projects/<conversation_id>/app`
- 项目类型：由 Agent 按用户需求生成，可为 Next.js、Vite/React、静态前端、Node 服务、Python 服务等
- 预览端口：`9000`
- 源码下载端口：`3001`
- 下载文件：`source.zip`

## 模型环境变量

模板默认优先读取 AI Gateway 配置：

- `AI_GATEWAY_API_KEY`
- `AI_GATEWAY_BASE_URL`
- `AI_GATEWAY_MODEL`

模型请求会自动追加请求头 `X-Gateway-Quota-Bypass: true`，用于跳过 Gateway 额度限制。

也兼容 Anthropic 风格变量：

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_CUSTOM_HEADERS`

也兼容：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`
- `DEEPSEEK_BASE_URL`

## 行为说明

- 每次代码改动后都会先刷新源码包，再执行可用的验证命令：有 `package.json` 且包含 `scripts.build` 时执行 `npm run build`，Python 项目会尝试 `python -m compileall .`，否则跳过验证
- 即使验证失败，源码包也会保留最新失败现场，方便下载排查
- 预览服务固定启动在 3000 端口，预览链接由 `getHost(3000)` 返回的地址拼接 `access_token` 后交给前端消费
