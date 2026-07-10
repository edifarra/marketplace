"use client";

import Image from "next/image";
import { useState } from "react";
import { deleteSelectedPhotosAction } from "./actions";

type Photo = {
  name: string;
  publicId: string;
  imageUrl: string;
  sizeBytes: number;
  createdAt: string;
  format: string;
  relatedSku?: string;
  relatedStock?: number;
};

export function PhotosSelection({ photos }: { photos: Photo[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const allSelected = photos.length > 0 && selected.length === photos.length;

  function toggleAll() {
    setSelected(allSelected ? [] : photos.map((photo) => photo.publicId));
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
            if (!window.confirm(`Excluir ${selected.length} foto(s) do Cloudinary?`)) {
              event.preventDefault();
            }
          }}
        >
          Excluir selecionadas
        </button>
      </div>

      <div className="photos-grid">
        {photos.map((photo) => {
          const checked = selected.includes(photo.publicId);
          return (
            <label className="photo-card" key={photo.publicId}>
              <input
                type="checkbox"
                name="photos"
                value={photo.publicId}
                checked={checked}
                onChange={() =>
                  setSelected((current) =>
                    checked ? current.filter((item) => item !== photo.publicId) : [...current, photo.publicId]
                  )
                }
              />
              <Image src={photo.imageUrl} alt={photo.name} width={160} height={160} unoptimized />
              <strong>{photo.name}</strong>
              <span>{formatBytes(photo.sizeBytes)}</span>
              <span>{photo.format ? photo.format.toUpperCase() : "Imagem"} - {formatDate(photo.createdAt)}</span>
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

function formatDate(value: string) {
  if (!value) {
    return "sem data";
  }

  return new Date(value).toLocaleDateString("pt-BR");
}
