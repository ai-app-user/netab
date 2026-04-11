import type { Filter, GetResult as StengGetResult } from '../steng/index.js';

/** One logical permission bit used by table policy enforcement. */
export type Permission =
  | 'read'
  | 'write'
  | 'delete'
  | 'query'
  | 'subscribe'
  | 'blob_add'
  | 'blob_delete'
  | 'admin';

/** Effective permission rules for one table. */
export type TablePermission = {
  allow: Permission[];
  readFields?: string[];
  writeFields?: string[];
};

/** One ACL rule granted to a caller group. */
export type AclRule = {
  group: string;
  tables: Record<string, TablePermission>;
};

/** JWT claims embedded into netab access tokens. */
export type JwtClaims = {
  sub: string;
  app: string;
  db: string;
  groups: readonly string[];
  siteId?: string;
  locationId?: string;
  brandId?: string;
  exp: number;
};

/** Request context after token verification. */
export type NetabContext = JwtClaims & {
  token: string;
};

/** One resolved site/location record exposed by onboarding helpers. */
export type SiteRecord = {
  siteId: string;
  locationId: string;
  brandId: string;
  brandName: string;
  db: string;
  hostname?: string;
  public?: boolean;
  locationProof?: string;
};

/** Simple PIN login mapping used by the reference runtime. */
export type PinRecord = {
  pin: string;
  sub: string;
  groups: readonly string[];
  siteId?: string;
  locationId?: string;
  brandId?: string;
  db: string;
};

/** Cluster routing policy for one logical table. */
export type TablePolicy = {
  type?: 'json' | 'binary';
  writePrimaryClusterId: string;
  readFallbackClusters?: string[];
};

/** `get_objs` result plus the cluster source that served the read. */
export type NetabGetResult = StengGetResult & {
  source?: 'local' | 'fallback';
};

/** Subscription event delivered to application code. */
export type SubEvent = {
  op: 'added' | 'updated' | 'deleted';
  id: string;
  ts: number;
  value?: unknown;
};

/** Read routing policy used by higher-level service/client calls. */
export type ReadMode = 'local_only' | 'local_then_fallback' | 'fallback_only';

/** Successful authentication or access-grant response. */
export type AccessResult = {
  token: string;
  site: SiteRecord;
};

/** Construction options for the convenience netab client. */
export type NetabClientOpts = {
  app: string;
  db: string;
  token?: string;
  baseUrl?: string;
  service?: NetabServiceLike;
};

/**
 * Minimal service contract implemented by the in-process reference service and
 * consumed by the convenience client.
 */
export interface NetabServiceLike {
  /** Exchange anonymous site or brand context for a scoped token. */
  auth_anonymous(args?: {
    brand?: string;
    siteId?: string;
  }): Promise<AccessResult>;
  /** Authenticate with a PIN and return a scoped token. */
  auth_login_pin(pin: string): Promise<AccessResult | { token: string }>;
  /** Redeem a join code into site access. */
  access_redeem_join_code(joinCode: string): Promise<AccessResult>;
  /** Ask for location-scoped access, optionally including a proof string. */
  access_request_location_access(
    locationId: string,
    proof?: string,
  ): Promise<AccessResult>;
  /** Resolve a brand name into matching sites. */
  access_lookup_brand(token: string, brandName: string): Promise<SiteRecord[]>;
  /** List all sites currently visible for a brand token. */
  access_list_sites_for_brand(
    token: string,
    brandName: string,
  ): Promise<SiteRecord[]>;
  /** Resolve a hostname into a site record. */
  access_resolve_domain(hostname: string): Promise<SiteRecord | null>;
  /** Resolve the site currently bound to the supplied token. */
  access_resolve_token_site(token: string): Promise<SiteRecord | null>;
  /** Read rows by id or filter from one logical table. */
  get_objs(
    token: string,
    table_name: string,
    ids?: string[] | null,
    filter?: Filter | null,
    start_pos?: number,
    max_count?: number,
    opts?: { readMode?: ReadMode },
  ): Promise<NetabGetResult>;
  /** Insert one row and return its generated storage id. */
  add_obj(
    token: string,
    table_name: string,
    value: unknown,
  ): Promise<{ id: string }>;
  /** Insert multiple rows and return their generated storage ids. */
  add_objs(
    token: string,
    table_name: string,
    rows: { value: unknown }[],
  ): Promise<{ ids: string[] }>;
  /** Patch multiple rows. */
  update_objs(
    token: string,
    table_name: string,
    ids: string[],
    patches: unknown[],
    opts?: { merge?: 'deep' | 'shallow' },
  ): Promise<void>;
  /** Replace multiple stored row values. */
  replace_objs(
    token: string,
    table_name: string,
    ids: string[],
    values: unknown[],
  ): Promise<void>;
  /** Delete rows by storage id. */
  delete_objs(token: string, table_name: string, ids: string[]): Promise<void>;
  /** Subscribe to matching changes. */
  subscribe_objs(
    token: string,
    table_name: string,
    filter: Filter | null,
    cb: (evt: SubEvent) => void,
  ): Promise<() => void>;
}
