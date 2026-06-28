import { uploadProductImageToCloudinary } from "./cloudinary";
import { downloadDriveFile, listDriveImagesFolderFiles, type DriveFile } from "./google-drive";
import { applyTemplate, groupPhotos, isValidPhotoName, nextSku, parsePhotoName } from "./pipeline";
import { supabaseAdmin } from "./supabase-admin";
import { BrandConfig, SpecialConfig, TypeConfig } from "./types";

const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

type DbTypeConfig = {
  code: string;
  description: string;
  sku_max: number | null;
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
};

type MarketplaceAccount = {
  id?: string;
  name: string;
  marketplace: "mercado_livre" | "shopee";
};

type ProductLoadLog = {
  fileName: string;
  sourceKey?: string;
  stage: string;
  status: "avaliado" | "descartado" | "duplicado" | "criado" | "falha";
  reason?: string;
  parse?: unknown;
  variables: Record<string, unknown>;
};

type FailureContext = {
  stage: string;
  fileName: string;
  parse?: unknown;
  variables: Record<string, unknown>;
};

type InvalidDriveFile = {
  file: DriveFile;
  reason: string;
  validName: boolean;
};

export type ProductLoadProgress = {
  totalFiles: number;
  processedFiles: number;
  currentFile?: string;
  percent: number;
};

export type ProductLoadResult = {
  totalFiles: number;
  totalDriveItems: number;
  totalFolders: number;
  totalGroups: number;
  created: number;
  duplicates: number;
  discarded: number;
  failed: number;
  createdProducts: Array<{ sku: string; title: string; sourceKey: string }>;
  duplicateProducts: string[];
  discardedItems: Array<{ name: string; reason: string }>;
  errorItems: Array<{ sourceKey: string; message: string }>;
  itemLogs: ProductLoadLog[];
};

