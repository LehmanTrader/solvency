export function validateConfig(cfg) {
  const problems = [];
  let { port, host = 'localhost', retries = 3 } = cfg;
  if (port === undefined) problems.push('port missing');
  else if (!Number.isInteger(port)) problems.push('port not an integer');
  else if (port < 1 || port > 65535) problems.push('port out of range');
  if (typeof host !== 'string' || host === '') problems.push('host empty');
  if (!Number.isInteger(retries)) problems.push('retries not an integer');
  else if (retries < 0) problems.push('retries out of range');
  if (problems.length) throw new Error('invalid config: ' + problems.sort((a, b) => a.localeCompare(b)).join('; '));
  return { port, host, retries };
}
