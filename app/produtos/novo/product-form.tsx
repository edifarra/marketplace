"use client";

import { useFormState } from "react-dom";
import { createProductAction } from "./actions";
import { SubmitButton } from "./submit-button";
import type { ProductFormOptions } from "@/lib/products";

const initialState = {
  ok: true,
  message: ""
};

export function ProductForm({ options }: { options: ProductFormOptions }) {
  const [state, formAction] = useFormState(createProductAction, initialState);

  return (
    <form action={formAction} className="card form-card">
      {!state.ok && <div className="form-error">{state.message}</div>}

      <div className="form-grid">
        <label>
          Tipo
          <select name="typeCode" required>
            <option value="">Selecione</option>
            {options.types.map((type) => (
              <option key={type.code} value={type.code}>
                {type.code} - {type.description}
              </option>
            ))}
          </select>
        </label>

        <label>
          Marca
          <select name="brandCode" required>
            <option value="">Selecione</option>
            {options.brands.map((brand) => (
              <option key={brand.code} value={brand.code}>
                {brand.code} - {brand.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Especial
          <select name="specialCode">
            <option value="">Nenhum</option>
            {options.specials.map((special) => (
              <option key={special.code} value={special.code}>
                {special.code} - {special.notes || special.include_description || "Regra especial"}
              </option>
            ))}
          </select>
        </label>

        <label>
          Modelo
          <input name="model" required placeholder="Ex: UN40J5200" />
        </label>

        <label>
          Versao
          <input name="version" placeholder="Ex: BN94" />
        </label>

        <label>
          Codigo da placa
          <input name="boardCode" placeholder="Ex: BN41-02360" />
        </label>

        <label>
          Preco
          <input name="price" required min="0.01" step="0.01" type="number" placeholder="0,00" />
        </label>

        <label>
          Estoque
          <input name="stock" required min="0" step="1" type="number" defaultValue={options.initialStock} />
        </label>
      </div>

      <div className="form-actions">
        <a className="secondary" href="/">
          Voltar
        </a>
        <SubmitButton />
      </div>
    </form>
  );
}
