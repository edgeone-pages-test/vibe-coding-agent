import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_MODEL,
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants';
import {
  buildPreviewLinkTool,
  buildProjectScaffoldTool,
  buildPublishPreviewTool,
  buildWriteProjectFilesTool,
} from './tools/_project-tools';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ConversationMessage,
  ProjectState,
  ScaffoldLog,
} from './_types';
import {
  detectFatalToolError,
  sanitizeAssistantText,
  truncateForStream,
} from './utils/_text';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildAnthropicCustomHeaders(customHeaders: string, conversationId: string) {
  const safeConversationId = sanitizeHeaderValue(conversationId);
  return [
    customHeaders,
    GATEWAY_QUOTA_BYPASS_HEADER,
    GATEWAY_QUOTA_PROMPT_HEADER,
    safeConversationId
      ? `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: ${safeConversationId}`
      : '',
  ].filter(Boolean).join('\n');
}

function shortenToolName(name: string) {
  const match = name.match(/^mcp__[^_]+__(.+)$/);
  return match ? match[1] : name;
}

function extractSandboxCommand(input: unknown) {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

function isBrowserSandboxToolName(name: string) {
  return name.toLowerCase().includes('browser');
}

function isInstallCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\bpnpm\s+install\b/.test(normalized)
    || /\byarn\s+install\b/.test(normalized)
    || /\bbun\s+install\b/.test(normalized)
    || /\bpython3?\s+-m\s+pip\s+install\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}

function isPreviewCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(normalized)
    || /\b(next|vite|astro|nuxt)\s+dev\b/.test(normalized)
    || /\bpython\s+-m\s+http\.server\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
}

type ToolProgressPhase = 'scaffold' | 'code' | 'install' | 'preview' | 'link';

function inferToolProgress(name: string, input: unknown): {
  phaseHint?: ToolProgressPhase;
  fileCount?: number;
} {
  const toolName = shortenToolName(name);
  if (toolName === 'ensure_project_scaffold') {
    return { phaseHint: 'scaffold' };
  }
  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phaseHint: 'preview' };
  }
  if (toolName === 'files_write' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phaseHint: 'code' };
  }
  if (toolName === 'write_project_files') {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const files = Array.isArray(record.files) ? record.files : [];
    return {
      phaseHint: 'code',
      ...(files.length > 0 ? { fileCount: files.length } : {}),
    };
  }
  if (toolName === 'commands') {
    const cmd = extractSandboxCommand(input);
    if (isInstallCommand(cmd)) {
      return { phaseHint: 'install' };
    }
    if (isPreviewCommand(cmd)) {
      return { phaseHint: 'preview' };
    }
  }
  return {};
}

