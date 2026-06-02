export function stringifyToolResult(result: unknown) {
  if (typeof result === 'string') {
    return result;
  }
  const json = JSON.stringify(result, null, 2);
  return typeof json === 'string' ? json : String(result);
}

// When maxTurns truncates or the claude CLI subprocess fails, the SDK may mix
// raw tool_use JSON blocks and terminal control sequences into resultMessage.result.
// Writing that content back into history pollutes the next prompt and can make
// the model continue emitting JSON. Clean it here in one place.
export function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input;

  // 1. Terminal control sequences: ESC[ number; number terminator, including bracketed paste markers.
  text = text.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '');
  // 2. Bare [200~ / [201~ markers left after ESC was stripped by an upstream layer.
  text = text.replace(/\[20[01]~/g, '');
  // 3. Other common ANSI escape leftovers.
  text = text.replace(/\x1b\][^\x07]*\x07/g, '');
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // 4. Leaked reasoning fragments: complete <think>...</think> blocks or trailing unclosed blocks.
  text = stripThinkBlocks(text);

  // 5. Raw tool_use / tool_result JSON fragments, for example:
  //    {"type":"tool_use","id":"...","name":"...","input":{...}}
  //    Remove the whole object with brace matching so nested quotes do not break regex parsing.
  text = stripJsonBlocksMatching(text, /\{\s*"type"\s*:\s*"(?:tool_use|tool_result)"/);

  // 6. Collapse three or more newlines.
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '');
}

// Find each JSON object start matching startPattern, then remove the whole
// object using brace matching. startPattern must match at the opening `{`.
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
      // Keep the original content if brace matching fails to avoid removing valid text.
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

// Detect whether tool_result text indicates a sandbox infrastructure failure:
// - "Not Found": LazySandbox's characteristic response when some routes are not initialized.
// - "Sandbox is not initialized": LazySandbox initialization failure.
// - "Running instances limit exceeded": sandbox instance quota is full; retries are not useful.
// - "Duplicate request detected": duplicate sandbox startup request; continuing would pollute context.
// Any match is fatal for the current agent run.
export function detectFatalToolError(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Match strictly so a literal "not found" in user files is not treated as infrastructure failure.
  if (/^Not Found\.?$/i.test(trimmed)) {
    return 'The EdgeOne sandbox API returned Not Found. Sandbox infrastructure is unavailable, so this agent run was stopped.';
  }
  if (/Sandbox is not initialized/i.test(trimmed)) {
    return 'The EdgeOne sandbox is not initialized, so this agent run was stopped.';
  }
  if (/Running instances limit exceeded(?:\s*\(max\s+\d+\))?/i.test(trimmed)) {
    return 'The EdgeOne sandbox running-instance limit has been reached, so this agent run was stopped.';
  }
  if (/Duplicate request detected\.\s*Please check your previous request result\.?/i.test(trimmed)) {
    return 'A duplicate EdgeOne sandbox startup request was detected, so this agent run was stopped.';
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
  return `${text.slice(0, max)}\n\n[Log truncated; ${text.length - max} characters were omitted]`;
}
