import { HISTORY_FETCH_LIMIT } from './_constants';
import { createProjectState } from './_project';
import type { ConversationMessage, ProjectState } from './_types';
import { sanitizeAssistantText } from './utils/_text';

export async function getHistory(context: any, conversationId: string): Promise<ConversationMessage[]> {
  // context.store 只暴露 conversation 维度的消息 API，没有通用 KV。
  // 历史就直接读取本会话的消息列表，再过滤成 user/assistant 文本对。
  try {
    const messages = await context.store.getMessages({
      conversationId,
      limit: HISTORY_FETCH_LIMIT,
      order: 'asc',
    });
    const items = Array.isArray(messages) ? messages : (messages?.items || []);
    return items
      .filter((item: any) => item.role === 'user' || item.role === 'assistant')
      .map((item: any) => ({
        role: item.role as 'user' | 'assistant',
        content: typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item.content ?? ''),
      }));
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return [];
    }
    throw error;
  }
}

export async function appendTurn(
  context: any,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  // assistant 内容兜底再过一遍清洗，避免新拼接逻辑把控制序列/原始 JSON 写进历史污染下一轮 prompt。
  const safeContent = role === 'assistant' ? sanitizeAssistantText(content) : content;
  await context.store.appendMessage({
    conversationId,
    role,
    content: safeContent,
  });
}

export async function getProjectState(context: any, conversationId: string): Promise<ProjectState> {
  // 项目状态不是会话消息，挂在 conversation metadata 上；首次访问会话还不存在时回退到默认值。
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.projectState as ProjectState | undefined;
    if (stored && typeof stored === 'object') {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return createProjectState(conversationId);
}

export async function saveProjectState(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  // updateConversation 是浅合并 metadata；这里把 projectState 整体覆盖成最新值。
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectState: state },
    });
  } catch (error: any) {
    // 还没有任何消息写入时 conversation 尚未建立，updateConversation 会抛 MemoryNotFoundError。
    // 此时无需特别处理：本轮稍后会通过 appendMessage 创建 conversation，
    // 下一轮再调用 saveProjectState 时即可正常写入。
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}
