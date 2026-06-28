"use client";

import { useFormStatus } from "react-dom";

type PendingSubmitButtonProps = {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  pendingLabel?: string;
};

export function PendingSubmitButton({
  children,
  className = "primary",
  disabled = false,
  pendingLabel = "Processando..."
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button className={className} type="submit" disabled={disabled || pending} data-pending={pending ? "true" : "false"}>
      {pending ? pendingLabel : children}
    </button>
  );
}
