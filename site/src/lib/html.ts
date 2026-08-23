/** Escape untrusted text before interpolating it into an HTML string. */
export const escapeHtml = (value: unknown): string => String(value).replace(
  /[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
);
