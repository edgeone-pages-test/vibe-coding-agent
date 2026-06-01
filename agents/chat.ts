import {
  createStreamResponse,
  runChatPipeline,
} from './_pipelines';

export async function onRequest(context: any) {
  // console.log('会话 id', context.conversation_id)
  // /chat 是整条流水线的总控：恢复状态 → 模型改代码并启动 dev → build → 回链路。
  const body = context?.request?.body || {};
  const message = String(body?.message || '').trim();
  const resetProject = body?.resetProject === true;
  return createStreamResponse((send) => runChatPipeline(context, message, send, { resetProject }));
}
