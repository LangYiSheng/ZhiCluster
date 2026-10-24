import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionDraft } from "./useSessionDraft";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it("配额满但仍可读取旧存储时，清理已提交内存稿且不复活旧稿", () => {
  sessionStorage.setItem("quota", "older draft");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const mounted = renderHook(() => useSessionDraft("quota"));
  act(() => mounted.result.current[1]("submitted draft"));
  expect(mounted.result.current[0]).toBe("submitted draft");
  act(() => mounted.result.current[2]("quota", "submitted draft"));
  expect(mounted.result.current[0]).toBe("");
  expect(sessionStorage.getItem("quota")).toBeNull();
  mounted.unmount();
  expect(renderHook(() => useSessionDraft("quota")).result.current[0]).toBe("");
});

it("旧实例清理自己的提交值，保留新实例已持久化的不同草稿", () => {
  const first = renderHook(() => useSessionDraft("same"));
  act(() => first.result.current[1]("submitted"));
  const oldClear = first.result.current[2];
  first.unmount();
  const second = renderHook(() => useSessionDraft("same"));
  act(() => second.result.current[1]("new draft"));
  act(() => oldClear("same", "submitted"));
  expect(second.result.current[0]).toBe("new draft");
  expect(sessionStorage.getItem("same")).toBe("new draft");
});

it("失败写入的旧实例不能删除其他实例随后保存的新稿", () => {
  sessionStorage.setItem("quota-race", "older draft");
  const first = renderHook(() => useSessionDraft("quota-race"));
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  act(() => first.result.current[1]("submitted"));
  write.mockRestore();
  sessionStorage.setItem("quota-race", "new external draft");
  act(() => first.result.current[2]("quota-race", "submitted"));
  expect(first.result.current[0]).toBe("new external draft");
  expect(sessionStorage.getItem("quota-race")).toBe("new external draft");
});

it("配额满时迟到的完成回调保留当前实例的新内存稿", () => {
  sessionStorage.setItem("quota-newer", "older draft");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const mounted = renderHook(() => useSessionDraft("quota-newer"));
  act(() => mounted.result.current[1]("submitted"));
  act(() => mounted.result.current[1]("newer memory draft"));
  act(() => mounted.result.current[2]("quota-newer", "submitted"));
  expect(mounted.result.current[0]).toBe("newer memory draft");
});

it("新实例重新保存与旧存储相同的文本也不能被失败写入的旧回调删掉", () => {
  sessionStorage.setItem("quota-aba", "older");
  const first = renderHook(() => useSessionDraft("quota-aba"));
  const failed = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  act(() => first.result.current[1]("submitted"));
  const oldClear = first.result.current[2];
  first.unmount();
  failed.mockRestore();
  const second = renderHook(() => useSessionDraft("quota-aba"));
  act(() => second.result.current[1]("older"));
  act(() => oldClear("quota-aba", "submitted"));
  expect(sessionStorage.getItem("quota-aba")).toBe("older");
  second.unmount();
  expect(renderHook(() => useSessionDraft("quota-aba")).result.current[0]).toBe(
    "older",
  );
});

it("存储完全不可用时也只清理匹配的内存值", () => {
  for (const name of ["getItem", "setItem", "removeItem"] as const)
    vi.spyOn(Storage.prototype, name).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  const mounted = renderHook(() => useSessionDraft("blocked"));
  act(() => mounted.result.current[1]("submitted"));
  act(() => mounted.result.current[1]("newer"));
  act(() => mounted.result.current[2]("blocked", "submitted"));
  expect(mounted.result.current[0]).toBe("newer");
  act(() => mounted.result.current[2]("blocked", "newer"));
  expect(mounted.result.current[0]).toBe("");
});
