// src/logoSrc.js
const API = (import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api").replace(/\/+$/, "");

// e.g. "https://api.dalyell.com.au/api"  -> "https://api.dalyell.com.au"
const API_ORIGIN = API.replace(/\/api$/, "");

/**
 * If branding.logo_url is absolute (starts with http), use it.
 * If it's relative (e.g., "/uploads/abc.png"), prefix with API origin.
 */
export function logoSrc(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `${API_ORIGIN}${url}`;
}