// Prompt-level guardrails: understand the request, generate or modify the project,
// then publish the preview link.
export function buildPrompt(
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  mcpServerName: string,
) {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n');

  return [
    'You are a Web Dev Agent that creates and modifies runnable web projects in a remote sandbox.',
    'You may create Next.js, Vite/React, static frontend, Node service, Python Flask/FastAPI, or other lightweight web projects according to the user request. Do not force every project to be Next.js.',
    `The only project directory you may modify is ${state.appDir}.`,
    `All file, command, browser, and code-execution operations must be performed through the ${mcpServerName} MCP tools in the remote sandbox.`,
    'If the user asks who you are, what you are, or what kind of agent you are, answer directly that you are the Vibe Coding Agent示例 on EdgeOne Makers, an out-of-the-box Agent template. In Chinese, reply: 我是 EdgeOne Makers 上的 Vibe Coding Agent示例，一个开箱即用的 Agent 模板，可以帮助你创建和修改可运行的 Web 项目。 Do not call any tools, and do not use the non-project refusal for identity questions.',
    'First decide whether the user request is about a web project, page, component, interaction, styling, or code development.',
    'If the user request is not related to project development, reply exactly: I can only help create or modify web projects. Please describe the page or feature you want to build. Do not call any tools.',
    'If the user request requires creating or modifying a project, you must call ensure_project_scaffold first to prepare the workspace, then inspect or modify project files.',
    `Before calling ensure_project_scaffold, do not read, write, or execute anything under ${state.appDir}.`,
    'Do not use the cloud function local filesystem as the project workspace, and do not modify business files outside the project directory.',
    'If ensure_project_scaffold returns created=false, inspect the existing code first, then make the smallest complete change needed for the user request.',
    [
      'If ensure_project_scaffold returns created=true, complete these steps in order:',
      '1. Choose the tech stack and file list based on the user request.',
      '2. Call write_project_files once or a small number of times to batch-write complete runnable files. The argument must be {"files":[{"path":"relative/path","content":"complete file contents"}]}.',
      '3. Install dependencies for the generated project. Use npm install by default for Node/frontend projects, use pnpm/yarn only when explicitly requested, and use python -m pip install -r requirements.txt for Python projects.',
      `4. Call the publish_preview tool. It starts the internal service on port ${PREVIEW_SERVER_PORT}, verifies that ${PREVIEW_PATH_PREFIX} is HTTP-ready, and generates the public preview with sandbox.getHost(${PREVIEW_PUBLIC_PORT}) + ${PREVIEW_PATH_PREFIX} + envdAccessToken. Do not hand-write background npm run dev commands.`,
    ].join('\n'),
    'Do not write only placeholder pages. Generated files must be complete, internally consistent, and directly installable and runnable.',
    'Prefer write_project_files to create or replace multiple project files. Paths must be relative to the project directory. Prefer passing files as an array, not a string.',
    'write_project_files / files_write are only for UTF-8 text source and configuration files. Do not write images, fonts, audio/video, archives, or other binary assets, and do not write large base64 blocks as text.',
    'Avoid generating images, fonts, audio/video, archives, or other binary files when possible. Prefer CSS, SVG, emoji, public remote asset URLs, or existing dependency capabilities for visual effects to save tokens and write cost.',
    'Only create binary assets when the user explicitly requests them, the feature truly depends on them, and there is no lightweight alternative. In that case, use the sandbox commands tool inside the project directory to generate, download, or decode assets. Do not write them directly with file-writing tools.',
    'Do not hand-write lockfiles, node_modules, .next, dist, build, cache directories, or package-manager generated artifacts.',
    'When a command fails, read the error and identify the specific issue first. Fix only the specific file, dependency, or configuration. Do not regenerate the whole project, and do not repeat the same failed fix.',
    'Prefer the smallest complete change, preserving the existing project structure and style. Do not refactor anything unrelated to the user request.',
    'Next.js projects must use the standard App Router structure. Use next.config.js or next.config.mjs for configuration; do not generate next.config.ts.',
    "Next.js projects must support basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || '' in next.config.js or next.config.mjs. Do not hard-code /preview into business routes.",
    `Vite projects must support sandbox preview under ${PREVIEW_PATH_PREFIX}: use base ${PREVIEW_PATH_PREFIX}; server.host='0.0.0.0'; server.port=${PREVIEW_SERVER_PORT}; server.strictPort=true; server.allowedHosts=true; server.hmr={ protocol:'wss', clientPort:443 }; legacy.skipWebSocketTokenCheck=true; do not set server.hmr.path.`,
    'Vite React projects must install @vitejs/plugin-react and configure plugins: [react()] to preserve React Fast Refresh.',
    'Do not hard-code temporary sandbox preview domains in vite.config.',
    'If you generate a TypeScript project, ensure imports, types, and routing APIs can pass build or verification.',
    'Do not paste large code blocks in the reply. The final response should use the main language of the current user prompt by default; if the prompt mixes languages, follow the primary language. Keep technical terms, error logs, and non-preview links unchanged.',
    'The final response must be a concrete conclusion tailored to the current user request, explaining what was completed and the preview/verification result. For example, if the user asks for "a pomodoro timer with stats and theme switching", reply with something like "Built the pomodoro timer with stats and theme switching. The preview is ready in the right panel." Do not say only "Done, please check the result."',
    'Do not claim success for anything that was not verified successfully. If it failed, briefly explain the failure point and the next step.',
    `After code changes and dependency installation, you must call publish_preview to publish the getHost(${PREVIEW_PUBLIC_PORT})${PREVIEW_PATH_PREFIX} preview for the user. publish_preview handles startup and validation of the internal ${PREVIEW_SERVER_PORT} preview service. get_preview_link is only a legacy alias; do not prefer it.`,
    'Do not synthesize preview URLs or sandboxDebugUrl. Use only the fields returned by publish_preview or get_preview_link.',
    'Do not include preview buttons, preview links, preview URLs, or sandboxDebugUrl in the final response. The preview is shown only in the right preview panel.',
    'Do not take screenshots.',
    'Do not include emoji in the response.',
    isNewProject ? 'The project workspace may not have been prepared yet.' : 'This conversation has already prepared a project workspace.',
    recentHistory ? `Recent conversation:\n${recentHistory}` : '',
    `Current user request: ${userMessage}`,
    'If the user request is unclear, ask the user for the specific requirement.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runCodingAgent(
  context: any,
  conversationId: string,
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  onScaffoldLog?: (log: ScaffoldLog) => void,
  onProgress?: (event: AgentProgressEvent) => void,
  onScaffoldDone?: () => void | Promise<void>,
): Promise<CodingAgentResult> {
  // Prefer AI Gateway for model access, with backward-compatible Anthropic / DeepSeek config.
  const apiKey = pickEnvValue(context, 'AI_GATEWAY_API_KEY')
    || pickEnvValue(context, 'ANTHROPIC_API_KEY')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const authToken = pickEnvValue(context, 'ANTHROPIC_AUTH_TOKEN')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const model = pickEnvValue(context, 'AI_GATEWAY_MODEL')
    || pickEnvValue(context, 'ANTHROPIC_MODEL')
    || pickEnvValue(context, 'DEEPSEEK_MODEL')
    || DEFAULT_MODEL;
  const baseURL = pickEnvValue(context, 'AI_GATEWAY_BASE_URL')
    || pickEnvValue(context, 'ANTHROPIC_BASE_URL')
    || pickEnvValue(context, 'DEEPSEEK_BASE_URL')
    || '';
  const customHeaders = pickEnvValue(context, 'ANTHROPIC_CUSTOM_HEADERS');
  const executablePath = pickEnvValue(context, 'CLAUDE_CODE_EXECUTABLE_PATH');

  if (!apiKey && !authToken) {
    return {
      success: false,
      output: null,
      error: 'Missing AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY. The agent cannot call the model.',
      projectTouched: false,
      wasCreated: false,
    };
  }

  if (!baseURL) {
    return {
      success: false,
      output: null,
      error: 'Missing AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL. The agent cannot call the model.',
      projectTouched: false,
      wasCreated: false,
    };
  }

  const sdkEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    // @anthropic-ai/sdk injects ANTHROPIC_CUSTOM_HEADERS into each model request.
    ANTHROPIC_CUSTOM_HEADERS: buildAnthropicCustomHeaders(customHeaders, conversationId),
    PATH: pickEnvValue(context, 'PATH') || DEFAULT_PATH,
    HOME: pickEnvValue(context, 'HOME') || '/tmp',
    CLAUDE_CONFIG_DIR: pickEnvValue(context, 'CLAUDE_CONFIG_DIR') || '/tmp/.claude',
  };

  if (apiKey) {
    sdkEnv.ANTHROPIC_API_KEY = apiKey;
  }
  if (authToken) {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = authToken;
  }
  if (!sdkEnv.ANTHROPIC_API_KEY && authToken) {
    sdkEnv.ANTHROPIC_API_KEY = authToken;
  }
  try {
    const mcpServerName = SANDBOX_MCP_SERVER_NAME;
    if (typeof context.tools?.toClaudeMcpServer !== 'function') {
      throw new Error('The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.');
    }
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    const sandboxTools = edgeoneMcp.tools.filter((tool) => !isBrowserSandboxToolName(tool.name));
    const sandboxAllowedTools = edgeoneMcp.allowedTools.filter((toolName) => !isBrowserSandboxToolName(toolName));
    let projectTouched = false;
    let previewTouched = false;
    let wasCreated = false;
    const scaffoldTool = buildProjectScaffoldTool(
      context,
      state,
      onScaffoldLog,
      ({ created }) => {
        projectTouched = true;
        wasCreated = created;
      },
    );
    const previewLinkTool = buildPreviewLinkTool(
      context,
      state,
      () => {
        previewTouched = true;
      },
    );
    const publishPreviewTool = buildPublishPreviewTool(
      context,
      state,
      () => {
        previewTouched = true;
      },
    );
    const writeProjectFilesTool = buildWriteProjectFilesTool(
      context,
      state,
      async () => {
        projectTouched = true;
        await onScaffoldDone?.();
      },
    );
    const mcpTools = [
      ...sandboxTools,
      scaffoldTool,
      writeProjectFilesTool,
      publishPreviewTool,
      previewLinkTool,
    ];
    const mcpAllowedTools = [
      ...sandboxAllowedTools,
      `mcp__${mcpServerName}__ensure_project_scaffold`,
      `mcp__${mcpServerName}__write_project_files`,
      `mcp__${mcpServerName}__publish_preview`,
      `mcp__${mcpServerName}__get_preview_link`,
    ];

    const sandboxMcpServer = createSdkMcpServer({
      name: mcpServerName,
      tools: mcpTools,
      alwaysLoad: true,
    });

    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      model,
      permissionMode: 'dontAsk',
      // maxTurns: 100,
      // Disable Claude Code built-in local tools so the model can only read,
      // write, and execute through EdgeOne sandbox MCP tools.
      tools: [],
      mcpServers: {
        [mcpServerName]: sandboxMcpServer,
      },
      allowedTools: mcpAllowedTools,
      strictMcpConfig: true,
      systemPrompt: buildPrompt(userMessage, history, state, isNewProject, mcpServerName),
      env: sdkEnv,
      // publish_preview starts the internal port 3000 service, verifies /preview/
      // readiness, and publishes the getHost(9000)/preview/ preview link.
      cwd: process.cwd(),
      settingSources: ['project'],
      debug: true,
      stderr: (data: string) => {
        console.log('[claude-code stderr]', data.trimEnd());
      },
    };

    if (executablePath) {
      sdkOptions.pathToClaudeCodeExecutable = executablePath;
    }

    const sdkQuery = query({
      prompt: userMessage,
      options: sdkOptions,
    });

    let resultMessage: SDKResultMessage | null = null;
    // Sandbox infrastructure failures, such as EdgeOne LazySandbox routes returning
    // Not Found, make all later tool calls fail. Retrying only consumes turns and
    // pollutes context, so stop this query immediately with a clear upper-layer error.
    let fatalError: string | null = null;
    // Diagnostic probe: independently record tool_use_id -> tool context for tool_result
    // lookup, without relying on pendingToolUses, which is deleted in extractCodeSnapshotsFromEvent.
    const probeToolContext = new Map<string, { name: string; command?: string }>();
    const SCAFFOLD_TOOL_NAME = `mcp__${mcpServerName}__ensure_project_scaffold`;
    // Push file_tree immediately at most once per turn after scaffold, avoiding duplicate find calls.
    let scaffoldHandled = false;

    for await (const event of sdkQuery as AsyncIterable<SDKMessage>) {
      console.log('event', JSON.stringify(event, null, 2));
      // Forward only structured tool progress to the frontend. Model thinking,
      // pre-tool narration, and tool input stay out of the UI to avoid exposing
      // reasoning and raw JSON.
      if (event.type === 'assistant') {
        const blocks = (event as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_use') {
              const toolName = typeof b.name === 'string' ? b.name : '<unknown>';
              const shortToolName = shortenToolName(toolName);
              const command = shortToolName === 'commands' ? extractSandboxCommand(b.input) : '';
              if (typeof b.id === 'string' && typeof b.name === 'string') {
                probeToolContext.set(b.id, {
                  name: b.name,
                  ...(command ? { command } : {}),
                });
              }
              const progress = typeof b.name === 'string'
                ? inferToolProgress(toolName, b.input)
                : {};
              onProgress?.({
                type: 'tool_use',
                data: {
                  id: typeof b.id === 'string' ? b.id : '',
                  name: toolName,
                  ...(command ? { command } : {}),
                  ...progress,
                },
              });
            }
          }
        }
      } else if (event.type === 'user') {
        const blocks = (event as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_result') {
              const text = Array.isArray(b.content)
                ? b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
                : (typeof b.content === 'string' ? b.content : '');
              const toolContext = probeToolContext.get(b.tool_use_id);
              const toolName = toolContext?.name || '<unknown>';
              // Full dump: tool name, error flag, and complete content without truncation,
              // useful for short failures such as exit status 1.
              // console.log(
              //   '[probe] tool_result',
              //   'tool=', toolName,
              //   'id=', b.tool_use_id,
              //   'is_error=', b.is_error === true,
              //   'content=', JSON.stringify(b.content),
              // );
              onProgress?.({
                type: 'tool_result',
                data: {
                  tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
                  toolName,
                  ...(toolContext?.command ? { command: toolContext.command } : {}),
                  ok: b.is_error !== true,
                  preview: truncateForStream(text, 500),
                },
              });
              // Once ensure_project_scaffold succeeds, notify the outer pipeline to
              // push file_tree so the Files panel does not wait for the whole runCodingAgent turn.
              if (
                !scaffoldHandled
                && toolName === SCAFFOLD_TOOL_NAME
                && b.is_error !== true
              ) {
                scaffoldHandled = true;
                try {
                  await onScaffoldDone?.();
                } catch (err) {
                  console.log('[scaffold-done] onScaffoldDone failed', err);
                }
              }
              // Detect sandbox infrastructure failures only on is_error=true tool
              // results, avoiding false positives from normal text containing "Not Found".
              if (b.is_error === true && !fatalError) {
                const fatal = detectFatalToolError(text);
                if (fatal) {
                  fatalError = `${fatal} (tool=${toolName})`;
                  console.log('[fatal] aborting agent loop:', fatalError);
                }
              }
            }
          }
        }
      }
      if (event.type === 'system' && event.subtype === 'init') {
        console.log('mcp servers', event.mcp_servers);
      }
      if (event.type === 'result') {
        resultMessage = event;
        break;
      }
      // Exit the loop immediately after a fatal error instead of waiting for more model turns.
      if (fatalError) {
        break;
      }
    }

    // Fatal errors take priority over normal results, even if the SDK produced
    // a result for this turn.
    if (fatalError) {
      try {
        await (sdkQuery as any)?.return?.();
      } catch {
        // Ignore this because the SDK may not support return(); stop it when possible.
      }
      return {
        success: false,
        output: null,
        error: fatalError,
        projectTouched,
        previewTouched,
        wasCreated,
        fatal: true,
      };
    }

    if (!resultMessage) {
      return {
        success: false,
        output: null,
        error: 'The model stream ended without returning a result.',
        projectTouched,
        previewTouched,
        wasCreated,
      };
    }

    // Probe the real resultMessage shape, truncated, when debugging SDK output pollution.
    try {
      const probe = JSON.stringify(resultMessage);
      // console.log('[probe] resultMessage', probe ? probe.slice(0, 4000) : '<unstringifiable>');
    } catch (err) {
      // console.log('[probe] resultMessage stringify failed', err);
    }

    if (resultMessage.subtype !== 'success') {
      return {
        success: false,
        output: null,
        error: Array.isArray(resultMessage.errors) && resultMessage.errors.length > 0
          ? resultMessage.errors[0]
          : 'Model execution failed.',
        projectTouched,
        previewTouched,
        wasCreated,
      };
    }

    return {
      success: true,
      output: sanitizeAssistantText((resultMessage.result || '').trim()),
      error: null,
      projectTouched,
      previewTouched,
      wasCreated,
    };
  } catch(e) {
    console.error(e);
    const message = e instanceof Error ? e.message : String(e);
    const fatal = detectFatalToolError(message);
    return {
      success: false,
      output: null,
      error: fatal || message || 'Execution failed.',
      projectTouched: false,
      wasCreated: false,
      ...(fatal ? { fatal: true } : {}),
    };
  } finally {
    // sdkQuery.close();
  }
}
