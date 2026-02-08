import { stat, open, access, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

type PendingCall = {
  tool_name: string;
  tool_input: any;
};

type WatchState = {
  filePath: string | null;
  offset: number;
  buffer: string;
  contentSessionId: string | null;
  cwd: string | null;
};

const DEFAULT_API = 'http://127.0.0.1:37777';
const DEFAULT_INTERVAL_MS = 2000;

const args = process.argv.slice(2);

const getArgValue = (name: string): string | null => {
  const direct = args.find(arg => arg.startsWith(`${name}=`));
  if (direct) {
    return direct.split('=').slice(1).join('=');
  }
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
};

const hasFlag = (name: string): boolean => args.includes(name);

const resolveDefaultRoot = (): string => {
  const explicitRoot = getArgValue('--root') || process.env.CODEX_SESSIONS_ROOT;
  if (explicitRoot) return explicitRoot;

  const dataRootCandidates = [
    join('/mnt/data', 'claude-mem', 'codex', 'sessions'),
    join('/mnt/data', 'codex', 'sessions'),
    join('/mnt/data', '.codex', 'sessions')
  ];

  for (const candidate of dataRootCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return join(homedir(), '.codex', 'sessions');
};

const rootDir = resolveDefaultRoot();
const apiBase = getArgValue('--api') || process.env.CLAUDE_MEM_API || DEFAULT_API;
const intervalMs = Number(getArgValue('--interval')) || DEFAULT_INTERVAL_MS;
const fromStart = hasFlag('--from-start');
const once = hasFlag('--once');

const pendingCalls = new Map<string, PendingCall>();
const state: WatchState = {
  filePath: null,
  offset: 0,
  buffer: '',
  contentSessionId: null,
  cwd: null
};

const extractSessionId = (filePath: string): string => {
  const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : basename(filePath).replace(/\.jsonl$/i, '');
};

const isCodexRollout = (name: string): boolean =>
  name.startsWith('rollout-') && name.endsWith('.jsonl');

const findLatestFile = async (): Promise<string | null> => {
  let latestFile: string | null = null;
  let latestMtime = 0;

  const scan = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && isCodexRollout(entry.name)) {
        try {
          const stats = await stat(fullPath);
          if (stats.mtimeMs > latestMtime) {
            latestMtime = stats.mtimeMs;
            latestFile = fullPath;
          }
        } catch {
          continue;
        }
      }
    }
  };

  await scan(rootDir);
  return latestFile;
};

const postJson = async (path: string, body: Record<string, any>): Promise<void> => {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  }
};

const postInit = async (contentSessionId: string, project: string, prompt: string): Promise<void> => {
  await postJson('/api/sessions/init', {
    contentSessionId,
    project,
    prompt
  });
};

const postObservation = async (
  contentSessionId: string,
  tool_name: string,
  tool_input: any,
  tool_response: any,
  cwd: string | null
): Promise<void> => {
  await postJson('/api/sessions/observations', {
    contentSessionId,
    tool_name,
    tool_input,
    tool_response,
    cwd
  });
};

const processLine = async (line: string): Promise<void> => {
  if (!line.trim()) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  if (entry.type === 'turn_context' && entry.payload?.cwd) {
    state.cwd = entry.payload.cwd;
    return;
  }

  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
    if (!state.contentSessionId) return;
    const prompt = entry.payload.message || '';
    if (!prompt.trim()) return;
    const project = state.cwd ? basename(state.cwd) : 'unknown';
    try {
      await postInit(state.contentSessionId, project, prompt);
    } catch (error) {
      console.error('[codex-ingest] Failed to post init:', error);
    }
    return;
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
    const callId = entry.payload.call_id;
    if (!callId) return;
    let toolInput: any = entry.payload.arguments;
    if (typeof toolInput === 'string') {
      try {
        toolInput = JSON.parse(toolInput);
      } catch {
        // Keep raw string
      }
    }
    pendingCalls.set(callId, {
      tool_name: entry.payload.name,
      tool_input: toolInput
    });
    return;
  }

  if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
    const callId = entry.payload.call_id;
    if (!callId) return;
    const pending = pendingCalls.get(callId);
    if (!pending || !state.contentSessionId) return;

    pendingCalls.delete(callId);
    try {
      await postObservation(
        state.contentSessionId,
        pending.tool_name,
        pending.tool_input,
        entry.payload.output,
        state.cwd
      );
    } catch (error) {
      console.error('[codex-ingest] Failed to post observation:', error);
    }
  }
};

const readNewLines = async (): Promise<void> => {
  if (!state.filePath) return;
  let stats;
  try {
    stats = await stat(state.filePath);
  } catch {
    return;
  }

  if (stats.size < state.offset) {
    state.offset = 0;
    state.buffer = '';
  }

  if (stats.size === state.offset) return;

  const handle = await open(state.filePath, 'r');
  try {
    const toRead = stats.size - state.offset;
    const buffer = Buffer.alloc(toRead);
    await handle.read(buffer, 0, toRead, state.offset);
    state.offset = stats.size;
    state.buffer += buffer.toString('utf8');

    const lines = state.buffer.split('\n');
    state.buffer = lines.pop() || '';
    for (const line of lines) {
      await processLine(line);
    }
  } finally {
    await handle.close();
  }
};

const switchFile = async (filePath: string): Promise<void> => {
  if (state.filePath === filePath) return;

  state.filePath = filePath;
  state.buffer = '';
  pendingCalls.clear();
  state.contentSessionId = `codex-${extractSessionId(filePath)}`;

  const stats = await stat(filePath);
  state.offset = fromStart ? 0 : stats.size;
};

const tick = async (): Promise<void> => {
  const latest = await findLatestFile();
  if (!latest) {
    console.log('[codex-ingest] No Codex session files found yet.');
    return;
  }

  await switchFile(latest);
  await readNewLines();
};

const main = async (): Promise<void> => {
  try {
    await access(rootDir);
  } catch {
    console.error(`[codex-ingest] Root directory not found: ${rootDir}`);
    console.error('[codex-ingest] Provide --root or set CODEX_SESSIONS_ROOT to a valid path.');
    process.exit(1);
  }

  if (rootDir.includes(`${join(homedir(), '.codex')}`)) {
    console.warn('[codex-ingest] Using ~/.codex by default. Set --root to a /mnt/data path if home is out of space.');
  }

  console.log('[codex-ingest] Watching Codex sessions', {
    rootDir,
    apiBase,
    intervalMs,
    fromStart
  });

  await tick();

  if (once) return;

  setInterval(() => {
    tick().catch(error => {
      console.error('[codex-ingest] Tick failed:', error);
    });
  }, intervalMs);
};

main().catch(error => {
  console.error('[codex-ingest] Fatal error:', error);
  process.exit(1);
});
