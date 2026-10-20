#!/usr/bin/env node
// Helper for action.yml in watch mode: opens one draft pull request per upgrade in a watch plan.
// Usage: watch-prs.mjs <plan.json>. TEST_CMD, when set, runs after each upgrade is applied. INSTALL_CMD is
// empty for the package manager the lockfile names, none to install nothing, or a command to run instead.
// TYPECHECK set to false turns off the type-check that runs after each install.
import { spawnSync } from 'node:child_process';
import { openWatchPullRequests } from '../src/watchpr.js';

const [planPath] = process.argv.slice(2);
if (!planPath) {
  console.error('usage: watch-prs.mjs <plan.json>');
  process.exit(2);
}
// gh's stderr is captured so watch mode can tell when the repository refuses the pull request, and printed as is.
const gh = (args) => {
  const r = spawnSync('gh', args, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8' });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')} failed with exit code ${r.status ?? r.error?.message}`), { stderr: r.stderr ?? '' });
};
const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
const runUrl = server && repo && run ? `${server}/${repo}/actions/runs/${run}` : null;
process.exitCode = await openWatchPullRequests({ root: process.cwd(), planPath, testCmd: process.env.TEST_CMD || null, install: process.env.INSTALL_CMD || 'auto', typecheck: process.env.TYPECHECK !== 'false', runUrl, gh, out: (s) => console.log(s), err: (s) => console.error(s) });