export async function loadProductsFromDriveImages(onProgress?: (progress: ProductLoadProgress) => Promise<void>): Promise<ProductLoadResult> {
  const supabase = supabaseAdmin();
  const driveItems = await listDriveImagesFolderFiles();
  const folderItems = driveItems.filter(isDriveFolder);
  const files = driveItems.filter((file) => !isDriveFolder(file));
  const { validFiles, invalidFiles } = splitProcessableDriveFiles(files);

  logDriveScan(driveItems, files, folderItems);

  const groups = groupPhotos(validFiles.map((file) => file.name));
  const filesByName = new Map(validFiles.map((file) => [file.name, file]));
  const configs = await loadConfigs();
  const initialStock = await getNumericSetting("ESTOQUE_INICIAL", 1);
  const defaultPrice = Math.max(await getNumericSetting("VALOR_MINIMO", 20), 20);
  let processedFiles = invalidFiles.length;
  await reportProgress(onProgress, files.length, processedFiles);
  const result: ProductLoadResult = {
    totalFiles: files.length,
    totalDriveItems: driveItems.length,
    totalFolders: folderItems.length,
    totalGroups: groups.length,
    created: 0,
    duplicates: 0,
    discarded: invalidFiles.length,
    failed: 0,
    createdProducts: [],
    duplicateProducts: [],
    discardedItems: invalidFiles.map((item) => ({ name: item.file.name, reason: item.reason })),
    errorItems: [],
    itemLogs: []
  };

  for (const folder of folderItems) {
    result.itemLogs.push({
      fileName: folder.name,
      stage: "scan_google_drive",
      status: "descartado",
      reason: "Item ignorado por ser pasta do Google Drive",
      variables: {
        id: folder.id,
        mimeType: folder.mimeType,
        parents: folder.parents,
        trashed: folder.trashed,
        isFolder: true
      }
    });
  }

  for (const item of invalidFiles) {
    result.itemLogs.push({
      fileName: item.file.name,
      stage: "validacao_nome",
      status: "descartado",
      reason: item.reason,
      variables: {
        id: item.file.id,
        mimeType: item.file.mimeType,
        parents: item.file.parents,
        trashed: item.file.trashed,
        validName: item.validName,
        isFolder: false
      }
    });
  }

  for (const file of validFiles) {
    const parsed = parsePhotoName(file.name);
    result.itemLogs.push({
      fileName: file.name,
      sourceKey: parsed.sourceKey,
      stage: "arquivo_avaliado",
      status: "avaliado",
      parse: parsed,
      variables: {
        id: file.id,
        mimeType: file.mimeType,
        parents: file.parents,
        trashed: file.trashed,
        typeCode: parsed.typeCode,
        brandCode: parsed.brandCode,
        model: parsed.model,
        boardCode: parsed.boardCode,
        version: parsed.version,
        specialCode: parsed.specialCode,
        photoNumber: parsed.photoNumber
      }
    });
  }

  for (const group of groups) {
    let failureContext: FailureContext | undefined;
    try {
      const main = parsePhotoName(group.photos[0]);
      result.itemLogs.push({
        fileName: group.photos.join(", "),
        sourceKey: group.sourceKey,
        stage: "parse",
        status: "avaliado",
        parse: main,
        variables: {
          photos: group.photos,
          photoCount: group.photos.length,
          typeCode: main.typeCode,
          brandCode: main.brandCode,
          model: main.model,
          boardCode: main.boardCode,
          version: main.version,
          specialCode: main.specialCode,
          photoNumber: main.photoNumber
        }
      });
      const existing = await supabase
        .from("products")
        .select("id,sku")
        .eq("source_key", group.sourceKey)
        .maybeSingle()
        .throwOnError();

      if (existing.data) {
        result.duplicates++;
        result.duplicateProducts.push(group.sourceKey);
        pushPhotoLogs(result, group.photos, group.sourceKey, "duplicidade", "duplicado", "source_key ja cadastrado", {
          existingProductId: existing.data.id,
          existingSku: existing.data.sku,
          sourceKey: group.sourceKey
        });
        result.itemLogs.push({
          fileName: group.photos.join(", "),
          sourceKey: group.sourceKey,
          stage: "duplicidade",
          status: "duplicado",
          reason: "source_key ja cadastrado",
          parse: main,
          variables: {
            existingProductId: existing.data.id,
            existingSku: existing.data.sku,
            sourceKey: group.sourceKey
          }
        });
        continue;
      }

      if (main.photoNumber !== 1) {
        result.discarded++;
        result.discardedItems.push({ name: group.sourceKey, reason: "Produto sem foto 01" });
        pushPhotoLogs(result, group.photos, group.sourceKey, "validacao_foto_principal", "descartado", "Produto sem foto 01", {
          firstPhotoNumber: main.photoNumber,
          photos: group.photos
        });
        continue;
      }

      const type = configs.types.get(main.typeCode);
      const brand = configs.brands.get(main.brandCode);
      const special = main.specialCode ? configs.specials.get(main.specialCode) : undefined;

      if (!type || !brand) {
        result.discarded++;
        const reason = !type ? "Tipo sem configuracao" : "Marca sem configuracao";
        result.discardedItems.push({ name: group.sourceKey, reason });
        pushPhotoLogs(result, group.photos, group.sourceKey, !type ? "validacao_tipo" : "validacao_marca", "descartado", reason, {
          typeCode: main.typeCode,
          brandCode: main.brandCode,
          typeFound: Boolean(type),
          brandFound: Boolean(brand),
          knownTypeCodes: [...configs.types.keys()],
          knownBrandCodes: [...configs.brands.keys()]
        });
        continue;
      }

      const skuInfo = await reserveNextSku(type);
      const title = applyTemplate(type.titleTemplate, {
        tipo: type.description,
        marca: brand.includeInTitle ? brand.name : "",
        modelo: main.model,
        versao: main.version,
        codigo: main.boardCode,
        especial: special?.includeDescription || "",
        sku: skuInfo.sku
      });
      let description = applyTemplate(type.descriptionTemplate, {
        nome_produto_completo: title,
        tipo: type.description,
        marca: brand.name,
        modelo: main.model,
        versao: main.version,
        codigo: main.boardCode,
        especial: special?.includeDescription || "",
        sku: skuInfo.sku
      });

      if (special?.removeDescription) {
        description = description.replace(special.removeDescription, "").trim();
      }
      
      const imageUploads = [];
      for (const [index, photoName] of group.photos.slice(0, 6).entries()) {
        const driveFile = filesByName.get(photoName);
        console.log("Imagens: ", driveFile)
        const photoParse = parsePhotoName(photoName);
        if (!driveFile) {
          failureContext = {
            stage: "drive_download",
            fileName: photoName,
            parse: photoParse,
            variables: { photoName, groupPhotos: group.photos }
          };
          throw new Error(`Arquivo nao localizado no Drive: ${photoName}`);
        }

        failureContext = {
          stage: "drive_download",
          fileName: photoName,
          parse: photoParse,
          variables: {
            driveFileId: driveFile.id,
            position: index + 1,
            mimeType: driveFile.mimeType
          }
        };
        const buffer = await downloadDriveFile(driveFile.id);
        await reportProgress(onProgress, files.length, processedFiles, photoName);
        console.log("Imagens by ID: ", buffer)
        result.itemLogs.push({
          fileName: photoName,
          sourceKey: group.sourceKey,
          stage: "cloudinary_upload_inicio",
          status: "avaliado",
          parse: photoParse,
          variables: {
            driveFileId: driveFile.id,
            position: index + 1,
            bytes: buffer.length,
            transformation: index === 0 ? "fundo branco" : "redimensionada"
          }
        });
        console.log("Passado o Cloudinary")
        failureContext = {
          stage: "cloudinary_upload",
          fileName: photoName,
          parse: photoParse,
          variables: {
            driveFileId: driveFile.id,
            position: index + 1,
            bytes: buffer.length,
            sku: skuInfo.sku,
            transformation: index === 0 ? "fundo branco" : "redimensionada"
          }
        };
        
        const upload = await uploadProductImageToCloudinary({
          buffer,
          fileName: photoName,
          sku: skuInfo.sku,
          typeCode: photoParse.typeCode,
          brandCode: photoParse.brandCode,
          model: photoParse.model,
          boardCode: photoParse.boardCode,
          position: index + 1
        });
        console.log("Upload: ", upload)
        processedFiles++;
        await reportProgress(onProgress, files.length, processedFiles, photoName);
        result.itemLogs.push({
          fileName: photoName,
          sourceKey: group.sourceKey,
          stage: "cloudinary_upload_fim",
          status: "avaliado",
          parse: photoParse,
          variables: {
            driveFileId: driveFile.id,
            position: index + 1,
            cloudinaryFileName: upload.cloudinaryFileName,
            cloudinaryUrl: upload.cloudinaryUrl,
            cloudinaryPublicId: upload.publicId,
            localUrl: upload.localUrl,
            localPath: upload.localPath,
            localBytes: upload.bytes
          }
        });
        imageUploads.push({ driveFile, upload, position: index + 1 });
      }
      console.log("Produto insert")
      failureContext = {
        stage: "produto_insert",
        fileName: group.photos.join(", "),
        parse: main,
        variables: {
          sku: skuInfo.sku,
          sourceKey: group.sourceKey,
          typeCode: main.typeCode,
          brandCode: main.brandCode,
          specialCode: main.specialCode,
          title,
          stock: initialStock,
          price: defaultPrice
        }
      };
      const product = await supabase
        .from("products")
        .insert({
          sku: skuInfo.sku,
          source_key: group.sourceKey,
          type_code: main.typeCode,
          brand_code: main.brandCode,
          special_code: main.specialCode || null,
          model: main.model,
          version: main.version || null,
          board_code: main.boardCode || null,
          title,
          description,
          price: defaultPrice,
          stock: initialStock,
          status: "draft"
        })
        .select("id")
        .single()
        .throwOnError();

      failureContext = {
        stage: "product_images_insert",
        fileName: group.photos.join(", "),
        parse: main,
        variables: {
          productId: product.data.id,
          imageCount: imageUploads.length,
          photos: group.photos
        }
      };
      await insertProductImages(product.data.id, imageUploads);

      failureContext = {
        stage: "listings_insert",
        fileName: group.photos.join(", "),
        parse: main,
        variables: {
          productId: product.data.id,
          sku: skuInfo.sku,
          stock: initialStock,
          price: defaultPrice
        }
      };
      await createDraftListings(product.data.id, skuInfo.sku, initialStock, defaultPrice);
      result.created++;
      result.createdProducts.push({ sku: skuInfo.sku, title, sourceKey: group.sourceKey });
      result.itemLogs.push({
        fileName: group.photos.join(", "),
        sourceKey: group.sourceKey,
        stage: "produto_criado",
        status: "criado",
        parse: main,
        variables: {
          productId: product.data.id,
          sku: skuInfo.sku,
          title,
          imageCount: imageUploads.length,
          status: "draft"
        }
      });
    } catch (error) {
      result.failed++;
      const message = error instanceof Error ? error.message : String(error);
      result.errorItems.push({
        sourceKey: group.sourceKey,
        message
      });
      result.itemLogs.push({
        fileName: failureContext?.fileName || group.photos.join(", "),
        sourceKey: group.sourceKey,
        stage: failureContext?.stage || "falha",
        status: "falha",
        reason: message,
        parse: failureContext?.parse,
        variables: {
          photos: group.photos,
          ...(failureContext?.variables || {})
        }
      });
    }
  }

  return result;
}

