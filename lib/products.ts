import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteCloudinaryResource } from "./cloudinary";
import { deleteLocalImagePath, deleteLocalProductFolder } from "./local-images";
import { applyTemplate, nextSku } from "./pipeline";
import { supabaseAdmin } from "./supabase-admin";
import { deactivateTinyProductById } from "./tiny";
import { BrandConfig, SpecialConfig, TypeConfig } from "./types";

type DbTypeConfig = {
  code: string;
  description: string;
  sku_max: number | null;
  marketplace_category: string | null;
  weight_net: number | null;
  weight_gross: number | null;
  width: number | null;
  height: number | null;
  length: number | null;
  description_template: string | null;
  sku_group: string;
  title_template: string | null;
  warranty_months: number | null;
};

type DbBrandConfig = {
  code: string;
  name: string;
  include_in_title: boolean;
};

type DbSpecialConfig = {
  code: string;
  include_description: string | null;
  remove_description: string | null;
  keep_warranty: boolean;
  notes: string | null;
};

type ProductFormInput = {
  typeCode: string;
  brandCode: string;
  specialCode?: string;
  model: string;
  version?: string;
  boardCode?: string;
  price: number;
  stock: number;
};

export type ProductFormOptions = {
  types: DbTypeConfig[];
  brands: DbBrandConfig[];
  specials: DbSpecialConfig[];
  initialStock: number;
};

export type CreateProductState = {
  ok: boolean;
  message: string;
};

type ProductImageForDelete = {
  local_path?: string | null;
  cloudinary_public_id?: string | null;
};

export async function getProductFormOptions(): Promise<ProductFormOptions> {
  const supabase = supabaseAdmin();

  const [types, brands, specials, initialStock] = await Promise.all([
    supabase.from("config_types").select("*").order("code").throwOnError(),
    supabase.from("config_brands").select("*").order("code").throwOnError(),
    supabase.from("config_specials").select("*").order("code").throwOnError(),
    getNumericSetting("ESTOQUE_INICIAL", 1)
  ]);

  return {
    types: (types.data ?? []) as DbTypeConfig[],
    brands: (brands.data ?? []) as DbBrandConfig[],
    specials: (specials.data ?? []) as DbSpecialConfig[],
    initialStock
  };
}

export async function createProductFromForm(formData: FormData): Promise<CreateProductState> {
  const input = parseProductForm(formData);
  const supabase = supabaseAdmin();

  const [{ data: type }, { data: brand }, { data: special }] = await Promise.all([
    supabase.from("config_types").select("*").eq("code", input.typeCode).single().throwOnError(),
    supabase.from("config_brands").select("*").eq("code", input.brandCode).single().throwOnError(),
    input.specialCode
      ? supabase.from("config_specials").select("*").eq("code", input.specialCode).single().throwOnError()
      : Promise.resolve({ data: null })
  ]);

  if (!type || !brand) {
    return { ok: false, message: "Tipo ou marca nao encontrados nas configuracoes." };
  }

  const typeConfig = toTypeConfig(type as DbTypeConfig);
  const brandConfig = toBrandConfig(brand as DbBrandConfig);
  const specialConfig = special ? toSpecialConfig(special as DbSpecialConfig) : undefined;
  const skuInfo = await reserveNextSku(typeConfig, input.specialCode);

  const title = applyTemplate(typeConfig.titleTemplate, {
    tipo: typeConfig.description,
    marca: brandConfig.includeInTitle ? brandConfig.name : "",
    modelo: input.model,
    versao: input.version,
    codigo: input.boardCode,
    especial: specialConfig?.includeDescription || "",
    sku: skuInfo.sku
  });

  let description = applyTemplate(typeConfig.descriptionTemplate, {
    nome_produto_completo: title,
    tipo: typeConfig.description,
    marca: brandConfig.name,
    modelo: input.model,
    versao: input.version,
    codigo: input.boardCode,
    especial: specialConfig?.includeDescription || "",
    sku: skuInfo.sku
  });

  if (specialConfig?.removeDescription) {
    description = description.replace(specialConfig.removeDescription, "").trim();
  }

  const sourceKey = buildManualSourceKey(input, skuInfo.sku);

  const productResult = await supabase
    .from("products")
    .insert({
      sku: skuInfo.sku,
      source_key: sourceKey,
      type_code: input.typeCode,
      brand_code: input.brandCode,
      special_code: input.specialCode || null,
      model: input.model,
      version: input.version || null,
      board_code: input.boardCode || null,
      title,
      description,
      price: input.price,
      stock: input.stock,
      status: "draft"
    })
    .select("id")
    .single();

  if (productResult.error) {
    return { ok: false, message: productResult.error.message };
  }

  await supabase
    .from("listings")
    .insert([
      {
        product_id: productResult.data.id,
        marketplace: "mercado_livre",
        external_sku: skuInfo.sku,
        status: "draft",
        stock: input.stock,
        price: input.price
      },
      {
        product_id: productResult.data.id,
        marketplace: "shopee",
        external_sku: skuInfo.sku,
        status: "draft",
        stock: input.stock,
        price: input.price
      }
    ])
    .throwOnError();

  revalidatePath("/");
  revalidatePath("/produtos/novo");
  redirect("/");
}

