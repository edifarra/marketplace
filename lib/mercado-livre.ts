import { supabaseAdmin } from "./supabase-admin";

const ML_API = "https://api.mercadolibre.com";

export type MarketplaceAccountConfig = {
  id: string;
  name: string;
  marketplace: string;
  active: boolean;
  account_id?: string | null;
  seller_id?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  redirect_uri?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
};

export type MercadoLivreInventoryItem = {
  accountId: string;
  accountName: string;
  marketplace: "mercado_livre";
  listingId: string;
  sku: string;
  title: string;
  price: number;
  stock: number;
  status: string;
  rawData: Record<string, unknown>;
};

export async function getActiveMercadoLivreAccounts() {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("config_marketplace_accounts")
    .select("id,name,marketplace,active,account_id,seller_id,client_id,client_secret,redirect_uri,access_token,refresh_token,token_expires_at")
    .eq("marketplace", "mercado_livre")
    .eq("active", true)
    .order("name")
    .throwOnError();

  return (data ?? []) as MarketplaceAccountConfig[];
}

export async function listMercadoLivreInventory(account: MarketplaceAccountConfig): Promise<MercadoLivreInventoryItem[]> {
  const accessToken = await getValidMercadoLivreAccessToken(account);
  const sellerId = account.seller_id || account.account_id;
  if (!sellerId) {
    throw new Error(`Seller/User ID nao configurado para ${account.name}.`);
  }

  const itemIds = await listSellerItemIds(sellerId, accessToken);
  const details = await getItemDetails(itemIds, accessToken);
  const items: MercadoLivreInventoryItem[] = [];

  for (const item of details) {
    const sku = extractSku(item);
    if (!sku) {
      continue;
    }

    items.push({
      accountId: account.id,
      accountName: account.name,
      marketplace: "mercado_livre",
      listingId: String(item.id || ""),
      sku,
      title: String(item.title || ""),
      price: Number(item.price || 0),
      stock: isMercadoLivreInactive(String(item.status || "")) ? 0 : Number(item.available_quantity || 0),
      status: String(item.status || ""),
      rawData: item
    });
  }

  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({
      last_inventory_sync_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      status: "active",
      last_error: null
    })
    .eq("id", account.id);

  return items;
}

export async function updateMercadoLivreStock(accountId: string, listingId: string, stock: number) {
  const account = await getMercadoLivreAccountById(accountId);
  const accessToken = await getValidMercadoLivreAccessToken(account);

  if (stock <= 0) {
    await putMercadoLivreItem(listingId, accessToken, { status: "paused" });
    return;
  }

  await putMercadoLivreItem(listingId, accessToken, { status: "active" });
  await putMercadoLivreItem(listingId, accessToken, { available_quantity: stock });
}

export async function removeMercadoLivreListing(accountId: string, listingId: string) {
  const account = await getMercadoLivreAccountById(accountId);
  const accessToken = await getValidMercadoLivreAccessToken(account);
  await putMercadoLivreItem(listingId, accessToken, { status: "paused" });
}

export function isMercadoLivreInactive(status: string) {
  return ["paused", "closed", "inactive"].includes(status);
}

async function getMercadoLivreAccountById(accountId: string) {
  const { data } = await supabaseAdmin()
    .from("config_marketplace_accounts")
    .select("id,name,marketplace,active,account_id,seller_id,client_id,client_secret,redirect_uri,access_token,refresh_token,token_expires_at")
    .eq("id", accountId)
    .single()
    .throwOnError();

  return data as MarketplaceAccountConfig;
}

async function getValidMercadoLivreAccessToken(account: MarketplaceAccountConfig) {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  const hasValidToken = account.access_token && expiresAt > Date.now() + 60_000;
  if (hasValidToken) {
    return account.access_token as string;
  }

  if (!account.refresh_token || !account.client_id || !account.client_secret) {
    if (account.access_token) {
      return account.access_token;
    }

    throw new Error(`Token OAuth incompleto para ${account.name}. Abra Configuracoes > MarketPlace e clique em Conectar ML nessa conta para gerar access_token e refresh_token.`);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: account.client_id,
    client_secret: account.client_secret,
    refresh_token: account.refresh_token
  });

  const response = await fetch(`${ML_API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Falha ao renovar token Mercado Livre: ${JSON.stringify(json)}`);
  }

  const expiresIn = Number(json.expires_in || 0);
  const expires = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  await supabaseAdmin()
    .from("config_marketplace_accounts")
    .update({
      access_token: json.access_token || account.access_token,
      refresh_token: json.refresh_token || account.refresh_token,
      token_expires_at: expires,
      scope: json.scope || null,
      token_type: json.token_type || null,
      seller_id: json.user_id ? String(json.user_id) : account.seller_id || account.account_id || null,
      status: "active",
      last_error: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", account.id);

  return String(json.access_token || account.access_token);
}

async function listSellerItemIds(sellerId: string, accessToken: string) {
  const ids: string[] = [];
  let scrollId = "";

  do {
    const params = new URLSearchParams({
      search_type: "scan",
      limit: "100"
    });
    if (scrollId) {
      params.set("scroll_id", scrollId);
    }

    const json = await mlGet(`/users/${sellerId}/items/search?${params.toString()}`, accessToken);
    ids.push(...((json.results || []) as string[]));
    scrollId = String(json.scroll_id || "");
  } while (scrollId);

  return ids;
}

async function getItemDetails(itemIds: string[], accessToken: string) {
  const details: Array<Record<string, unknown>> = [];

  for (let index = 0; index < itemIds.length; index += 20) {
    const batch = itemIds.slice(index, index + 20);
    const params = new URLSearchParams({
      ids: batch.join(","),
      attributes: "id,title,price,available_quantity,status,seller_custom_field,attributes,variations"
    });
    const json = await mlGet(`/items?${params.toString()}`, accessToken);
    for (const entry of json as Array<{ code?: number; body?: Record<string, unknown> }>) {
      if (entry.code && entry.code >= 400) {
        continue;
      }
      if (entry.body) {
        details.push(entry.body);
      }
    }
  }

  return details;
}

async function putMercadoLivreItem(listingId: string, accessToken: string, payload: Record<string, unknown>) {
  const response = await fetch(`${ML_API}/items/${listingId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }

  return json;
}

async function mlGet(path: string, accessToken: string) {
  const response = await fetch(`${ML_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store"
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }

  return json;
}

function extractSku(item: Record<string, unknown>) {
  const sellerCustomField = String(item.seller_custom_field || "").trim();
  if (sellerCustomField) {
    return sellerCustomField;
  }

  const attributes = (item.attributes || []) as Array<{ id?: string; value_name?: string; value_id?: string }>;
  const skuAttribute = attributes.find((attribute) => attribute.id === "SELLER_SKU" || attribute.id === "SELLER_CUSTOM_FIELD");
  if (skuAttribute?.value_name || skuAttribute?.value_id) {
    return String(skuAttribute.value_name || skuAttribute.value_id).trim();
  }

  const variations = (item.variations || []) as Array<{ seller_custom_field?: string; attributes?: Array<{ id?: string; value_name?: string }> }>;
  for (const variation of variations) {
    if (variation.seller_custom_field) {
      return String(variation.seller_custom_field).trim();
    }

    const variationSku = variation.attributes?.find((attribute) => attribute.id === "SELLER_SKU");
    if (variationSku?.value_name) {
      return String(variationSku.value_name).trim();
    }
  }

  return "";
}
