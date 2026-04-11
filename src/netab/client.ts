import type { Filter } from '../steng/index.js';
import type {
  NetabClientOpts,
  NetabGetResult,
  SiteRecord,
  SubEvent,
} from './types.js';

/** Convenience client returned by {@link createNetabClient}. */
export type NetabClient = ReturnType<typeof createNetabClient>;

/** Execute one JSON-over-HTTP netab call. */
async function doFetch<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

/**
 * Build a small ergonomic client for either the in-process reference service or
 * the HTTP wrapper around it.
 *
 * The returned object intentionally mirrors the grouped netab API surface so it
 * can be used the same way in tests, playgrounds, and browser/server code.
 */
export function createNetabClient(opts: NetabClientOpts) {
  let token = opts.token ?? '';

  const service = opts.service;
  const baseUrl = opts.baseUrl;

  if (!service && !baseUrl) {
    throw new Error('createNetabClient requires either service or baseUrl');
  }

  /** Dispatch to the in-process service when available, otherwise use HTTP. */
  async function call<T>(
    local: () => Promise<T>,
    path: string,
    body: unknown,
  ): Promise<T> {
    if (service) {
      return local();
    }
    return doFetch<T>(baseUrl!, path, body, token);
  }

  return {
    auth: {
      /**
       * Updates token.
       * @param nextToken Token to store.
       */
      setToken(nextToken: string) {
        token = nextToken;
      },
      /**
       * Returns token.
       */
      getToken() {
        return token;
      },
      /**
       * Handles anonymous.
       * @param args Args.
       */
      async anonymous(args?: { brand?: string; siteId?: string }) {
        const result = await call(
          () => service!.auth_anonymous(args),
          '/v1/netab/auth/anonymous',
          args ?? {},
        );
        token = result.token;
        return result;
      },
      /**
       * Handles login pin.
       * @param pin PIN value.
       */
      async login_pin(pin: string) {
        const result = await call(
          () => service!.auth_login_pin(pin),
          '/v1/netab/auth/pin',
          { pin },
        );
        token = result.token;
        return result;
      },
    },
    access: {
      /**
       * Handles redeem join code.
       * @param joinCode Join code.
       */
      async redeem_join_code(joinCode: string) {
        const result = await call(
          () => service!.access_redeem_join_code(joinCode),
          '/v1/netab/access/redeem_join_code',
          { joinCode },
        );
        token = result.token;
        return result;
      },
      /**
       * Handles request location access.
       * @param locationId Location identifier.
       * @param proof Optional proof value.
       */
      async request_location_access(locationId: string, proof?: string) {
        const result = await call(
          () => service!.access_request_location_access(locationId, proof),
          '/v1/netab/access/request_location_access',
          { locationId, proof },
        );
        token = result.token;
        return result;
      },
      /**
       * Handles lookup brand.
       * @param brandName Brand name.
       */
      async lookup_brand(brandName: string): Promise<SiteRecord[]> {
        return call(
          () => service!.access_lookup_brand(token, brandName),
          '/v1/netab/access/lookup_brand',
          { brandName },
        );
      },
      /**
       * Lists sites for brand.
       * @param brandName Brand name.
       */
      async list_sites_for_brand(brandName: string): Promise<SiteRecord[]> {
        return call(
          () => service!.access_list_sites_for_brand(token, brandName),
          '/v1/netab/access/list_sites_for_brand',
          { brandName },
        );
      },
      /**
       * Resolves domain.
       * @param hostname Host name.
       */
      async resolve_domain(hostname: string): Promise<SiteRecord | null> {
        return call(
          () => service!.access_resolve_domain(hostname),
          '/v1/netab/access/resolve_domain',
          { hostname },
        );
      },
      /**
       * Resolves token site.
       */
      async resolve_token_site(): Promise<SiteRecord | null> {
        return call(
          () => service!.access_resolve_token_site(token),
          '/v1/netab/access/resolve_token_site',
          {},
        );
      },
    },
    /**
     * Returns objects.
     * @param table_name Table name.
     * @param ids Identifiers to process.
     * @param filter Optional filter expression.
     * @param start_pos Start offset.
     * @param max_count Maximum number of results.
     * @param opts Optional call options.
     */
    async get_objs(
      table_name: string,
      ids?: string[] | null,
      filter?: Filter | null,
      start_pos?: number,
      max_count?: number,
      opts?: {
        readMode?: 'local_only' | 'local_then_fallback' | 'fallback_only';
      },
    ): Promise<NetabGetResult> {
      return call(
        () =>
          service!.get_objs(
            token,
            table_name,
            ids,
            filter,
            start_pos,
            max_count,
            opts,
          ),
        '/v1/netab/objs/get',
        { table_name, ids, filter, start_pos, max_count, opts },
      );
    },
    /**
     * Adds object.
     * @param table_name Table name.
     * @param value Value to process.
     */
    async add_obj(table_name: string, value: unknown) {
      return call(
        () => service!.add_obj(token, table_name, value),
        '/v1/netab/obj/add',
        { table_name, value },
      );
    },
    /**
     * Adds objects.
     * @param table_name Table name.
     * @param rows Rows to process.
     */
    async add_objs(table_name: string, rows: { value: unknown }[]) {
      return call(
        () => service!.add_objs(token, table_name, rows),
        '/v1/netab/objs/add',
        { table_name, rows },
      );
    },
    /**
     * Handles update objects.
     * @param table_name Table name.
     * @param ids Identifiers to process.
     * @param patches Patch values.
     * @param opts Optional call options.
     */
    async update_objs(
      table_name: string,
      ids: string[],
      patches: unknown[],
      opts?: { merge?: 'deep' | 'shallow' },
    ) {
      return call(
        () => service!.update_objs(token, table_name, ids, patches, opts),
        '/v1/netab/objs/update',
        { table_name, ids, patches, opts },
      );
    },
    /**
     * Handles replace objects.
     * @param table_name Table name.
     * @param ids Identifiers to process.
     * @param values Values to process.
     */
    async replace_objs(table_name: string, ids: string[], values: unknown[]) {
      return call(
        () => service!.replace_objs(token, table_name, ids, values),
        '/v1/netab/objs/replace',
        { table_name, ids, values },
      );
    },
    /**
     * Removes objects.
     * @param table_name Table name.
     * @param ids Identifiers to process.
     */
    async delete_objs(table_name: string, ids: string[]) {
      return call(
        () => service!.delete_objs(token, table_name, ids),
        '/v1/netab/objs/delete',
        { table_name, ids },
      );
    },
    /**
     * Subscribes to objects.
     * @param table_name Table name.
     * @param filter Optional filter expression.
     * @param cb Callback function.
     */
    async subscribe_objs(
      table_name: string,
      filter: Filter | null,
      cb: (evt: SubEvent) => void,
    ) {
      if (!service) {
        throw new Error(
          'HTTP subscribe is not implemented in the reference client',
        );
      }
      return service.subscribe_objs(token, table_name, filter, cb);
    },
  };
}
