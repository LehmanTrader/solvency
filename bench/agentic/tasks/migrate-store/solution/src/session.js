export function createSessions(store) {
  return {
    async open(id, user) { await store.put(`sess:${id}`, user); return user; },
    async whoIs(id) {
      try { return await store.get(`sess:${id}`); } catch { return null; }
    },
  };
}
