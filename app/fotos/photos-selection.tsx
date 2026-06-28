"use client";

import Image from "next/image";
import { useState } from "react";
import { deleteSelectedPhotosAction } from "./actions";

type Photo = {
  name: string;
  localUrl: string;
  sizeBytes: number;
  modifiedAt: string;
  relatedSku?: string;
  relatedStock?: number;
};

export function PhotosSelection({ photos }: { photos: Photo[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = photos.length > 0 && selected.length === photos.length;

  function toggleAll() {
    setSelected(allSelected ? [] : photos.map((photo) => photo.localUrl));
  }

  return (
    <form action={deleteSelectedPhotosAction} className="photos-form">
      <div className="photo-actions">
        <button className="secondary" type="button" onClick={toggleAll}>
          {allSelected ? "Limpar selecao" : "Selecionar todas"}
        </button>
        <button
          className="danger"
          type="submit"
          disabled={selected.length === 0}
          onClick={(event) => {
            if (!window.confirm(`Excluir ${selected.length} foto(s) local(is)?`)) {
              event.preventDefault();
            }
          }}
        >
          Excluir selecionadas
        </button>
      </div>

      <div className="photos-grid">
        {photos.map((photo) => {
          const checked = selected.includes(photo.localUrl);
          return (
            <label className="photo-card" key={photo.localUrl}>
              <input
                type="checkbox"
                name="photos"
                value={photo.localUrl}
                checked={checked}
                onChange={() =>
                  setSelected((current) =>
                    checked ? current.filter((item) => item !== photo.localUrl) : [...current, photo.localUrl]
                  )
                }
              />
              <Image src={photo.localUrl} alt={photo.name} width={160} height={160} unoptimized />
              <strong>{photo.name}</strong>
              <span>{formatBytes(photo.sizeBytes)}</span>
              <span>{photo.relatedSku ? `${photo.relatedSku} - estoque ${photo.relatedStock ?? 0}` : "Sem produto relacionado"}</span>
            </label>
          );
        })}
      </div>
    </form>
  );
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} MB`;
}
