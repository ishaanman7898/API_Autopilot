// Bounded HTTPS reads for the watcher, with no redirects. Everything fetched is untrusted: rule files are only used after
// their signature checks out, and everything else is parsed as data. fetchImpl can be replaced in tests.

export class FetchError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 15000, maxBytes = 25 * 1024 * 1024, accept = '*/*' } = {}) {
  if (!/^https:\/\//.test(url)) throw new FetchError(`refusing to fetch ${url}: only https is allowed`);
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept } });
  } catch (e) {
    throw new FetchError(`could not fetch ${url}: ${e.message}`);
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
