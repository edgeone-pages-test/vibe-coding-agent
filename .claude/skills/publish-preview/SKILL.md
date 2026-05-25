---
name: publish-preview
description: Publish a live preview after editing or generating a web project. Use this skill whenever the project server has already been started on internal port 3000 by the start_preview_server tool and should be exposed through sandbox.getHost(3000) — triggers include phrases like "preview", "run it", "show me", "see the result", "查看效果", "预览", or any request that implies the user wants to view the app after a code change.
---

# Publish preview

You have just finished editing files in the project's app directory, installed dependencies, and called the `start_preview_server` tool to start a long-running HTTP server on internal port 3000. The public preview is generated from `sandbox.getHost(3000)` by `get_preview_link`. To make the result viewable, perform these two steps **in order**, calling each tool exactly once unless a step fails. The app directory is the one returned by `ensure_project_scaffold` (typically `projects/<id>/app`).

## Step 1 — Confirm HTTP readiness

Call `mcp__edgeone-sandbox__commands` with `timeoutMs: 35000` and:

```sh
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000 >/dev/null && exit 0; sleep 1; done; exit 1
```

If this exits non-zero, read `/tmp/dev.log` via `mcp__edgeone-sandbox__commands` (`cat /tmp/dev.log`) and surface the relevant error to the user. **Do not proceed to step 2** — the preview is not ready. Do not start a fixed framework command from this skill; the `start_preview_server` tool is responsible for starting the correct Next, Vite, Node, Python, or custom server command before using this skill.

## Step 2 — Return the public preview link

Call `get_preview_link` (no arguments). It returns `{ url, sandboxDebugUrl }`. `url` is the actual preview the user opens; `sandboxDebugUrl` is an internal sandbox-inspection link and may be undefined. Do **not** construct either field yourself — only use the values returned by this tool.

When summarizing to the user, mention briefly that the preview is ready. The host application will render the link button automatically; you do not need to paste the URL into your reply. **Never quote internal URLs (`http://127.0.0.1:*`, `http://localhost:*`) or echo back tool inputs in your reply** — they would render as broken clickable links.
