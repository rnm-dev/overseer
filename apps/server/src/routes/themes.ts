import express from "express";
import { DEFAULT_THEME_ID, THEME_CATALOG, THEME_PACKAGE_FORMAT, renderThemeCss } from "../modules/themes/index.js";

export function themesRouter(): express.Router {
  const router = express.Router();
  router.get("/v1/themes", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    res.json({ format: THEME_PACKAGE_FORMAT, defaultThemeId: DEFAULT_THEME_ID, themes: THEME_CATALOG });
  });
  router.get("/v1/themes.css", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
    res.type("text/css").send(renderThemeCss());
  });
  return router;
}
