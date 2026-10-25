import { api, ApiError, errorText } from "../../lib/api";
import type { Document } from "../../lib/api";
import type { UploadLimits } from "../../lib/documentFormats";

export type UploadItem = {
  document?: Document;
  filename?: string;
  status: string;
  message?: string;
};

type UploadOptions = {
  kbId: string;
  files: File[];
  policy: string;
  targetFolderId: string | null;
  limits?: UploadLimits;
  onProgress?: (items: UploadItem[]) => void;
};

const relativePaths = new WeakMap<File, string>();
const MIB = 1024 * 1024;
const DEFAULT_LIMITS: UploadLimits = {
  max_file_size_bytes: 50 * MIB,
  max_batch_size_bytes: 200 * MIB,
  // Older servers may not publish their configurable batch limits.
  max_batch_files: 1,
};

function relativePath(file: File) {
  return relativePaths.get(file) || file.webkitRelativePath || file.name;
}

async function readEntry(entry: FileSystemEntry, parent = ""): Promise<File[]> {
  const path = `${parent}${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    // Keep the browser's File intact; relative paths travel separately from
    // multipart filenames so nested files retain a valid API basename.
    relativePaths.set(file, path);
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: File[] = [];
  // Chromium may return at most 100 entries in one readEntries callback.
  for (;;) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!entries.length) return files;
    for (const child of entries)
      files.push(...(await readEntry(child, `${path}/`)));
  }
}

export function collectDroppedFiles(transfer: DataTransfer): Promise<File[]> {
  // DataTransfer is protected again after the event returns. Snapshot every
  // root handle and fallback File before any asynchronous traversal.
  const roots = Array.from(transfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry?.(),
      file: item.getAsFile?.(),
    }));
  const fallback = Array.from(transfer.files);
  if (!roots.length) return Promise.resolve(fallback);
  return (async () => {
    const files: File[] = [];
    for (const root of roots) {
      if (root.entry) {
        try {
          files.push(...(await readEntry(root.entry)));
        } catch {
          throw new Error(
            `无法读取「${root.entry.name}」中的文件，请确认文件仍可访问，或通过“本地文件夹”重新选择。`,
          );
        }
      } else if (root.file) files.push(root.file);
    }
    return files;
  })();
}

async function uploadBatch(options: UploadOptions) {
  const data = new FormData();
  options.files.forEach((file) => data.append("files", file, file.name));
  if (options.files.some((file) => relativePath(file) !== file.name))
    data.append(
      "relative_paths",
      JSON.stringify(options.files.map(relativePath)),
    );
  if (options.targetFolderId) data.append("folder_id", options.targetFolderId);
  data.append("duplicate_policy", options.policy);
  const result = await api<{ items: UploadItem[] }>(
    `/knowledge-bases/${options.kbId}/uploads`,
    { method: "POST", body: data },
  );
  return options.files.map((file, index) => ({
    ...(result.items[index] || {
      status: "error",
      message: "服务未返回此文件的上传结果，请重试。",
    }),
    filename: result.items[index]?.filename || file.name,
  }));
}

function uploadError(error: unknown) {
  if (error instanceof ApiError && error.status === 413)
    return "文件超过服务当前的上传大小限制，请缩小文件，或联系管理员检查上传限制。";
  if (error instanceof TypeError)
    return "文件读取或连接中断，请确认文件仍可访问、服务连接正常后重试。";
  return errorText(error);
}

export async function uploadDocuments(options: UploadOptions) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as (keyof UploadLimits)[]) {
    const value = options.limits?.[key];
    if (value && Number.isFinite(value) && value > 0)
      limits[key] = Math.floor(value);
  }
  const items: UploadItem[] = [];
  const report = (results: UploadItem[]) => {
    items.push(...results);
    options.onProgress?.([...items]);
  };
  async function submit(files: File[]) {
    try {
      report(await uploadBatch({ ...options, files }));
    } catch (error) {
      // These request rejections happen before accepting files. Do not retry
      // connection errors: the server may have already accepted that request.
      if (
        files.length > 1 &&
        error instanceof ApiError &&
        (error.status === 413 || error.code === "invalid_batch")
      ) {
        const middle = Math.ceil(files.length / 2);
        await submit(files.slice(0, middle));
        await submit(files.slice(middle));
      } else
        report(
          files.map((file) => ({
            filename: file.name,
            status: "error",
            message: uploadError(error),
          })),
        );
    }
  }
  let batch: File[] = [];
  let batchSize = 0;
  const flush = async () => {
    if (batch.length) await submit(batch);
    batch = [];
    batchSize = 0;
  };
  // Keep directory progress per file, including partial failures and retries.
  const directory = options.files.some(
    (file) => relativePath(file) !== file.name,
  );
  for (const file of options.files) {
    const limit = Math.min(
      limits.max_file_size_bytes,
      limits.max_batch_size_bytes,
    );
    if (file.size > limit) {
      await flush();
      report([
        {
          filename: file.name,
          status: "error",
          message: `文件大小超过 ${Number((limit / MIB).toFixed(2))} MB 限制，请缩小后重试。`,
        },
      ]);
      continue;
    }
    if (
      batch.length &&
      (directory ||
        batch.length >= limits.max_batch_files ||
        batchSize + file.size > limits.max_batch_size_bytes)
    )
      await flush();
    batch.push(file);
    batchSize += file.size;
  }
  await flush();
  return { items };
}
