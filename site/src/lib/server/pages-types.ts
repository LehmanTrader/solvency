export interface BuildPlansEnv {
  DB: D1DatabaseLike;
  ACCOUNT_PLANS_ENABLED?: string;
  ENTITLEMENTS_ENABLED?: string;
  PRODUCT_INTENTS_ENABLED?: string;
  PREVIEW_ACCOUNT_ERASURE_ENABLED?: string;
  STRIPE_CHECKOUT_ENABLED?: string;
  STRIPE_PORTAL_ENABLED?: string;
  STRIPE_WEBHOOK_ENABLED?: string;
  APP_ENV?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  BUILD_SHARE_TOKEN_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_ACCOUNT_ID?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRO_MONTHLY_PRICE_ID?: string;
  STRIPE_PRO_ANNUAL_PRICE_ID?: string;
}

export interface ApiFunctionData {
  ownerUserId?: string;
  requestId?: string;
}

export interface PagesContextLike {
  request: Request;
  env: BuildPlansEnv;
  params: Record<string, string | string[]>;
  data: ApiFunctionData;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

export type PagesHandler = (context: PagesContextLike) => Response | Promise<Response>;

export interface D1ResultLike<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; [key: string]: unknown };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
}
