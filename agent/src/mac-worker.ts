import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as github from './github.ts';
import { createTaskDeps } from './runtime.ts';
import { markInterrupted, runTask } from './task.ts';

const GUARD_MAX_AGE_MS = 60 * 1000;

interface LockState {
  pid: number;
  issue?: number;
}

export type LockResult = { status: 'busy' } | { status: 'acquired'; interruptedIssue?: number };

function readLock(path: string): LockState | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockState;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleGuard(guard: string): void {
  try {
    if (Date.now() - statSync(guard).mtimeMs > GUARD_MAX_AGE_MS) {
      rmSync(guard, { recursive: true, force: true });
    }
  } catch {
    // Another worker removed the guard first.
  }
}

/**
 * Takes the single-job lock. An atomic guard directory protects the check and the write.
 * A lock left by a dead process keeps its issue on disk until recovery succeeds.
 */
export function acquireLock(path: string, pid: number, isAlive: (pid: number) => boolean): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const guard = `${path}.guard`;
  try {
    mkdirSync(guard);
  } catch {
    removeStaleGuard(guard);
    return { status: 'busy' };
  }
  try {
    const existing = readLock(path);
    if (existing && isAlive(existing.pid)) return { status: 'busy' };
    recordLockIssue(path, pid, existing?.issue);
    return { status: 'acquired', interruptedIssue: existing?.issue };
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

export function recordLockIssue(path: string, pid: number, issue: number | undefined): void {
  writeFileSync(path, JSON.stringify({ pid, issue } satisfies LockState));
}

export function releaseLock(path: string): void {
  rmSync(path, { force: true });
}

async function main(): Promise<void> {
  const lockPath = join(homedir(), '.local', 'state', 'git-practice-agent', 'lock.json');
  const lock = acquireLock(lockPath, process.pid, isProcessAlive);
  if (lock.status === 'busy') return;

  // On an unexpected error the lock stays on disk, so the next run can recover the issue.
  try {
    if (lock.interruptedIssue) {
      await markInterrupted(
        lock.interruptedIssue,
        'Mac の実行が途中で止まりました。再実行せず、人の判断を待ちます。',
        github,
      );
      recordLockIssue(lockPath, process.pid, undefined);
    }
    await github.setHeartbeat(new Date().toISOString());

    const [issueNumber] = await github.listMacIssues();
    if (issueNumber !== undefined) {
      recordLockIssue(lockPath, process.pid, issueNumber);
      const result = await runTask(issueNumber, 'mac', createTaskDeps('mac', process.cwd()));
      console.log(`Issue #${issueNumber}: ${result.status}`);
    }
  } catch (error) {
    console.error(`Worker failed: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  releaseLock(lockPath);
}

if (import.meta.main) {
  await main();
}
