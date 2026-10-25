export type SourceAnchors = Record<string, number | string>;

export function anchorNumber(
  anchors: SourceAnchors | undefined,
  key: string,
): number | undefined {
  const value = anchors?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Source ranges are meaningful only within their sheet or EPUB chapter. */
export function matchesSourceAnchor(
  source: SourceAnchors,
  target: SourceAnchors,
): boolean {
  let contextual = false;
  for (const key of [
    "sheet_index",
    "sheet_name",
    "chapter_index",
    "chapter_title",
    "chapter_path",
  ]) {
    if (target[key] !== undefined) {
      if (source[key] !== target[key]) return false;
      contextual = true;
    }
  }
  for (const kind of ["slide", "row", "record", "page", "paragraph", "line"]) {
    const value = anchorNumber(target, `${kind}_start`);
    if (value !== undefined) {
      const from = anchorNumber(source, `${kind}_start`);
      const to = anchorNumber(source, `${kind}_end`) ?? from;
      return (
        from !== undefined && to !== undefined && from <= value && to >= value
      );
    }
  }
  return contextual;
}

export function hasSourceAnchor(anchors: SourceAnchors): boolean {
  return [
    "sheet_index",
    "sheet_name",
    "chapter_index",
    "chapter_title",
    "chapter_path",
    "slide_start",
    "row_start",
    "record_start",
    "page_start",
    "paragraph_start",
    "line_start",
  ].some((key) => anchors[key] !== undefined);
}
