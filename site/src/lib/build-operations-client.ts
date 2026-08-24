export type AccountBuildAlertTrigger =
  | 'model_price_change'
  | 'monthly_spend_above'
  | 'monthly_spend_change_percent'
  | 'baseline_delta_percent';

export interface AccountBuildPlanShare {
  id: string;
  planId: string;
  version: number;
  allowQuoteExport: boolean;
  expiresAt: string | null;
  status: 'active' | 'expired';
  createdAt: string;
}

export interface RevealedAccountBuildPlanShare extends AccountBuildPlanShare {
  token: string;
  path: string;
}

export interface InactiveAccountBuildPlanAlert {
  id: string;
  planId: string;
  version: number;
  trigger: AccountBuildAlertTrigger;
  threshold: number | null;
  baselineVersion: number | null;
  status: 'inactive';
  createdAt: string;
  updatedAt: string;
}

const PLAN_ID = /^plan_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHARE_ID = /^share_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALERT_ID = /^alert_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHARE_TOKEN = /^sv1_[A-Za-z0-9_-]{43}$/;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const ALERT_TRIGGERS = new Set<AccountBuildAlertTrigger>([
  'model_price_change', 'monthly_spend_above',
  'monthly_spend_change_percent', 'baseline_delta_percent',
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === allowed.length
    && keys.every((key) => typeof key === 'string' && allowed.includes(key));
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

const validVersion = (value: unknown): value is number => Number.isSafeInteger(value)
  && Number(value) >= 1 && Number(value) <= 100;

function share(value: unknown, revealed: false): AccountBuildPlanShare | null;
function share(value: unknown, revealed: true): RevealedAccountBuildPlanShare | null;
function share(
  value: unknown,
  revealed: boolean,
): AccountBuildPlanShare | RevealedAccountBuildPlanShare | null {
  if (!plainRecord(value)) return null;
  const baseKeys = ['id', 'planId', 'version', 'allowQuoteExport', 'expiresAt', 'status', 'createdAt'];
  const allowed = revealed ? [...baseKeys, 'token', 'path'] : baseKeys;
  if (!exactKeys(value, allowed)
    || typeof value.id !== 'string' || !SHARE_ID.test(value.id)
    || typeof value.planId !== 'string' || !PLAN_ID.test(value.planId)
    || !validVersion(value.version) || typeof value.allowQuoteExport !== 'boolean'
    || (value.expiresAt !== null && !canonicalDate(value.expiresAt))
    || (value.status !== 'active' && value.status !== 'expired')
    || !canonicalDate(value.createdAt)) return null;
  if (!revealed) return value as unknown as AccountBuildPlanShare;
  if (typeof value.token !== 'string' || !SHARE_TOKEN.test(value.token)
    || value.path !== `/shared-build-plans/${value.token}`) return null;
  return value as unknown as RevealedAccountBuildPlanShare;
}

function alert(value: unknown): InactiveAccountBuildPlanAlert | null {
  if (!plainRecord(value) || !exactKeys(value, [
    'id', 'planId', 'version', 'trigger', 'threshold', 'baselineVersion',
    'status', 'createdAt', 'updatedAt',
  ])
    || typeof value.id !== 'string' || !ALERT_ID.test(value.id)
    || typeof value.planId !== 'string' || !PLAN_ID.test(value.planId)
    || !validVersion(value.version) || typeof value.trigger !== 'string'
    || !ALERT_TRIGGERS.has(value.trigger as AccountBuildAlertTrigger)
    || value.status !== 'inactive' || !canonicalDate(value.createdAt)
    || !canonicalDate(value.updatedAt)) return null;

  const threshold = value.threshold;
  const baselineVersion = value.baselineVersion;
  if (value.trigger === 'model_price_change') {
    if (threshold !== null || baselineVersion !== null) return null;
  } else if (typeof threshold !== 'number' || !Number.isFinite(threshold)
    || Object.is(threshold, -0) || threshold <= 0 || threshold > 1_000_000_000) {
    return null;
  }
  if (value.trigger === 'baseline_delta_percent') {
    if (!validVersion(baselineVersion) || baselineVersion === value.version) return null;
  } else if (baselineVersion !== null) return null;
  return value as unknown as InactiveAccountBuildPlanAlert;
}

function dataEnvelope(payload: unknown): unknown | null {
  if (!plainRecord(payload) || !exactKeys(payload, ['data'])) return null;
  return payload.data;
}

export function parseAccountShareList(payload: unknown): AccountBuildPlanShare[] | null {
  try {
    const data = dataEnvelope(payload);
    if (!Array.isArray(data) || data.length > 20) return null;
    const parsed = data.map((value) => share(value, false));
    return parsed.every((value): value is AccountBuildPlanShare => value !== null) ? parsed : null;
  } catch { return null; }
}

export function parseCreatedAccountShare(payload: unknown): RevealedAccountBuildPlanShare | null {
  try { return share(dataEnvelope(payload), true); } catch { return null; }
}

export function parseRevokedAccountShare(payload: unknown, expectedShareId: string): boolean {
  try {
    const data = dataEnvelope(payload);
    return SHARE_ID.test(expectedShareId) && plainRecord(data)
      && exactKeys(data, ['revoked', 'shareId'])
      && data.revoked === true && data.shareId === expectedShareId;
  } catch { return false; }
}

export function parseAccountAlertList(payload: unknown): InactiveAccountBuildPlanAlert[] | null {
  try {
    const data = dataEnvelope(payload);
    if (!Array.isArray(data) || data.length > 20) return null;
    const parsed = data.map(alert);
    return parsed.every((value): value is InactiveAccountBuildPlanAlert => value !== null) ? parsed : null;
  } catch { return null; }
}

export function parseMutatedAccountAlert(payload: unknown): InactiveAccountBuildPlanAlert | null {
  try { return alert(dataEnvelope(payload)); } catch { return null; }
}

export function parseDeletedAccountAlert(payload: unknown, expectedAlertId: string): boolean {
  try {
    const data = dataEnvelope(payload);
    return ALERT_ID.test(expectedAlertId) && plainRecord(data)
      && exactKeys(data, ['deleted', 'alertId'])
      && data.deleted === true && data.alertId === expectedAlertId;
  } catch { return false; }
}

/** Retains one key for an operation and exact body until a validated success. */
export class StableAccountOperationKeys {
  readonly #pending = new Map<string, { fingerprint: string; key: string }>();
  readonly #createKey: () => string;

  constructor(createKey: () => string = () => `composer-operation:${crypto.randomUUID()}`) {
    this.#createKey = createKey;
  }

  key(operation: string, fingerprint: string): string {
    if (!operation || operation.length > 256 || fingerprint.length > 8_192) {
      throw new Error('Account operation identity is invalid.');
    }
    const existing = this.#pending.get(operation);
    if (existing?.fingerprint === fingerprint) return existing.key;
    const key = this.#createKey();
    if (!OPERATION_KEY.test(key)) throw new Error('Account operation key is invalid.');
    if (this.#pending.size >= 128 && !existing) this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(operation, { fingerprint, key });
    return key;
  }

  complete(operation: string, fingerprint: string): void {
    if (this.#pending.get(operation)?.fingerprint === fingerprint) this.#pending.delete(operation);
  }

  clear(): void { this.#pending.clear(); }
}

export function accountShareUrl(path: string, origin: string): string | null {
  try {
    const token = path.startsWith('/shared-build-plans/') ? path.slice('/shared-build-plans/'.length) : '';
    if (!SHARE_TOKEN.test(token) || path !== `/shared-build-plans/${token}`) return null;
    const base = new URL(origin);
    const url = new URL(path, base.origin);
    return url.origin === base.origin && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === path ? url.href : null;
  } catch { return null; }
}

export async function copyAccountShareUrl(
  url: string,
  origin: string,
  writeText: (value: string) => Promise<void>,
): Promise<boolean> {
  try {
    const parsed = accountShareUrl(new URL(url).pathname, origin);
    if (parsed !== url) return false;
    await writeText(url);
    return true;
  } catch { return false; }
}

export function inactiveAccountAlertSummary(alert: InactiveAccountBuildPlanAlert): string {
  if (alert.trigger === 'model_price_change') return 'Re-check if a model price in this plan changes';
  if (alert.trigger === 'monthly_spend_above') return `Re-check if monthly spend exceeds $${alert.threshold!.toLocaleString()}`;
  if (alert.trigger === 'monthly_spend_change_percent') return `Re-check if monthly spend changes by ${alert.threshold!.toLocaleString()}%`;
  return `Re-check if version ${alert.version} exceeds baseline version ${alert.baselineVersion} by ${alert.threshold!.toLocaleString()}%`;
}
