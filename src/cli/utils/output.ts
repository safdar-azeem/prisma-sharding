import readline from 'readline';

export interface CliLoader {
  succeed: (message: string) => void;
  fail: (message: string) => void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const printCliHeader = (icon: string, title: string): void => {
  console.log(`${icon} ${title}\n`);
};

export const printCliRow = (icon: string, label: string, message: string): void => {
  console.log(`${icon} ${label}  ${message}`);
};

export const printVerboseHint = (): void => {
  console.log('\nRun with SHARD_CLI_VERBOSE=true for details.');
};

export const createCliLoader = (
  label: string,
  message: string,
  enabled = true
): CliLoader => {
  const animated = enabled && Boolean(process.stdout.isTTY);
  let frameIndex = 0;
  let timer: NodeJS.Timeout | undefined;
  let finished = false;

  const clear = () => {
    if (animated) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
  };

  const render = () => {
    clear();
    process.stdout.write(`${SPINNER_FRAMES[frameIndex]} ${label}  ${message}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };

  if (animated) {
    render();
    timer = setInterval(render, 80);
  }

  const finish = (icon: string, finalMessage: string) => {
    if (finished) {
      return;
    }
    finished = true;

    if (timer) {
      clearInterval(timer);
    }
    clear();
    printCliRow(icon, label, finalMessage);
  };

  return {
    succeed: (finalMessage) => finish('✅', finalMessage),
    fail: (finalMessage) => finish('❌', finalMessage),
  };
};
