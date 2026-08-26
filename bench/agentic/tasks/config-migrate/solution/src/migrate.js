export function migrateConfig(v1) {
  const { server, timeoutSec, features, debug, schemaVersion, ...rest } = v1;
  const host = server?.host ?? '0.0.0.0';
  const port = server?.port ?? 8080;
  const f = {};
  for (const name of features ?? []) f[name] = true;
  if (debug === true && !('log' in f)) f.log = true;
  return { ...rest, listen: `${host}:${port}`, timeoutMs: (timeoutSec ?? 30) * 1000, features: f, schemaVersion: 2 };
}
