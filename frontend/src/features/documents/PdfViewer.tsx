import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button } from "../../components/ui/button";
import { ErrorState, Loading } from "../../components/common";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfViewer({
  documentId,
  page,
  onPageChange,
}: {
  documentId: string;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState<unknown>(null);
  const [renderedPage, setRenderedPage] = useState(0);
  const [text, setText] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
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
        if (active) setDocument(value);
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
      void task.destroy().catch(() => undefined);
    };
  }, [documentId, attempt]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let task: RenderTask | undefined;
    const currentCanvas = canvas.current;
    const actualPage = Math.max(1, Math.min(document.numPages, page));
    setRenderedPage(0);
    setError(null);
    void (async () => {
      const source = await document.getPage(actualPage);
      if (!active) return;
      const base = source.getViewport({ scale: 1 });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.max(0.3, Math.min(1.6, (width - 24) / base.width));
      const viewport = source.getViewport({ scale: scale * pixelRatio });
      currentCanvas.width = Math.ceil(viewport.width);
      currentCanvas.height = Math.ceil(viewport.height);
      currentCanvas.style.width = `${viewport.width / pixelRatio}px`;
      currentCanvas.style.height = `${viewport.height / pixelRatio}px`;
      task = source.render({ canvas: currentCanvas, viewport });
      await task.promise;
      if (!active) return;
      const content = await source.getTextContent();
      if (active) {
        setText(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
        setRenderedPage(actualPage);
      }
    })().catch((e) => {
      if (active && !(e instanceof pdfjs.RenderingCancelledException))
        setError(e);
    });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, page, width]);
  const actualPage = document
    ? Math.max(1, Math.min(document.numPages, page))
    : page;
  return (
    <div className="pdf-viewer" ref={host}>
      <div className="pdf-controls">
        <div className="row gap">
          <Button
            size="sm"
            disabled={!document || actualPage <= 1}
            onClick={() => onPageChange(actualPage - 1)}
          >
            上一页
          </Button>
          <label>
            页码
            <input
              aria-label="PDF 页码"
              type="number"
              min={1}
              max={document?.numPages}
              value={actualPage}
              onChange={(e) =>
                onPageChange(Math.max(1, Number(e.target.value) || 1))
              }
            />
          </label>
          <span className="muted">/ {document?.numPages || "…"}</span>
          <Button
            size="sm"
            disabled={!document || actualPage >= document.numPages}
            onClick={() => onPageChange(actualPage + 1)}
          >
            下一页
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
