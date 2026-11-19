import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LABELS, OWNER } from '../src/route.ts';
import type { Executor, IssueSnapshot } from '../src/route.ts';
import { routeIssue } from '../src/router.ts';
import { markInterrupted, runTask } from '../src/task.ts';
import type { TaskDeps } from '../src/task.ts';

interface FakeOptions {
  labels?: string[];
  author?: string;
  branchExists?: boolean;
  changedFiles?: string[];
  branchOwnedByOther?: boolean;
  implementError?: Error;
  removeLabelError?: Error;
  planText?: string;
  diffText?: string;
}

function createFake(options: FakeOptions = {}) {
  const state: IssueSnapshot = {
    number: 7,
    title: 'Update the README',
    body: 'Add a usage section.',
    author: options.author ?? OWNER,
    labels: [...(options.labels ?? [LABELS.ready, LABELS.runMac])],
    state: 'OPEN',
  };
  const calls: string[] = [];
  const comments: string[] = [];

  if (options.branchOwnedByOther) state.labels.push(LABELS.running);

  const deps: TaskDeps = {
    secrets: [],
    github: {
      getIssue: async () => ({ ...state, labels: [...state.labels] }),
      addLabel: async (_number, label) => {
        calls.push(`add:${label}`);
        state.labels.push(label);
      },
      removeLabel: async (_number, label) => {
        calls.push(`remove:${label}`);
        if (options.removeLabelError && label === LABELS.runMac && !calls.includes('failed-once')) {
          calls.push('failed-once');
          throw options.removeLabelError;
        }
        state.labels = state.labels.filter((item) => item !== label);
      },
      comment: async (_number, body) => {
        comments.push(body);
      },
      createDraftPr: async (branch) => {
        calls.push(`pr:${branch}`);
        return 'https://github.com/yuga-2920/git-practice/pull/9';
      },
    },
    workspace: {
      claimBranch: async () => !(options.branchExists || options.branchOwnedByOther),
      prepare: async (branch) => {
        calls.push(`prepare:${branch}`);
        return '/tmp/worktree';
      },
      stageAndListChanges: async () => options.changedFiles ?? ['README.md'],
      stagedDiff: async () => options.diffText ?? '+ a safe change',
      commitAndPush: async (_cwd, branch) => {
        calls.push(`push:${branch}`);
      },
      cleanup: async () => {
        calls.push('cleanup');
      },
    },
    agents: {
      plan: async () => {
        calls.push('plan');
        return options.planText ?? 'The plan';
      },
      implement: async () => {
        calls.push('implement');
        if (options.implementError) throw options.implementError;
      },
    },
  };
  return { deps, state, calls, comments };
}

async function run(fake: ReturnType<typeof createFake>, executor: Executor = 'mac') {
  return runTask(7, executor, fake.deps);
}

describe('runTask', () => {
  it('plans, implements, pushes, and opens a draft PR', async () => {
    const fake = createFake();
    const result = await run(fake);

    assert.equal(result.status, 'done');
    assert.deepEqual(
      fake.calls.filter((call) => !call.includes(':') || /^(prepare|push|pr):/.test(call)),
      ['prepare:agent/issue-7', 'plan', 'implement', 'push:agent/issue-7', 'pr:agent/issue-7', 'cleanup'],
    );
    assert.ok(!fake.state.labels.includes(LABELS.running));
    assert.ok(!fake.state.labels.includes(LABELS.runMac));
    assert.ok(!fake.state.labels.includes(LABELS.needsHuman));
    assert.ok(fake.comments.some((body) => body.includes('The plan')));
    assert.ok(fake.comments.some((body) => body.includes('/pull/9')));
  });

  it('claims the issue before it starts work', async () => {
    const fake = createFake();
    await run(fake);
    assert.ok(fake.calls.indexOf(`add:${LABELS.running}`) < fake.calls.indexOf('prepare:agent/issue-7'));
  });

  it('skips an issue routed to the other executor', async () => {
    const fake = createFake({ labels: [LABELS.runCloud] });
    const result = await run(fake, 'mac');
    assert.equal(result.status, 'skipped');
    assert.deepEqual(fake.calls, []);
  });

  it('skips an issue from another author', async () => {
    const fake = createFake({ author: 'someone-else' });
    const result = await run(fake);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(fake.calls, []);
  });

  it('stops for a person when the branch already exists', async () => {
    const fake = createFake({ branchExists: true });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(fake.state.labels.includes(LABELS.needsHuman));
    assert.ok(!fake.calls.includes('plan'));
  });

  it('leaves the issue alone when the other executor won the claim', async () => {
    const fake = createFake({ labels: [LABELS.runMac], branchOwnedByOther: true });
    const result = await run(fake, 'mac');
    assert.equal(result.status, 'skipped');
    assert.deepEqual(fake.calls, []);
  });

  it('stops for a person when a network error follows the claim', async () => {
    const fake = createFake({ removeLabelError: new Error('network') });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(fake.state.labels.includes(LABELS.needsHuman));
    assert.ok(!fake.state.labels.includes(LABELS.running));
    assert.ok(!fake.calls.includes('plan'));
  });

  it('never publishes a plan that contains a credential', async () => {
    const leaked = `sk-ant-${'a'.repeat(24)}`;
    const fake = createFake({ planText: `token ${leaked}` });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(!fake.comments.some((body) => body.includes(leaked)));
    assert.ok(!fake.calls.includes('implement'));
  });

  it('never pushes a diff that contains a credential', async () => {
    const fake = createFake({ diffText: `+ ghs_${'a'.repeat(30)}` });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(!fake.calls.some((call) => call.startsWith('push:')));
  });

  it('stops for a person when the agent changes nothing', async () => {
    const fake = createFake({ changedFiles: [] });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(!fake.calls.some((call) => call.startsWith('push:')));
    assert.ok(fake.state.labels.includes(LABELS.needsHuman));
  });

  it('refuses to push changes to automation files', async () => {
    const fake = createFake({ changedFiles: ['README.md', '.github/workflows/x.yml'] });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(!fake.calls.some((call) => call.startsWith('push:')));
    assert.ok(fake.comments.some((body) => body.includes('.github/workflows/x.yml')));
  });

  it('stops for a person and cleans up when the agent fails', async () => {
    const fake = createFake({ implementError: new Error('secret detail') });
    const result = await run(fake);
    assert.equal(result.status, 'needs-human');
    assert.ok(fake.state.labels.includes(LABELS.needsHuman));
    assert.ok(!fake.state.labels.includes(LABELS.running));
    assert.ok(fake.calls.includes('cleanup'));
    assert.ok(!fake.comments.some((body) => body.includes('secret detail')));
  });
});

