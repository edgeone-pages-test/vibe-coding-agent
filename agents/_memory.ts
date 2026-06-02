import { HISTORY_FETCH_LIMIT } from './_constants';
import { createProjectState } from './_project';
import type { ConversationMessage, ProjectState } from './_types';
import { sanitizeAssistantText } from './utils/_text';

export async function getHistory(context: any, conversationId: string): Promise<ConversationMessage[]> {
  // context.store only exposes conversation-scoped message APIs, not a generic KV store.
  // Read this conversation's messages and filter them into user/assistant text pairs.
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
  // Sanitize assistant content before writing history so control sequences or raw JSON
  // from new concatenation paths do not pollute the next prompt.
  const safeContent = role === 'assistant' ? sanitizeAssistantText(content) : content;
  await context.store.appendMessage({
    conversationId,
    role,
    content: safeContent,
  });
}

export async function getProjectState(context: any, conversationId: string): Promise<ProjectState> {
  // Project state is conversation metadata, not a chat message. On first access,
  // the conversation may not exist yet, so fall back to the default state.
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
  // updateConversation shallow-merges metadata; replace projectState as a whole.
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectState: state },
    });
  } catch (error: any) {
    // If no messages have been written, the conversation does not exist yet and
    // updateConversation throws MemoryNotFoundError. appendMessage will create it
    // later in this turn, and the next saveProjectState call can write normally.
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}
