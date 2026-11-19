import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

/** Runs a command without a shell. Errors name the command but never include its output. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.on('error', () => reject(new Error(`${command} could not be started`)));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      reject(new Error(`${command} ${args[0] ?? ''} failed (${signal ?? code})`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}