async function reportProgress(
  onProgress: ((progress: ProductLoadProgress) => Promise<void>) | undefined,
  totalFiles: number,
  processedFiles: number,
  currentFile = ""
) {
  if (!onProgress) {
    return;
  }

  await onProgress({
    totalFiles,
    processedFiles,
    currentFile,
    percent: totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 100
  });
}

function pushPhotoLogs(
  result: ProductLoadResult,
  photos: string[],
  sourceKey: string,
  stage: string,
  status: ProductLoadLog["status"],
  reason: string,
  variables: Record<string, unknown>
) {
  for (const photo of photos) {
    let parsed: unknown;
    try {
      parsed = parsePhotoName(photo);
    } catch (error) {
      parsed = { error: error instanceof Error ? error.message : String(error) };
    }

    result.itemLogs.push({
      fileName: photo,
      sourceKey,
      stage,
      status,
      reason,
      parse: parsed,
      variables: {
        ...variables,
        photo
      }
    });
  }
}

function splitProcessableDriveFiles(files: DriveFile[]) {
  const validFiles: DriveFile[] = [];
  const invalidFiles: InvalidDriveFile[] = [];

  for (const file of files) {
    if (file.trashed) {
      invalidFiles.push({
        file,
        reason: "Arquivo esta na lixeira",
        validName: false
      });
      continue;
    }

    const validName = isValidPhotoName(file.name);
    if (validName) {
      validFiles.push(file);
      continue;
    }

    invalidFiles.push({
      file,
      reason: "Nome invalido ou extensao nao permitida",
      validName
    });
  }

  return { validFiles, invalidFiles };
}

