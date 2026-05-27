import {
  FILE_TREE_IGNORED_DIRECTORIES,
  FILE_TREE_IGNORED_FILENAMES,
  PREVIEW_SERVER_PORT,
  PREVIEW_BINARY_EXTENSIONS,
  PREVIEW_MAX_BYTES,
} from './_constants';
import type { BuildResult, BuildStatus, FileTreeItem, ProjectState, ScaffoldLog } from './_types';
import { readFileExtension, safeSegment } from './utils/_paths';
import { detectFatalToolError } from './utils/_text';

export function createProjectState(conversationId: string): ProjectState {
  const sessionDir = `projects/${safeSegment(conversationId)}`;
  return {
    created: false,
    sessionDir,
    appDir: `${sessionDir}/app`,
  };
}

export async function ensureProjectScaffold(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
) {
  const sandbox = context.sandbox;
  onLog?.({ stream: 'status', content: `准备项目工作区 ${state.appDir}` });
  await sandbox.files.makeDir(state.sessionDir);
  await sandbox.files.makeDir(state.appDir);

  const existing = await sandbox.commands.run(
    [
      'find . -mindepth 1 -maxdepth 2',
      "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
      '-o -print',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 60,
    },
  );
  if (existing.exitCode !== 0) {
    throw new Error(existing.stderr || existing.stdout || '工作区检查失败');
  }

  // 一个 conversation_id 对应一个长期复用的项目；已有业务文件时只复用，不覆盖。
  if (existing.stdout.trim()) {
    onLog?.({ stream: 'status', content: '检测到已有工作区，跳过初始化。' });
    return false;
  }

  onLog?.({ stream: 'status', content: '已准备空项目工作区，等待 Agent 生成项目文件。' });
  const sandboxInfo = context.sandbox.getInfo();
  console.log('沙箱信息', {
    hasInstanceId: Boolean(sandboxInfo?.instanceId),
    expiresAt: sandboxInfo?.expiresAt,
  });
  return true;
}

