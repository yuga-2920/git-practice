import { BASE_BRANCH, LABELS, REPO } from './route.ts';
import type { IssueSnapshot } from './route.ts';
import { run } from './shell.ts';

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  labels: { name: string }[];
}

export async function getIssue(issueNumber: number): Promise<IssueSnapshot> {
  const output = await run('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    REPO,
    '--json',
    'number,title,body,state,author,labels',
  ]);
  const issue = JSON.parse(output) as GhIssue;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    author: issue.author.login,
    labels: issue.labels.map((label) => label.name),
  };
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  await run('gh', ['issue', 'edit', String(issueNumber), '--repo', REPO, '--add-label', label]);
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  await run('gh', ['issue', 'edit', String(issueNumber), '--repo', REPO, '--remove-label', label]);
}

export async function comment(issueNumber: number, body: string): Promise<void> {
  await run('gh', ['issue', 'comment', String(issueNumber), '--repo', REPO, '--body-file', '-'], {
    input: body,
  });
}

export async function createDraftPr(branch: string, issue: IssueSnapshot): Promise<string> {
  const output = await run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      REPO,
      '--base',
      BASE_BRANCH,
      '--head',
      branch,
      '--draft',
      '--title',
      issue.title,
      '--body-file',
      '-',
    ],
    { input: `Closes #${issue.number}\n\nこの PR はエージェントが作成しました。内容を確認してからマージしてください。\n` },
  );
  return output.trim();
}

export async function createBranchRef(branch: string, sha: string): Promise<void> {
  await run('gh', [
    'api',
    '--method',
    'POST',
    `repos/${REPO}/git/refs`,
    '-f',
    `ref=refs/heads/${branch}`,
    '-f',
    `sha=${sha}`,
  ]);
}

export async function dispatchCloud(issueNumber: number): Promise<void> {
  await run('gh', [
    'workflow',
    'run',
    'agent-cloud.yml',
    '--repo',
    REPO,
    '--ref',
    BASE_BRANCH,
    '-f',
    `issue_number=${issueNumber}`,
  ]);
}

export async function listMacIssues(): Promise<number[]> {
  const output = await run('gh', [
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--label',
    LABELS.runMac,
    '--limit',
    '20',
    '--json',
    'number',
  ]);
  const issues = JSON.parse(output) as { number: number }[];
  return issues.map((issue) => issue.number).sort((a, b) => a - b);
}

export async function setHeartbeat(timestamp: string): Promise<void> {
  await run('gh', ['variable', 'set', 'MAC_HEARTBEAT_AT', '--repo', REPO, '--body', timestamp]);
}