function isDriveFolder(file: DriveFile) {
  return file.mimeType === DRIVE_FOLDER_MIME_TYPE;
}

function logDriveScan(driveItems: DriveFile[], files: DriveFile[], folders: DriveFile[]) {
  console.log("[SCAN]");
  console.log(`Total itens: ${driveItems.length}`);
  console.log(`Arquivos: ${files.length}`);
  console.log(`Pastas: ${folders.length}`);

  if (!folders.length) {
    return;
  }

  console.log("");
  console.log("Pastas ignoradas:");
  for (const folder of folders) {
    console.log(`* ${folder.name}`);
  }
}

async function loadConfigs() {
  const supabase = supabaseAdmin();
  const [types, brands, specials] = await Promise.all([
    supabase.from("config_types").select("*").throwOnError(),
    supabase.from("config_brands").select("*").throwOnError(),
    supabase.from("config_specials").select("*").throwOnError()
  ]);

  return {
    types: new Map(((types.data ?? []) as DbTypeConfig[]).map((row) => [row.code, toTypeConfig(row)])),
    brands: new Map(((brands.data ?? []) as DbBrandConfig[]).map((row) => [row.code, toBrandConfig(row)])),
    specials: new Map(((specials.data ?? []) as DbSpecialConfig[]).map((row) => [row.code, toSpecialConfig(row)]))
  };
}

