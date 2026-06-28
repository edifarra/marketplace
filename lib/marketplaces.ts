import { Marketplace } from "./types";

type ListingPayload = {
  sku: string;
  title: string;
  description: string;
  price: number;
  stock: number;
  images: string[];
  categoryId?: string | null;
};

export type MarketplaceClient = {
  createListing(payload: ListingPayload): Promise<{ listingId: string; status: string }>;
  updateStock(listingId: string, stock: number): Promise<void>;
  pauseListing(listingId: string): Promise<void>;
};

export function getMarketplaceClient(marketplace: Marketplace): MarketplaceClient {
  if (marketplace === "mercado_livre") {
    return new MercadoLivreClient();
  }

  return new ShopeeClient();
}

class MercadoLivreClient implements MarketplaceClient {
  async createListing(payload: ListingPayload) {
    const accessToken = await getMercadoLivreAccessToken();
    const response = await fetch("https://api.mercadolibre.com/items", {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        title: payload.title,
        category_id: payload.categoryId,
        price: payload.price,
        currency_id: "BRL",
        available_quantity: payload.stock,
        buying_mode: "buy_it_now",
        condition: "used",
        listing_type_id: "gold_special",
        pictures: payload.images.map((source) => ({ source })),
        attributes: [{ id: "SELLER_SKU", value_name: payload.sku }]
      })
    });

    const json = await readJson(response);
    return { listingId: json.id, status: json.status || "active" };
  }

  async updateStock(listingId: string, stock: number) {
    const accessToken = await getMercadoLivreAccessToken();
    await readJson(await fetch(`https://api.mercadolibre.com/items/${listingId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ available_quantity: stock })
    }));
  }

  async pauseListing(listingId: string) {
    const accessToken = await getMercadoLivreAccessToken();
    await readJson(await fetch(`https://api.mercadolibre.com/items/${listingId}`, {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ status: "paused" })
    }));
  }
}

class ShopeeClient implements MarketplaceClient {
  async createListing(payload: ListingPayload) {
    const endpoint = shopeeEndpoint("/api/v2/product/add_item");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        item_name: payload.title,
        description: payload.description,
        category_id: payload.categoryId,
        original_price: payload.price,
        seller_stock: [{ stock: payload.stock }],
        item_sku: payload.sku,
        image: { image_url_list: payload.images }
      })
    });

    const json = await readJson(response);
    return { listingId: String(json.response?.item_id || ""), status: "active" };
  }

  async updateStock(listingId: string, stock: number) {
    await readJson(await fetch(shopeeEndpoint("/api/v2/product/update_stock"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: Number(listingId), stock_list: [{ seller_stock: [{ stock }] }] })
    }));
  }

  async pauseListing(listingId: string) {
    await readJson(await fetch(shopeeEndpoint("/api/v2/product/update_item"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: Number(listingId), item_status: "UNLIST" })
    }));
  }
}

function authHeaders(accessToken: string) {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json"
  };
}

async function getMercadoLivreAccessToken() {
  const token = process.env.MERCADO_LIVRE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("MERCADO_LIVRE_ACCESS_TOKEN nao configurado.");
  }

  return token;
}

function shopeeEndpoint(path: string) {
  const baseUrl = "https://partner.shopeemobile.com";
  return `${baseUrl}${path}`;
}

async function readJson(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }

  return json;
}
