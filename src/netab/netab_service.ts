import type { CordNodeHandle } from '../cord/index.js';
import type { Filter, GetResult, StengApi, TableInfo } from '../steng/index.js';
import { randomId, getField } from '../shared/utils.js';
import { JwtHmac } from './auth.js';
import {
  assertPermission,
  assertWritableFields,
  filterReadableValue,
} from './rbac.js';
import type {
  AccessResult,
  AclRule,
  JwtClaims,
  NetabContext,
  NetabGetResult,
  NetabServiceLike,
  PinRecord,
  ReadMode,
  SiteRecord,
  SubEvent,
  TablePolicy,
} from './types.js';

/** Construction options for the reference in-process netab service. */
type ServiceOptions = {
  app: string;
  db: string;
  clusterId: string;
  nodeId: string;
  steng: StengApi;
  cord: CordNodeHandle;
  directory: NetabDirectory;
  dbSecrets: Record<string, string>;
  aclRules?: AclRule[];
  pins?: readonly PinRecord[];
  sites?: readonly SiteRecord[];
  joinCodes?: Record<string, string>;
  tablePolicies?: Record<string, TablePolicy>;
  siteScopedTables?: string[];
  defaultTableType?: 'json' | 'binary';
};

/** Extract an upper time bound from a query filter when one is present. */
function extractUpperBound(
  filter: Filter | null,
  field: string,
): number | undefined {
  if (!filter) {
    return undefined;
  }
  let upperBound: number | undefined;
  for (const [currentField, op, value] of filter) {
    if (currentField !== field) {
      continue;
    }
    if ((op === '<' || op === '<=') && typeof value === 'number') {
      upperBound =
        upperBound === undefined ? value : Math.min(upperBound, value);
    }
    if (
      op === 'between' &&
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[1] === 'number'
    ) {
      upperBound =
        upperBound === undefined ? value[1] : Math.min(upperBound, value[1]);
    }
  }
  return upperBound;
}

/** Infer the index type needed to support a filter clause. */
function inferIndexType(
  op: string,
  value: unknown,
): 'str' | 'i64' | 'bool' | 'time' {
  if (op === 'between') {
    return 'time';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number') {
    return 'i64';
  }
  return 'str';
}

/** Reject low-level caller-supplied storage ids on `add_objs`. */
function assertGeneratedIdOnly(row: { value: unknown }): void {
  const maybeId = (row as { id?: unknown }).id;
  if (maybeId !== undefined) {
    throw new Error(
      'add_objs does not accept caller-defined ids; store app ids inside the JSON value instead',
    );
  }
}

/** In-memory directory of running `NetabService` instances keyed by cluster and node id. */
export class NetabDirectory {
  private readonly services = new Map<string, Map<string, NetabService>>();

  /** Register one running service instance. */
  register(service: NetabService): void {
    const cluster =
      this.services.get(service.clusterId) ?? new Map<string, NetabService>();
    cluster.set(service.nodeId, service);
    this.services.set(service.clusterId, cluster);
  }

  /** Remove one running service instance from the directory. */
  unregister(service: NetabService): void {
    const cluster = this.services.get(service.clusterId);
    if (!cluster) {
      return;
    }
    cluster.delete(service.nodeId);
    if (cluster.size === 0) {
      this.services.delete(service.clusterId);
    }
  }

  /** Resolve the current leader service for one cluster, if any. */
  async getLeader(clusterId: string): Promise<NetabService | null> {
    const cluster = this.services.get(clusterId);
    if (!cluster || cluster.size === 0) {
      return null;
    }

    const sample = cluster.values().next().value as NetabService | undefined;
    if (!sample) {
      return null;
    }
    const leaderId = await sample.cord.get_leader();
    return leaderId ? (cluster.get(leaderId) ?? null) : null;
  }
}

/**
 * Reference netab service implementation.
 *
 * It combines auth, RBAC, table provisioning, multi-cluster routing, and the
 * higher-level onboarding/access flows described in the design docs.
 */
export class NetabService implements NetabServiceLike {
  readonly app: string;
  readonly db: string;
  readonly clusterId: string;
  readonly nodeId: string;
  readonly steng: ServiceOptions['steng'];
  readonly cord: ServiceOptions['cord'];