async function reserveNextSku(type: TypeConfig) {
  const supabase = supabaseAdmin();

  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = await supabase
      .from("sku_counters")
      .select("current_number")
      .eq("sku_group", type.skuGroup)
      .maybeSingle()
      .throwOnError();
    const currentNumber = Number(counter.data?.current_number ?? type.skuMax ?? 0);
    const skuInfo = nextSku(type, currentNumber);
    const update = counter.data
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

  throw new Error("Nao foi possivel reservar SKU.");
}

async function createDraftListings(productId: string, sku: string, stock: number, price: number) {
  const supabase = supabaseAdmin();
  const accounts = await getMarketplaceAccounts();
  const listingPayload = accounts.map((account) => ({
    product_id: productId,
    marketplace: account.marketplace,
    marketplace_account_id: account.id,
    marketplace_name: account.name,
    external_sku: sku,
    status: "draft",
    stock,
    price
  }));

  const result = await supabase.from("listings").insert(listingPayload);
  if (!result.error) {
    return;
  }

  await supabase.from("listings").insert([
    {
      product_id: productId,
      marketplace: "mercado_livre",
      external_sku: sku,
      status: "draft",
      stock,
      price
    },
    {
      product_id: productId,
      marketplace: "shopee",
      external_sku: sku,
      status: "draft",
      stock,
      price
    }
  ]).throwOnError();
}

async function insertProductImages(
  productId: string,
  imageUploads: Array<{
    driveFile: DriveFile;
    upload: {
      publicId: string;
      cloudinaryFileName: string;
      cloudinaryUrl: string;
      localPath: string;
      localUrl: string;
      bytes: number;
    };
    position: number;
  }>
) {
  const supabase = supabaseAdmin();
  const fullPayload = imageUploads.map((image) => ({
    product_id: productId,
    drive_file_id: image.driveFile.id,
    original_name: image.driveFile.name,
    url: image.upload.cloudinaryUrl,
    cloudinary_url: image.upload.cloudinaryUrl,
    cloudinary_public_id: image.upload.publicId,
    local_path: image.upload.localPath,
    local_url: image.upload.localUrl,
    bytes: image.upload.bytes,
    position: image.position,
    status: "uploaded"
  }));

  const fullInsert = await supabase.from("product_images").insert(fullPayload);
  if (!fullInsert.error) {
    return;
  }

  if (!isMissingColumnError(fullInsert.error.message)) {
    throw fullInsert.error;
  }

  await supabase
    .from("product_images")
    .insert(imageUploads.map((image) => ({
      product_id: productId,
      drive_file_id: image.driveFile.id,
      original_name: image.driveFile.name,
      url: image.upload.localUrl,
      position: image.position,
      status: "uploaded_local"
    })))
    .throwOnError();
}

function isMissingColumnError(message: string) {
  return /column .* does not exist|schema cache|Could not find/i.test(message);
}

async function getMarketplaceAccounts(): Promise<MarketplaceAccount[]> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("config_marketplace_accounts")
    .select("id,name,marketplace")
    .eq("active", true)
    .order("name");

  if (!error && data?.length) {
    return data as MarketplaceAccount[];
  }

  return [
    { name: "Mercado Livre", marketplace: "mercado_livre" },
    { name: "Shopee", marketplace: "shopee" }
  ];
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
