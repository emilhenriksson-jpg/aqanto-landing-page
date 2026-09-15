/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** REST origin. Defaults to http://127.0.0.1:8787 (apps/rest). */
  readonly VITE_API_BASE?: string;
  /**
   * Keep screens on demo data when unset or anything other than `0`.
   * Set `VITE_USE_DEMO=0` to call the REST API.
   */
  readonly VITE_USE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
