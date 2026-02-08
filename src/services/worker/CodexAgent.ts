/**
 * CodexAgent: Codex CLI-based observation extraction
 *
 * Uses the Codex CLI in non-interactive mode to process prompts and
 * return structured XML observations/summaries compatible with the
 * existing claude-mem parser.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export class CodexAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Codex CLI fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Codex agent for a session
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      const codexPath = this.findCodexExecutable();

      // Generate synthetic memorySessionId (Codex CLI is stateless)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `codex-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Codex`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryCodexWithHistory(codexPath, session.conversationHistory);

      if (initResponse) {
        session.conversationHistory.push({ role: 'assistant', content: initResponse });
        const tokensUsed = this.estimateTokens(initResponse);
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'Codex',
          undefined
        );
      } else {
        logger.error('SDK', 'Empty Codex init response - session may lack context', {
          sessionId: session.sessionDbId
        });
      }

      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);

        if (message.cwd) {
          lastCwd = message.cwd;
        }

        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryCodexWithHistory(codexPath, session.conversationHistory);

          if (obsResponse) {
            session.conversationHistory.push({ role: 'assistant', content: obsResponse });
          }

          const tokensUsed = this.estimateTokens(obsResponse || '');
          session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

          await processAgentResponse(
            obsResponse || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Codex',
            lastCwd
          );
        } else if (message.type === 'summarize') {
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryCodexWithHistory(codexPath, session.conversationHistory);

          if (summaryResponse) {
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse });
          }

          const tokensUsed = this.estimateTokens(summaryResponse || '');
          session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
          session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

          await processAgentResponse(
            summaryResponse || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'Codex',
            lastCwd
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Codex agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Codex agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Codex CLI failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Codex agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const maxMessages = parseInt(settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxTokens = parseInt(settings.CLAUDE_MEM_CODEX_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= maxMessages) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= maxTokens) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= maxMessages || tokenCount + msgTokens > maxTokens) {
        logger.warn('SDK', 'Codex context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxTokens
        });
        break;
      }

      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private formatHistoryForPrompt(history: ConversationMessage[]): string {
    return history.map(msg => {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      return `${role}:\n${msg.content}`;
    }).join('\n\n');
  }

  private async queryCodexWithHistory(codexPath: string, history: ConversationMessage[]): Promise<string> {
    const truncatedHistory = this.truncateHistory(history);
    const prompt = this.formatHistoryForPrompt(truncatedHistory);
    return this.runCodex(codexPath, prompt);
  }

  private async runCodex(codexPath: string, prompt: string): Promise<string> {
    ensureDir(OBSERVER_SESSIONS_DIR);

    const tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-codex-'));
    const outputFile = path.join(tempDir, 'last-message.txt');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--output-last-message', outputFile,
      '-C', OBSERVER_SESSIONS_DIR,
      '-'
    ];

    let stderr = '';
    let stdout = '';

    try {
      const codexHome = resolveCodexHome();
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(codexPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...(codexHome ? { HOME: codexHome } : {})
          }
        });

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => resolve(code ?? 1));

        child.stdin.write(prompt);
        child.stdin.end();
      });

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
        throw new Error(`Codex CLI failed: ${detail}`);
      }

      if (!existsSync(outputFile)) {
        const detail = stderr.trim() || stdout.trim() || 'missing output file';
        throw new Error(`Codex CLI produced no output: ${detail}`);
      }

      return readFileSync(outputFile, 'utf-8').trim();
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private findCodexExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (settings.CLAUDE_MEM_CODEX_PATH) {
      if (!existsSync(settings.CLAUDE_MEM_CODEX_PATH)) {
        throw new Error(`CLAUDE_MEM_CODEX_PATH is set to "${settings.CLAUDE_MEM_CODEX_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_MEM_CODEX_PATH;
    }

    const resolved = resolveCodexExecutable();
    if (resolved) return resolved;

    throw new Error('Codex executable not found. Please either:\n1. Add "codex" to your system PATH, or\n2. Set CLAUDE_MEM_CODEX_PATH in ~/.claude-mem/settings.json');
  }
}

/**
 * Check if Codex CLI is available (has executable on PATH or configured path)
 */
export function isCodexAvailable(): boolean {
  return resolveCodexExecutable() !== null;
}

function resolveCodexExecutable(): string | null {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (settings.CLAUDE_MEM_CODEX_PATH) {
    return existsSync(settings.CLAUDE_MEM_CODEX_PATH) ? settings.CLAUDE_MEM_CODEX_PATH : null;
  }

  const found = findCodexOnPath();
  if (!found) return null;

  if (isWrapperCodex(found)) {
    const wrapperDir = path.dirname(found);
    const alt = findCodexOnPath(wrapperDir);
    return alt && alt !== found ? alt : found;
  }

  return found;
}

function findCodexOnPath(excludeDir?: string): string | null {
  const pathVar = process.env.PATH || '';
  const parts = pathVar.split(path.delimiter).filter(Boolean);

  for (const dir of parts) {
    if (excludeDir && path.resolve(dir) === path.resolve(excludeDir)) {
      continue;
    }
    const candidate = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isWrapperCodex(candidate: string): boolean {
  try {
    const content = readFileSync(candidate, 'utf-8');
    return content.includes('start-worker-if-needed.sh') || content.includes('start-codex-ingest-if-needed.sh');
  } catch {
    return false;
  }
}

function resolveCodexHome(): string | null {
  const envHome = process.env.HOME;
  if (envHome && existsSync(path.join(envHome, '.codex'))) {
    return envHome;
  }

  const user = process.env.USER;
  if (user) {
    const userHome = path.join('/home', user);
    if (existsSync(path.join(userHome, '.codex'))) {
      return userHome;
    }
  }

  if (existsSync('/home/ubuntu/.codex')) {
    return '/home/ubuntu';
  }

  return envHome || null;
}
