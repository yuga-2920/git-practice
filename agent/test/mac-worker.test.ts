import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireLock, recordLockIssue, releaseLock } from '../src/mac-worker.ts';

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agent-lock-')), 'state', 'lock.json');
}

describe('acquireLock', () => {
  it('acquires a free lock', () => {
    const path = lockPath();
    assert.deepEqual(acquireLock(path, 10, () => false), { status: 'acquired', interruptedIssue: undefined });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 10);
  });

  it('reports busy while the owner is alive', () => {
    const path = lockPath();
    acquireLock(path, 10, () => false);
    assert.deepEqual(acquireLock(path, 11, () => true), { status: 'busy' });
  });

  it('reports the interrupted issue when the owner died', () => {
    const path = lockPath();
    acquireLock(path, 10, () => false);
    recordLockIssue(path, 10, 42);
    assert.deepEqual(acquireLock(path, 11, () => false), { status: 'acquired', interruptedIssue: 42 });
  });

  it('keeps the interrupted issue on disk until recovery succeeds', () => {
    const path = lockPath();
    acquireLock(path, 10, () => false);
    recordLockIssue(path, 10, 42);
    acquireLock(path, 11, () => false);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).issue, 42);
    assert.deepEqual(acquireLock(path, 12, () => false), { status: 'acquired', interruptedIssue: 42 });
  });

  it('reports busy while another worker is taking the lock', () => {
    const path = lockPath();
    mkdirSync(`${path}.guard`, { recursive: true });
    assert.deepEqual(acquireLock(path, 10, () => false), { status: 'busy' });
  });

  it('replaces an unreadable lock', () => {
    const path = lockPath();
    acquireLock(path, 10, () => false);
    writeFileSync(path, 'broken');
    assert.equal(acquireLock(path, 11, () => false).status, 'acquired');
  });

  it('can be acquired again after release', () => {
    const path = lockPath();
    acquireLock(path, 10, () => false);
    releaseLock(path);
    assert.equal(acquireLock(path, 11, () => false).status, 'acquired');
  });
});
