import { DEFAULT_APP_NAME } from "@open-inspect/shared/app-name";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;

/** Lowercase, hyphenated form of APP_NAME for example identifiers such as labels. */
export const APP_NAME_SLUG = APP_NAME.toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const DEFAULT_FAVICON_URL = "/favicon.ico";

export const APP_ICON_URL = process.env.NEXT_PUBLIC_APP_ICON_URL?.trim() || "";
export const APP_FAVICON_URL = APP_ICON_URL || DEFAULT_FAVICON_URL;