  private readonly jwt: JwtHmac;
  private readonly aclRules: AclRule[];
  private readonly pins: PinRecord[];
  private readonly sites = new Map<string, SiteRecord>();
  private readonly joinCodes = new Map<string, string>();
  private readonly tablePolicies: Record<string, TablePolicy>;
  private readonly siteScopedTables: Set<string>;
  private readonly defaultTableType: 'json' | 'binary';

  /** Construct the service around one local steng store and cord node. */
  constructor(private readonly options: ServiceOptions) {
    this.app = options.app;
    this.db = options.db;
    this.clusterId = options.clusterId;
    this.nodeId = options.nodeId;
    this.steng = options.steng;
    this.cord = options.cord;
    this.jwt = new JwtHmac((db) => options.dbSecrets[db] ?? null);
    this.aclRules = options.aclRules ?? defaultAclRules();
    this.pins = [...(options.pins ?? [])];
    for (const site of options.sites ?? []) {
      this.sites.set(site.siteId, site);
    }
    for (const [joinCode, siteId] of Object.entries(options.joinCodes ?? {})) {
      this.joinCodes.set(joinCode, siteId);
    }
    this.tablePolicies = options.tablePolicies ?? {};
    this.siteScopedTables = new Set(
      options.siteScopedTables ?? [
        'menu_items',
        'orders',
        'payments',
        'events',
        'nodes',
      ],
    );
    this.defaultTableType = options.defaultTableType ?? 'json';
  }

  /** Start the backing cord node and register the service in the local directory. */
  async start(): Promise<void> {
    await this.cord.start();
    this.options.directory.register(this);
  }

  /** Stop the backing cord node and unregister the service. */
  async stop(): Promise<void> {
    this.options.directory.unregister(this);
    await this.cord.stop();
  }

  /** Issue an anonymous customer token scoped to a public or explicitly selected site. */
  async auth_anonymous(args?: {
    brand?: string;
    siteId?: string;
  }): Promise<AccessResult> {
    const site = this.resolveAnonymousSite(args);
    const token = this.jwt.issue({
      sub: randomId('anon'),
      app: this.app,
      db: site.db,
      groups: ['customer'],
      siteId: site.siteId,
      locationId: site.locationId,
      brandId: site.brandId,
      exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
    });
    return { token, site };
  }

