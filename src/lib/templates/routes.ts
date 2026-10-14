export const TEMPLATES_PATH = "/templates";
export const templatePath = (templateId: string) =>
  `${TEMPLATES_PATH}/${encodeURIComponent(templateId)}`;

export const TEMPLATES_API = "/api/templates";
export const templateApi = (templateId: string) =>
  `${TEMPLATES_API}/${encodeURIComponent(templateId)}`;
