import { randomId } from '../../shared/utils.js';
import { createNetabClient, type NetabClient } from '../../netab/client.js';
import type { SiteRecord } from '../../netab/types.js';
import type { Filter } from '../../steng/index.js';

/** Connected POS session context returned by the onboarding helpers. */
export type ConnectedCtx = {
  app: 'pos';
  siteId: string;
  locationId: string;
  brandId: string;
  apiBaseUrl: string;
  token: string;
};

/** One candidate site shown after brand lookup. */
export type SiteChoice = {
  siteId: string;
  locationId: string;
  brandId: string;
  brandName: string;
};

/** POS menu row stored in `menu_items`. */
export type MenuItem = {
  itemId: string;
  siteId?: string;
  brandId: string;
  name: string;
  sku: string;
  priceCents: number;
  isActive: boolean;
};

/** Minimal order draft accepted by `order_create`. */
export type OrderDraft = {
  orderId?: string;
  items: Array<{ sku: string; qty: number; mods?: string[] }>;
  notes?: string;
  customer?: Record<string, unknown>;
  source?: string;
};

/** Normalized order record returned by `order_list`. */
export type Order = {
  orderId: string;
  siteId: string;
  brandId: string;
  locationId: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  items: Array<{ sku: string; qty: number; mods?: string[] }>;
  notes?: string;
  customer?: Record<string, unknown>;
  source?: string;
};

/** Construction options for the POS helper facade. */
type PosHelperOptions = {
  client?: NetabClient;
  clientOptions?: Parameters<typeof createNetabClient>[0];
};

/** Convert a resolved site plus token into the stable connected context shape. */
function toConnectedCtx(
  site: SiteRecord,
  token: string,
  apiBaseUrl: string,
): ConnectedCtx {
  return {
    app: 'pos',
    siteId: site.siteId,
    locationId: site.locationId,
    brandId: site.brandId,
    apiBaseUrl,
    token,
  };
}

/**
 * Lightweight POS-oriented facade over the lower-level netab client.
 *
 * This helper keeps mobile or web POS code focused on onboarding, menu access,
 * and order CRUD instead of directly composing the generic netab table API.
 */
export class PosHelper {
  private readonly client: NetabClient;
  private ctx: ConnectedCtx | null = null;
  private pendingSites: SiteChoice[] = [];

  /** Build the helper around an existing client or enough options to create one. */
  constructor(options: PosHelperOptions) {
    this.client = options.client ?? createNetabClient(options.clientOptions!);
  }

  /** Lifecycle hook kept for symmetry with future async initialization work. */
  async init(): Promise<void> {}

  /** Return the onboarding methods supported by this reference helper. */
  onboarding_options() {
    return { byQR: true, byBrand: true, byLocationId: true };
  }

  /** Redeem a QR join code and set the active POS context. */
  async connect_by_qr(qrPayload: { joinCode: string }): Promise<ConnectedCtx> {
    const result = await this.client.access.redeem_join_code(
      qrPayload.joinCode,
    );
    const nextCtx = toConnectedCtx(
      result.site,
      this.client.auth.getToken(),
      this.ctx?.apiBaseUrl ?? '',
    );
    await this.set_context(nextCtx);
    return nextCtx;
  }

  /** Request direct location access and set the active POS context. */
  async connect_by_location_id(
    locationId: string,
    proof?: string,
  ): Promise<ConnectedCtx> {
    const result = await this.client.access.request_location_access(
      locationId,
      proof,
    );
    const nextCtx = toConnectedCtx(
      result.site,
      this.client.auth.getToken(),
      this.ctx?.apiBaseUrl ?? '',
    );
    await this.set_context(nextCtx);
    return nextCtx;
  }

  /** Resolve a brand name into candidate sites, falling back to join-code flow when blocked. */
  async connect_by_brand_name(
    brandName: string,
  ): Promise<{ choices: SiteChoice[] } | { requiresAdminOrJoinCode: true }> {
    try {
      const sites = await this.client.access.list_sites_for_brand(brandName);
      this.pendingSites = sites.map((site) => ({
        siteId: site.siteId,
        locationId: site.locationId,
        brandId: site.brandId,
        brandName: site.brandName,
      }));
      return { choices: this.pendingSites };
    } catch {
      return { requiresAdminOrJoinCode: true };
    }
  }

