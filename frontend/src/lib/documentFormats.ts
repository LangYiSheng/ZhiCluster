import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type DocumentFormat = {
  extension: string;
  label: string;
  mime_type: string;
  preview: "pdf" | "text";
  available: boolean;
  reason?: string | null;
};

export type UploadLimits = {
  max_file_size_bytes: number;
  max_batch_size_bytes: number;
  max_batch_files: number;
};

// This conservative initial state also keeps the existing four-format server
// usable while its capability request is pending or unavailable.
const INITIAL_FORMATS: DocumentFormat[] = [
  {
    extension: "pdf",
    label: "PDF",
    mime_type: "application/pdf",
    preview: "pdf",
    available: true,
  },
  {
    extension: "docx",
    label: "DOCX",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    preview: "text",
    available: true,
  },
  {
    extension: "md",
    label: "Markdown",
    mime_type: "text/markdown",
    preview: "text",
    available: true,
  },
  {
    extension: "txt",
    label: "TXT",
    mime_type: "text/plain",
    preview: "text",
    available: true,
  },
];

export function useDocumentFormats(enabled = true) {
  const catalog = useQuery({
    queryKey: ["document-formats"],
    queryFn: () =>
      api<{ formats: DocumentFormat[]; limits?: UploadLimits }>(
        "/settings/file-formats",
      ),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  const formats = Array.isArray(catalog.data?.formats)
    ? catalog.data.formats.filter((format) =>
        /^[a-z0-9]+$/.test(format.extension),
      )
    : INITIAL_FORMATS;
  const available = formats.filter((format) => format.available);
  return {
    formats,
    limits: catalog.data?.limits,
    accept: available.map((format) => `.${format.extension}`).join(","),
    unavailable: formats.filter((format) => !format.available),
    loading: catalog.isPending && catalog.isFetching,
    error: catalog.error,
  };
}
