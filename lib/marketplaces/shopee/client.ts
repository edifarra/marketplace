import { createShopeeSignature } from "./signature";

const DEFAULT_SHOPEE_BASE_URL = "https://partner.shopeemobile.com";

type ShopeeClientOptions = {
  partnerId: string;
  partnerKey: string;
  redirectUri: string;
  baseUrl?: string | null;
};

type ShopeeRequestOptions = {
  accessToken?: string | null;
  shopId?: string | number | null;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  query?: Record<string, string | number | null | undefined>;
};

export type ShopeeTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  shop_id?: number;
  merchant_id?: number;
  request_id?: string;
  error?: string;
  message?: string;
  [key: string]: unknown;
};

export class ShopeeClient {
  private partnerId: string;
  private partnerKey: string;
  private redirectUri: string;
  private baseUrl: string;

  constructor(options: ShopeeClientOptions) {
    this.partnerId = options.partnerId;
    this.partnerKey = options.partnerKey;
    this.redirectUri = options.redirectUri;
    this.baseUrl = (options.baseUrl || DEFAULT_SHOPEE_BASE_URL).replace(/\/+$/, "");
  }

  buildAuthorizationUrl() {
    const path = "/api/v2/shop/auth_partner";
    const timestamp = currentTimestamp();
    const params = new URLSearchParams({
      partner_id: this.partnerId,
      timestamp: String(timestamp),
      sign: this.sign(path, timestamp),
      redirect: this.redirectUri
    });

    return `${this.baseUrl}${path}?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string, shopId: string | number): Promise<ShopeeTokenResponse> {
    return this.signedRequest<ShopeeTokenResponse>("/api/v2/auth/token/get", {
      method: "POST",
      body: {
        code,
        shop_id: Number(shopId),
        partner_id: Number(this.partnerId)
      }
    });
  }

  async refreshAccessToken(refreshToken: string, shopId: string | number): Promise<ShopeeTokenResponse> {
    return this.signedRequest<ShopeeTokenResponse>("/api/v2/auth/access_token/get", {
      method: "POST",
      body: {
        refresh_token: refreshToken,
        shop_id: Number(shopId),
        partner_id: Number(this.partnerId)
      }
    });
  }

  async getShopInfo(accessToken: string, shopId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/shop/get_shop_info", {
      accessToken,
      shopId
    });
  }

  async getProducts(accessToken: string, shopId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/get_item_list", {
      accessToken,
      shopId,
      query: {
        offset: 0,
        page_size: 100,
        item_status: "NORMAL"
      }
    });
  }

  async getCategories(accessToken: string, shopId: string | number, language = "pt-br") {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/get_category", {
      accessToken,
      shopId,
      query: { language }
    });
  }

  async getProductById(accessToken: string, shopId: string | number, itemId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/get_item_base_info", {
      accessToken,
      shopId,
      query: {
        item_id_list: String(itemId)
      }
    });
  }

  async getStock(accessToken: string, shopId: string | number, itemId: string | number) {
    return this.getProductById(accessToken, shopId, itemId);
  }

  async updateStock(accessToken: string, shopId: string | number, itemId: string | number, stock: number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/update_stock", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        item_id: Number(itemId),
        stock_list: [{ seller_stock: [{ stock }] }]
      }
    });
  }

  async createProduct(accessToken: string, shopId: string | number, payload: Record<string, unknown>) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/add_item", {
      accessToken,
      shopId,
      method: "POST",
      body: payload
    });
  }

  async updatePrice(accessToken: string, shopId: string | number, itemId: string | number, price: number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/update_price", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        item_id: Number(itemId),
        price_list: [{ original_price: price }]
      }
    });
  }

  async activateProduct(accessToken: string, shopId: string | number, itemId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/unlist_item", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        item_list: [{ item_id: Number(itemId), unlist: false }]
      }
    });
  }

  async pauseProduct(accessToken: string, shopId: string | number, itemId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/unlist_item", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        item_list: [{ item_id: Number(itemId), unlist: true }]
      }
    });
  }

  private async signedRequest<T>(path: string, options: ShopeeRequestOptions = {}): Promise<T> {
    const timestamp = currentTimestamp();
    const params = new URLSearchParams({
      partner_id: this.partnerId,
      timestamp: String(timestamp),
      sign: this.sign(path, timestamp, options.accessToken, options.shopId)
    });

    if (options.accessToken) {
      params.set("access_token", options.accessToken);
    }
    if (options.shopId) {
      params.set("shop_id", String(options.shopId));
    }
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== null && value !== undefined) {
        params.set(key, String(value));
      }
    }

    const response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      method: options.method || "GET",
      headers: { "content-type": "application/json" },
      body: options.method === "POST" ? JSON.stringify(options.body || {}) : undefined
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      throw new Error(`Falha Shopee ${path}: ${JSON.stringify(json)}`);
    }

    return json as T;
  }

  private sign(path: string, timestamp: number, accessToken?: string | null, shopId?: string | number | null) {
    return createShopeeSignature({
      partnerId: this.partnerId,
      partnerKey: this.partnerKey,
      path,
      timestamp,
      accessToken,
      shopId
    });
  }
}

export function currentTimestamp() {
  return Math.floor(Date.now() / 1000);
}
