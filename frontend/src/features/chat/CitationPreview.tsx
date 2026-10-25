import * as HoverCard from "@radix-ui/react-hover-card";
import { FileText } from "lucide-react";
import { forwardRef, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Citation } from "../../lib/api";
import "./citation-preview.css";

// HoverCard's anchor prevents touchstart to suppress focus. A citation is a
// button: retain the browser's native single-tap click instead of cancelling it.
const PreviewButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PreviewButton({ onTouchStart, ...props }, ref) {
  void onTouchStart;
  return <button {...props} ref={ref} />;
});

type Props = {
  citation?: Citation;
  label: string;
  className?: string;
  children: ReactNode;
  onCitation: (citation: Citation) => void;
};

export function CitationPreview(props: Props) {
  const { citation, className, label, children } = props;
  if (!citation || citation.available === false)
    return (
      <button
        type="button"
        className={className}
        disabled
        aria-label={label}
        title="来源已删除、不可访问或引用无效"
      >
        {children}
      </button>
    );
  return (
    <AvailablePreview
      key={`${citation.document_id}:${citation.chunk_id}`}
      {...props}
      citation={citation}
    />
  );
}

function AvailablePreview({
  citation,
  label,
  className,
  children,
  onCitation,
}: Props & { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const suppressed = useRef(false);
  const touch = useRef(false);
  const id = useId();
  const title =
    text(citation.document_name) || text(citation.display_name) || "查看原文";
  const snippet = text(citation.snippet);
  const kbName = text(citation.kb_name);
  const extension =
    text(citation.ext) || title.match(/\.([a-z0-9]{1,10})$/i)?.[1] || "";
  const format = /^[a-z0-9]{1,10}$/i.test(extension)
    ? extension.toUpperCase()
    : "文档";
  function dismiss() {
    suppressed.current = true;
    setOpen(false);
  }
  return (
    <HoverCard.Root
      open={open}
      openDelay={220}
      closeDelay={180}
      onOpenChange={(next) => {
        if (!next || !suppressed.current) setOpen(next);
      }}
    >
      <HoverCard.Trigger
        asChild
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") suppressed.current = false;
        }}
        onFocus={(event) => {
          if (touch.current) event.preventDefault();
          else suppressed.current = false;
        }}
        onBlur={() => {
          touch.current = false;
        }}
      >
        <PreviewButton
          type="button"
          className={className}
          aria-label={label}
          aria-describedby={open ? id : undefined}
          onPointerDownCapture={(event) => {
            touch.current = event.pointerType === "touch";
            if (touch.current) dismiss();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") dismiss();
          }}
          onClick={() => {
            dismiss();
            onCitation(citation);
          }}
        >
          {children}
        </PreviewButton>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          id={id}
          role="tooltip"
          aria-label={`来源预览：${title}`}
          className="citation-preview-card"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          sticky="always"
          onEscapeKeyDown={dismiss}
        >
          <strong className="citation-preview-title">{title}</strong>
          {snippet && <p className="citation-preview-snippet">{snippet}</p>}
          <div className="citation-preview-footer">
            <span className="citation-preview-format">
              <FileText size={13} strokeWidth={1.6} />
              {format}
            </span>
            {kbName && (
              <span className="citation-preview-library">@ {kbName}</span>
            )}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
