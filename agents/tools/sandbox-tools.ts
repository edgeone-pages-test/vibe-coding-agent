import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SANDBOX_MCP_SERVER_NAME } from '../constants';
import type { ClaudeMcpTool, PlatformTool } from '../types';
import { stringifyToolResult } from '../utils/text';

const TOOL_INPUT_SCHEMAS = {
  commands: {
    cmd: z.string().describe('Shell command to execute in the sandbox'),
    cwd: z.string().describe('Working directory in the sandbox').optional(),
    timeoutMs: z.number().describe('Maximum command runtime in milliseconds').optional(),
  },
  files: {
    op: z.enum(['read', 'write', 'list', 'exists', 'remove', 'makeDir']).describe('File operation'),
    path: z.string().describe('File or directory path in the sandbox'),
    content: z.string().describe('Content for write').optional(),
  },
  browser: {
    op: z.enum(['fetch', 'goto', 'click', 'type', 'evaluate']).describe('Browser operation'),
    url: z.string().describe('Target URL').optional(),
    selector: z.string().describe('CSS selector').optional(),
    text: z.string().describe('Text to type').optional(),
    script: z.string().describe('JavaScript to evaluate').optional(),
  },
  code_interpreter: {
    language: z.enum(['python', 'javascript', 'r', 'bash']).describe('Language to execute'),
    code: z.string().describe('Code to execute'),
  },
} satisfies Record<string, Record<string, z.ZodTypeAny>>;

export function buildEdgeOneMcpTools(context: any): {
  tools: ClaudeMcpTool[];
  allowedTools: string[];
} {
  const platformTools: PlatformTool[] = context.tools?.all?.() ?? [];
  const tools: ClaudeMcpTool[] = [];

  console.log('platform tools count', platformTools.length);

  for (const item of platformTools) {
    const name = item.name || item.function?.name;
    const execute = item.execute || item.handler || item.invoke;
    const inputSchema = name ? TOOL_INPUT_SCHEMAS[name as keyof typeof TOOL_INPUT_SCHEMAS] : undefined;

    if (!name || !inputSchema || typeof execute !== 'function') {
      console.log('skipped unsupported platform tool', name || '<unknown>');
      continue;
    }

    tools.push(defineClaudeTool(
      name,
      item.description || item.function?.description || `EdgeOne sandbox tool: ${name}`,
      inputSchema,
      async (args) => {
        try {
          const result = await execute.call(item, args as Record<string, any>, undefined);
          return {
            content: [{ type: 'text' as const, text: stringifyToolResult(result) }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          };
        }
      },
    ) as ClaudeMcpTool);
    console.log('registered platform tool', name);
  }

  return {
    tools,
    allowedTools: tools.map((tool) => `mcp__${SANDBOX_MCP_SERVER_NAME}__${tool.name}`),
  };
}
