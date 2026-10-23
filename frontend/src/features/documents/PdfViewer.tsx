import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button } from "../../components/ui/button";
import { ErrorState, Loading } from "../../components/common";
import { ZoomIn, ZoomOut } from "lucide-react";
import { PdfNavigation } from "./PdfNavigation";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfViewer({
  documentId,
  page,
  onPageChange,
  onPageCount,
  active = true,
}: {
  documentId: string;
  page: number;
  onPageChange: (page: number) => void;
  onPageCount?: (total: number) => void;
  active?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState<unknown>(null);
  const [renderedPage, setRenderedPage] = useState(0);
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const rendering = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0].contentRect.width > 0)
        setWidth(entries[0].contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setError(null);
    setDocument(null);
    setRenderedPage(0);
    const task = pdfjs.getDocument({
      url: `/api/documents/${documentId}/download?inline=true`,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    void task.promise
      .then((value) => {
        if (active) {
          setDocument(value);
          onPageCount?.(value.numPages);
        }
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
      void task.destroy().catch(() => undefined);
    };
  }, [documentId, attempt, onPageCount]);
  useEffect(() => {
    if (!document || !canvas.current || !active) return;
    let current = true;
    let task: RenderTask | undefined;
    const currentCanvas = canvas.current;
    const actualPage = Math.max(1, Math.min(document.numPages, page));
    setRenderedPage(0);
    setError(null);
    rendering.current = rendering.current
      .catch(() => undefined)
      .then(async () => {
        if (!current) return;
        const source = await document.getPage(actualPage);
        if (!current) return;
        const base = source.getViewport({ scale: 1 });
        const scale = Math.max(0.2, (width - 28) / base.width) * zoom;
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_000_000 / (base.width * base.height * scale * scale)),
        );
        const viewport = source.getViewport({ scale: scale * pixelRatio });
        currentCanvas.width = Math.ceil(viewport.width);
        currentCanvas.height = Math.ceil(viewport.height);
        currentCanvas.style.width = `${viewport.width / pixelRatio}px`;
        currentCanvas.style.height = `${viewport.height / pixelRatio}px`;
        task = source.render({ canvas: currentCanvas, viewport });
        await task.promise;
        if (!current) return;
        const content = await source.getTextContent();
        if (current) {
          setText(
            content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" "),
          );
          setRenderedPage(actualPage);
        }
      })
      .catch((e) => {
        if (current && !(e instanceof pdfjs.RenderingCancelledException))
          setError(e);
      });
    return () => {
      current = false;
      task?.cancel();
    };
  }, [document, page, width, zoom, active]);
  const actualPage = document
    ? Math.max(1, Math.min(document.numPages, page))
    : page;
  return (
    <div className="pdf-viewer" ref={host}>
      <div className="pdf-controls">
        <PdfNavigation
          page={actualPage}
          total={document?.numPages || 0}
          onPageChange={onPageChange}
        />
        <div className="pdf-zoom" aria-label="PDF 缩放">
          <Button
            variant="ghost"
            size="icon"
            aria-label="缩小页面"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            <ZoomOut size={15} />
          </Button>
          <button
            type="button"
            className="pdf-fit"
            onClick={() => setZoom(1)}
            title="恢复适应宽度"
          >
            {zoom === 1 ? "适应宽度" : `${Math.round(zoom * 100)}%`}
          </button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="放大页面"
            disabled={zoom >= 2.5}
            onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))}
          >
            <ZoomIn size={15} />
          </Button>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} retry={() => setAttempt((a) => a + 1)} />
      ) : (
        !renderedPage && <Loading />
      )}
      <div className="pdf-canvas-wrap">
        <canvas
          ref={canvas}
          className="pdf-canvas"
          aria-label={`PDF 第 ${actualPage} 页`}
          role="img"
          data-rendered-page={renderedPage || undefined}
          style={{ visibility: renderedPage ? "visible" : "hidden" }}
        />
      </div>
      <p className="sr-only" data-pdf-text={renderedPage || undefined}>
        {text}
      </p>
    </div>
  );
}
