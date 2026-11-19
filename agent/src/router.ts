import { setTimeout as delay } from 'node:timers/promises';
import * as github from './github.ts';
import {
  LABELS,
  MAC_CLAIM_WAIT_MS,
  decideFallback,
  decideRoute,
  parseIssueNumber,
  shouldRoute,
} from './route.ts';
import type { IssueSnapshot } from './route.ts';

export interface RouterDeps {
  github: {
    getIssue(issueNumber: number): Promise<IssueSnapshot>;
    addLabel(issueNumber: number, label: string): Promise<void>;
    removeLabel(issueNumber: number, label: string): Promise<void>;
    dispatchCloud(issueNumber: number): Promise<void>;
    comment(issueNumber: number, body: string): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type RouteResult = 'mac' | 'cloud' | 'skipped' | 'needs-human';

async function startCloud(issueNumber: number, deps: RouterDeps): Promise<RouteResult> {
  try {
    await deps.github.dispatchCloud(issueNumber);
    return 'cloud';
  } catch {
    await deps.github.addLabel(issueNumber, LABELS.needsHuman);
    await deps.github.removeLabel(issueNumber, LABELS.runCloud);
    await deps.github.comment(issueNumber, 'クラウド実行を起動できませんでした。再実行せず、人の判断を待ちます。');
    return 'needs-human';
  }
}

export async function routeIssue(
  issueNumber: number,
  heartbeatAt: string | undefined,
  deps: RouterDeps,
): Promise<RouteResult> {
  const issue = await deps.github.getIssue(issueNumber);
  if (!shouldRoute(issue)) return 'skipped';

  if (decideRoute(heartbeatAt, deps.now()) === 'cloud') {
    await deps.github.addLabel(issueNumber, LABELS.runCloud);
    return startCloud(issueNumber, deps);
  }

  await deps.github.addLabel(issueNumber, LABELS.runMac);
  await deps.sleep(MAC_CLAIM_WAIT_MS);

  const latest = await deps.github.getIssue(issueNumber);
  if (!decideFallback(latest)) return 'mac';

  await deps.github.removeLabel(issueNumber, LABELS.runMac);
  await deps.github.addLabel(issueNumber, LABELS.runCloud);
  return startCloud(issueNumber, deps);
}

if (import.meta.main) {
  const issueNumber = parseIssueNumber(process.env.ISSUE_NUMBER);
  const result = await routeIssue(issueNumber, process.env.MAC_HEARTBEAT_AT, {
    github,
    sleep: async (ms) => {
      await delay(ms);
    },
    now: () => Date.now(),
  });
  console.log(`Issue #${issueNumber}: ${result}`);
}
