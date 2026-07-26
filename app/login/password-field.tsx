"use client";

import { useState } from "react";

export function PasswordField({ disabled = false, name = "password", label = "Senha" }) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <span className="password-field">
        <input
          name={name}
          type={visible ? "text" : "password"}
          minLength={8}
          autoComplete="current-password"
          required
          disabled={disabled}
        />
        <button type="button" className="secondary compact" onClick={() => setVisible(!visible)}>
          {visible ? "Ocultar" : "Mostrar"}
        </button>
      </span>
    </label>
  );
}
