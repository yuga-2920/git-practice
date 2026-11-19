import { parseIssueNumber } from './route.ts';
import { createTaskDeps } from './runtime.ts';
import { runTask } from './task.ts';

const issueNumber = parseIssueNumber(process.env.ISSUE_NUMBER);
const result = await runTask(issueNumber, 'cloud', createTaskDeps('cloud', process.cwd()));
console.log(`Issue #${issueNumber}: ${result.status}`);
if (result.status === 'needs-human') process.exitCode = 1;
