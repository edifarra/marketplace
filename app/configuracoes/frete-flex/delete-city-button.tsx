"use client";

import type { FormEvent } from "react";
import { deleteFreteFlexCity } from "./actions";

export function DeleteCityButton({ id }: { id: string }) {
  function confirmDelete(event: FormEvent<HTMLFormElement>) {
    if (!window.confirm("Excluir esta cidade da lista de Extremo SP? Ela passará a usar a tarifa Capital / Grande SP.")) event.preventDefault();
  }
  return <form action={deleteFreteFlexCity} onSubmit={confirmDelete}>
    <input type="hidden" name="id" value={id}/>
    <button className="secondary compact" type="submit">Excluir</button>
  </form>;
}
