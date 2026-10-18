// Bounded HTTPS reads for the watcher, with no redirects. Everything fetched is untrusted: rule files are only used after
// their signature checks out, and everything else is parsed as data. fetchImpl can be replaced in tests.

export class FetchError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

// sameHostRedirects allows that many redirects that stay on the same https host, such as GitHub's for a renamed repository.
export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 15000, maxBytes = 25 * 1024 * 1024, accept = '*/*', sameHostRedirects = 0 } = {}) {
  if (!/^https:\/\//.test(url)) throw new FetchError(`refusing to fetch ${url}: only https is allowed`);
  let res;
  for (let hops = 0; ; hops++) {
    try {
      res = await fetchImpl(url, { redirect: sameHostRedirects ? 'manual' : 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept } });
    } catch (e) {
      throw new FetchError(`could not fetch ${url}: ${e.message}`);
    }
    if (!sameHostRedirects || ![301, 302, 303, 307, 308].includes(res.status)) break;
    let next;
    try { next = new URL(res.headers?.get?.('location') ?? '', url); } catch { next = null; }
    if (!next || next.protocol !== 'https:' || next.host !== new URL(url).host) throw new FetchError(`refusing to follow ${url} to another host`);
    if (hops >= sameHostRedirects) throw new FetchError(`${url} redirects more than ${sameHostRedirects} times`);
    url = next.href;
  }
  if (!res.ok) throw new FetchError(`could not fetch ${url}: HTTP ${res.status}`, res.status);
  const length = Number(res.headers?.get?.('content-length') ?? 0);
  if (length > maxBytes) throw new FetchError(`${url} is larger than ${maxBytes} bytes`);
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new FetchError(`${url} is larger than ${maxBytes} bytes`);
  return text;
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { accept: 'application/json', ...options });
  try { return JSON.parse(text); } catch { throw new FetchError(`${url} is not valid JSON`); }
}
