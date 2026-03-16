import type { Filter, GetResult as StengGetResult } from "../steng/index.js";

export type Permission = "read" | "write" | "delete" | "query" | "subscribe" | "blob_add" | "blob_delete" | "admin";

export type TablePermission = {
  allow: Permission[];
  readFields?: string[];
  writeFields?: string[];
};

export type AclRule = {
  group: string;
  tables: Record<string, TablePermission>;
};

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

export type NetabContext = JwtClaims & {
  token: string;
};

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

export type PinRecord = {
  pin: string;
  sub: string;
  groups: readonly string[];
  siteId?: string;
  locationId?: string;
  brandId?: string;
  db: string;
};

export type TablePolicy = {
  type?: "json" | "binary";
  writePrimaryClusterId: string;
  readFallbackClusters?: string[];
};

export type NetabGetResult = StengGetResult & {
  source?: "local" | "fallback";
};

export type SubEvent = {
  op: "added" | "updated" | "deleted";
  id: string;
  ts: number;
  value?: unknown;
};

export type ReadMode = "local_only" | "local_then_fallback" | "fallback_only";

export type AccessResult = {
  token: string;
  site: SiteRecord;
};

export type NetabClientOpts = {
  app: string;
  db: string;
  token?: string;
  baseUrl?: string;
  service?: NetabServiceLike;
};

export interface NetabServiceLike {
  auth_anonymous(args?: { brand?: string; siteId?: string }): Promise<AccessResult>;
  auth_login_pin(pin: string): Promise<AccessResult | { token: string }>;
  access_redeem_join_code(joinCode: string): Promise<AccessResult>;
  access_request_location_access(locationId: string, proof?: string): Promise<AccessResult>;
  access_lookup_brand(token: string, brandName: string): Promise<SiteRecord[]>;
  access_list_sites_for_brand(token: string, brandName: string): Promise<SiteRecord[]>;
  access_resolve_domain(hostname: string): Promise<SiteRecord | null>;
  access_resolve_token_site(token: string): Promise<SiteRecord | null>;
  get_objs(token: string, table_name: string, ids?: string[] | null, filter?: Filter | null, start_pos?: number, max_count?: number, opts?: { readMode?: ReadMode }): Promise<NetabGetResult>;
  add_obj(token: string, table_name: string, value: unknown): Promise<{ id: string }>;
  add_objs(token: string, table_name: string, rows: { value: unknown }[]): Promise<{ ids: string[] }>;
  update_objs(token: string, table_name: string, ids: string[], patches: unknown[], opts?: { merge?: "deep" | "shallow" }): Promise<void>;
  replace_objs(token: string, table_name: string, ids: string[], values: unknown[]): Promise<void>;
  delete_objs(token: string, table_name: string, ids: string[]): Promise<void>;
  subscribe_objs(token: string, table_name: string, filter: Filter | null, cb: (evt: SubEvent) => void): Promise<() => void>;
}
