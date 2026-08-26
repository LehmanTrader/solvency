export function record(store, event, cb) {
  store.get('audit-log', (err, log) => {
    const next = (err ? [] : log).concat([event]);
    store.put('audit-log', next, 0, () => cb(null, next.length));
  });
}
export function entries(store, cb) {
  store.get('audit-log', (err, log) => cb(null, err ? [] : log));
}
