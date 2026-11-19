import {
  LABELS,
  branchName,
  buildImplementPrompt,
  buildPlanPrompt,
  containsSecret,
  decideClaim,
  findForbiddenPaths,
} from './route.ts';
import type { Executor, IssueSnapshot } from './route.ts';

export interface IssueLabels {
  getIssue(issueNumber: number): Promise<IssueSnapshot>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
}

export interface TaskDeps {
  secrets: string[];
  github: IssueLabels & {
    createDraftPr(branch: string, issue: IssueSnapshot): Promise<string>;
  };
  workspace: {
    /** Atomically creates the remote branch. Returns false when it already exists. */
    claimBranch(branch: string): Promise<boolean>;
    prepare(branch: string): Promise<string>;
    stageAndListChanges(cwd: string): Promise<string[]>;
    stagedDiff(cwd: string): Promise<string>;
    commitAndPush(cwd: string, branch: string, message: string): Promise<void>;
    cleanup(cwd: string, branch: string): Promise<void>;
  };
  agents: {
    plan(prompt: string, cwd: string): Promise<string>;
    implement(prompt: string, cwd: string): Promise<void>;
  };
}

export type TaskResult =
  | { status: 'done'; url: string }
  | { status: 'skipped'; reason: string }
  | { status: 'needs-human'; reason: string };

const ACTIVE_LABELS = [LABELS.running, LABELS.runMac, LABELS.runCloud];

async function clearActiveLabels(issueNumber: number, github: IssueLabels): Promise<void> {
  for (const label of ACTIVE_LABELS) {
    await github.removeLabel(issueNumber, label);
  }
}

async function stopForHuman(
  issueNumber: number,
  reason: string,
  github: IssueLabels,
): Promise<TaskResult> {
  await github.addLabel(issueNumber, LABELS.needsHuman);
  await clearActiveLabels(issueNumber, github);
  await github.comment(issueNumber, `自動実行を停止しました。${reason}`);
  return { status: 'needs-human', reason };
}

/** Hands an interrupted run to a person. It never starts the work again. */
export async function markInterrupted(
  issueNumber: number,
  message: string,
  github: IssueLabels,
): Promise<boolean> {
  const issue = await github.getIssue(issueNumber);
  if (!ACTIVE_LABELS.some((label) => issue.labels.includes(label))) return false;
  await github.addLabel(issueNumber, LABELS.needsHuman);
  await clearActiveLabels(issueNumber, github);
  await github.comment(issueNumber, message);
  return true;
}

export async function runTask(
  issueNumber: number,
  executor: Executor,
  deps: TaskDeps,
): Promise<TaskResult> {
  const issue = await deps.github.getIssue(issueNumber);
  const claim = decideClaim(issue, executor);
  if (!claim.ok) return { status: 'skipped', reason: claim.reason };

  const branch = branchName(issueNumber);
  if (!(await deps.workspace.claimBranch(branch))) {
    const latest = await deps.github.getIssue(issueNumber);
    if (latest.labels.includes(LABELS.running)) {
      return { status: 'skipped', reason: 'another executor owns the issue' };
    }
    return stopForHuman(issueNumber, `ブランチ \`${branch}\` がすでに存在します。`, deps.github);
  }

  let cwd: string | undefined;
  try {
    await deps.github.addLabel(issueNumber, LABELS.running);
    await deps.github.removeLabel(issueNumber, LABELS.runMac);
    await deps.github.removeLabel(issueNumber, LABELS.runCloud);

    cwd = await deps.workspace.prepare(branch);

    const plan = await deps.agents.plan(buildPlanPrompt(issue), cwd);
    if (containsSecret(plan, deps.secrets)) {
      return await stopForHuman(issueNumber, '計画に認証情報らしい文字列が含まれていたため公開しませんでした。', deps.github);
    }
    await deps.github.comment(issueNumber, `## 実装計画（${executor}）\n\n${plan}`);
    await deps.agents.implement(buildImplementPrompt(issue, plan), cwd);

    const changes = await deps.workspace.stageAndListChanges(cwd);
    if (changes.length === 0) {
      return await stopForHuman(issueNumber, 'エージェントはファイルを変更しませんでした。', deps.github);
    }
    const forbidden = findForbiddenPaths(changes);
    if (forbidden.length > 0) {
      const list = forbidden.map((path) => `\`${path}\``).join('、');
      return await stopForHuman(issueNumber, `変更できないファイルが含まれています: ${list}`, deps.github);
    }
    if (containsSecret(await deps.workspace.stagedDiff(cwd), deps.secrets)) {
      return await stopForHuman(issueNumber, '変更に認証情報らしい文字列が含まれていたため push しませんでした。', deps.github);
    }

    await deps.workspace.commitAndPush(cwd, branch, `${issue.title} (#${issueNumber})`);
    const url = await deps.github.createDraftPr(branch, issue);
    await deps.github.removeLabel(issueNumber, LABELS.running);
    await deps.github.comment(issueNumber, `ドラフト PR を作成しました: ${url}`);
    return { status: 'done', url };
  } catch (error) {
    console.error(`Issue #${issueNumber} failed: ${(error as Error).message}`);
    return stopForHuman(issueNumber, `${executor} の実行中にエラーが発生しました。ログを確認してください。`, deps.github);
  } finally {
    if (cwd) {
      await deps.workspace.cleanup(cwd, branch).catch(() => undefined);
    }
  }
}
