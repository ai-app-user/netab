import type { Filter } from "../steng/index.js";
import type { NetabClientOpts, NetabGetResult, SiteRecord, SubEvent } from "./types.js";

export type NetabClient = ReturnType<typeof createNetabClient>;

async function doFetch<T>(baseUrl: string, path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

export function createNetabClient(opts: NetabClientOpts) {
  let token = opts.token ?? "";

  const service = opts.service;
  const baseUrl = opts.baseUrl;

  if (!service && !baseUrl) {
    throw new Error("createNetabClient requires either service or baseUrl");
  }

  async function call<T>(local: () => Promise<T>, path: string, body: unknown): Promise<T> {
    if (service) {
      return local();
    }
    return doFetch<T>(baseUrl!, path, body, token);
  }

  return {
    auth: {
      setToken(nextToken: string) {
        token = nextToken;
      },
      getToken() {
        return token;
      },
      async anonymous(args?: { brand?: string; siteId?: string }) {
        const result = await call(
          () => service!.auth_anonymous(args),
          "/v1/netab/auth/anonymous",
          args ?? {},
        );
        token = result.token;
        return result;
      },
      async login_pin(pin: string) {
        const result = await call(
          () => service!.auth_login_pin(pin),
          "/v1/netab/auth/pin",
          { pin },
        );
        token = result.token;
        return result;
      },
    },
    access: {
      async redeem_join_code(joinCode: string) {
        const result = await call(
          () => service!.access_redeem_join_code(joinCode),
          "/v1/netab/access/redeem_join_code",
          { joinCode },
        );
        token = result.token;
        return result;
      },
      async request_location_access(locationId: string, proof?: string) {
        const result = await call(
          () => service!.access_request_location_access(locationId, proof),
          "/v1/netab/access/request_location_access",
          { locationId, proof },
        );
        token = result.token;
        return result;
      },
      async lookup_brand(brandName: string): Promise<SiteRecord[]> {
        return call(
          () => service!.access_lookup_brand(token, brandName),
          "/v1/netab/access/lookup_brand",
          { brandName },
        );
      },
      async list_sites_for_brand(brandName: string): Promise<SiteRecord[]> {
        return call(
          () => service!.access_list_sites_for_brand(token, brandName),
          "/v1/netab/access/list_sites_for_brand",
          { brandName },
        );
      },
      async resolve_domain(hostname: string): Promise<SiteRecord | null> {
        return call(
          () => service!.access_resolve_domain(hostname),
          "/v1/netab/access/resolve_domain",
          { hostname },
        );
      },
      async resolve_token_site(): Promise<SiteRecord | null> {
        return call(
          () => service!.access_resolve_token_site(token),
          "/v1/netab/access/resolve_token_site",
          {},
        );
      },
    },
    async get_objs(table_name: string, ids?: string[] | null, filter?: Filter | null, start_pos?: number, max_count?: number, opts?: { readMode?: "local_only" | "local_then_fallback" | "fallback_only" }): Promise<NetabGetResult> {
      return call(
        () => service!.get_objs(token, table_name, ids, filter, start_pos, max_count, opts),
        "/v1/netab/objs/get",
        { table_name, ids, filter, start_pos, max_count, opts },
      );
    },
    async add_obj(table_name: string, value: unknown) {
      return call(
        () => service!.add_obj(token, table_name, value),
        "/v1/netab/obj/add",
        { table_name, value },
      );
    },
    async add_objs(table_name: string, rows: { value: unknown }[]) {
      return call(
        () => service!.add_objs(token, table_name, rows),
        "/v1/netab/objs/add",
        { table_name, rows },
      );
    },
    async update_objs(table_name: string, ids: string[], patches: unknown[], opts?: { merge?: "deep" | "shallow" }) {
      return call(
        () => service!.update_objs(token, table_name, ids, patches, opts),
        "/v1/netab/objs/update",
        { table_name, ids, patches, opts },
      );
    },
    async replace_objs(table_name: string, ids: string[], values: unknown[]) {
      return call(
        () => service!.replace_objs(token, table_name, ids, values),
        "/v1/netab/objs/replace",
        { table_name, ids, values },
      );
    },
    async delete_objs(table_name: string, ids: string[]) {
      return call(
        () => service!.delete_objs(token, table_name, ids),
        "/v1/netab/objs/delete",
        { table_name, ids },
      );
    },
    async subscribe_objs(table_name: string, filter: Filter | null, cb: (evt: SubEvent) => void) {
      if (!service) {
        throw new Error("HTTP subscribe is not implemented in the reference client");
      }
      return service.subscribe_objs(token, table_name, filter, cb);
    },
  };
}
