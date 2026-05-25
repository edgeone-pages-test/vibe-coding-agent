import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  previewUrl?: string;
  sandboxDebugUrl?: string;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type StreamSend = (event: Record<string, unknown>) => void;

export type ScaffoldLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type CodingAgentResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  projectTouched: boolean;
  wasCreated: boolean;
  fatal?: boolean;
};

export type BuildResult = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
  fatal?: boolean;
};

export type ProjectFileInput = {
  path: string;
  content: string;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
};

// 流给前端的过程事件：tool_use 是模型调用工具的请求，tool_result 是工具回执。
// 前端用来在 assistant 消息里实时展示「正在做什么」。
export type AgentProgressEvent =
  | {
      type: 'tool_use';
      data: {
        id: string;
        name: string;
        inputPreview: string;
      };
    }
  | {
      type: 'tool_result';
      data: {
        tool_use_id: string;
        ok: boolean;
        preview: string;
      };
    }
  | {
      type: 'text_segment';
      data: {
        uuid: string;
        text: string;
      };
    };

export type PlatformTool = {
  name?: string;
  description?: string;
  function?: {
    name?: string;
    description?: string;
  };
  execute?: (args: Record<string, any>) => unknown | Promise<unknown>;
  handler?: (args: Record<string, any>, extra?: unknown) => unknown | Promise<unknown>;
  invoke?: (args: Record<string, any>) => unknown | Promise<unknown>;
};

export type ClaudeMcpTool = SdkMcpToolDefinition<any>;
