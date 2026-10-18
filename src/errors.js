// Exit codes: 0 ok, 1 gate, test or verify failure, 2 usage or config error, 3 trust failure.
export const EXIT = { ok: 0, failed: 1, usage: 2, trust: 3 };

export class UsageError extends Error {}
