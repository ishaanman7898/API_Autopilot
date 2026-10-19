import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { main } from './cli.js';
import { loadConfig } from './commands/common.js';
import { installDependencies } from './install.js';
import { changedPaths, watchBody, watchBranch, watchTitle } from './prbody.js';

// Opens one draft pull request per upgrade in a `watch` plan, for the Action's watch mode. Each upgrade is
// applied on its own branch from the commit that was checked out, with --allow-unsigned only for drafts.
// An upgrade whose branch already exists on the remote is skipped, so a scheduled run does not open it twice.
// New versions are installed before the tests: install is 'auto' for the package manager the lockfile names,
// 'none', or a shell command. After an upgrade installed, the base versions are installed again, so the next
// upgrade is tested against the base dependencies. git and gh get argument arrays, never a shell. gh can be
// replaced in tests. Returns the exit code.
export async function openWatchPullRequests({ root, planPath, testCmd = null, install = 'auto', runUrl = null, gh, out = () => {}, err = () => {} }) {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const must = (...args) => {
    const r = git(...args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout.trim();
  };
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const baseSha = must('rev-parse', 'HEAD');
  const baseBranch = must('rev-parse', '--abbrev-ref', 'HEAD');
  const cfg = loadConfig(root);
  const pinned = cfg.pins.length > 0;
  const evidencePath = join(root, '.apimigrate', 'evidence.json');
  let failed = 0;
  const installFlags = install === 'none' ? [] : install === 'auto' ? ['--install'] : ['--install-cmd', install];
  const backToBase = () => {
    must('reset', '-q', '--hard');
    must('checkout', '-q', '--detach', baseSha);
    if (!existsSync(evidencePath)) return;
    const installed = JSON.parse(readFileSync(evidencePath, 'utf8')).install;
    if (!installed) return;
    const manifests = installed.runs.map((r) => (r.dir === '.' ? 'package.json' : `${r.dir}/package.json`));
    const back = installDependencies(root, manifests, { cmd: install === 'auto' ? null : install });
    if (!back.ok) err(`could not install the base dependencies again: ${back.runs.at(-1).cmd} exited with ${back.runs.at(-1).exitCode}`);
    must('reset', '-q', '--hard');
  };

  for (const entry of plan.upgrades) {
    const name = `${entry.package} ${entry.from} -> ${entry.to}`;
    if (entry.source !== 'signed' && entry.source !== 'draft') { out(`${name}: no rules, ${entry.reason}`); continue; }
    if (entry.source === 'draft' && pinned) { out(`${name}: skipped, the draft is unsigned and .apimigrate.yml sets pins`); continue; }
    // apply refuses a provider that is not listed, so a draft from one is skipped rather than failing the run.
    // Signed rules were already checked against the list when watch fetched them.
    const provider = entry.source === 'draft' && cfg.providers.length ? JSON.parse(readFileSync(resolve(root, entry.rules), 'utf8')).provider : null;
    if (provider !== null && !cfg.providers.includes(provider)) { out(`${name}: skipped, the draft's provider ${provider} is not in the providers list of .apimigrate.yml`); continue; }
    const branch = watchBranch(entry);
    const remote = git('ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`);
    if (remote.status === 0) { out(`${name}: skipped, ${branch} already exists`); continue; }
    if (remote.status !== 2) { err(`${name}: could not list remote branches: ${(remote.stderr || '').trim()}`); failed++; continue; }

    must('checkout', '-q', '-B', branch, baseSha);
    for (const f of ['evidence.json', 'unresolved.json']) rmSync(join(root, '.apimigrate', f), { force: true });
    const rules = resolve(root, entry.rules);
    const args = ['apply', '--root', root, '--rules', rules, ...(entry.source === 'signed' ? ['--keys', resolve(root, entry.keys)] : ['--allow-unsigned']), ...installFlags, ...(testCmd ? ['--test-cmd', testCmd] : [])];
    const code = await main(args, { out, err });
    const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
    // When only the tests failed, the pull request still opens, marked as failing, so the upgrades that break
    // the most are not the ones nobody hears about. A failed gate or install still stops it.
    const testsFailed = code === 1 && evidence?.gate?.ok === true && evidence.tests != null && evidence.tests.exitCode !== 0 && (evidence.install?.runs ?? []).every((r) => r.exitCode === 0);
    if ((code !== 0 && !testsFailed) || !evidence) {
      err(`${name}: apply exited with ${code}, no pull request opened`);
      failed++;
      backToBase();
      must('branch', '-q', '-D', branch);
      continue;
    }
    if (testsFailed) err(`${name}: tests failed with exit code ${evidence.tests.exitCode}, the pull request is opened and marked as failing tests`);
    const stem = rules.replace(/(\.rules)?\.json$/, '');
    copyFileSync(evidencePath, `${stem}.evidence.json`);
    const paths = changedPaths(evidence);
    if (!paths.length) {
      out(`${name}: nothing to migrate, no pull request opened`);
      backToBase();
      must('branch', '-q', '-D', branch);
      continue;
    }
    const title = watchTitle(entry, evidence);
    const bodyFile = `${stem}.pr.md`;
    writeFileSync(bodyFile, watchBody(entry, evidence, JSON.parse(readFileSync(rules, 'utf8')), { rulesPath: basename(rules), runUrl }));
    must('add', '--', ...paths);
    must('-c', 'user.name=apimigrate', '-c', 'user.email=apimigrate@users.noreply.github.com', 'commit', '-q', '-m', title);
    must('push', '-q', 'origin', `${branch}:refs/heads/${branch}`);
    try {
      gh(['pr', 'create', '--draft', ...(baseBranch !== 'HEAD' ? ['--base', baseBranch] : []), '--head', branch, '--title', title, '--body-file', bodyFile]);
      const marks = [entry.source !== 'signed' && 'unsigned', testsFailed && 'failing tests'].filter(Boolean);
      out(`${name}: opened a draft pull request from ${branch}${marks.length ? `, marked ${marks.join(' and ')}` : ''}`);
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
