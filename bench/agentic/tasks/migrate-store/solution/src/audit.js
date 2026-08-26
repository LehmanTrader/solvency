export async function record(store, event) {
  let log;
  try { log = await store.get('audit-log'); } catch { log = []; }
  const next = log.concat([event]);
  await store.put('audit-log', next);
  return next.length;
}
export async function entries(store) {
  try { return await store.get('audit-log'); } catch { return []; }
}
