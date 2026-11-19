import * as github from './github.ts';
import { parseIssueNumber } from './route.ts';
import { markInterrupted } from './task.ts';

const issueNumber = parseIssueNumber(process.env.ISSUE_NUMBER);
const changed = await markInterrupted(
  issueNumber,
  'クラウド実行が途中で止まりました。再実行せず、人の判断を待ちます。',
  github,
);
console.log(`Issue #${issueNumber}: ${changed ? 'needs-human' : 'no change'}`);
