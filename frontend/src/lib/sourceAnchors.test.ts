import { expect, it } from "vitest";
import { anchorText } from "./api";
import { matchesSourceAnchor } from "./sourceAnchors";

it("表格行号只在相同工作表内匹配，不能命中另一张表的相同行", () => {
  const target = { sheet_index: 2, sheet_name: "成本", row_start: 7 };
  expect(
    matchesSourceAnchor(
      { sheet_index: 1, sheet_name: "收入", row_start: 1, row_end: 20 },
      target,
    ),
  ).toBe(false);
  expect(
    matchesSourceAnchor(
      { sheet_index: 2, sheet_name: "成本", row_start: 1, row_end: 20 },
      target,
    ),
  ).toBe(true);
  expect(
    matchesSourceAnchor(
      { sheet_index: 2, sheet_name: "成本", row_start: 21, row_end: 40 },
      target,
    ),
  ).toBe(false);
});

it("EPUB章节内重复段号不串章，无锚点时不假造定位", () => {
  const target = {
    chapter_index: 3,
    chapter_title: "结论",
    paragraph_start: 2,
  };
  expect(
    matchesSourceAnchor(
      {
        chapter_index: 2,
        chapter_title: "引言",
        paragraph_start: 1,
        paragraph_end: 4,
      },
      target,
    ),
  ).toBe(false);
  expect(
    matchesSourceAnchor(
      {
        chapter_index: 3,
        chapter_title: "结论",
        paragraph_start: 1,
        paragraph_end: 4,
      },
      target,
    ),
  ).toBe(true);
  expect(matchesSourceAnchor({}, {})).toBe(false);
});

it("新格式显示真实幻灯片、工作表行、记录与章节位置", () => {
  const citation = { document_id: "doc", chunk_id: "chunk" };
  expect(
    anchorText({ ...citation, anchors: { slide_start: 2, slide_end: 2 } }),
  ).toBe("第 2 张幻灯片");
  expect(
    anchorText({
      ...citation,
      anchors: {
        sheet_name: "预算",
        sheet_index: 1,
        row_start: 41,
        row_end: 80,
      },
    }),
  ).toBe("工作表「预算」 · 第 41–80 行");
  expect(
    anchorText({ ...citation, anchors: { row_start: 3, row_end: 3 } }),
  ).toBe("第 3 行");
  expect(
    anchorText({ ...citation, anchors: { record_start: 10, record_end: 12 } }),
  ).toBe("第 10–12 条记录");
  expect(
    anchorText({
      ...citation,
      anchors: {
        chapter_index: 2,
        chapter_title: "方法",
        paragraph_start: 8,
        paragraph_end: 11,
      },
    }),
  ).toBe("章节「方法」 · 第 8–11 段");
});