export async function deleteProductById(formData: FormData) {
  const productId = requiredText(formData, "productId");
  const supabase = supabaseAdmin();

  const { data: product, error } = await getProductForDelete(productId);

  if (error || !product) {
    redirect(`/produtos?erro=${encodeURIComponent("Produto nao encontrado.")}`);
  }

  const typed = product as {
    id: string;
    sku: string;
    source_key: string;
    status?: string | null;
    sent_target?: string | null;
    tiny_product_id?: string | null;
    listings?: Array<{ external_listing_id?: string | null }>;
    product_images?: ProductImageForDelete[];
  };

  const hasPublishedListing = (typed.listings || []).some((listing) => Boolean(listing.external_listing_id));
  if (hasPublishedListing) {
    redirect(`/produtos?erro=${encodeURIComponent("Nao foi possivel excluir: existe anuncio publicado para este produto.")}`);
  }

  const tinyProductId = typed.tiny_product_id || await getTinyProductIdFromLastResult(typed.id);
  if (tinyProductId) {
    try {
      await deactivateTinyProductById(tinyProductId);
    } catch (tinyError) {
      redirect(`/produtos?erro=${encodeURIComponent(`Nao foi possivel inativar no Tiny: ${tinyError instanceof Error ? tinyError.message : String(tinyError)}`)}`);
    }
  } else if (typed.sent_target === "TINY") {
    redirect(`/produtos?erro=${encodeURIComponent("Nao foi possivel excluir: produto marcado como enviado ao Tiny, mas sem codigo tiny_product_id para inativacao.")}`);
  }

  for (const image of typed.product_images || []) {
    await deleteLocalImagePath(image.local_path);
    await deleteCloudinaryResource(image.cloudinary_public_id);
  }

  await deleteLocalProductFolder(typed.sku);
  await supabase.from("product_images").delete().eq("product_id", typed.id).throwOnError();
  await supabase.from("listings").delete().eq("product_id", typed.id).throwOnError();
  await supabase.from("pipeline_logs").delete().filter("payload->>sourceKey", "eq", typed.source_key);
  await supabase.from("products").delete().eq("id", typed.id).throwOnError();

  revalidatePath("/");
  revalidatePath("/produtos");
  redirect("/produtos");
}

async function getProductForDelete(productId: string) {
  const supabase = supabaseAdmin();
  const withIntegration = await supabase
    .from("products")
    .select(`
      id,
      sku,
      source_key,
      status,
      sent_target,
      tiny_product_id,
      listings (
        id,
        external_listing_id
      ),
      product_images (
        local_path,
        cloudinary_public_id
      )
    `)
    .eq("id", productId)
    .single();

  if (!withIntegration.error) {
    return withIntegration;
  }

  if (!/sent_target|tiny_product_id|schema cache|Could not find/i.test(withIntegration.error.message)) {
    return withIntegration;
  }

  return supabase
    .from("products")
    .select(`
      id,
      sku,
      source_key,
      status,
      listings (
        id,
        external_listing_id
      ),
      product_images (
        local_path,
        cloudinary_public_id
      )
    `)
    .eq("id", productId)
    .single();
}

async function getTinyProductIdFromLastResult(productId: string) {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("value")
    .eq("key", `TINY_LAST_PRODUCT_${productId}`)
    .maybeSingle();

  const value = data?.value;
  if (!value || typeof value !== "object") {
    return "";
  }

  return String((value as Record<string, unknown>).idProduto || "");
}

