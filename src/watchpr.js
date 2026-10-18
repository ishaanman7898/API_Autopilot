import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { main } from './cli.js';
import { loadConfig } from './commands/common.js';
import { changedPaths, watchBody, watchBranch, watchTitle } from './prbody.js';

// Opens one draft pull request per upgrade in a `watch` plan, for the Action's watch mode. Each upgrade is
// applied on its own branch from the commit that was checked out, with --allow-unsigned only for drafts.
// An upgrade whose branch already exists on the remote is skipped, so a scheduled run does not open it twice.
// git and gh get argument arrays, never a shell. gh can be replaced in tests. Returns the exit code.
export async function openWatchPullRequests({ root, planPath, testCmd = null, gh, out = () => {}, err = () => {} }) {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const must = (...args) => {
    const r = git(...args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout.trim();
  };
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const baseSha = must('rev-parse', 'HEAD');
  const baseBranch = must('rev-parse', '--abbrev-ref', 'HEAD');
  const pinned = loadConfig(root).pins.length > 0;
  const evidencePath = join(root, '.apimigrate', 'evidence.json');
  let failed = 0;
  const backToBase = () => {
    must('reset', '-q', '--hard');
    must('checkout', '-q', '--detach', baseSha);
  };

  for (const entry of plan.upgrades) {
    const name = `${entry.package} ${entry.from} -> ${entry.to}`;
    if (entry.source !== 'signed' && entry.source !== 'draft') { out(`${name}: no rules, ${entry.reason}`); continue; }
    if (entry.source === 'draft' && pinned) { out(`${name}: skipped, the draft is unsigned and .apimigrate.yml sets pins`); continue; }
    const branch = watchBranch(entry);
    const remote = git('ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`);
    if (remote.status === 0) { out(`${name}: skipped, ${branch} already exists`); continue; }
    if (remote.status !== 2) { err(`${name}: could not list remote branches: ${(remote.stderr || '').trim()}`); failed++; continue; }

    must('checkout', '-q', '-B', branch, baseSha);
    for (const f of ['evidence.json', 'unresolved.json']) rmSync(join(root, '.apimigrate', f), { force: true });
    const rules = resolve(root, entry.rules);
    const args = ['apply', '--root', root, '--rules', rules, ...(entry.source === 'signed' ? ['--keys', resolve(root, entry.keys)] : ['--allow-unsigned']), ...(testCmd ? ['--test-cmd', testCmd] : [])];
    const code = await main(args, { out, err });
    if (code !== 0 || !existsSync(evidencePath)) {
      err(`${name}: apply exited with ${code}, no pull request opened`);
      failed++;
      backToBase();
      must('branch', '-q', '-D', branch);
      continue;
    }
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const stem = rules.replace(/(\.rules)?\.json$/, '');
    copyFileSync(evidencePath, `${stem}.evidence.json`);
    const paths = changedPaths(evidence);
    if (!paths.length) {
      out(`${name}: nothing to migrate, no pull request opened`);
      backToBase();
      must('branch', '-q', '-D', branch);
      continue;
    }
    const title = watchTitle(entry);
    const bodyFile = `${stem}.pr.md`;
    writeFileSync(bodyFile, watchBody(entry, evidence, JSON.parse(readFileSync(rules, 'utf8')), { rulesPath: basename(rules) }));
    must('add', '--', ...paths);
    must('-c', 'user.name=apimigrate', '-c', 'user.email=apimigrate@users.noreply.github.com', 'commit', '-q', '-m', title);
    must('push', '-q', 'origin', `${branch}:refs/heads/${branch}`);
    try {
      gh(['pr', 'create', '--draft', ...(baseBranch !== 'HEAD' ? ['--base', baseBranch] : []), '--head', branch, '--title', title, '--body-file', bodyFile]);
      out(`${name}: opened a draft pull request from ${branch}${entry.source === 'signed' ? '' : ', marked unsigned'}`);
    } catch (e) {
      // Without the pull request the branch would make every later run skip this upgrade.
      err(`${name}: ${e.message}`);
      git('push', '-q', 'origin', '--delete', branch);
      failed++;
    }
    backToBase();
  }
  if (baseBranch !== 'HEAD') must('checkout', '-q', baseBranch);
  return failed ? 1 : 0;
}
