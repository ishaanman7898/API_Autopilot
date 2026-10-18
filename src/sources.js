import { UsageError } from './errors.js';
import { fetchKeySet } from './keys.js';
import { fetchJson } from './net.js';
import { lineOf } from './registry.js';
import { isSunset, validateRuleSet } from './rule.js';
import { verifyRuleSet } from './signing.js';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// The `sources` setting: "package domain" pairs, such as "@mux/mux-node mux.com".
export function parseSources(list) {
  const sources = new Map();
  for (const item of list) {
    const parts = item.trim().split(/\s+/);
    if (parts.length !== 2 || !HOST.test(parts[1])) throw new UsageError(`.apimigrate.yml: source "${item}" must be a package name and a domain, such as "acme-sdk acme.com"`);
    sources.set(parts[0], parts[1]);
  }
  return sources;
}

// A provider lists its rule files at https://<domain>/.well-known/apimigrate-rules.json:
// { "rules": [{ "package": "acme-sdk", "from": "1", "to": "2", "url": "https://acme.com/rules/1-to-2.json" }] }.
// from and to are version lines, as `watch` reports them. The rule file is used only when it is valid,
// signed by a key the same domain publishes, for this package, not past its sunset, and allowed by the
// repository's providers and pins. Every other outcome comes back with a reason.
export async function signedRulesFor(upgrade, domain, { fetchImpl, cfg, now = new Date() } = {}) {
  const index = `https://${domain}/.well-known/apimigrate-rules.json`;
  let listing;
  try { listing = await fetchJson(index, { fetchImpl, maxBytes: 1024 * 1024 }); } catch (e) { return { ok: false, reason: e.message }; }
  const toLine = lineOf(upgrade.to);
  const entry = (Array.isArray(listing?.rules) ? listing.rules : []).find((r) => r?.package === upgrade.package && String(r.from) === upgrade.line && String(r.to) === toLine);
  if (!entry) return { ok: false, reason: `${index} lists no rules for ${upgrade.package} ${upgrade.line} to ${toLine}` };
  if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) return { ok: false, reason: `${index} gives no https url for ${upgrade.package}` };
  let ruleSet;
  try { ruleSet = await fetchJson(entry.url, { fetchImpl, maxBytes: 5 * 1024 * 1024 }); } catch (e) { return { ok: false, reason: e.message }; }
  const errors = validateRuleSet(ruleSet);
  if (errors.length) return { ok: false, reason: `${entry.url} is not a valid rule file: ${errors[0]}` };
  if (ruleSet.package !== upgrade.package) return { ok: false, reason: `${entry.url} is for ${ruleSet.package}, not ${upgrade.package}` };
  let keys;
  try { keys = await fetchKeySet(domain, { fetchImpl }); } catch (e) { return { ok: false, reason: e.message }; }
  const verified = verifyRuleSet(ruleSet, keys, now);
  if (!verified.ok) return { ok: false, reason: `${entry.url}: ${verified.reason}` };
  if (isSunset(ruleSet, now)) return { ok: false, reason: `${entry.url} has passed its sunset date ${ruleSet.sunset}` };
  if (cfg.providers.length && !cfg.providers.includes(ruleSet.provider)) return { ok: false, reason: `provider ${ruleSet.provider} is not allowed by .apimigrate.yml` };
  if (cfg.pins.length && !cfg.pins.includes(verified.hash)) return { ok: false, reason: `rule hash ${verified.hash} is not in the pins list of .apimigrate.yml` };
  return { ok: true, ruleSet, keys, url: entry.url, hash: verified.hash, keyId: verified.keyId };
}
