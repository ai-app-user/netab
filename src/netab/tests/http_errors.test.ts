import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startNetabHttpServer } from '../http/server.js';
import type { NetabServiceLike } from '../types.js';

function httpPost(
  baseUrl: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const service: NetabServiceLike = {
  async auth_anonymous() {
    return {
      token: 'anon',
      site: {
        siteId: 's',
        locationId: 'l',
        brandId: 'b',
        brandName: 'B',
        db: 'd',
      },
    };
  },
  async auth_login_pin() {
    return { token: 'pin' };
  },
  async access_redeem_join_code() {
    return {
      token: 'join',
      site: {
        siteId: 's',
        locationId: 'l',
        brandId: 'b',
        brandName: 'B',
        db: 'd',
      },
    };
  },
  async access_request_location_access() {
    return {
      token: 'loc',
      site: {
        siteId: 's',
        locationId: 'l',
        brandId: 'b',
        brandName: 'B',
        db: 'd',
      },
    };
  },
  async access_lookup_brand(token) {
    if (!token) {
      throw new Error('Missing bearer token');
    }
    return [];
  },
  async access_list_sites_for_brand(token) {
    if (!token) {
      throw new Error('Missing bearer token');
    }
    return [];
  },
  async access_resolve_domain() {
    return null;
  },
  async access_resolve_token_site(token) {
    if (!token) {
      throw new Error('Missing bearer token');
    }
    return null;
  },
  async get_objs() {
    return { items: [], next_pos: 0 };
  },
  async add_obj() {
    return { id: 'doc_1' };
  },
  async add_objs() {
    return { ids: [] };
  },
  async update_objs() {},
  async replace_objs() {},
  async delete_objs() {},
  async subscribe_objs() {
    return () => {};
  },
};

test('http server returns 404 for unknown route and 400 for malformed auth/json', async () => {
  const http = await startNetabHttpServer(service);
  try {
    const notFound = await httpPost(http.baseUrl, '/v1/netab/unknown', {});
    assert.equal(notFound.status, 404);

    const missingBearer = await httpPost(
      http.baseUrl,
      '/v1/netab/access/lookup_brand',
      { brandName: 'X' },
    );
    assert.equal(missingBearer.status, 400);
    assert.match(missingBearer.body, /Missing bearer token/);

    const malformedJson = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const url = new URL('/v1/netab/auth/anonymous', http.baseUrl);
        const req = request(
          url,
          { method: 'POST', headers: { 'content-type': 'application/json' } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end('{');
      },
    );
    assert.equal(malformedJson.status, 400);
    assert.match(malformedJson.body, /error/i);
  } finally {
    await http.stop();
  }
});