function createRouterFake(labels: string[], afterWait?: string[], dispatchFails = false) {
  const state: IssueSnapshot = {
    number: 7,
    title: 'T',
    body: 'B',
    author: OWNER,
    labels: [...labels],
    state: 'OPEN',
  };
  const calls: string[] = [];
  const deps = {
    github: {
      getIssue: async () => ({ ...state, labels: [...state.labels] }),
      addLabel: async (_number: number, label: string) => {
        calls.push(`add:${label}`);
        state.labels.push(label);
      },
      removeLabel: async (_number: number, label: string) => {
        calls.push(`remove:${label}`);
        state.labels = state.labels.filter((item) => item !== label);
      },
      dispatchCloud: async () => {
        calls.push('dispatch');
        if (dispatchFails) throw new Error('dispatch failed');
      },
      comment: async () => {
        calls.push('comment');
      },
    },
    sleep: async () => {
      calls.push('sleep');
      if (afterWait) state.labels = [...afterWait];
    },
    now: () => Date.parse('2026-11-19T12:00:00.000Z'),
  };
  return { deps, state, calls };
}

describe('routeIssue', () => {
  const fresh = '2026-11-19T11:59:00.000Z';
  const stale = '2026-11-19T11:00:00.000Z';

  it('dispatches the cloud run when the Mac is offline', async () => {
    const fake = createRouterFake([LABELS.ready]);
    assert.equal(await routeIssue(7, stale, fake.deps), 'cloud');
    assert.deepEqual(fake.calls, [`add:${LABELS.runCloud}`, 'dispatch']);
  });

  it('leaves the issue with the Mac when it claims in time', async () => {
    const fake = createRouterFake([LABELS.ready], [LABELS.ready, LABELS.running]);
    assert.equal(await routeIssue(7, fresh, fake.deps), 'mac');
    assert.deepEqual(fake.calls, [`add:${LABELS.runMac}`, 'sleep']);
  });

  it('moves the issue to the cloud when the Mac does not claim it', async () => {
    const fake = createRouterFake([LABELS.ready]);
    assert.equal(await routeIssue(7, fresh, fake.deps), 'cloud');
    assert.deepEqual(fake.calls, [
      `add:${LABELS.runMac}`,
      'sleep',
      `remove:${LABELS.runMac}`,
      `add:${LABELS.runCloud}`,
      'dispatch',
    ]);
  });

  it('stops for a person when the cloud run cannot be started', async () => {
    const fake = createRouterFake([LABELS.ready], undefined, true);
    assert.equal(await routeIssue(7, stale, fake.deps), 'needs-human');
    assert.ok(fake.state.labels.includes(LABELS.needsHuman));
    assert.ok(!fake.state.labels.includes(LABELS.runCloud));
  });

  it('ignores an issue that was already routed', async () => {
    const fake = createRouterFake([LABELS.ready, LABELS.runCloud]);
    assert.equal(await routeIssue(7, stale, fake.deps), 'skipped');
    assert.deepEqual(fake.calls, []);
  });
});

describe('markInterrupted', () => {
  it('moves a running issue to needs-human without rerunning it', async () => {
    const fake = createFake({ labels: [LABELS.running] });
    assert.equal(await markInterrupted(7, 'stopped', fake.deps.github), true);
    assert.deepEqual(fake.state.labels, [LABELS.needsHuman]);
    assert.deepEqual(fake.comments, ['stopped']);
  });

  it('moves an unstarted cloud issue to needs-human', async () => {
    const fake = createFake({ labels: [LABELS.runCloud] });
    assert.equal(await markInterrupted(7, 'stopped', fake.deps.github), true);
    assert.deepEqual(fake.state.labels, [LABELS.needsHuman]);
  });

  it('does nothing when the run already finished', async () => {
    const fake = createFake({ labels: [LABELS.ready] });
    assert.equal(await markInterrupted(7, 'stopped', fake.deps.github), false);
    assert.deepEqual(fake.calls, []);
  });
});