  /** Authenticate a PIN and return either a bare token or token plus resolved site. */
  async auth_login_pin(pin: string): Promise<AccessResult | { token: string }> {
    const record = this.pins.find((candidate) => candidate.pin === pin);
    if (!record) {
      throw new Error('Invalid PIN');
    }
    const site = record.siteId ? (this.sites.get(record.siteId) ?? null) : null;
    const token = this.jwt.issue({
      sub: record.sub,
      app: this.app,
      db: record.db,
      groups: record.groups,
      siteId: record.siteId,
      locationId: record.locationId ?? site?.locationId,
      brandId: record.brandId ?? site?.brandId,
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
    return site ? { token, site } : { token };
  }

  /** Redeem a join code into a scoped staff token. */
  async access_redeem_join_code(joinCode: string): Promise<AccessResult> {
    const siteId = this.joinCodes.get(joinCode);
    if (!siteId) {
      throw new Error('Unknown join code');
    }
    const site = this.requireSite(siteId);
    const token = this.jwt.issue({
      sub: randomId('join'),
      app: this.app,
      db: site.db,
      groups: ['staff'],
      siteId: site.siteId,
      locationId: site.locationId,
      brandId: site.brandId,
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
    return { token, site };
  }

  /** Grant location-scoped access when the location exists and any proof matches. */
  async access_request_location_access(
    locationId: string,
    proof?: string,
  ): Promise<AccessResult> {
    const site = Array.from(this.sites.values()).find(
      (candidate) => candidate.locationId === locationId,
    );
    if (!site) {
      throw new Error('Unknown location');
    }
    if (site.locationProof && site.locationProof !== proof) {
      throw new Error('Location proof required');
    }
    const token = this.jwt.issue({
      sub: randomId('loc'),
      app: this.app,
      db: site.db,
      groups: ['staff'],
      siteId: site.siteId,
      locationId: site.locationId,
      brandId: site.brandId,
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
    return { token, site };
  }

  /** Admin-only brand lookup used by onboarding helpers. */
  async access_lookup_brand(
    token: string,
    brandName: string,
  ): Promise<SiteRecord[]> {
    this.requireAdmin(token);
    return this.findSitesByBrand(brandName);
  }

  /** Admin-only site listing for a given brand. */
  async access_list_sites_for_brand(
    token: string,
    brandName: string,
  ): Promise<SiteRecord[]> {
    this.requireAdmin(token);
    return this.findSitesByBrand(brandName);
  }

  /** Resolve one public hostname to a known site record. */
  async access_resolve_domain(hostname: string): Promise<SiteRecord | null> {
    return (
      Array.from(this.sites.values()).find(
        (site) => site.hostname === hostname,
      ) ?? null
    );
  }

  /** Resolve the current token's bound site, if any. */
  async access_resolve_token_site(token: string): Promise<SiteRecord | null> {
    const ctx = this.requireContext(token);
    return ctx.siteId ? (this.sites.get(ctx.siteId) ?? null) : null;
  }

  /** Read rows from one table, applying RBAC, site scoping, and fallback cluster logic. */
  async get_objs(
    token: string,
    table_name: string,
    ids: string[] | null = null,
    filter: Filter | null = null,
    start_pos = 0,
    max_count = -1,
    opts?: { readMode?: ReadMode },
  ): Promise<NetabGetResult> {
    const ctx = this.requireContext(token);
    const action = filter && !ids ? 'query' : 'read';
    const permission = assertPermission(this.aclRules, ctx, table_name, action);
    const table = await this.getOrEnsureTable(
      table_name,
      this.policyFor(table_name).type ?? this.defaultTableType,
    );
    const scopedFilter = this.applySiteScope(table_name, ctx, filter);
    await this.ensureIndexesForFilter(table, scopedFilter);
    const localResult = await this.steng.get_objs(
      table.tableId,
      ids,
      scopedFilter,
      start_pos,
      max_count,
    );
    const filteredLocal = {
      ...localResult,
      items: localResult.items.map((item) => ({
        ...item,
        value:
          item.value !== undefined
            ? filterReadableValue(item.value, permission)
            : item.value,
      })),
      source: 'local' as const,
    };

    const readMode = opts?.readMode ?? 'local_then_fallback';
    if (readMode === 'local_only') {
      return filteredLocal;
    }

    const fallback = await this.maybeFallbackRead(
      ctx,
      table_name,
      ids,
      scopedFilter,
      start_pos,
      max_count,
      filteredLocal,
      readMode,
    );
    return fallback ?? filteredLocal;
  }

  /**
   * Adds object.
   * @param token Token.
   * @param table_name Table name.
   * @param value Value to process.
   */
  async add_obj(
    token: string,
    table_name: string,
    value: unknown,
  ): Promise<{ id: string }> {
    const inserted = await this.add_objs(token, table_name, [{ value }]);
    return { id: inserted.ids[0] };
  }

  /**
   * Adds objects.
   * @param token Token.
   * @param table_name Table name.
   * @param rows Rows to process.
   */
  async add_objs(
    token: string,
    table_name: string,
    rows: { value: unknown }[],
  ): Promise<{ ids: string[] }> {
    const ctx = this.requireContext(token);
    const permission = assertPermission(
      this.aclRules,
      ctx,
      table_name,
      'write',
    );
    return this.routeWrite(table_name, async (leader) => {
      const table = await leader.getOrEnsureTable(
        table_name,
        leader.policyFor(table_name).type ?? leader.defaultTableType,
      );
      const normalized = rows.map((row) => {
        assertGeneratedIdOnly(row);
        const value = leader.applyWriteScope(table_name, ctx, row.value);
        assertWritableFields(value, permission);
        return { value };
      });
      return leader.steng.add_objs(table.tableId, normalized);
    });
  }

  /**
   * Handles update objects.
   * @param token Token.
   * @param table_name Table name.
   * @param ids Identifiers to process.
   * @param patches Patches.
   * @param opts Opts.
   */
  async update_objs(
    token: string,
    table_name: string,
    ids: string[],
    patches: unknown[],
    opts?: { merge?: 'deep' | 'shallow' },
  ): Promise<void> {
    const ctx = this.requireContext(token);
    const permission = assertPermission(
      this.aclRules,
      ctx,
      table_name,
      'write',
    );
    await this.routeWrite(table_name, async (leader) => {
      const table = await leader.getOrEnsureTable(
        table_name,
        leader.policyFor(table_name).type ?? leader.defaultTableType,
      );
      const rows = ids.map((id, index) => {
        const patch = leader.applyWriteScope(
          table_name,
          ctx,
          patches[index] ?? {},
        );
        assertWritableFields(patch, permission);
        return { id, patch, merge: opts?.merge ?? 'deep' };
      });
      await leader.steng.update_objs(table.tableId, rows);
    });
  }

  /**
   * Handles replace objects.
   * @param token Token.
   * @param table_name Table name.
   * @param ids Identifiers to process.
   * @param values Values to process.
   */
  async replace_objs(
    token: string,
    table_name: string,
    ids: string[],
    values: unknown[],
  ): Promise<void> {
    const ctx = this.requireContext(token);
    const permission = assertPermission(
      this.aclRules,
      ctx,
      table_name,
      'write',
    );
    await this.routeWrite(table_name, async (leader) => {
      const table = await leader.getOrEnsureTable(
        table_name,
        leader.policyFor(table_name).type ?? leader.defaultTableType,
      );
      const rows = ids.map((id, index) => {
        const value = leader.applyWriteScope(table_name, ctx, values[index]);
        assertWritableFields(value, permission);
        return { id, value };
      });
      await leader.steng.replace_objs(table.tableId, rows);
    });
  }

  /**
   * Removes objects.
   * @param token Token.
   * @param table_name Table name.
   * @param ids Identifiers to process.
   */
  async delete_objs(
    token: string,
    table_name: string,
    ids: string[],
  ): Promise<void> {
    const ctx = this.requireContext(token);
    assertPermission(this.aclRules, ctx, table_name, 'delete');
    await this.routeWrite(table_name, async (leader) => {
      const table = await leader.getOrEnsureTable(
        table_name,
        leader.policyFor(table_name).type ?? leader.defaultTableType,
      );
      await leader.steng.delete_objs(table.tableId, ids);
    });
  }

  /**
   * Subscribes to objects.
   * @param token Token.
   * @param table_name Table name.
   * @param filter Optional filter expression.
   * @param cb Cb.
   */
  async subscribe_objs(
    token: string,
    table_name: string,
    filter: Filter | null,
    cb: (evt: SubEvent) => void,
  ): Promise<() => void> {
    const ctx = this.requireContext(token);
    const permission = assertPermission(
      this.aclRules,
      ctx,
      table_name,
      'subscribe',
    );
    const table = await this.getOrEnsureTable(
      table_name,
      this.policyFor(table_name).type ?? this.defaultTableType,
    );
    const scopedFilter = this.applySiteScope(table_name, ctx, filter);
    await this.ensureIndexesForFilter(table, scopedFilter);
    return this.steng.subscribe_objs(table.tableId, scopedFilter, (evt) => {
      cb({
        op: evt.op,
        id: evt.id,
        ts: evt.ts,
        value:
          evt.value !== undefined
            ? filterReadableValue(evt.value, permission)
            : undefined,
      });
    });
  }

  /**
   * Resolves anonymous site.
   * @param args Args.
   */
  private resolveAnonymousSite(args?: {
    brand?: string;
    siteId?: string;
  }): SiteRecord {
    if (args?.siteId) {
      const site = this.requireSite(args.siteId);
      if (!site.public) {
        throw new Error('Site is not public');
      }
      return site;
    }

    if (args?.brand) {
      const matches = this.findSitesByBrand(args.brand).filter(
        (site) => site.public,
      );
      if (matches.length !== 1) {
        throw new Error('Brand is ambiguous or not public');
      }
      return matches[0];
    }

    const publicSites = Array.from(this.sites.values()).filter(
      (site) => site.public,
    );
    if (publicSites.length !== 1) {
      throw new Error('Anonymous auth requires a site hint');
    }
    return publicSites[0];
  }

  /**
   * Handles require site.
   * @param siteId Site id.
   */
  private requireSite(siteId: string): SiteRecord {
    const site = this.sites.get(siteId);
    if (!site) {
      throw new Error(`Unknown site ${siteId}`);
    }
    return site;
  }

  /**
   * Handles require context.
   * @param token Token.
   */
  private requireContext(token: string): NetabContext {
    const claims = this.jwt.decode(token);
    if (claims.app !== this.app) {
      throw new Error(`Token app mismatch: ${claims.app}`);
    }
    return { ...claims, token };
  }

  /**
   * Handles require admin.
   * @param token Token.
   */
  private requireAdmin(token: string): NetabContext {
    const ctx = this.requireContext(token);
    if (!ctx.groups.includes('admin') && !ctx.groups.includes('installer')) {
      throw new Error('Admin token required');
    }
    return ctx;
  }

  /**
   * Returns or ensure table.
   * @param tableName Table name.
   * @param type Type value to process.
   */
  private async getOrEnsureTable(
    tableName: string,
    type: 'json' | 'binary',
  ): Promise<TableInfo> {
    const existing = await this.steng.get_table_info(
      this.app,
      this.db,
      tableName,
    );
    if (existing) {
      return existing;
    }
    return this.steng.ensure_table(this.app, this.db, tableName, type);
  }

  /**
   * Ensures indexes for filter.
   * @param table Table descriptor.
   * @param filter Optional filter expression.
   */
  private async ensureIndexesForFilter(
    table: TableInfo,
    filter: Filter | null,
  ): Promise<void> {
    if (!filter) {
      return;
    }
    for (const [field, op, value] of filter) {
      if (field === 'id' || table.config.indexes[field]) {
        continue;
      }
      const idxType = inferIndexType(
        op,
        Array.isArray(value) ? value[0] : value,
      );
      await this.steng.add_index(table.tableId, field, idxType);
      table.config.indexes[field] = { type: idxType };
    }
  }

  /**
   * Handles find sites by brand.
   * @param brandName Brand name.
   */
  private findSitesByBrand(brandName: string): SiteRecord[] {
    return Array.from(this.sites.values())
      .filter(
        (site) => site.brandName.toLowerCase() === brandName.toLowerCase(),
      )
      .sort((left, right) => left.locationId.localeCompare(right.locationId));
  }

  /**
   * Handles policy for.
   * @param tableName Table name.
   */
  private policyFor(tableName: string): TablePolicy {
    return (
      this.tablePolicies[tableName] ?? {
        type: 'json',
        writePrimaryClusterId: this.clusterId,
        readFallbackClusters: [],
      }
    );
  }

  /**
   * Applies site scope.
   * @param tableName Table name.
   * @param ctx Execution context.
   * @param filter Optional filter expression.
   */
  private applySiteScope(
    tableName: string,
    ctx: NetabContext,
    filter: Filter | null,
  ): Filter | null {
    if (!ctx.siteId || !this.siteScopedTables.has(tableName)) {
      return filter;
    }
    return [...(filter ?? []), ['siteId', '==', ctx.siteId]];
  }

  /**
   * Applies write scope.
   * @param tableName Table name.
   * @param ctx Execution context.
   * @param value Value to process.
   */
  private applyWriteScope(
    tableName: string,
    ctx: NetabContext,
    value: unknown,
  ): unknown {
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    const record = { ...(value as Record<string, unknown>) };
    if (this.siteScopedTables.has(tableName) && ctx.siteId) {
      if (record.siteId && record.siteId !== ctx.siteId) {
        throw new Error('siteId does not match token scope');
      }
      record.siteId = ctx.siteId;
    }
    if (ctx.locationId && record.locationId === undefined) {
      record.locationId = ctx.locationId;
    }
    if (ctx.brandId && record.brandId === undefined) {
      record.brandId = ctx.brandId;
    }
    return record;
  }

  /**
   * Handles route write.
   * @param tableName Table name.
   * @param fn Callback function.
   */
  private async routeWrite<T>(
    tableName: string,
    fn: (leader: NetabService) => Promise<T>,
  ): Promise<T> {
    const targetClusterId = this.policyFor(tableName).writePrimaryClusterId;
    const leader = await this.options.directory.getLeader(targetClusterId);
    if (!leader) {
      throw new Error(`No leader available for cluster ${targetClusterId}`);
    }
    return fn(leader);
  }

  /**
   * Handles maybe fallback read.
   * @param ctx Execution context.
   * @param tableName Table name.
   * @param ids Identifiers to process.
   * @param filter Optional filter expression.
   * @param start_pos Start offset.
   * @param max_count Maximum number of results.
   * @param localResult Local result.
   * @param readMode Read mode.
   */
  private async maybeFallbackRead(
    ctx: NetabContext,
    tableName: string,
    ids: string[] | null,
    filter: Filter | null,
    start_pos: number,
    max_count: number,
    localResult: NetabGetResult,
    readMode: ReadMode,
  ): Promise<NetabGetResult | null> {
    if (readMode === 'fallback_only') {
      return this.readFromFallbacks(
        ctx,
        tableName,
        ids,
        filter,
        start_pos,
        max_count,
      );
    }

    if (ids && localResult.items.some((item) => item.miss)) {
      const fallback = await this.readFromFallbacks(
        ctx,
        tableName,
        ids,
        filter,
        start_pos,
        max_count,
      );
      if (!fallback) {
        return null;
      }
      const merged = fallback.items.map((fallbackItem) => {
        const localItem = localResult.items.find(
          (item) => item.id === fallbackItem.id && !item.miss,
        );
        return localItem ?? fallbackItem;
      });
      return { ...fallback, items: merged, source: 'fallback' };
    }

    if (
      !ids &&
      localResult.items.length === 0 &&
      (this.policyFor(tableName).readFallbackClusters?.length ?? 0) > 0
    ) {
      return this.readFromFallbacks(
        ctx,
        tableName,
        ids,
        filter,
        start_pos,
        max_count,
      );
    }

    const table = await this.steng.get_table_info(this.app, this.db, tableName);
    if (!table?.config.timeField) {
      return null;
    }

    const upperBound = extractUpperBound(filter, table.config.timeField);
    const watermark = localResult.watermark?.localMinTimeMs;
    if (
      watermark !== undefined &&
      upperBound !== undefined &&
      upperBound <= watermark
    ) {
      return this.readFromFallbacks(
        ctx,
        tableName,
        ids,
        filter,
        start_pos,
        max_count,
      );
    }

    return null;
  }

  /**
   * Reads from fallbacks.
   * @param ctx Execution context.
   * @param tableName Table name.
   * @param ids Identifiers to process.
   * @param filter Optional filter expression.
   * @param start_pos Start offset.
   * @param max_count Maximum number of results.
   */
  private async readFromFallbacks(
    ctx: NetabContext,
    tableName: string,
    ids: string[] | null,
    filter: Filter | null,
    start_pos: number,
    max_count: number,
  ): Promise<NetabGetResult | null> {
    for (const clusterId of this.policyFor(tableName).readFallbackClusters ??
      []) {
      const leader = await this.options.directory.getLeader(clusterId);
      if (!leader || leader === this) {
        continue;
      }
      const result = await leader.get_objs(
        ctx.token,
        tableName,
        ids,
        filter,
        start_pos,
        max_count,
        { readMode: 'local_only' },
      );
      return { ...result, source: 'fallback' };
    }
    return null;
  }
}

/**
 * Returns the default acl rules.
 */
function defaultAclRules(): AclRule[] {
  return [
    {
      group: 'customer',
      tables: {
        menu_items: { allow: ['read', 'query', 'subscribe'] },
        orders: {
          allow: ['write', 'read'],
          writeFields: [
            'items',
            'notes',
            'customer',
            'source',
            'createdAt',
            'siteId',
            'brandId',
            'locationId',
          ],
        },
      },
    },
    {
      group: 'staff',
      tables: {
        '*': { allow: ['read', 'query', 'subscribe'] },
        orders: { allow: ['read', 'query', 'write', 'delete', 'subscribe'] },
        menu_items: {
          allow: ['read', 'query', 'write', 'delete', 'subscribe'],
        },
        events: { allow: ['read', 'query', 'write', 'delete', 'subscribe'] },
      },
    },
    {
      group: 'installer',
      tables: {
        '*': {
          allow: [
            'admin',
            'read',
            'query',
            'write',
            'delete',
            'subscribe',
            'blob_add',
            'blob_delete',
          ],
        },
      },
    },
    {
      group: 'admin',
      tables: {
        '*': {
          allow: [
            'admin',
            'read',
            'query',
            'write',
            'delete',
            'subscribe',
            'blob_add',
            'blob_delete',
          ],
        },
      },
    },
  ];
}
