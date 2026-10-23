import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../components/ui/button";

export function PdfNavigation({
  page,
  total,
  onPageChange,
}: {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const current = Math.max(1, Math.min(total || 1, page));
  return (
    <nav className="pdf-navigation" aria-label="PDF 页面导航">
      <Button
        variant="ghost"
        size="icon"
        aria-label="上一页"
        disabled={!total || current <= 1}
        onClick={() => onPageChange(current - 1)}
      >
        <ChevronLeft size={16} />
      </Button>
      <label>
        <span className="sr-only">PDF 页码</span>
        <input
          aria-label="PDF 页码"
          type="number"
          min={1}
          max={total || 1}
          disabled={!total}
          value={current}
          onChange={(event) =>
            onPageChange(
              Math.min(
                total || 1,
                Math.max(1, Number(event.target.value) || 1),
              ),
            )
          }
        />
      </label>
      <span className="muted">/ {total || "…"}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="下一页"
        disabled={!total || current >= total}
        onClick={() => onPageChange(current + 1)}
      >
        <ChevronRight size={16} />
      </Button>
    </nav>
  );
}
