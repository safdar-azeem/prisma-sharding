import { spawn } from 'child_process';
import path from 'path';

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
}

export const getNpxCommand = (): string => (process.platform === 'win32' ? 'npx.cmd' : 'npx');

export const runCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> => {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: path.resolve(options.cwd || process.cwd()),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const settle = (result: CommandResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      if (options.verbose) {
        process.stdout.write(output);
      }
    });

    child.stderr?.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      if (options.verbose) {
        process.stderr.write(output);
      }
    });

    child.once('error', (error) => {
      settle({
        success: false,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.once('close', (exitCode) => {
      settle({
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        error:
          exitCode === 0
            ? undefined
            : stderr.trim() || stdout.trim() || `Command exited with code ${exitCode}`,
      });
    });
  });
};

export const runPrismaCommand = (
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> => runCommand(getNpxCommand(), ['prisma', ...args], options);