function parseProductForm(formData: FormData): ProductFormInput {
  const typeCode = requiredText(formData, "typeCode");
  const brandCode = requiredText(formData, "brandCode");
  const model = requiredText(formData, "model");
  const price = positiveNumber(formData, "price");
  const stock = nonNegativeInteger(formData, "stock");

  return {
    typeCode,
    brandCode,
    model,
    price,
    stock,
    specialCode: optionalText(formData, "specialCode"),
    version: optionalText(formData, "version"),
    boardCode: optionalText(formData, "boardCode")
  };
}

async function reserveNextSku(type: TypeConfig, specialCode?: string) {
  const supabase = supabaseAdmin();

  for (let attempt = 0; attempt < 5; attempt++) {
    const counterResult = await supabase
      .from("sku_counters")
      .select("current_number")
      .eq("sku_group", type.skuGroup)
      .maybeSingle()
      .throwOnError();

    const currentNumber = Number(counterResult.data?.current_number ?? type.skuMax ?? 0);
    const skuInfo = nextSku(type, currentNumber, specialCode);

    const update = counterResult.data
      ? await supabase
          .from("sku_counters")
          .update({ current_number: skuInfo.nextNumber, updated_at: new Date().toISOString() })
          .eq("sku_group", type.skuGroup)
          .eq("current_number", currentNumber)
          .select("sku_group")
      : await supabase
          .from("sku_counters")
          .insert({ sku_group: type.skuGroup, current_number: skuInfo.nextNumber })
          .select("sku_group");

    if (!update.error && update.data && update.data.length > 0) {
      return skuInfo;
    }
  }

  throw new Error("Nao foi possivel reservar SKU. Tente novamente.");
}

async function getNumericSetting(key: string, fallback: number) {
  const supabase = supabaseAdmin();
  const { data } = await supabase.from("settings").select("value").eq("key", key).maybeSingle().throwOnError();
  const raw = data?.value;
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(",", "."));
  return Number.isFinite(value) ? value : fallback;
}

function toTypeConfig(row: DbTypeConfig): TypeConfig {
  return {
    code: row.code,
    description: row.description,
    skuGroup: row.sku_group,
    skuMax: row.sku_max ?? undefined,
    titleTemplate: row.title_template || "[TIPO] [MARCA] [MODELO] [VERSAO] [CODIGO] [ESPECIAL]",
    descriptionTemplate: row.description_template || "Produto: [NOME_PRODUTO_COMPLETO]",
    warrantyMonths: row.warranty_months ?? undefined,
    dimensions: {
      weightNet: Number(row.weight_net ?? 0),
      weightGross: Number(row.weight_gross ?? 0),
      width: Number(row.width ?? 0),
      height: Number(row.height ?? 0),
      length: Number(row.length ?? 0)
    }
  };
}

function toBrandConfig(row: DbBrandConfig): BrandConfig {
  return {
    code: row.code,
    name: row.name,
    includeInTitle: row.include_in_title
  };
}

function toSpecialConfig(row: DbSpecialConfig): SpecialConfig {
  return {
    code: row.code,
    includeDescription: row.include_description,
    removeDescription: row.remove_description,
    keepWarranty: row.keep_warranty
  };
}

function buildManualSourceKey(input: ProductFormInput, sku: string) {
  const parts = [input.typeCode + input.brandCode, input.model, input.version, input.boardCode, input.specialCode]
    .filter(Boolean)
    .join("-");

  return `manual_${normalizeKey(parts)}_${sku}`;
}

function normalizeKey(value: string) {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function requiredText(formData: FormData, key: string) {
  const value = String(formData.get(key) || "").trim();
  if (!value) {
    throw new Error(`Campo obrigatorio: ${key}`);
  }

  return value;
}

function optionalText(formData: FormData, key: string) {
  const value = String(formData.get(key) || "").trim();
  return value || undefined;
}

function positiveNumber(formData: FormData, key: string) {
  const value = Number(String(formData.get(key) || "").replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Valor invalido para ${key}`);
  }

  return value;
}

function nonNegativeInteger(formData: FormData, key: string) {
  const value = Number(formData.get(key));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Valor invalido para ${key}`);
  }

  return value;
}
