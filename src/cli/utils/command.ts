import { spawn } from 'child_process';
import path from 'path';
import { INTERNAL_DEFAULTS } from '../../constants/internal';
import { sanitizeDatabaseText } from '../../utils/sanitize';
import { terminateChildProcess } from './process';

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number | null;
}

export interface RunCommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  verbose?: boolean;
  timeoutMs?: number;
  forceKillGraceMs?: number;
  maxOutputLength?: number;
}

export const getNpxCommand = (): string => (process.platform === 'win32' ? 'npx.cmd' : 'npx');

const OUTPUT_TRUNCATED_MARKER = '\n[output truncated]\n';

const appendBoundedOutput = (current: string, chunk: string, limit: number): string => {
  const combined = current + chunk;
  if (combined.length <= limit) {
    return combined;
  }
  if (limit <= OUTPUT_TRUNCATED_MARKER.length) {
    return combined.slice(-limit);
  }
  return (
    OUTPUT_TRUNCATED_MARKER +
    combined.slice(-(limit - OUTPUT_TRUNCATED_MARKER.length))
  );
};

export const sanitizeCommandOutput = (
  output: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const databaseUrls = Object.entries(env)
    .filter(
      ([name, value]) =>
        Boolean(value) && (name === 'DATABASE_URL' || /^SHARD_\d+_URL$/.test(name))
    )
    .map(([, value]) => value as string);

  return sanitizeDatabaseText(output, databaseUrls)
    .replace(/(\bpassword\s*[=:]\s*)[^\s,;]+/gi, '$1***');
};

export const runCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const env = options.env || process.env;
    const timeoutMs = options.timeoutMs ?? INTERNAL_DEFAULTS.CLI_COMMAND_TIMEOUT_MS;
    const forceKillGraceMs =
      options.forceKillGraceMs ?? INTERNAL_DEFAULTS.CLI_FORCE_KILL_GRACE_MS;
    const maxOutputLength =
      options.maxOutputLength ?? INTERNAL_DEFAULTS.CLI_MAX_OUTPUT_LENGTH;
    const processGroup = process.platform !== 'win32';

    const child = spawn(command, args, {
      env,
      cwd: path.resolve(options.cwd || process.cwd()),
      detached: processGroup,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const settle = (result: CommandResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }
        const sanitizedResult = {
          ...result,
          stdout: sanitizeCommandOutput(result.stdout, env),
          stderr: sanitizeCommandOutput(result.stderr, env),
          error: result.error ? sanitizeCommandOutput(result.error, env) : undefined,
        };

        if (options.verbose) {
          if (sanitizedResult.stdout) {
            process.stdout.write(sanitizedResult.stdout);
          }
          if (sanitizedResult.stderr) {
            process.stderr.write(sanitizedResult.stderr);
          }
        }

        resolve(sanitizedResult);
      }
    };

    child.stdout?.on('data', (data) => {
      if (!settled) {
        stdout = appendBoundedOutput(stdout, data.toString(), maxOutputLength);
      }
    });

    child.stderr?.on('data', (data) => {
      if (!settled) {
        stderr = appendBoundedOutput(stderr, data.toString(), maxOutputLength);
      }
    });

    child.once('error', (error) => {
      settle({
        success: false,
        stdout,
        stderr,
        exitCode: null,
        error: timedOut ? `Command timed out after ${timeoutMs}ms` : error.message,
      });
    });

    child.once('close', (exitCode) => {
      settle({
        success: !timedOut && exitCode === 0,
        stdout,
        stderr,
        exitCode,
        error:
          timedOut
            ? `Command timed out after ${timeoutMs}ms`
            : exitCode === 0
            ? undefined
            : stderr.trim() || stdout.trim() || `Command exited with code ${exitCode}`,
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child, { signal: 'SIGTERM', processGroup });
      forceKillTimeout = setTimeout(() => {
        terminateChildProcess(child, { signal: 'SIGKILL', processGroup });
        settle({
          success: false,
          stdout,
          stderr,
          exitCode: null,
          error: `Command timed out after ${timeoutMs}ms`,
        });
      }, forceKillGraceMs);
      forceKillTimeout.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
};

export const runPrismaCommand = (
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> => runCommand(getNpxCommand(), ['prisma', ...args], options);
