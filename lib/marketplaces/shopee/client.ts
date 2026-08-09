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

  async getOrderList(
    accessToken: string,
    shopId: string | number,
    timeFrom: number,
    timeTo: number,
    cursor = "",
    pageSize = 50
  ) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/order/get_order_list", {
      accessToken,
      shopId,
      query: {
        time_range_field: "update_time",
        time_from: timeFrom,
        time_to: timeTo,
        page_size: Math.min(Math.max(pageSize, 1), 100),
        ...(cursor ? { cursor } : {})
      }
    });
  }

  async getOrderDetails(accessToken: string, shopId: string | number, orderSns: string[]) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/order/get_order_detail", {
      accessToken,
      shopId,
      query: {
        order_sn_list: orderSns.join(","),
        response_optional_fields: [
          "item_list", "total_amount", "actual_shipping_fee_confirmed",
          "package_list", "create_time", "update_time"
        ].join(",")
      }
    });
  }

  async getProducts(accessToken: string, shopId: string | number, offset = 0, pageSize = 100) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/get_item_list", {
      accessToken,
      shopId,
      query: {
        offset,
        page_size: pageSize,
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
    return this.getProductsByIds(accessToken, shopId, [itemId]);
  }

  async getProductsByIds(accessToken: string, shopId: string | number, itemIds: Array<string | number>) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/get_item_base_info", {
      accessToken,
      shopId,
      query: {
        item_id_list: itemIds.map(String).join(",")
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

  async deleteProduct(accessToken: string, shopId: string | number, itemId: string | number) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/product/delete_item", {
      accessToken,
      shopId,
      method: "POST",
      body: { item_id: Number(itemId) }
    });
  }

  async createShippingDocument(
    accessToken: string,
    shopId: string | number,
    orderSn: string,
    packageNumber: string | null,
    trackingNumber: string
  ) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/create_shipping_document", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        order_list: [{
          order_sn: orderSn,
          ...(packageNumber ? { package_number: packageNumber } : {}),
          tracking_number: trackingNumber,
          shipping_document_type: "NORMAL_AIR_WAYBILL"
        }]
      }
    });
  }

  async getShippingParameter(accessToken: string, shopId: string | number, orderSn: string) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/get_shipping_parameter", {
      accessToken,
      shopId,
      query: { order_sn: orderSn }
    });
  }

  async getTrackingNumber(
    accessToken: string,
    shopId: string | number,
    orderSn: string,
    packageNumber?: string | null
  ) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/get_tracking_number", {
      accessToken,
      shopId,
      query: {
        order_sn: orderSn,
        ...(packageNumber ? { package_number: packageNumber } : {})
      }
    });
  }

  async getTrackingInfo(
    accessToken: string,
    shopId: string | number,
    orderSn: string,
    packageNumber?: string | null
  ) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/get_tracking_info", {
      accessToken,
      shopId,
      query: {
        order_sn: orderSn,
        ...(packageNumber ? { package_number: packageNumber } : {})
      }
    });
  }

  async shipOrder(
    accessToken: string,
    shopId: string | number,
    orderSn: string,
    packageNumber: string | null | undefined,
    shippingMethod: Record<string, unknown>
  ) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/ship_order", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        order_sn: orderSn,
        ...(packageNumber ? { package_number: packageNumber } : {}),
        ...shippingMethod
      }
    });
  }

  async getShippingDocumentResult(accessToken: string, shopId: string | number, orderSn: string, packageNumber?: string | null) {
    return this.signedRequest<Record<string, unknown>>("/api/v2/logistics/get_shipping_document_result", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        order_list: [{
          order_sn: orderSn,
          ...(packageNumber ? { package_number: packageNumber } : {}),
          shipping_document_type: "NORMAL_AIR_WAYBILL"
        }]
      }
    });
  }

  async downloadShippingDocument(accessToken: string, shopId: string | number, orderSn: string, packageNumber?: string | null) {
    return this.signedBinaryRequest("/api/v2/logistics/download_shipping_document", {
      accessToken,
      shopId,
      method: "POST",
      body: {
        order_list: [{
          order_sn: orderSn,
          ...(packageNumber ? { package_number: packageNumber } : {})
        }],
        shipping_document_type: "NORMAL_AIR_WAYBILL"
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
    const responseText = await response.text();
    let json: Record<string, any> = {};
    try {
      json = responseText ? JSON.parse(responseText) : {};
    } catch {
      json = {};
    }
    if (!response.ok || json.error) {
      const detail = responseText || response.statusText || "resposta vazia";
      throw new Error(`Falha Shopee ${path} (HTTP ${response.status}): ${detail}`);
    }

    return json as T;
  }

  private async signedBinaryRequest(path: string, options: ShopeeRequestOptions = {}) {
    const timestamp = currentTimestamp();
    const params = new URLSearchParams({
      partner_id: this.partnerId,
      timestamp: String(timestamp),
      sign: this.sign(path, timestamp, options.accessToken, options.shopId)
    });
    if (options.accessToken) params.set("access_token", options.accessToken);
    if (options.shopId) params.set("shop_id", String(options.shopId));
    const response = await fetch(`${this.baseUrl}${path}?${params.toString()}`, {
      method: options.method || "GET",
      headers: { "content-type": "application/json" },
      body: options.method === "POST" ? JSON.stringify(options.body || {}) : undefined,
      cache: "no-store"
    });
    const body = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/pdf";
    if (!response.ok || /application\/json/i.test(contentType)) {
      const text = new TextDecoder().decode(body);
      let detail = text;
      try {
        const json = JSON.parse(text);
        detail = JSON.stringify(json);
        if (response.ok && !json.error) {
          return { body, contentType };
        }
      } catch {
        // Mantém o corpo original na mensagem de erro.
      }
      throw new Error(`Falha Shopee ${path} (HTTP ${response.status}): ${detail || response.statusText}`);
    }
    return {
      body,
      contentType
    };
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
