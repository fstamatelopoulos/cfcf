import { useEffect, type ReactNode } from "react";

/**
 * Minimal modal dialog (item 6.12). Centred overlay, backdrop close,
 * Escape-to-close, focus stays inside the SPA so deep-linking still
 * works. Designed for sharp, single-purpose interactions like
 * "Create workspace" or "Confirm delete" — not for long forms.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  /** Optional footer slot (typically buttons). Renders bottom-right. */
  footer,
  /** Width hint -- "sm" / "md" (default) / "lg". */
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  // Escape closes; restore body scroll on unmount/close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widthByLabel = { sm: "min(420px, 92vw)", md: "min(640px, 92vw)", lg: "min(880px, 95vw)" }[size];

  return (
    <div
      className="modal__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal__panel" style={{ width: widthByLabel }}>
        <div className="modal__header">
          <h3 className="modal__title">{title}</h3>
          <button
            type="button"
            className="modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
