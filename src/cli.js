import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeys, isSunset, signRuleSet, validateRuleSet, verifyRuleSet } from './rule.js';
import { applyRuleSet } from './engine.js';
import { linePct, runGate } from './gate.js';
import { buildEvidence, replay } from './evidence.js';
import { diffSpecs, draftRules } from './diff.js';
import { parseConfig, withDefaults } from './config.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.apimigrate']);
const CODE = /\.[cm]?[jt]sx?$/;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { flags, pos };
}

function readTree(root, paths = ['.'], extensions = []) {
  const wanted = { test: (name) => (extensions.length ? extensions.some((x) => name.endsWith(x)) : CODE.test(name)) };
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (wanted.test(name)) files[relative(root, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
    }
  };
  for (const p of paths) {
    const full = resolve(root, p);
    if (existsSync(full)) statSync(full).isDirectory() ? walk(full) : (files[relative(root, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8'));
  }
  return files;
}

function loadConfig(root) {
  const p = join(root, '.apimigrate.yml');
  return withDefaults(existsSync(p) ? parseConfig(readFileSync(p, 'utf8')) : {});
}

async function loadKeys(flags) {
  if (flags.pubkey) return [{ keyId: flags['key-id'] ?? readJson(flags.rules).signature?.keyId, publicKey: readFileSync(flags.pubkey, 'utf8') }];
  if (flags['well-known']) {
    const url = `https://${flags['well-known']}/.well-known/apimigrate-keys.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
    return (await res.json()).keys;
  }
  return [];
}

function audit(root, event) {
  const dir = join(root, '.apimigrate');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'audit.log'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}

const commands = {
  keygen({ flags }) {
    const out = flags.out ?? '.';
    const { publicPem, privatePem } = generateKeys();
    writeFileSync(join(out, 'apimigrate-private.pem'), privatePem, { mode: 0o600 });
    writeFileSync(join(out, 'apimigrate-public.pem'), publicPem);
    console.log(`wrote ${join(out, 'apimigrate-private.pem')} (keep secret) and apimigrate-public.pem`);
    console.log('publish the public key at /.well-known/apimigrate-keys.json as {"keys":[{"keyId","publicKey"}]}');
  },

  lint({ pos }) {
    const errors = validateRuleSet(readJson(pos[0]));
    errors.forEach((e) => console.error('error:', e));
    return errors.length ? 1 : (console.log('ok'), 0);
  },

  sign({ pos, flags }) {
    const rs = readJson(pos[0]);
    const errors = validateRuleSet(rs);
    if (errors.length) return errors.forEach((e) => console.error('error:', e)), 1;
    const signed = signRuleSet(rs, readFileSync(flags.key, 'utf8'), flags['key-id'] ?? 'k1');
    writeFileSync(flags.out ?? pos[0], JSON.stringify(signed, null, 2) + '\n');
    console.log(`signed ${signed.id} hash=${signed.signature.hash}`);
  },

  async check({ pos, flags }) {
    const res = verifyRuleSet(readJson(pos[0]), await loadKeys({ ...flags, rules: pos[0] }));
    console.log(res.ok ? `valid ${res.hash}` : `INVALID: ${res.reason}`);
    return res.ok ? 0 : 1;
  },

  draft({ pos, flags }) {
    const diff = diffSpecs(readJson(pos[0]), readJson(pos[1]));
    const rules = draftRules(diff, { provider: flags.provider ?? 'provider', pkg: flags.package ?? 'sdk', from: flags.from ?? 'old', to: flags.to ?? 'new' });
    writeFileSync(flags.out ?? 'draft-rules.json', JSON.stringify(rules, null, 2) + '\n');
    console.log(`draft with ${rules.rules.length} rules (${diff.renamedOps.length} renames, ${diff.removedOps.length} removals); review before signing`);
  },

  async apply({ flags }) {
    const root = resolve(flags.root ?? '.');
    const cfg = loadConfig(root);
    const rs = readJson(flags.rules);

    const errors = validateRuleSet(rs);
    if (errors.length) return errors.forEach((e) => console.error('error:', e)), 1;
    if (isSunset(rs)) return console.error(`rule ${rs.id} passed its sunset date ${rs.sunset}`), 1;
    if (cfg.providers.length && !cfg.providers.includes(rs.provider)) return console.error(`provider ${rs.provider} is not allowed by .apimigrate.yml`), 1;
    if (cfg.pins.length && !cfg.pins.includes(rs.signature?.hash)) return console.error('rule hash is not pinned in .apimigrate.yml'), 1;
    if (!flags['allow-unsigned']) {
      const res = verifyRuleSet(rs, await loadKeys({ ...flags, rules: flags.rules }));
      if (!res.ok) return console.error(`refusing unsigned or invalid rule: ${res.reason}`), 1;
    }

    const before = readTree(root, cfg.paths, cfg.extensions);
    const result = applyRuleSet(rs, before);
    if (!flags['dry-run']) {
      for (const [p, text] of Object.entries(result.files)) if (before[p] !== text) writeFileSync(join(root, p), text);
    }

    let tests = null;
    if (flags['test-cmd'] && !flags['dry-run']) {
      const r = spawnSync(flags['test-cmd'], { cwd: root, shell: true, encoding: 'utf8' });
      tests = { cmd: flags['test-cmd'], exitCode: r.status };
    }

    const after = flags['dry-run'] ? result.files : readTree(root, cfg.paths, cfg.extensions);
    const cov = (p) => (p && existsSync(p) ? linePct(readJson(p)) : null);
    const gate = runGate({ base: before, head: after, coverageBase: cov(flags['cov-base']), coverageHead: cov(flags['cov-head']) });
    const evidence = buildEvidence({ ruleSet: rs, before, result, gate, tests });

    mkdirSync(join(root, '.apimigrate'), { recursive: true });
    writeFileSync(join(root, '.apimigrate', 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    if (result.unresolved.length) writeFileSync(join(root, '.apimigrate', 'unresolved.json'), JSON.stringify(result.unresolved, null, 2) + '\n');
    audit(root, { event: 'apply', rule: rs.id, hash: rs.signature?.hash ?? null, changed: evidence.files.length, unresolved: result.unresolved.length, gate: gate.ok });

    console.log(`${result.changes.length} call sites changed in ${evidence.files.length} files, ${result.unresolved.length} need an agent`);
    gate.failures.forEach((f) => console.error('gate:', f));
    if (tests && tests.exitCode !== 0) console.error(`tests failed (exit ${tests.exitCode})`);
    return gate.ok && (!tests || tests.exitCode === 0) ? 0 : 1;
  },

  // Run on a checkout of the PR's base commit.
  async verify({ flags }) {
    const root = resolve(flags.root ?? '.');
    const rs = readJson(flags.rules);
    const evidence = readJson(flags.evidence);
    const res = replay(rs, readTree(root, loadConfig(root).paths, loadConfig(root).extensions), evidence);
    console.log(res.ok ? `replay matches ${res.digest}` : `MISMATCH expected ${res.expected} got ${res.digest}`);
    if (res.note) console.log(res.note);
    return res.ok ? 0 : 1;
  },

  gate({ pos, flags }) {
    const cov = (p) => (p ? linePct(readJson(p)) : null);
    const res = runGate({ base: readTree(resolve(pos[0])), head: readTree(resolve(pos[1])), coverageBase: cov(flags['cov-base']), coverageHead: cov(flags['cov-head']) });
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  },
};

const HELP = `apimigrate <command>
  keygen [--out dir]                          create an ed25519 signing key pair
  lint <rules.json>                           validate a rule file
  sign <rules.json> --key priv.pem [--key-id] sign a rule file
  check <rules.json> --pubkey pub.pem | --well-known domain
  draft <old-spec.json> <new-spec.json> [--provider --package --from --to --out]
  apply --rules r.json (--pubkey pub.pem | --well-known domain) [--root dir] [--dry-run] [--test-cmd cmd] [--cov-base f --cov-head f]
  verify --rules r.json --evidence e.json [--root dir]
  gate <baseDir> <headDir> [--cov-base f --cov-head f]`;

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!commands[name]) return console.log(HELP), name ? 1 : 0;
  try {
    return (await commands[name](parseArgs(rest))) ?? 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}
