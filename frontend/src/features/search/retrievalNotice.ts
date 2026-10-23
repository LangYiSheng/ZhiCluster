/** Keep actionable service notices, leaving ranking internals out of the UI. */
export function retrievalNotice(notice?: string) {
  const messages = (notice || "").split(/[；;\n]+/).flatMap((part) => {
    const text = part.trim();
    if (
      !text ||
      /^(关键词搜索|仅关键词搜索|混合检索)$/.test(text) ||
      /^关键词\s*\+\s*当前模型精确\s*cosine\s*检索(?:，复合问题分路融合)?$/i.test(
        text,
      )
    )
      return [];
    const reason = text.replace(/^仅关键词搜索[:：]\s*/, "");
    if (/未配置\s*Embedding\s*服务/i.test(reason))
      return ["尚未配置向量模型，可前往设置连接。"];
    if (/当前模型尚未向量化/.test(reason))
      return ["文档尚未建立当前模型的索引，请在设置中重建索引。"];
    return [reason];
  });
  return [...new Set(messages)].join("；").replace(/。；/g, "。") || null;
}
