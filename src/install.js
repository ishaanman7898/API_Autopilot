import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { matchesAny } from './glob.js';

// After a rule edits package.json, the new versions must be installed before tests mean anything, and the
// lockfile must match or `npm ci` fails on the pull request. Each package manager updates its own lockfile
// here without running any package's install scripts. The first lockfile found decides the manager.
const NPM = ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
const MANAGERS = [
  ['pnpm-lock.yaml', () => ['pnpm', 'install', '--ignore-scripts', '--no-frozen-lockfile']],
  ['yarn.lock', (dir) => (existsSync(join(dir, '.yarnrc.yml')) ? ['yarn', 'install', '--mode=skip-build', '--no-immutable'] : ['yarn', 'install', '--ignore-scripts', '--non-interactive'])],
  ['bun.lock', () => ['bun', 'install', '--ignore-scripts']],
  ['bun.lockb', () => ['bun', 'install', '--ignore-scripts']],
  ['npm-shrinkwrap.json', () => NPM],
  ['package-lock.json', () => NPM],
];

// LF text digests, the same as the evidence uses, so a lockfile can be checked in a head checkout.
const digest = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex') : null);

// Whether the package.json in dir lists member, a folder relative to dir, among its workspaces.
function hasWorkspace(dir, member) {
  let ws;
  try { ws = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).workspaces; } catch { return false; }
  const patterns = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  return patterns.some((p) => typeof p === 'string' && matchesAny(member, [p.replace(/^\.\//, '').replace(/\/$/, '')]));
}

// Where to install for each changed package.json: the closest folder at or above it inside the repository
// that has a lockfile, else the closest workspace root that lists it, else its own folder, which then gets no lockfile.
export function installTargets(root, manifests) {
  const targets = new Map();
  for (const manifest of manifests) {
    const own = posix.dirname(manifest);
    const up = [];
    for (let d = own; ; d = posix.dirname(d)) {
      up.push(d);
      if (d === '.') break;
    }
    let target = null;
    for (const d of up) {
      const found = MANAGERS.find(([lock]) => existsSync(join(root, d, lock)));
      if (found) { target = { dir: d, lockfile: posix.join(d, found[0]), argv: found[1](join(root, d)) }; break; }
    }
    if (!target) {
      const dir = up.slice(1).find((d) => hasWorkspace(join(root, d), posix.relative(d === '.' ? '' : d, own))) ?? own;
      target = { dir, lockfile: null, argv: [...NPM, '--no-package-lock'] };
    }
    if (!targets.has(target.dir)) targets.set(target.dir, target);
  }
  return [...targets.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

// Runs the installs, or one shell command at the root when the repository gives its own. Returns what ran
// and the lockfiles it changed, as { ok, runs: [{ dir, cmd, exitCode }], lockfiles: [{ path, before, after }], output }.
export function installDependencies(root, manifests, { cmd = null, spawn = spawnSync, timeoutMs = 10 * 60 * 1000 } = {}) {
  const targets = installTargets(root, manifests);
  const locks = targets.filter((t) => t.lockfile).map((t) => t.lockfile);
  const before = Object.fromEntries(locks.map((p) => [p, digest(join(root, p))]));
  const steps = cmd ? [{ dir: '.', argv: null, shell: cmd }] : targets;
  const runs = [];
  let output = '';
  for (const t of steps) {
    const options = { cwd: join(root, t.dir), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] };
    // On Windows npm, pnpm and yarn are .cmd files, which only run through a shell. The arguments are fixed words.
    const r = t.shell ? spawn(t.shell, { ...options, shell: true }) : spawn(t.argv[0], t.argv.slice(1), { ...options, shell: process.platform === 'win32' });
    const exitCode = r.status ?? 1;
    runs.push({ dir: t.dir, cmd: t.shell ?? t.argv.join(' '), exitCode });
    if (exitCode !== 0) {
      output = `${r.stderr || ''}${r.stdout || ''}${r.error ? r.error.message : ''}`.trim().split('\n').slice(-20).join('\n');
      break;
    }
  }
  const lockfiles = locks.map((path) => ({ path, before: before[path], after: digest(join(root, path)) })).filter((l) => l.before !== l.after);
  return { ok: runs.every((r) => r.exitCode === 0), runs, lockfiles, output };
}
