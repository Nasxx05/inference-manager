/**
 * Optional references: an image or a website URL the user supplies alongside
 * their task.
 *
 * A reference answers "what should the result look like?" — never "what does
 * the user want?". The task text stays authoritative for intent; a reference
 * only adds design and structure understanding.
 *
 * `references: []` is always valid. Text-only requests never touch this code.
 */

/** Supported reference kinds. Video is deliberately absent. */
export type ReferenceType = "image" | "website";

/** Image types accepted. Anything else is rejected before it is read. */
export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Extensions accepted, matched case-insensitively alongside the MIME type. */
export const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;

/** Hard ceiling per image. Bounds memory and provider cost. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Hard ceiling on references per request. Prevents dozens of huge inputs. */
export const MAX_REFERENCES = 4;

export interface ImageReferenceInput {
  type: "image";
  /** Validated MIME type, always one of SUPPORTED_IMAGE_TYPES. */
  mimeType: SupportedImageType;
  /** Raw image bytes, base64-encoded, with no `data:` prefix. */
  base64: string;
  /** Sanitised original filename. Display only; never used as a path. */
  filename?: string;
}

export interface WebsiteReferenceInput {
  type: "website";
  /** Normalised http(s) URL that has already passed SSRF validation. */
  url: string;
}

export type ReferenceInput = ImageReferenceInput | WebsiteReferenceInput;

/** Structured layout observations. Every field optional: uncertainty is real. */
export interface ReferenceLayout {
  navigation?: string;
  hero?: string;
  sections?: string;
  footer?: string;
}

export interface ReferenceVisualStyle {
  colors: string[];
  typography?: string;
  spacing?: string;
  borders?: string;
  imagery?: string;
}

/**
 * One reference, understood.
 *
 * `uncertainties` is not decoration: visual interpretation is an AI analysis,
 * so anything the model could not determine confidently is recorded there
 * rather than invented.
 */
export interface ReferenceAnalysis {
  /** Stable within a request: `ref:image:0`, `ref:website:0`. */
  id: string;
  type: ReferenceType;
  /** What kind of thing was analysed, e.g. "visual_web_reference". */
  kind: string;
  summary: string;
  layout: ReferenceLayout;
  visualStyle: ReferenceVisualStyle;
  components: string[];
  interactions: string[];
  responsiveObservations: string[];
  notablePatterns: string[];
  uncertainties: string[];
  /**
   * True only when the analysis was derived from actual pixels — an uploaded
   * image, or a rendered screenshot. False for text/DOM-only inspection, which
   * cannot honestly judge visual style. Never set optimistically.
   */
  visual: boolean;
  /** How the analysis was produced, so the UI can state it plainly. */
  source: string;
}

/**
 * Workload a reference adds to planning.
 *
 * Deliberately small and transparent: references add planning work, they do
 * not become a second cost engine.
 */
export interface ReferenceWorkload {
  /** Extra distinct requirements implied by the references. */
  addedRequirements: number;
  /** Multiplier applied to the effort score. 1 means no change. */
  effortMultiplier: number;
  /** Human-readable driver, shown by the UI only when references exist. */
  driver: string;
}

/** Empty, valid workload for text-only requests. */
export const NO_REFERENCE_WORKLOAD: ReferenceWorkload = {
  addedRequirements: 0,
  effortMultiplier: 1,
  driver: "",
};