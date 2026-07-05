import { ChildProcess } from 'child_process';

export const isChildProcessRunning = (childProcess: ChildProcess): boolean => {
  return (
    childProcess.exitCode === null &&
    childProcess.signalCode === null &&
    !childProcess.killed
  );
};

export interface TerminateChildProcessOptions {
  signal?: NodeJS.Signals;
  processGroup?: boolean;
}

export const terminateChildProcess = (
  childProcess: ChildProcess,
  options: TerminateChildProcessOptions = {}
): boolean => {
  if (!isChildProcessRunning(childProcess)) {
    return false;
  }

  const signal = options.signal || 'SIGTERM';

  try {
    if (options.processGroup && childProcess.pid && process.platform !== 'win32') {
      try {
        process.kill(-childProcess.pid, signal);
        return true;
      } catch {
        // Fall back to killing the direct child if the process group no longer exists.
      }
    }

    return childProcess.kill(signal);
  } catch {
    return false;
  }
};

export const waitForChildProcessClose = (
  childProcess: ChildProcess,
  timeoutMs: number
): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!isChildProcessRunning(childProcess)) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onClose = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      childProcess.off('close', onClose);
      childProcess.off('exit', onClose);
    };

    childProcess.once('close', onClose);
    childProcess.once('exit', onClose);
  });
};
