import './store.js';
// v1-era caller: open(id, user, cb) / whoIs(id, cb). Migrate to the v2 promise
// contract documented in SPEC.md.
export function createSessions(store) {
  return {
    open(id, user, cb) { store.put(`sess:${id}`, user, 0, (err) => cb(err, user)); },
    whoIs(id, cb) { store.get(`sess:${id}`, (err, user) => cb(null, err ? null : user)); },
  };
}
