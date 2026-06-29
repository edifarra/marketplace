"use client";

type ConfirmActionButtonProps = {
  children: React.ReactNode;
  className?: string;
  message: string;
};

export function ConfirmActionButton({ children, className = "danger compact", message }: ConfirmActionButtonProps) {
  return (
    <button
      className={className}
      type="submit"
      onClick={(event) => {
        if (!window.confirm(message)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
