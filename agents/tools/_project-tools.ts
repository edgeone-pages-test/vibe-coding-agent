import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  assertPreviewServerReady,
  ensureProjectScaffold,
  resolvePublicLinks,
  startPreviewServer,
} from '../_project';
import type { ClaudeMcpTool, ProjectFileInput, ProjectState, ScaffoldLog } from '../_types';
import { getBlockedProjectWriteReason, normalizeRelPath } from '../utils/_paths';
import { stringifyToolResult } from '../utils/_text';

const projectFileSchema = z.object({
  path: z.string().describe('Relative file path under appDir'),
  content: z.string().describe('Complete UTF-8 file contents'),
});

const projectFilesInputSchema = z.union([
  z.array(projectFileSchema).min(1),
  projectFileSchema,
  z.record(z.string(), z.string()),
]).describe(
  'Files to create or replace. Preferred shape: [{ "path": "src/App.tsx", "content": "..." }].',
);

const writeProjectFilesInputSchema = {
  files: projectFilesInputSchema.optional().describe(
    'Preferred: array of complete files, e.g. [{ "path": "src/App.tsx", "content": "..." }].',
  ),
  file: projectFileSchema.optional().describe('Single complete file. Use files for multiple files.'),
  entries: projectFilesInputSchema.optional().describe('Alias for files.'),
  path: z.string().optional().describe('Single file path, only valid together with content.'),
  content: z.string().optional().describe('Single file content, only valid together with path.'),
};

export function buildProjectScaffoldTool(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
  onResult?: (result: { created: boolean }) => void,
) {
  return defineClaudeTool(
    'ensure_project_scaffold',
    'Prepare or reuse the project workspace in the EdgeOne sandbox before any project file reads or writes.',
    {},
    async () => {
      try {
        const created = await ensureProjectScaffold(context, state, onLog);
        state.created = true;
        onResult?.({ created });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              created,
              appDir: state.appDir,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}

export function buildWriteProjectFilesTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { written: string[] }) => void | Promise<void>,
) {
  return defineClaudeTool(
    'write_project_files',
    'Write multiple complete project files under appDir in one call. Paths must be relative to appDir.',
    writeProjectFilesInputSchema,
    async (input) => {
      try {
        const normalizedFiles = normalizeWriteProjectFilesInput(input);
        if (normalizedFiles.length === 0) {
          throw new Error(
            'Missing files. Call write_project_files with {"files":[{"path":"src/App.tsx","content":"..."}]}.',
          );
        }
        const written: string[] = [];
        for (const file of normalizedFiles) {
          const relPath = normalizeRelPath(file.path);
          if (!relPath) {
            throw new Error(`Invalid file path: ${file.path}`);
          }
          const blockedReason = getBlockedProjectWriteReason(relPath);
          if (blockedReason) {
            throw new Error(`Refusing to write ${relPath}: ${blockedReason}`);
          }

          const parent = relPath.split('/').slice(0, -1).join('/');
          if (parent) {
            await context.sandbox.files.makeDir(`${state.appDir}/${parent}`);
          }
          await context.sandbox.files.write(`${state.appDir}/${relPath}`, file.content);
          written.push(relPath);
        }
        await onResult?.({ written });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({ written }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}

function normalizeWriteProjectFilesInput(input: unknown): ProjectFileInput[] {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (record.files !== undefined) {
      return normalizeProjectFilesInput(record.files);
    }
    if (record.file !== undefined) {
      return normalizeProjectFilesInput(record.file);
    }
    if (record.entries !== undefined) {
      return normalizeProjectFilesInput(record.entries);
    }
  }

  return normalizeProjectFilesInput(input);
}

function normalizeProjectFilesInput(files: unknown): ProjectFileInput[] {
  if (Array.isArray(files)) {
    return files as ProjectFileInput[];
  }

  if (files && typeof files === 'object') {
    const record = files as Record<string, unknown>;
    if (typeof record.path === 'string' && typeof record.content === 'string') {
      return [{ path: record.path, content: record.content }];
    }

    return Object.entries(record).map(([path, content]) => ({
      path,
      content: String(content),
    }));
  }

  return [];
}

export function buildPreviewLinkTool(
  context: any,
  state: ProjectState,
) {
  return defineClaudeTool(
    'get_preview_link',
    'Return the public preview URL generated from sandbox.getHost(3000) plus envdAccessToken and an optional sandboxDebugUrl from sandbox.browser.liveUrl. Do not synthesize either field — only use this tool result.',
    {},
    async () => {
      try {
        await assertPreviewServerReady(context);
        const links = await resolvePublicLinks(context);
        state.previewUrl = links.previewUrl;
        state.sandboxDebugUrl = links.sandboxDebugUrl;
        const preview = {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
        };
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult(preview),
          }],
        };
      } catch (error) {
        state.previewUrl = undefined;
        state.sandboxDebugUrl = undefined;
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}

export function buildStartPreviewServerTool(
  context: any,
  state: ProjectState,
) {
  return defineClaudeTool(
    'start_preview_server',
    'Start the project server on internal port 3000, write logs to /tmp/dev.log, and wait until http://127.0.0.1:3000 is ready. The public URL is generated from sandbox.getHost(3000). Call this after dependencies are installed and before publish-preview.',
    {},
    async () => {
      try {
        const result = await startPreviewServer(context, state);
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult(result),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
