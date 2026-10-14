/** Measured layout evidence from a template document (see server/templates/template-layout.ts). */
export interface TemplateLayoutHints {
  pageSize: "letter" | "a4" | "unknown";
  marginsInches?: number;
  fonts: string[];
  baseSizePt?: number;
  headingSizesPt: number[];
  twoColumnsLikely: boolean;
  rightAlignedText: boolean;
  hasTables: boolean;
}
