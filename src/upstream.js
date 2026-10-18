import { diffSurfaces, draftFromSurfaces, fetchApiSurface } from './apimd.js';
import { fetchText } from './net.js';
import { NPM_REGISTRY, packageManifest, packageVersions } from './registry.js';

// When a provider publishes no signed rules, `watch` drafts them the way `draft` does from two SDK checkouts,
// reading each release's api.md files from GitHub instead of from disk. Nothing here is trusted: the result
// is a draft, marked unsigned, for a person to review.

export const RAW = 'https://raw.githubusercontent.com';
const MAX_FILE = 5 * 1024 * 1024;
const NAME = /^[\w.-]+$/;

// The GitHub repository in a manifest's repository field, such as "git+https://github.com/muxinc/mux-node-sdk.git",
// "git@github.com:owner/repo.git", "github:owner/repo" or "owner/repo", with its directory in a monorepo.
export function githubRepo(manifest) {
  const field = manifest?.repository;
  const url = typeof field === 'string' ? field : field?.url;
  if (typeof url !== 'string') return null;
  const m = url.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ?? url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') return null;
  const dir = typeof field?.directory === 'string' ? field.directory.replace(/^\.?\/+|\/+$/g, '') : '';
  if (dir.split('/').some((s) => s === '..' || s === '.')) return null;
  return { owner: m[1], repo: m[2], dir };
}

// Where a release's source may be: the commit npm recorded when it was published, then the usual tag names.
export function releaseRefs(manifest, name, version) {
  const base = name.replace(/^@[^/]+\//, '');
  const head = /^[0-9a-f]{40}$/.test(manifest?.gitHead ?? '') ? manifest.gitHead : null;
  return [...new Set([head, `v${version}`, version, `${base}-v${version}`, `${base}@${version}`].filter(Boolean))];
}

// The api.md surface of one npm release, read from GitHub at the first ref that has an api.md.
export async function releaseSurface(name, version, { registry = NPM_REGISTRY, fetchImpl } = {}) {
  let manifest;
  try { manifest = await packageManifest(name, version, { registry, fetchImpl }); } catch (e) { return { ok: false, reason: e.message }; }
  const gh = githubRepo(manifest);
  if (!gh) return { ok: false, reason: `${name}@${version} names no GitHub repository` };
  const repo = `github.com/${gh.owner}/${gh.repo}`;
  const refs = releaseRefs(manifest, name, version);
  for (const ref of refs) {
    const at = (rel) => `${RAW}/${gh.owner}/${gh.repo}/${ref}/${gh.dir ? `${gh.dir}/` : ''}${rel}`;
    const get = async (rel) => {
      try { return await fetchText(at(rel), { fetchImpl, maxBytes: MAX_FILE, sameHostRedirects: 3 }); } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    };
    let root;
    try { root = await get('api.md'); } catch (e) { return { ok: false, reason: e.message }; }
    if (root == null) continue;
    let pkg = {};
    try { pkg = JSON.parse(await get('package.json') ?? '{}'); } catch { /* the name and version are then unknown */ }
    try {
      const surface = await fetchApiSurface((rel) => (rel === 'api.md' ? root : get(rel)), pkg);
      return { ok: true, surface, repo, ref, dir: gh.dir, owner: gh.owner, url: at('api.md') };
    } catch (e) {
      return { ok: false, reason: `${at('api.md')}: ${e.message}` };
    }
  }
  return { ok: false, reason: `${repo} has no api.md for ${name}@${version} at ${refs.join(', ')}` };
}

// Drafts rules for an upgrade from the api.md files of both releases. A new package name is only used when
// the old release kept the npm name in its package.json and the new name is published at the new version.
export async function draftedRulesFor(upgrade, { registry = NPM_REGISTRY, fetchImpl } = {}) {
  if (upgrade.name && upgrade.name !== upgrade.package) return { ok: false, reason: `${upgrade.name} is an npm alias for ${upgrade.package}, drafts are only made for dependencies under their own name` };
  const a = await releaseSurface(upgrade.package, upgrade.from, { registry, fetchImpl });
  if (!a.ok) return a;
  const b = await releaseSurface(upgrade.package, upgrade.to, { registry, fetchImpl });
  if (!b.ok) return b;
  const oldName = upgrade.package;
  let newName = oldName;
  let newVersion = upgrade.to;
  const next = b.surface.name;
  if (next && next !== oldName && (a.surface.name ?? oldName) === oldName && b.surface.version) {
    try {
      if ((await packageVersions(next, { registry, fetchImpl })).versions.includes(b.surface.version)) {
        newName = next;
        newVersion = b.surface.version;
      }
    } catch { /* not published under the new name, so the dependency keeps its name */ }
  }
  const { ruleSet, report } = draftFromSurfaces(diffSurfaces(a.surface, b.surface), {
    provider: b.owner,
    from: upgrade.from,
    to: upgrade.to,
    oldName,
    newName,
    newVersion,
    oldMethods: [...a.surface.methods.values()].flat().map((m) => m.call),
  });
  const where = (s) => ({ repo: s.repo, ref: s.ref, dir: s.dir, url: s.url, files: s.surface.files.length });
  return { ok: true, ruleSet, report, from: where(a), to: where(b) };
}
