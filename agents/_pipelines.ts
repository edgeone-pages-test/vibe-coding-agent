import { runCodingAgent } from './_agent';
import { AUTO_FIX_MAX_ATTEMPTS } from './_constants';
import {
  appendTurn,
  getHistory,
  getProjectState,
  saveProjectState,
} from './_memory';
import {
  getFileTree,
  readFileFromSandbox,
  runVerification,
} from './_project';
import type {
  AgentProgressEvent,
  BuildStatus,
  FileTreeItem,
  ScaffoldLog,
  StreamSend,
} from './_types';
import { buildAutoFixPrompt } from './utils/_build-errors';
import { normalizeRelPath } from './utils/_paths';
import { sanitizeAssistantText } from './utils/_text';

function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createStreamResponse(run: (send: StreamSend) => Promise<void>) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send: StreamSend = (event) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      run(send)
        .catch((error) => {
          send({
            type: 'error',
            error: error instanceof Error ? error.message : '请求处理失败。',
          });
        })
        .finally(() => {
          closed = true;
          controller.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-stream': 'true',
    },
  });
}

function getRequestHeader(context: any, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';

  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '');
  }

  const lowerName = name.toLowerCase();
  const value = headers[name] ?? headers[lowerName];
  return typeof value === 'string' ? value : String(value || '');
}

function queryValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return queryValueToString(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function getSearchParamFromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }

  const raw = rawValue.trim();
  try {
    if (raw.startsWith('?')) {
      return new URLSearchParams(raw.slice(1)).get(name) || '';
    }
    if (raw.includes('?') || raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
      return new URL(raw, 'http://local').searchParams.get(name) || '';
    }
    if (raw.includes('=')) {
      return new URLSearchParams(raw).get(name) || '';
    }
  } catch {
    return '';
  }

  return '';
}

function getRequestQueryParam(context: any, name: string): {
  value: string;
  source: string;
} {
  const request = context?.request || {};
  const stringFields = [
    'url',
    'path',
    'pathname',
    'search',
    'queryString',
    'rawUrl',
    'originalUrl',
  ];
  for (const field of stringFields) {
    const value = getSearchParamFromString(request[field], name);
    if (value) {
      return { value, source: `request.${field}` };
    }
  }

  const queryObjects = [
    { source: 'request.query', value: request.query },
    { source: 'request.params', value: request.params },
    { source: 'request.searchParams', value: request.searchParams },
    { source: 'context.query', value: context?.query },
    { source: 'context.params', value: context?.params },
  ];
  for (const query of queryObjects) {
    if (query.value && typeof query.value.get === 'function') {
      const value = query.value.get(name);
      if (value) {
        return { value: queryValueToString(value), source: query.source };
      }
      continue;
    }
    if (!query || typeof query !== 'object') continue;
    const value = query.value?.[name];
    const normalized = queryValueToString(value);
    if (normalized) {
      return { value: normalized, source: query.source };
    }
  }

  return { value: '', source: 'none' };
}

function getRequestDebugSnapshot(context: any): Record<string, unknown> {
  const request = context?.request || {};
  const snapshot: Record<string, unknown> = {
    requestKeys: Object.keys(request).slice(0, 24),
  };
  for (const field of ['url', 'path', 'pathname', 'search', 'queryString', 'rawUrl', 'originalUrl']) {
    if (typeof request[field] === 'string' && request[field]) {
      snapshot[field] = request[field].slice(0, 300);
    }
  }
  for (const field of ['query', 'params', 'searchParams']) {
    const value = request[field];
    if (value && typeof value === 'object') {
      snapshot[field] = typeof value.entries === 'function'
        ? Object.fromEntries(Array.from(value.entries() as Iterable<[PropertyKey, unknown]>).slice(0, 20))
        : Object.keys(value).slice(0, 20);
    }
  }
  return snapshot;
}

