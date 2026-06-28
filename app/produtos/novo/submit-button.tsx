"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button className="primary" type="submit" disabled={pending}>
      {pending ? "Salvando..." : "Cadastrar produto"}
    </button>
  );
}
