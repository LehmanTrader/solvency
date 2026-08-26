export function createLimiter(max, windowMs) {
  const hits = [];
  return {
    allow(now) {
      while (hits.length && hits[0] < now - windowMs) hits.shift();
      if (hits.length >= max) return false;
      hits.push(now);
      return true;
    },
  };
}
