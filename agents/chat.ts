import {
  createStreamResponse,
  runChatPipeline,
} from './_pipelines';

export async function onRequest(context: any) {
  // /chat 是整条流水线的总控：恢复状态 → 模型改代码并启动 dev → build → 回链路。
  const message = String(context?.request?.body?.message || '').trim();
  return createStreamResponse((send) => runChatPipeline(context, message, send));
}
