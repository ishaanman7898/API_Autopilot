import { fetchJson } from './net.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

const parse = (v) => {
  const m = VERSION.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: v.includes('-') } : null;
};
const compare = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
};

// The line a version belongs to: its major, or 0.minor below 1.0, where npm treats each minor as breaking.
export function lineOf(version) {
  const v = parse(version);
  if (!v) return null;
  return v.major > 0 ? String(v.major) : `0.${v.minor}`;
}

// The line a dependency range is pinned to, or null for ranges the watcher does not follow, such as
// *, latest, workspace:, file:, git and URL dependencies. An npm: alias names its own package.
export function rangeLine(name, range) {
  if (typeof range !== 'string') return null;
  let target = name;
  let spec = range.trim();
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(spec);
  if (alias) { target = alias[1]; spec = alias[2]; }
  if (/^(workspace:|file:|link:|git|github:|https?:|[\w-]+\/[\w-]+$)/.test(spec)) return null;
  const m = /^[\^~>=v\s]*(\d+)(?:\.(\d+|x|\*))?/.exec(spec);
  if (!m) return null;
  const major = Number(m[1]);
  if (major > 0) return { target, line: String(major) };
  if (m[2] === undefined || m[2] === 'x' || m[2] === '*') return null;
  return { target, line: `0.${Number(m[2])}` };
}

const packageUrl = (registry, name) => `${registry}/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;

// Released versions and the latest tag of a package, from the abbreviated registry document.
export async function packageVersions(name, { registry = NPM_REGISTRY, fetchImpl } = {}) {
  const doc = await fetchJson(packageUrl(registry, name), { fetchImpl, accept: 'application/vnd.npm.install-v1+json' });
  const versions = Object.keys(doc.versions ?? {}).filter((v) => parse(v) && !parse(v).pre).sort(compare);
  return { latest: doc['dist-tags']?.latest ?? versions.at(-1), versions, deprecated: Object.fromEntries(Object.entries(doc.versions ?? {}).filter(([, m]) => m.deprecated).map(([v, m]) => [v, m.deprecated])) };
}

// The full package.json of one published version, which carries its repository.
export const packageManifest = (name, version, { registry = NPM_REGISTRY, fetchImpl } = {}) => fetchJson(`${packageUrl(registry, name)}/${encodeURIComponent(version)}`, { fetchImpl });

// Dependencies whose latest release is on a newer line than the one package.json allows.
// manifests maps package.json paths to their text. Returns one entry per package and line, with the
// newest version on the current line as `from` and the latest release as `to`.
export async function findUpgrades(manifests, { registry = NPM_REGISTRY, fetchImpl, only = [] } = {}) {
  const wanted = new Map();
  for (const [file, text] of Object.entries(manifests)) {
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        const current = rangeLine(name, range);
        if (!current || (only.length && !only.includes(name))) continue;
        const key = `${current.target} ${current.line}`;
        if (!wanted.has(key)) wanted.set(key, { name, package: current.target, line: current.line, manifests: [] });
        wanted.get(key).manifests.push({ file, field, range });
      }
    }
  }
  const upgrades = [];
  const skipped = [];
  const cache = new Map();
  for (const want of wanted.values()) {
    let info = cache.get(want.package);
    if (!info) {
      try { info = await packageVersions(want.package, { registry, fetchImpl }); } catch (e) { skipped.push({ package: want.package, reason: e.message }); continue; }
      cache.set(want.package, info);
    }
    const latest = info.latest;
    if (!latest || !parse(latest) || parse(latest).pre) continue;
    const onLine = info.versions.filter((v) => lineOf(v) === want.line);
    if (!onLine.length || lineOf(latest) === want.line || compare(latest, onLine.at(-1)) <= 0) continue;
    upgrades.push({ ...want, from: onLine.at(-1), to: latest, deprecated: info.deprecated[latest] ?? null });
  }
  upgrades.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
  return { upgrades, skipped };
}
