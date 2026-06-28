export type Marketplace = "mercado_livre" | "shopee";

export type ProductStatus = "draft" | "ready" | "publishing" | "active" | "paused" | "error";

export type PhotoNameParts = {
  sourceKey: string;
  typeCode: string;
  brandCode: string;
  model: string;
  version?: string;
  boardCode?: string;
  specialCode?: string;
  photoNumber: number;
};

export type TypeConfig = {
  code: string;
  description: string;
  skuGroup: string;
  skuMax?: number;
  titleTemplate: string;
  descriptionTemplate: string;
  warrantyMonths?: number;
  dimensions: {
    weightNet: number;
    weightGross: number;
    width: number;
    height: number;
    length: number;
  };
};

export type BrandConfig = {
  code: string;
  name: string;
  includeInTitle: boolean;
};

export type SpecialConfig = {
  code: string;
  includeDescription?: string | null;
  removeDescription?: string | null;
  keepWarranty: boolean;
};

export type BuiltProduct = {
  sku: string;
  sourceKey: string;
  title: string;
  description: string;
  typeCode: string;
  brandCode: string;
  specialCode?: string;
  model: string;
  version?: string;
  boardCode?: string;
  price: number;
  stock: number;
  imageNames: string[];
};
