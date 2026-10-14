import { publicEnv } from "./env.public";

/** Static, browser-safe product metadata shared by layout, manifest and UI. */
export const siteConfig = {
  name: publicEnv.NEXT_PUBLIC_APP_NAME,
  shortName: "Marcus AI",
  description: "Format resumes to client templates from your phone or desktop.",
  /** Keep in sync with `--background` / `--primary` in globals.css. */
  themeColor: { light: "#000000", dark: "#000000" },
  brandColor: "#ec0a14",
} as const;
