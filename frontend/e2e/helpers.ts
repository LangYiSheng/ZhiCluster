import { expect, type APIRequestContext, type Page } from "@playwright/test";

export async function chooseOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

export async function waitForParsed(
  request: APIRequestContext,
  kbId: string,
  names: string[],
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/knowledge-bases/${kbId}/documents`,
        );
        const body = await response.json();
        return body.items?.filter(
          (doc: { display_name: string; parse_status: string }) =>
            names.includes(doc.display_name) && doc.parse_status === "ready",
        ).length;
      },
      { timeout: 30000 },
    )
    .toBe(names.length);
}
