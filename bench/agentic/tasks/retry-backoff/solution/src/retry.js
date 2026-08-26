export async function retry(fn, policy) {
  const { retries, baseMs, factor, capMs, jitter, sleep, budgetMs, retryable } = policy;
  const attempts = [];
  let slept = 0;
  let lastErr = null;
  for (let n = 1; n <= retries + 1; n++) {
    let delayMs = 0;
    if (n > 1) {
      const raw = Math.min(baseMs * Math.pow(factor, n - 2), capMs);
      delayMs = jitter(raw);
      if (slept + delayMs > budgetMs) { lastErr.retryStopped = 'budget'; lastErr.attempts = attempts; throw lastErr; }
      await sleep(delayMs);
      slept += delayMs;
    }
    attempts.push({ n, delayMs });
    try {
      const value = await fn(n);
      return { value, attempts };
    } catch (e) {
      lastErr = e;
      if (!retryable(e)) { e.retryStopped = 'non-retryable'; e.attempts = attempts; throw e; }
    }
  }
  lastErr.retryStopped = 'exhausted'; lastErr.attempts = attempts;
  throw lastErr;
}