  /** Select one site from the last brand lookup result and make it active. */
  async connect_select_site(siteId: string): Promise<ConnectedCtx> {
    const site = this.pendingSites.find((choice) => choice.siteId === siteId);
    if (!site) {
      throw new Error(`Site ${siteId} is not in the pending selection list`);
    }

    const resolved = await this.client.access.resolve_token_site();
    const activeSite =
      resolved && resolved.siteId === siteId
        ? resolved
        : await this.client.auth
            .anonymous({ siteId })
            .then((result) => result.site);

    const nextCtx = toConnectedCtx(
      activeSite,
      this.client.auth.getToken(),
      this.ctx?.apiBaseUrl ?? '',
    );
    await this.set_context(nextCtx);
    return nextCtx;
  }

  /** List active menu items for the current brand or an explicitly supplied brand id. */
  async menu_list(brandId = this.requireCtx().brandId): Promise<MenuItem[]> {
    const result = await this.client.get_objs(
      'menu_items',
      null,
      [
        ['brandId', '==', brandId],
        ['isActive', '==', true],
      ],
      0,
      500,
    );
    return result.items.flatMap((item) =>
      item.value ? [item.value as MenuItem] : [],
    );
  }

  /** Insert or replace a menu item based on its business `itemId`. */
  async menu_upsert(item: MenuItem): Promise<void> {
    const existingId = await this.findSingleDocId('menu_items', [
      ['itemId', '==', item.itemId],
    ]);
    if (!existingId) {
      await this.client.add_obj('menu_items', item);
      return;
    }
    await this.client.replace_objs('menu_items', [existingId], [item]);
  }

  /** Flip one menu item's availability flag. */
  async menu_set_availability(
    itemId: string,
    isActive: boolean,
  ): Promise<void> {
    const docId = await this.requireSingleDocId('menu_items', [
      ['itemId', '==', itemId],
    ]);
    await this.client.update_objs('menu_items', [docId], [{ isActive }], {
      merge: 'shallow',
    });
  }

  /** Create a new order row and return its business order id. */
  async order_create(draft: OrderDraft): Promise<{ orderId: string }> {
    const ctx = this.requireCtx();
    const orderId = draft.orderId ?? randomId('ord');
    const now = Date.now();
    await this.client.add_obj('orders', {
      orderId,
      siteId: ctx.siteId,
      brandId: ctx.brandId,
      locationId: ctx.locationId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      items: draft.items,
      notes: draft.notes,
      customer: draft.customer,
      source: draft.source ?? 'staff_tablet',
    });
    return { orderId };
  }

  /** List orders, optionally constrained by a raw steng/netab filter. */
  async order_list(filter: Filter | null = null): Promise<Order[]> {
    const result = await this.client.get_objs('orders', null, filter, 0, 500);
    return result.items.flatMap((item) =>
      item.value ? [item.value as Order] : [],
    );
  }

  /** Subscribe to order changes for the active site. */
  async order_subscribe(cb: (evt: unknown) => void): Promise<() => void> {
    return this.client.subscribe_objs('orders', null, cb);
  }

  /** Return the currently active POS context, if any. */
  get_context(): ConnectedCtx | null {
    return this.ctx;
  }

  /** Replace the active POS context and sync the underlying auth token. */
  async set_context(ctx: ConnectedCtx): Promise<void> {
    this.ctx = ctx;
    this.client.auth.setToken(ctx.token);
  }

  /** Require an active context before using context-dependent methods. */
  private requireCtx(): ConnectedCtx {
    if (!this.ctx) {
      throw new Error('POS helper is not connected');
    }
    return this.ctx;
  }

  /** Resolve exactly one storage id for the provided business-key filter. */
  private async findSingleDocId(
    tableName: string,
    filter: Filter,
  ): Promise<string | null> {
    const result = await this.client.get_objs(tableName, null, filter, 0, 2);
    if (result.items.length === 0) {
      return null;
    }
    if (result.items.length > 1) {
      throw new Error(
        `Expected one ${tableName} row for ${JSON.stringify(filter)}, found ${result.items.length}`,
      );
    }
    return result.items[0].id;
  }

  /** Resolve exactly one storage id and throw when no row matches. */
  private async requireSingleDocId(
    tableName: string,
    filter: Filter,
  ): Promise<string> {
    const docId = await this.findSingleDocId(tableName, filter);
    if (!docId) {
      throw new Error(
        `No ${tableName} row found for ${JSON.stringify(filter)}`,
      );
    }
    return docId;
  }
}
