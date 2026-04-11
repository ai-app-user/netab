import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Filter } from '../../steng/index.js';
import type { NetabServiceLike } from '../types.js';

/** Optional bind options for the lightweight reference HTTP wrapper. */
type ServerOptions = {
  host?: string;
  port?: number;
};

/** Read and parse one JSON request body, defaulting to `{}` for an empty body. */
async function readJson(
  req: import('node:http').IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Extract and validate a bearer token from the Authorization header. */
function bearerToken(req: import('node:http').IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new Error('Missing bearer token');
  }
  return header.slice('Bearer '.length);
}

/**
 * Start a small HTTP server that exposes the `NetabServiceLike` contract over
 * JSON POST routes.
 *
 * This wrapper intentionally stays thin: it performs route dispatch, JSON
 * parsing, bearer-token extraction, and basic error formatting while leaving
 * all real business logic inside the service implementation.
 */
export async function startNetabHttpServer(
  service: NetabServiceLike,
  options: ServerOptions = {},
) {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }

      const body = (await readJson(req)) as Record<string, unknown>;
      const token = req.headers.authorization ? bearerToken(req) : '';

      let payload: unknown;
      switch (req.url) {
        case '/v1/netab/auth/anonymous':
          payload = await service.auth_anonymous(
            body as { brand?: string; siteId?: string },
          );
          break;
        case '/v1/netab/auth/pin':
          payload = await service.auth_login_pin(String(body.pin));
          break;
        case '/v1/netab/access/redeem_join_code':
          payload = await service.access_redeem_join_code(
            String(body.joinCode),
          );
          break;
        case '/v1/netab/access/request_location_access':
          payload = await service.access_request_location_access(
            String(body.locationId),
            body.proof ? String(body.proof) : undefined,
          );
          break;
        case '/v1/netab/access/lookup_brand':
          payload = await service.access_lookup_brand(
            token,
            String(body.brandName),
          );
          break;
        case '/v1/netab/access/list_sites_for_brand':
          payload = await service.access_list_sites_for_brand(
            token,
            String(body.brandName),
          );
          break;
        case '/v1/netab/access/resolve_domain':
          payload = await service.access_resolve_domain(String(body.hostname));
          break;
        case '/v1/netab/access/resolve_token_site':
          payload = await service.access_resolve_token_site(token);
          break;
        case '/v1/netab/objs/get':
          payload = await service.get_objs(
            token,
            String(body.table_name),
            (body.ids as string[] | null | undefined) ?? null,
            (body.filter as Filter | null | undefined) ?? null,
            typeof body.start_pos === 'number' ? body.start_pos : undefined,
            typeof body.max_count === 'number' ? body.max_count : undefined,
            body.opts as
              | {
                  readMode?:
                    | 'local_only'
                    | 'local_then_fallback'
                    | 'fallback_only';
                }
              | undefined,
          );
          break;
        case '/v1/netab/obj/add':
          payload = await service.add_obj(
            token,
            String(body.table_name),
            body.value,
          );
          break;
        case '/v1/netab/objs/add':
          payload = await service.add_objs(
            token,
            String(body.table_name),
            body.rows as { value: unknown }[],
          );
          break;
        case '/v1/netab/objs/update':
          payload = await service.update_objs(
            token,
            String(body.table_name),
            body.ids as string[],
            body.patches as unknown[],
            body.opts as { merge?: 'deep' | 'shallow' } | undefined,
          );
          break;
        case '/v1/netab/objs/replace':
          payload = await service.replace_objs(
            token,
            String(body.table_name),
            body.ids as string[],
            body.values as unknown[],
          );
          break;
        case '/v1/netab/objs/delete':
          payload = await service.delete_objs(
            token,
            String(body.table_name),
            body.ids as string[],
          );
          break;
        default:
          res.writeHead(404).end();
          return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload ?? { ok: true }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () =>
      resolve(),
    );
  });

  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://${address.address}:${address.port}`,
    /**
     * Stops the service.
     */
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
