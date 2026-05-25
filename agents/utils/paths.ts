import {
  BLOCKED_PROJECT_WRITE_EXTENSIONS,
  BLOCKED_PROJECT_WRITE_FILENAMES,
  BLOCKED_PROJECT_WRITE_SEGMENTS,
} from '../constants';

// 会话 ID 进入沙箱目录前先收敛字符集，保证不同运行环境下路径都稳定可用。
export function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function readFileExtension(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash === -1 ? path : path.slice(slash + 1);
  const dot = tail.lastIndexOf('.');
  if (dot <= 0) return '';
  return tail.slice(dot).toLowerCase();
}

export function normalizeRelPath(rawPath: string): string | null {
  // 拒绝绝对路径、空路径以及含 .. 的路径，避免逃出 appDir。
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.filter(Boolean).join('/');
}

export function getBlockedProjectWriteReason(path: string): string | null {
  const segments = path.split('/');
  for (const segment of segments) {
    if (BLOCKED_PROJECT_WRITE_SEGMENTS.has(segment)) {
      return `generated/cache directory "${segment}" is not writable`;
    }
  }

  const filename = segments[segments.length - 1] || '';
  if (BLOCKED_PROJECT_WRITE_FILENAMES.has(filename)) {
    return 'package manager lockfiles and system files must not be generated manually';
  }

  const ext = readFileExtension(path);
  if (ext && BLOCKED_PROJECT_WRITE_EXTENSIONS.has(ext)) {
    return `binary/cache file extension "${ext}" is not writable`;
  }

  return null;
}