function maskConversationId(value: string): string {
  if (!value) return '<empty>';
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

export async function runFileReadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'pages-agent-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const conversationSource = contextConversationId
    ? 'context.conversation_id'
    : pagesHeaderConversationId
      ? 'pages-agent-conversation-id'
      : headerConversationId
        ? 'conversationId'
        : 'none';
  const diagnosticBase = {
    contextConversationId: maskConversationId(contextConversationId),
    pagesHeaderConversationId: maskConversationId(pagesHeaderConversationId),
    headerConversationId: maskConversationId(headerConversationId),
    selectedConversationId: maskConversationId(conversationId),
    selectedConversationSource: conversationSource,
  };
  const pathParam = getRequestQueryParam(context, 'path');
  const relPath = pathParam.value;
  if (!conversationId) {
    console.log('[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'missing conversation_id',
    });
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const norm = normalizeRelPath(relPath);
  if (!norm) {
    console.log('[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'invalid path',
      request: getRequestDebugSnapshot(context),
    });
    return new Response(JSON.stringify({ ok: false, error: 'invalid path' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const state = await getProjectState(context, conversationId);
  console.log('[file-read]', {
    ...diagnosticBase,
    rawPath: relPath,
    pathSource: pathParam.source,
    normalizedPath: norm,
    appDir: state.appDir,
    stage: 'before-read',
  });
  const res = await readFileFromSandbox(context, state, norm);
  console.log('[file-read]', {
    ...diagnosticBase,
    normalizedPath: norm,
    appDir: state.appDir,
    ok: res.ok,
    error: res.error,
    size: res.size,
    truncated: res.truncated,
    stage: 'after-read',
  });
  return new Response(
    JSON.stringify({ path: norm, ...res }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export async function runChatPipeline(context: any, message: string, send: StreamSend) {
  const conversationId = String(context.conversation_id || '');

  if (!message) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: conversationId,
        reply: '请先描述你想构建的页面或功能。',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  const state = await getProjectState(context, conversationId);
  const history = await getHistory(context, conversationId);
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();

  send({
    type: 'status',
    message: '正在执行 Agent 流程',
  });

  const handleScaffoldLog = (log: ScaffoldLog) => {
    if (!isInitialProjectTurn) {
      return;
    }
    send({
      type: 'log',
      phase: 'scaffold',
      stream: log.stream,
      message: log.content,
    });
  };
  const forwardProgress = (event: AgentProgressEvent) => {
    // 直接转发结构化过程事件给前端，前端按 type 分支渲染。
    if (
      !isInitialProjectTurn
      && event.type === 'tool_use'
      && (event.data.name === 'ensure_project_scaffold' || event.data.name.endsWith('__ensure_project_scaffold'))
    ) {
      hiddenScaffoldToolUseIds.add(event.data.id);
      return;
    }
    if (!isInitialProjectTurn && event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data.tool_use_id)) {
      return;
    }
    if (event.type === 'text_segment' && state.previewUrl) {
      send({
        ...event,
        data: {
          ...event.data,
          text: stripReturnedPreviewLinks(event.data.text, state.previewUrl),
        },
      } as unknown as Record<string, unknown>);
      return;
    }
    send(event as unknown as Record<string, unknown>);
  };
  const pushFileTree = async (fallbackMessage: string): Promise<FileTreeItem[]> => {
    try {
      const tree = await getFileTree(context, state);
      send({
        type: 'file_tree',
        data: {
          root: state.appDir,
          items: tree,
        },
      });
      return tree;
    } catch (error) {
      send({
        type: 'log',
        phase: 'agent',
        stream: 'stderr',
        message: error instanceof Error ? error.message : fallbackMessage,
      });
      return [];
    }
  };
  const pushEarlyFileTree = async () => {
    // scaffold 一成功就提前推一份 file_tree，让 Files 面板不必等本轮结束。
    // 失败不致命：本轮收尾时下面还会再推一次最终状态。
    await pushFileTree('scaffold 后读取文件列表失败');
  };

  // 模型只负责代码层的创造性工作；下面的构建、服务步骤都保持确定性。
  const modelResult = await runCodingAgent(
    context,
    message,
    history,
    state,
    !state.created,
    handleScaffoldLog,
    forwardProgress,
    pushEarlyFileTree,
  );
  const assistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelResult.success && modelResult.output
      ? modelResult.output
      : modelResult.error || 'Agent 没有生成有效回复。'
  ) || 'Agent 没有生成有效回复。', state.previewUrl);

  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });

  if (modelResult.fatal) {
    await appendTurn(context, conversationId, 'user', message);
    await appendTurn(context, conversationId, 'assistant', assistantReply);
    await saveProjectState(context, conversationId, state);

    send({
      type: 'result',
      data: {
        ok: false,
        reply: assistantReply,
        conversation_id: conversationId,
        build: {
          status: 'skipped' as BuildStatus,
          stderr: modelResult.error || assistantReply,
        },
        preview: {},
      },
    });
    return;
  }

  if (!modelResult.projectTouched) {
    await appendTurn(context, conversationId, 'user', message);
    await appendTurn(context, conversationId, 'assistant', assistantReply);

    send({
      type: 'result',
      data: {
        ok: modelResult.success,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  let fileTree = await pushFileTree('文件列表读取失败');
  let build = await runVerification(context, state);
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  if (build.fatal) {
    const fatalReply = build.stderr || '任务失败，后续流程已终止。';
    await appendTurn(context, conversationId, 'user', message);
    await appendTurn(context, conversationId, 'assistant', fatalReply);
    await saveProjectState(context, conversationId, state);

    send({
      type: 'result',
      data: {
        ok: false,
        reply: fatalReply,
        conversation_id: conversationId,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build,
        files: {
          root: state.appDir,
          items: fileTree,
        },
        preview: {},
      },
    });
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    send({
      type: 'status',
      message: `验证失败，正在自动修复 1/${AUTO_FIX_MAX_ATTEMPTS}`,
    });

    const autoFixPrompt = buildAutoFixPrompt(
      message,
      assistantReply,
      build,
      1,
      AUTO_FIX_MAX_ATTEMPTS,
    );
    const autoFixResult = await runCodingAgent(
      context,
      autoFixPrompt,
      [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: assistantReply },
      ],
      state,
      false,
      handleScaffoldLog,
      forwardProgress,
      pushEarlyFileTree,
    );
    autoFixReply = stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl);

    if (autoFixReply) {
      send({
        type: 'agent',
        data: {
          ok: autoFixResult.success,
          reply: autoFixReply,
          ...(autoFixResult.error ? { error: autoFixResult.error } : {}),
        },
      });
    }

    fileTree = await pushFileTree('自动修复后读取文件列表失败');
    build = await runVerification(context, state);
    if (build.fatal) {
      const fatalReply = build.stderr || '任务失败，后续流程已终止。';
      await appendTurn(context, conversationId, 'user', message);
      await appendTurn(context, conversationId, 'assistant', fatalReply);
      await saveProjectState(context, conversationId, state);

      send({
        type: 'result',
        data: {
          ok: false,
          reply: fatalReply,
          conversation_id: conversationId,
          project: {
            dir: state.appDir,
            created: modelResult.wasCreated,
          },
          build,
          files: {
            root: state.appDir,
            items: fileTree,
          },
          preview: {},
        },
      });
      return;
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };

  // dev server 启动与浏览器预热已交给 agent 模型完成；外层不再重复启动服务。
  // 模型在 get_preview_link 中会写入 state.previewUrl / state.sandboxDebugUrl。
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
        },
      },
    });
  }

  const autoFixSuffix = autoFixAttempts > 0
    ? build.status === 'success'
      ? ` 已根据验证错误自动修复 ${autoFixAttempts} 轮，并已通过验证。`
      : ` 已自动修复 ${autoFixAttempts} 轮，但验证仍失败；最终日志已保留用于继续排查。`
    : '';
  const buildFailedSuffix = build.status === 'failed' && autoFixAttempts === 0
    ? ' 当前验证失败，我没有把它描述成已成功更新；请根据日志继续排查。'
    : '';
  const missingPreviewSuffix = state.previewUrl
    ? ''
    : ' 未获取到预览链接，请继续要求 Agent 调用 start_preview_server 并调用 get_preview_link。';
  const baseReply = autoFixReply || assistantReply;
  const reply = stripReturnedPreviewLinks(
    `${baseReply}${autoFixSuffix}${buildFailedSuffix}${missingPreviewSuffix}`,
    state.previewUrl,
  );

  // 先 append 本轮的两条消息（这会顺带创建 conversation），再写 projectState 到 metadata。
  await appendTurn(context, conversationId, 'user', message);
  await appendTurn(context, conversationId, 'assistant', reply);
  await saveProjectState(context, conversationId, state);

  send({
    type: 'result',
    data: {
      ok: modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl),
      reply,
      conversation_id: conversationId,
      project: {
        dir: state.appDir,
        created: modelResult.wasCreated,
      },
      build,
      files: {
        root: state.appDir,
        items: fileTree,
      },
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
        ...(!state.previewUrl ? { error: 'Agent 没有完成 start_preview_server 或 get_preview_link。' } : {}),
      },
    },
  });
}
