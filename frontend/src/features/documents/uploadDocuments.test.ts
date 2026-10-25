import { afterEach, expect, it, vi } from "vitest";
import { collectDroppedFiles, uploadDocuments } from "./uploadDocuments";

afterEach(() => vi.unstubAllGlobals());
const MIB = 1024 * 1024;
const defaults = { kbId: "kb", policy: "skip", targetFolderId: "target" };
const limits = {
  max_file_size_bytes: 50 * MIB,
  max_batch_size_bytes: 200 * MIB,
  max_batch_files: 20,
};
function file(name: string, size = 1) {
  const result = new File([name], name, { type: "text/plain" });
  Object.defineProperty(result, "size", { value: size });
  return result;
}
function mockUpload(
  handler?: (files: File[], body: FormData) => Response | Promise<Response>,
) {
  const requests: FormData[] = [];
  const fetch = vi.fn(async (_: string, init: RequestInit) => {
    const body = init.body as FormData;
    requests.push(body);
    const files = body.getAll("files") as File[];
    return handler
      ? handler(files, body)
      : new Response(
          JSON.stringify({ items: files.map(() => ({ status: "queued" })) }),
        );
  });
  vi.stubGlobal("fetch", fetch);
  return { requests, fetch };
}

it("35个普通文件按服务数量上限分批，结果顺序与目标目录保持一致", async () => {
  const { requests } = mockUpload();
  const files = Array.from({ length: 35 }, (_, i) => file(`${i}.txt`));
  const { items } = await uploadDocuments({ ...defaults, files, limits });
  expect(requests.map((body) => body.getAll("files").length)).toEqual([20, 15]);
  expect(requests.every((body) => body.get("folder_id") === "target")).toBe(
    true,
  );
  expect(items.map((item) => item.filename)).toEqual(files.map((f) => f.name));
  expect(items.every((item) => item.status === "queued")).toBe(true);
});

it("目录能力接口未返回时，普通文件也保守逐件发送", async () => {
  const { requests } = mockUpload();
  const files = [file("a.txt"), file("b.txt"), file("c.txt")];
  const { items } = await uploadDocuments({ ...defaults, files });
  expect(requests.map((body) => body.getAll("files").length)).toEqual([
    1, 1, 1,
  ]);
  expect(items).toHaveLength(3);
});

it("按总字节拆批，单文件超限不阻塞之后的合法文件", async () => {
  const { requests } = mockUpload();
  const files = [
    file("one.txt", 9 * MIB),
    file("two.txt", 9 * MIB),
    file("too-large.txt", 51 * MIB),
    file("three.txt", 9 * MIB),
    file("four.txt", 9 * MIB),
    file("five.txt", 9 * MIB),
  ];
  const { items } = await uploadDocuments({
    ...defaults,
    files,
    limits: { ...limits, max_batch_size_bytes: 20 * MIB },
  });
  expect(requests.map((body) => body.getAll("files").length)).toEqual([
    2, 2, 1,
  ]);
  expect(items.map((item) => item.filename)).toEqual(files.map((f) => f.name));
  expect(items[2]).toMatchObject({
    status: "error",
    message: expect.stringContaining("20 MB"),
  });
  expect(items.at(-1)?.status).toBe("queued");
});

it("入口413递归拆小批次，单件413有可读原因且不丢其它结果", async () => {
  const { requests } = mockUpload((files) =>
    files.length > 1 || files[0].name === "blocked.txt"
      ? new Response("<html>too large</html>", { status: 413 })
      : new Response(JSON.stringify({ items: [{ status: "queued" }] })),
  );
  const { items } = await uploadDocuments({
    ...defaults,
    files: [file("a.txt"), file("blocked.txt"), file("c.txt")],
    limits,
  });
  expect(requests.map((body) => body.getAll("files").length)).toEqual([
    3, 2, 1, 1, 1,
  ]);
  expect(items.map((item) => item.status)).toEqual([
    "queued",
    "error",
    "queued",
  ]);
  expect(items[1].message).toContain("大小限制");
});

it("网络失败不自动重发可能已经入库的文件，之后批次仍可上传", async () => {
  const { fetch } = mockUpload((files) => {
    if (files[0].name === "a.txt") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ items: [{ status: "queued" }] }));
  });
  const { items } = await uploadDocuments({
    ...defaults,
    files: [file("a.txt"), file("b.txt"), file("c.txt")],
    limits: { ...limits, max_batch_files: 2 },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(items.map((item) => item.status)).toEqual([
    "error",
    "error",
    "queued",
  ]);
  expect(items[0].message).toContain("文件读取或连接中断");
});

function fileEntry(value: File) {
  return {
    name: value.name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: File) => void) =>
      queueMicrotask(() => resolve(value)),
  } as unknown as FileSystemFileEntry;
}
function directoryEntry(name: string, batches: FileSystemEntry[][]) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          queueMicrotask(() => resolve(batches[index++] || [])),
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

it("同步捕获所有原生目录入口，递归读取超过100项并保留相对路径及纯文件名", async () => {
  const entries = Array.from({ length: 103 }, (_, i) =>
    fileEntry(file(`${i}.txt`)),
  );
  const folder = directoryEntry("本地资料", [
    entries.slice(0, 100),
    [
      ...entries.slice(100),
      directoryEntry("附件", [[fileEntry(file("说明.txt"))]]),
    ],
  ]);
  let protectedMode = false;
  const roots = [folder, fileEntry(file("松散.txt"))];
  const transfer = {
    items: roots.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => {
        if (protectedMode) throw new Error("DataTransfer已保护");
        return entry;
      },
      getAsFile: () => null,
    })),
    files: [],
  } as unknown as DataTransfer;
  const pending = collectDroppedFiles(transfer);
  protectedMode = true;
  const files = await pending;
  expect(files).toHaveLength(105);
  const { requests } = mockUpload();
  await uploadDocuments({ ...defaults, files, limits });
  const nested = requests[103];
  expect(nested.get("relative_paths")).toBe('["本地资料/附件/说明.txt"]');
  expect((nested.get("files") as File).name).toBe("说明.txt");
  expect((requests[104].get("files") as File).name).toBe("松散.txt");
});

it("目录读取失败提供文件夹提示，而不是上传目录伪文件", async () => {
  const entry = {
    name: "失效目录",
    isDirectory: true,
    createReader: () => ({
      readEntries: (_: unknown, reject: (error: Error) => void) =>
        reject(new Error("access denied")),
    }),
  };
  const transfer = {
    items: [{ kind: "file", webkitGetAsEntry: () => entry }],
    files: [file("失效目录")],
  } as unknown as DataTransfer;
  await expect(collectDroppedFiles(transfer)).rejects.toThrow(
    "无法读取「失效目录」",
  );
});
