import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as github from './github.ts';
import { BASE_BRANCH } from './route.ts';
import type { Executor } from './route.ts';
import { run } from './shell.ts';
import type { TaskDeps } from './task.ts';

const PLAN_TIMEOUT_MS = 15 * 60 * 1000;
const IMPLEMENT_TIMEOUT_MS = 40 * 60 * 1000;
const GIT_IDENTITY = ['-c', 'user.name=git-practice-agent', '-c', 'user.email=agent@users.noreply.github.com'];

const CLAUDE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'CLAUDE_CODE_OAUTH_TOKEN'];

const READ_DENY_RULES = [
  '//proc/**',
  '//sys/**',
  '//dev/**',
  '//etc/**',
  '//private/etc/**',
  '//Volumes/**',
  '//home/runner/work/_temp/**',
  '//home/runner/.*/**',
  '~/.ssh/**',
  '~/.aws/**',
  '~/.config/**',
  '~/.claude/**',
  '~/.claude.json',
  '~/.codex/**',
  '~/.gnupg/**',
  '~/.netrc',
  '~/.gitconfig',
  '~/.git-credentials',
  '~/.local/**',
  '~/Library/**',
  '~/Documents/**',
  '~/Desktop/**',
  '~/Downloads/**',
].map((path) => `Read(${path})`);

function agentEnv(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runClaude(
  prompt: string,
  cwd: string,
  tools: string,
  maxTurns: number,
  timeoutMs: number,
): Promise<string> {
  const output = await run(
    'claude',
    [
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-turns',
      String(maxTurns),
      '--permission-mode',
      'acceptEdits',
      '--tools',
      tools,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--settings',
      JSON.stringify({ permissions: { deny: READ_DENY_RULES } }),
    ],
    { cwd, env: agentEnv(CLAUDE_ENV_KEYS), input: prompt, timeoutMs },
  );
  const result = JSON.parse(output) as { is_error?: boolean; result?: string };
  if (result.is_error) throw new Error('claude reported an error');
  return result.result ?? '';
}

async function runCodexPlan(prompt: string, cwd: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'git-practice-agent-'));
  const outputFile = join(directory, 'plan.md');
  await run(
    'codex',
    [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--sandbox',
      'read-only',
      '--cd',
      cwd,
      '--output-last-message',
      outputFile,
      '-',
    ],
    { cwd, env: agentEnv(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']), input: prompt, timeoutMs: PLAN_TIMEOUT_MS },
  );
  return (await readFile(outputFile, 'utf8')).trim();
}

export function createTaskDeps(executor: Executor, repoRoot: string): TaskDeps {
  const fetchBase = () =>
    run('git', ['fetch', 'origin', `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`], {
      cwd: repoRoot,
    });
  const remoteBranchExists = async (branch: string) => {
    const output = await run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return output.trim().length > 0;
  };

  return {
    github,
    secrets: [process.env.GH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN].filter(
      (secret): secret is string => Boolean(secret),
    ),
    workspace: {
      async claimBranch(branch) {
        await fetchBase();
        const sha = (await run('git', ['rev-parse', `origin/${BASE_BRANCH}`], { cwd: repoRoot })).trim();
        try {
          await github.createBranchRef(branch, sha);
          return true;
        } catch (error) {
          if (await remoteBranchExists(branch)) return false;
          throw error;
        }
      },
      async prepare(branch) {
        const cwd = join(repoRoot, '.claude', 'worktrees', branch.replace('agent/', ''));
        await run('git', ['worktree', 'add', '-b', branch, cwd, `origin/${BASE_BRANCH}`], { cwd: repoRoot });
        return cwd;
      },
      stagedDiff(cwd) {
        return run('git', ['diff', '--cached', '--no-ext-diff'], { cwd });
      },
      async stageAndListChanges(cwd) {
        await run('git', ['add', '--all'], { cwd });
        const output = await run('git', ['diff', '--cached', '--name-only', '--no-renames', '-z'], { cwd });
        return output.split('\0').filter(Boolean);
      },
      async commitAndPush(cwd, branch, message) {
        await run('git', [...GIT_IDENTITY, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message], { cwd });
        if (executor === 'cloud') await run('gh', ['auth', 'setup-git'], { cwd });
        await run('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `${branch}:refs/heads/${branch}`], { cwd });
      },
      async cleanup(cwd, branch) {
        await run('git', ['worktree', 'remove', '--force', cwd], { cwd: repoRoot });
        await run('git', ['branch', '-D', branch], { cwd: repoRoot });
      },
    },
    agents: {
      plan(prompt, cwd) {
        if (executor === 'mac') return runCodexPlan(prompt, cwd);
        return runClaude(prompt, cwd, 'Read,Glob,Grep', 20, PLAN_TIMEOUT_MS);
      },
      async implement(prompt, cwd) {
        await runClaude(prompt, cwd, 'Read,Edit,Write,Glob,Grep', 40, IMPLEMENT_TIMEOUT_MS);
      },
    },
  };
}
