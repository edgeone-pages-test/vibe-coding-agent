import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_MODEL,
  DEFAULT_PATH,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  PREVIEW_SERVER_PORT,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants';
import {
  buildPreviewLinkTool,
  buildProjectScaffoldTool,
  buildStartPreviewServerTool,
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
  safeJsonString,
  sanitizeAssistantText,
  truncateForStream,
} from './utils/_text';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

// Prompt 约束模型的核心约束：理解需求 → 生成/修改项目 → 启动预览服务 → 获取预览链接。
export function buildPrompt(
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  mcpServerName: string,
) {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`)
    .join('\n');

  return [
    '你是一个 Web Dev Agent，在远程沙箱中创建和修改可运行的 Web 项目。',
    '你可以按用户需求创建 Next.js、Vite/React、静态前端、Node 服务、Python Flask/FastAPI 服务或其它轻量 Web 项目；不要把项目固定为 Next.js。',
    `唯一允许修改的项目目录是 ${state.appDir}。`,
    `所有文件、命令、浏览器、代码执行操作都必须通过 ${mcpServerName} MCP 工具在远程沙箱中完成。`,
    '你必须先判断用户需求是否属于 Web 项目、页面、组件、交互、样式或代码开发。',
    '如果用户需求不是项目开发相关，直接回复：我只能帮助创建或修改 Web 项目，请描述你想构建的页面或功能。不要调用任何工具。',
    '如果用户需求需要创建或修改项目，必须先调用 ensure_project_scaffold 工具准备工作区，然后再检查或修改项目文件。',
    `在调用 ensure_project_scaffold 之前，不要读取、写入或执行 ${state.appDir} 下的任何内容。`,
    '不要使用云函数本地文件系统作为项目工作区，不要修改项目目录之外的业务文件。',
    '如果 ensure_project_scaffold 返回 created=false，先检查现有代码，再根据用户需求做最小且完整的修改。',
    [
      '如果 ensure_project_scaffold 返回 created=true，必须按顺序完成：',
      '1. 根据用户需求确定技术栈和文件列表。',
      '2. 调用 write_project_files 一次或少数几次批量写入完整可运行文件；参数必须是 {"files":[{"path":"相对路径","content":"完整文件内容"}]}。',
      '3. 根据生成的项目安装依赖；Node/前端项目默认使用 npm install，用户明确要求 pnpm/yarn 时可使用对应包管理器；Python 项目使用 python -m pip install -r requirements.txt。',
      `4. 调用 start_preview_server 工具启动内部 ${PREVIEW_SERVER_PORT} 端口服务；公开预览由 get_preview_link 通过 sandbox.getHost(${PREVIEW_SERVER_PORT}) 加 envdAccessToken 生成，不要手写 npm run dev 后台命令。`,
      `5. 使用 publish-preview skill 确认 HTTP 就绪并调用 get_preview_link；不要调用 browser 工具预热、fetch 或截图。`,
    ].join('\n'),
    '不要只写占位页面；生成的文件必须完整、内部一致、可直接安装和运行。',
    '优先用 write_project_files 创建或替换多个项目文件；路径必须是相对项目目录的路径，files 必须优先传数组，不要传字符串。',
    'write_project_files / files_write 只用于 UTF-8 文本源码和配置，不得写入图片、字体、音视频、压缩包等二进制资源，也不要把大段 base64 当作文本写入。',
    '尽量不要生成图片、字体、音视频、压缩包等二进制文件；优先使用 CSS、SVG、emoji、远程公开资源链接或现有依赖能力实现视觉效果，以节约 token 和写入成本。',
    '仅当用户明确要求、功能确实依赖、且没有轻量替代方案时，才允许创建二进制资源；此时必须使用沙箱 commands 工具在项目目录内生成、下载或解码资源，不得用文件写入工具直接写。',
    '禁止手写 lockfile、node_modules、.next、dist、build、缓存目录或包管理器生成物。',
    '命令失败时必须先阅读错误并定位具体问题；只修复具体文件、依赖或配置，不要整体重生成项目，不要重复执行同一个失败修复。',
    '优先做最小且完整的修改，保持现有项目结构和风格；不要做与用户需求无关的重构。',
    'Next.js 项目必须使用 App Router 常规结构；配置文件使用 next.config.js 或 next.config.mjs，不要生成 next.config.ts。',
    'Vite 项目不要在 vite.config 中硬编码临时沙箱预览域名；如果需要配置 server.allowedHosts，只能从 process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS 读取并填入显式列表，不要设置 allowedHosts: true。',
    '如果生成 TypeScript 项目，确保导入、类型和路由用法能通过构建或验证。',
    '不要在回复里粘贴大段代码；最终回复默认使用用户当前 prompt 的主要语言，中英混合时跟随主要语言；技术名词、错误日志、非预览链接原文保留。',
    '不要声明未验证成功的结果；如果失败，简洁说明失败点和下一步。',
    `完成代码修改和依赖安装后，必须调用 start_preview_server 工具启动内部 ${PREVIEW_SERVER_PORT} 端口服务，然后使用 publish-preview skill 调用 get_preview_link 发布 getHost(${PREVIEW_SERVER_PORT}) 预览供用户查看。`,
    '不要自行拼 preview URL 或 sandboxDebugUrl，只能使用 get_preview_link 返回的字段。',
    '不要在最终回复中输出预览按钮、预览链接、preview URL 或 sandboxDebugUrl；预览只通过右侧预览面板展示。',
    '不要截图。',
    isNewProject ? '当前可能还没有准备项目工作区。' : '当前会话之前已经准备过项目工作区。',
    recentHistory ? `最近对话：\n${recentHistory}` : '',
    `当前用户需求：${userMessage}`,
    '如果用户需求不明确，请询问用户具体需求。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runCodingAgent(
  context: any,
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  onScaffoldLog?: (log: ScaffoldLog) => void,
  onProgress?: (event: AgentProgressEvent) => void,
  onScaffoldDone?: () => void | Promise<void>,
): Promise<CodingAgentResult> {
  // 模型接入优先走 AI Gateway，再兼容 Anthropic / DeepSeek 旧配置。
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
      error: '缺少 AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY，Agent 无法调用模型。',
      projectTouched: false,
      wasCreated: false,
    };
  }

  if (!baseURL) {
    return {
      success: false,
      output: null,
      error: '缺少 AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL，Agent 无法调用模型。',
      projectTouched: false,
      wasCreated: false,
    };
  }

  const sdkEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    // @anthropic-ai/sdk 会把 ANTHROPIC_CUSTOM_HEADERS 注入每次模型请求。
    ANTHROPIC_CUSTOM_HEADERS: customHeaders
      ? `${customHeaders}\n${GATEWAY_QUOTA_BYPASS_HEADER}\n${GATEWAY_QUOTA_PROMPT_HEADER}`
      : `${GATEWAY_QUOTA_BYPASS_HEADER}\n${GATEWAY_QUOTA_PROMPT_HEADER}`,
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
      throw new Error('当前 Pages Agent Runtime 缺少 context.tools.toClaudeMcpServer，请升级到支持 pages-agent-toolkit 新 Tools API 的运行时。');
    }
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    let projectTouched = false;
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
    const previewLinkTool = buildPreviewLinkTool(context, state);
    const startPreviewServerTool = buildStartPreviewServerTool(context, state);
    const writeProjectFilesTool = buildWriteProjectFilesTool(
      context,
      state,
      async () => {
        projectTouched = true;
        await onScaffoldDone?.();
      },
    );
    const mcpTools = [
      ...edgeoneMcp.tools,
      scaffoldTool,
      writeProjectFilesTool,
      startPreviewServerTool,
      previewLinkTool,
    ];
    const mcpAllowedTools = [
      ...edgeoneMcp.allowedTools,
      `mcp__${mcpServerName}__ensure_project_scaffold`,
      `mcp__${mcpServerName}__write_project_files`,
      `mcp__${mcpServerName}__start_preview_server`,
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
      maxTurns: 18,
      // 禁用 Claude Code 内置本地工具，只允许模型通过 EdgeOne sandbox MCP 工具读写/执行。
      // 注意：SDK 文档说设置 `skills` 后会自动启用 Skill 工具，不依赖 `tools` 字段。
      tools: [],
      mcpServers: {
        [mcpServerName]: sandboxMcpServer,
      },
      allowedTools: mcpAllowedTools,
      strictMcpConfig: true,
      systemPrompt: buildPrompt(userMessage, history, state, isNewProject, mcpServerName),
      env: sdkEnv,
      // Skills：从 cwd 向上扫描 .claude/skills/ 加载文件型 skill。
      // start_preview_server 工具负责启动内部 3000；publish-preview 负责确认 HTTP 就绪并发布 getHost(3000) 预览链接。
      cwd: process.cwd(),
      settingSources: ['project'],
      skills: ['publish-preview'],
    };

    if (executablePath) {
      sdkOptions.pathToClaudeCodeExecutable = executablePath;
    }

    const sdkQuery = query({
      prompt: userMessage,
      options: sdkOptions,
    });

    let resultMessage: SDKResultMessage | null = null;
    // 沙箱基础设施级故障（如 EdgeOne LazySandbox 路由 Not Found）会让所有后续工具调用全部失败，
    // 模型继续重试只会消耗 turn 并污染上下文。一旦命中就立即终止本轮 query，给上层一个明确错误。
    let fatalError: string | null = null;
    // [诊断探针] 独立记录 tool_use_id -> name，用于在 tool_result 时回查，
    // 不依赖 pendingToolUses（那个 Map 在 extractCodeSnapshotsFromEvent 里会被 delete）。
    const probeToolNames = new Map<string, string>();
    const SCAFFOLD_TOOL_NAME = `mcp__${mcpServerName}__ensure_project_scaffold`;
    // 一轮对话里 scaffold 最多触发一次「立即推送 file_tree」，避免重复 find。
    let scaffoldHandled = false;

    for await (const event of sdkQuery as AsyncIterable<SDKMessage>) {
      console.log('event', JSON.stringify(event, null, 2));
      // [诊断探针] 同时把 tool_use / tool_result 摘要事件流给前端，用于在 assistant
      // 消息里实时展示「正在做什么」。input/preview 都做长度截断，避免大文件 write 把流灌爆。
      if (event.type === 'assistant') {
        const blocks = (event as any).message?.content;
        const evUuid = typeof (event as any).uuid === 'string' ? (event as any).uuid : '';
        if (Array.isArray(blocks)) {
          // 把本条 assistant message 里所有 text block 串起来，作为一个"段"实时推送到前端。
          // 前端按 uuid 维护 segment map，到达顺序拼成完整内容，达到分段流式效果。
          const textPieces: string[] = [];
          for (const b of blocks) {
            if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
              textPieces.push(b.text);
            }
          }
          if (textPieces.length && evUuid) {
            onProgress?.({
              type: 'text_segment',
              data: {
                uuid: evUuid,
                text: textPieces.join(''),
              },
            });
          }
          for (const b of blocks) {
            if (b?.type === 'tool_use') {
              const inputJson = safeJsonString(b.input);
              if (typeof b.id === 'string' && typeof b.name === 'string') {
                probeToolNames.set(b.id, b.name);
              }
              // console.log('[probe] tool_use', b.name, 'id=', b.id, 'input=', inputJson);
              onProgress?.({
                type: 'tool_use',
                data: {
                  id: typeof b.id === 'string' ? b.id : '',
                  name: typeof b.name === 'string' ? b.name : '<unknown>',
                  inputPreview: truncateForStream(inputJson, 500),
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
              const toolName = probeToolNames.get(b.tool_use_id) || '<unknown>';
              // 完整 dump：tool 名 + 是否报错 + 整段 content（不截断，便于排查 exit status 1 之类的简短结果）
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
                  ok: b.is_error !== true,
                  preview: truncateForStream(text, 500),
                },
              });
              // 一旦 ensure_project_scaffold 工具成功返回，立刻通知外层去推一份 file_tree，
              // 让 Files 面板不必等 runCodingAgent 整轮结束。
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
              // 沙箱基础设施级故障检测：只在 is_error=true 的工具回执上判定，避免误伤正常文本里的 "Not Found"。
              if (b.is_error === true && !fatalError) {
                const fatal = detectFatalToolError(text);
                if (fatal) {
                  fatalError = `${fatal}（tool=${toolName}）`;
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
      // 检测到致命错误就立刻退出循环，不再等模型继续 turn。
      if (fatalError) {
        break;
      }
    }

    // 致命错误优先于正常 result 处理：哪怕这一轮 SDK 还产出了 result，也用 fatalError 替换。
    if (fatalError) {
      try {
        await (sdkQuery as any)?.return?.();
      } catch {
        // 忽略：SDK 不一定支持 return()，能停就停。
      }
      return {
        success: false,
        output: null,
        error: fatalError,
        projectTouched,
        wasCreated,
        fatal: true,
      };
    }

    if (!resultMessage) {
      return {
        success: false,
        output: null,
        error: '模型流已结束，但没有返回结果。',
        projectTouched,
        wasCreated,
      };
    }

    // [probe] 打印 resultMessage 真实形状（截断），便于排查 SDK 输出污染问题。
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
          : '模型执行失败。',
        projectTouched,
        wasCreated,
      };
    }

    return {
      success: true,
      output: sanitizeAssistantText((resultMessage.result || '').trim()),
      error: null,
      projectTouched,
      wasCreated,
    };
  } catch(e) {
    console.error(e);
    const message = e instanceof Error ? e.message : String(e);
    const fatal = detectFatalToolError(message);
    return {
      success: false,
      output: null,
      error: fatal || message || '执行失败。',
      projectTouched: false,
      wasCreated: false,
      ...(fatal ? { fatal: true } : {}),
    };
  } finally {
    // sdkQuery.close();
  }
}
