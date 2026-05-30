export function stringifyToolResult(result: unknown) {
  if (typeof result === 'string') {
    return result;
  }
  const json = JSON.stringify(result, null, 2);
  return typeof json === 'string' ? json : String(result);
}

// SDK 在 maxTurns 截断 / claude CLI 子进程异常时，会把原始 tool_use JSON 块和
// 终端控制序列（bracketed paste \e[200~/\e[201~、ANSI CSI）混进 resultMessage.result。
// 这些内容如果原样回写历史，会污染下一轮 prompt（模型会模仿着继续吐 JSON）。
// 这里集中做一次清洗：去控制序列、剥 thinking/tool JSON 片段、收敛连续空行。
export function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input;

  // 1. 终端控制序列：ESC[ 数字; 数字 终止符（含 \e[200~ / \e[201~ bracketed paste）
  text = text.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '');
  // 2. 裸出现的 [200~ / [201~（ESC 已被某层吃掉，只剩括号那段）
  text = text.replace(/\[20[01]~/g, '');
  // 3. 其它常见 ANSI 转义残留
  text = text.replace(/\x1b\][^\x07]*\x07/g, '');
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // 4. 模型 reasoning 泄漏片段：完整 <think>...</think> 或末尾未闭合 <think> 块。
  text = stripThinkBlocks(text);

  // 5. tool_use / tool_result 原始 JSON 片段：形如
  //    {"type":"tool_use","id":"...","name":"...","input":{...}}
  //    用括号配平算法整段抠掉，避免内嵌引号造成正则失配。
  text = stripJsonBlocksMatching(text, /\{\s*"type"\s*:\s*"(?:tool_use|tool_result)"/);

  // 6. 收敛三个以上换行
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '');
}

// 从 text 中找出所有匹配 startPattern 的 JSON 对象起点，做花括号配平把整段对象删除。
// startPattern 必须能在 `{` 处匹配（即包含起始的 `{`）。
function stripJsonBlocksMatching(text: string, startPattern: RegExp): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const m = rest.match(startPattern);
    if (!m || m.index === undefined) {
      out += rest;
      break;
    }
    out += rest.slice(0, m.index);
    const start = i + m.index;
    const end = findJsonObjectEnd(text, start);
    if (end < 0) {
      // 配平失败，保留原样，避免把正常内容误删
      out += text.slice(start);
      break;
    }
    i = end + 1;
  }
  return out;
}

function findJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function safeJsonString(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return typeof s === 'string' ? s : String(input);
  } catch {
    return String(input);
  }
}

// 判断一段 tool_result 文本是否表明沙箱基础设施挂了：
// - "Not Found"：EdgeOne LazySandbox 在某些路由未初始化时的特征响应
// - "Sandbox is not initialized"：LazySandbox 抛出的初始化错误
// - "Running instances limit exceeded"：沙箱实例配额已满，后续重试/构建/预览都没有意义
// - "Duplicate request detected"：沙箱启动请求重复，继续跑 agent 会污染上下文
// 命中任意一条就视为致命错误，应立即终止本轮 agent，不再让模型重试。
export function detectFatalToolError(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 严格匹配：避免把用户文件里出现 "not found" 这种字面量误判成基础设施故障。
  if (/^Not Found\.?$/i.test(trimmed)) {
    return 'EdgeOne 沙箱接口返回 Not Found，沙箱基础设施不可用，已终止本轮 Agent。';
  }
  if (/Sandbox is not initialized/i.test(trimmed)) {
    return 'EdgeOne 沙箱尚未初始化，已终止本轮 Agent。';
  }
  if (/Running instances limit exceeded(?:\s*\(max\s+\d+\))?/i.test(trimmed)) {
    return 'EdgeOne 沙箱运行实例数已达上限，已终止本轮 Agent。';
  }
  if (/Duplicate request detected\.\s*Please check your previous request result\.?/i.test(trimmed)) {
    return 'EdgeOne 沙箱启动请求重复，已终止本轮 Agent。';
  }
  return null;
}

export function truncateForStream(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(truncated ${text.length - max}b)`;
}

export function truncateForPrompt(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[日志已截断，剩余 ${text.length - max} 字符未包含]`;
}