export async function runVerification(context: any, state: ProjectState): Promise<BuildResult> {
  try {
    const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    if (packageExists) {
      const hasBuildScript = await context.sandbox.commands.run(
        'node -e "const p=require(\'./package.json\'); process.exit(p.scripts && p.scripts.build ? 0 : 2)"',
        {
          cwd: state.appDir,
          timeout: 30,
        },
      );

      if (hasBuildScript.exitCode === 0) {
        const result = await context.sandbox.commands.run('npm run build', {
          cwd: state.appDir,
          timeout: 600,
        });

        return {
          status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }

      if (hasBuildScript.exitCode !== 2) {
        return {
          status: 'failed',
          stdout: hasBuildScript.stdout,
          stderr: hasBuildScript.stderr || 'package.json 解析失败，无法判断 build 脚本。',
        };
      }
    }

    const pythonFiles = await context.sandbox.commands.run(
      [
        'find .',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' -o -path './.venv' -o -path './venv' \\) -prune",
        "-o -name '*.py' -print -quit",
      ].join(' '),
      {
        cwd: state.appDir,
        timeout: 30,
      },
    );

    if (pythonFiles.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: pythonFiles.stdout,
        stderr: pythonFiles.stderr || 'Python 文件检查失败。',
      };
    }

    if (pythonFiles.stdout.trim()) {
      const result = await context.sandbox.commands.run('python -m compileall .', {
        cwd: state.appDir,
        timeout: 300,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    return {
      status: 'skipped',
      stdout: 'No package build script or Python source files found; verification skipped.',
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof commandError.stdout === 'string' ? commandError.stdout : '';
    const stderr = typeof commandError.stderr === 'string' ? commandError.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError([stdout, stderr, message].filter(Boolean).join('\n'));
    return {
      status: 'failed',
      stdout,
      stderr: fatal || stderr || message || '验证失败。',
      ...(fatal ? { fatal: true } : {}),
    };
  }
}

export async function getFileTree(context: any, state: ProjectState): Promise<FileTreeItem[]> {
  const ignoredDirectoryPruneExpression = FILE_TREE_IGNORED_DIRECTORIES
    .map((dir) => `-path './${dir}'`)
    .join(' -o ');
  const result = await context.sandbox.commands.run(
    [
      'find .',
      `\\( ${ignoredDirectoryPruneExpression} \\) -prune`,
      "-o -maxdepth 4 -print",
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 30,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || '文件列表读取失败');
  }

  return result.stdout
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line && line !== '.')
    .filter((line: string) => {
      const name = line.replace(/^\.\//, '').split('/').pop() || '';
      return !FILE_TREE_IGNORED_FILENAMES.has(name);
    })
    .slice(0, 220)
    .map((line: string) => {
      const path = line.replace(/^\.\//, '');
      const name = path.split('/').pop() || path;
      return {
        path,
        name,
        type: /\.[^/]+$/.test(name) ? ('file' as const) : ('directory' as const),
        depth: path.split('/').length - 1,
      };
    });
}

export async function resolvePublicLinks(context: any) {
  const previewHost = context.sandbox.getHost(PREVIEW_SERVER_PORT);
  const accessToken = context.sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(context.sandbox.browser?.liveUrl);
  console.log('检查预览链接生成条件', {
    port: PREVIEW_SERVER_PORT,
    hasPreviewHost: Boolean(previewBaseUrl),
    hasEnvdAccessToken: Boolean(accessToken),
    hasSandboxDebugUrl: Boolean(sandboxDebugUrl),
  });

  const previewUrl = (previewBaseUrl && accessToken)
    ? appendAccessToken(previewBaseUrl, accessToken)
    : undefined;

  return {
    previewUrl,
    sandboxDebugUrl,
  };
}

function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function appendAccessToken(url: string, token: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

function resolvePreviewAllowedHost(context: any) {
  try {
    const previewHost = context.sandbox.getHost(PREVIEW_SERVER_PORT);
    const previewUrl = normalizePublicUrl(previewHost);
    if (!previewUrl) {
      return '';
    }
    return new URL(previewUrl).hostname;
  } catch {
    return '';
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildViteAllowedHostEnvPrefix(context: any) {
  const allowedHost = resolvePreviewAllowedHost(context);
  return allowedHost
    ? `env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)} `
    : '';
}

async function findViteConfigFilename(context: any, state: ProjectState) {
  const candidates = [
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.cts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
  ];
  for (const filename of candidates) {
    if (await context.sandbox.files.exists(`${state.appDir}/${filename}`)) {
      return filename;
    }
  }
  return '';
}

async function prepareVitePreviewConfig(context: any, state: ProjectState) {
  const userConfigFilename = await findViteConfigFilename(context, state);
  const userConfigSpecifier = userConfigFilename ? `../${userConfigFilename}` : '';
  const previewConfigPath = `${state.appDir}/.vite/edgeone-preview.config.mjs`;
  await context.sandbox.files.makeDir(`${state.appDir}/.vite`);
  await context.sandbox.files.write(previewConfigPath, [
    "import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite';",
    '',
    "const mode = process.env.NODE_ENV || 'development';",
    "const configEnv = { command: 'serve', mode, isSsrBuild: false, isPreview: false };",
    `const userConfigSpecifier = ${JSON.stringify(userConfigSpecifier)};`,
    'const loaded = userConfigSpecifier',
    '  ? await loadConfigFromFile(configEnv, new URL(userConfigSpecifier, import.meta.url).pathname)',
    '  : null;',
    'const userConfig = loaded?.config || {};',
    "const additionalHost = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '';",
    'const existingAllowedHosts = userConfig.server?.allowedHosts;',
    'const allowedHosts = existingAllowedHosts === true',
    '  ? true',
    '  : Array.from(new Set([',
    '    ...(Array.isArray(existingAllowedHosts) ? existingAllowedHosts : []),',
    '    ...(additionalHost ? [additionalHost] : []),',
    '  ]));',
    'const edgeoneConfig = {',
    "  root: userConfig.root || process.cwd(),",
    '  server: {',
    "    host: '0.0.0.0',",
    `    port: Number(process.env.PORT || ${PREVIEW_SERVER_PORT}),`,
    '    allowedHosts,',
    '  },',
    '};',
    '',
    'export default defineConfig(mergeConfig(userConfig, edgeoneConfig));',
    '',
  ].join('\n'));
  return '.vite/edgeone-preview.config.mjs';
}

type PreviewStartCommand = {
  command: string;
  framework: string;
};

export async function startPreviewServer(context: any, state: ProjectState) {
  const port = PREVIEW_SERVER_PORT;
  const release = await context.sandbox.commands.run(
    [
      'if command -v fuser >/dev/null 2>&1; then',
      `fuser -k ${port}/tcp 2>/dev/null || true;`,
      'elif command -v lsof >/dev/null 2>&1; then',
      `lsof -ti tcp:${port} | xargs -r kill -9 2>/dev/null || true;`,
      'fi;',
      'sleep 1',
    ].join(' '),
    { timeout: 10 },
  );

  if (release.exitCode !== 0) {
    throw new Error(release.stderr || release.stdout || `Failed to free port ${port}.`);
  }

  const start = await detectPreviewStartCommand(context, state);
  const startResult = await context.sandbox.commands.run(
    `: > /tmp/dev.log; ${start.command}`,
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (startResult.exitCode !== 0) {
    throw new Error(startResult.stderr || startResult.stdout || `Failed to start preview server on port ${port}.`);
  }

  const ready = await context.sandbox.commands.run(
    [
      `for i in $(seq 1 30); do curl -fsS http://127.0.0.1:${port} >/dev/null && exit 0; sleep 1; done;`,
      `echo "Preview server did not become ready on port ${port}" >&2;`,
      'tail -n 120 /tmp/dev.log >&2 || true;',
      'exit 1',
    ].join(' '),
    { timeout: 35 },
  );

  if (ready.exitCode !== 0) {
    throw new Error(ready.stderr || ready.stdout || `Preview server did not become ready on port ${port}.`);
  }

  return {
    port,
    framework: start.framework,
    command: start.command,
    ready: true,
  };
}

export async function assertPreviewServerReady(context: any) {
  const result = await context.sandbox.commands.run(
    `curl -fsS http://127.0.0.1:${PREVIEW_SERVER_PORT} >/dev/null`,
    { timeout: 10 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Preview server is not ready on port ${PREVIEW_SERVER_PORT}. Start the dev server and wait for HTTP readiness before calling get_preview_link.`);
  }
}

async function detectPreviewStartCommand(
  context: any,
  state: ProjectState,
): Promise<PreviewStartCommand> {
  const port = PREVIEW_SERVER_PORT;
  const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
  if (packageExists) {
    const metadata = await readPackageMetadata(context, state);
    const scripts = metadata.scripts || {};
    const deps = metadata.deps || {};
    const scriptText = Object.values(scripts).join(' ');
    const viteAllowedHostEnv = buildViteAllowedHostEnvPrefix(context);

    if (deps.next || /\bnext\b/.test(scriptText)) {
      return {
        framework: 'next',
        command: `nohup npm run dev -- --hostname 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      };
    }

    if (deps.vite || /\bvite\b/.test(scriptText)) {
      const vitePreviewConfig = await prepareVitePreviewConfig(context, state);
      return {
        framework: 'vite',
        command: `nohup ${viteAllowedHostEnv}npm run dev -- --host 0.0.0.0 --port ${port} --config ${shellQuote(vitePreviewConfig)} > /tmp/dev.log 2>&1 &`,
      };
    }

    if (
      deps.astro
      || deps.nuxt
      || deps['@sveltejs/kit']
      || /\b(astro|nuxt|svelte-kit)\b/.test(scriptText)
    ) {
      return {
        framework: 'frontend-dev-server',
        command: `nohup ${viteAllowedHostEnv}npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      };
    }

    if (scripts.dev) {
      return {
        framework: 'node-dev-server',
        command: `nohup env HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${port} npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      };
    }

    if (scripts.start) {
      return {
        framework: 'node-start-server',
        command: `nohup env HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${port} npm start > /tmp/dev.log 2>&1 &`,
      };
    }
  }

  const pythonCommand = await detectPythonPreviewCommand(context, state);
  if (pythonCommand) {
    return pythonCommand;
  }

  return {
    framework: 'static-http',
    command: `nohup python3 -m http.server ${port} --bind 0.0.0.0 > /tmp/dev.log 2>&1 &`,
  };
}

async function readPackageMetadata(
  context: any,
  state: ProjectState,
): Promise<{
  scripts?: Record<string, string>;
  deps?: Record<string, string>;
}> {
  const result = await context.sandbox.commands.run(
    [
      'node -e "',
      'const fs=require(\'fs\');',
      'const p=JSON.parse(fs.readFileSync(\'package.json\',\'utf8\'));',
      'console.log(JSON.stringify({scripts:p.scripts||{},deps:{...(p.dependencies||{}),...(p.devDependencies||{})}}));',
      '"',
    ].join(''),
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to parse package.json for preview startup.');
  }

  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error('Failed to parse package.json metadata for preview startup.');
  }
}

async function detectPythonPreviewCommand(
  context: any,
  state: ProjectState,
): Promise<PreviewStartCommand | null> {
  const port = PREVIEW_SERVER_PORT;
  const result = await context.sandbox.commands.run(
    [
      'if [ -f main.py ] && grep -q "FastAPI(" main.py 2>/dev/null; then echo fastapi:main; exit 0; fi;',
      'if [ -f app.py ] && grep -q "FastAPI(" app.py 2>/dev/null; then echo fastapi:app; exit 0; fi;',
      'if [ -f app.py ] && grep -q "Flask(" app.py 2>/dev/null; then echo flask:app; exit 0; fi;',
      'if [ -f main.py ] && grep -q "Flask(" main.py 2>/dev/null; then echo flask:main; exit 0; fi;',
      'find . -maxdepth 2 -type f -name "*.py" -print -quit',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to inspect Python project for preview startup.');
  }

  const marker = String(result.stdout || '').trim();
  if (marker === 'fastapi:main') {
    return {
      framework: 'fastapi',
      command: `nohup python3 -m uvicorn main:app --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
    };
  }
  if (marker === 'fastapi:app') {
    return {
      framework: 'fastapi',
      command: `nohup python3 -m uvicorn app:app --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
    };
  }
  if (marker === 'flask:app') {
    return {
      framework: 'flask',
      command: `nohup python3 -m flask --app app run --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
    };
  }
  if (marker === 'flask:main') {
    return {
      framework: 'flask',
      command: `nohup python3 -m flask --app main run --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
    };
  }
  return null;
}

export async function readFileFromSandbox(
  context: any,
  state: ProjectState,
  relPath: string,
): Promise<{
  ok: boolean;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
}> {
  const ext = readFileExtension(relPath);
  if (ext && PREVIEW_BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, error: `不支持预览二进制文件 (${ext})` };
  }

  // 走 commands.run 用 head -c 读，既能限制大小又不依赖 sandbox.files.read 的不确定签名。
  // 用单引号包裹路径并转义内含的单引号，避免 shell 注入。
  const safePath = relPath.replace(/'/g, "'\\''");
  const cmd = `if [ ! -f '${safePath}' ]; then echo "__NOTFOUND__" 1>&2; exit 2; fi; wc -c < '${safePath}' | tr -d ' '; echo "__SEP__"; head -c ${PREVIEW_MAX_BYTES + 1} '${safePath}'`;
  let result;
  try {
    result = await context.sandbox.commands.run(cmd, {
      cwd: state.appDir,
      timeout: 15,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '读取失败' };
  }

  if (result.exitCode !== 0) {
    const stderr = String(result.stderr || '').trim();
    if (stderr.includes('__NOTFOUND__')) {
      return { ok: false, error: '文件不存在' };
    }
    return { ok: false, error: stderr || '读取失败' };
  }

  const stdout = String(result.stdout || '');
  const sepIdx = stdout.indexOf('__SEP__\n');
  if (sepIdx === -1) {
    return { ok: false, error: '读取格式异常' };
  }
  const sizeStr = stdout.slice(0, sepIdx).trim();
  const size = Number(sizeStr) || 0;
  let content = stdout.slice(sepIdx + '__SEP__\n'.length);
  let truncated = false;
  if (content.length > PREVIEW_MAX_BYTES) {
    content = content.slice(0, PREVIEW_MAX_BYTES);
    truncated = true;
  } else if (size > PREVIEW_MAX_BYTES) {
    truncated = true;
  }
  // 二进制兜底：如果开头 4KB 内有大量不可打印控制字符，视为二进制。
  const sample = content.slice(0, 4096);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) nonPrintable += 1;
  }
  if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
    return { ok: false, error: '文件疑似二进制，已拒绝预览' };
  }

  return { ok: true, content, size, truncated };
}
