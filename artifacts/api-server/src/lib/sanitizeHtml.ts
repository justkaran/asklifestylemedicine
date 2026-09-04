import sanitizeHtmlLib from "sanitize-html";

/**
 * Sanitize steward-authored newsletter HTML before it is rendered on the
 * anonymous public publication pages (`/p/:slug`, `/p/:slug/:issueId`).
 *
 * The public reading pages render this HTML with `dangerouslySetInnerHTML`, so
 * any `<script>`, inline event handler, or `javascript:` URL stored by a
 * (trusted-but-fallible) editor would otherwise execute in a visitor's browser.
 * We allow a small rich-text allowlist sufficient for newsletter prose and drop
 * everything else.
 */
export function sanitizeNewsletterHtml(html: string | null): string | null {
  if (html == null) return null;
  return sanitizeHtmlLib(html, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "figure",
      "figcaption",
      "span",
      "code",
      "pre",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https"],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform("a", {
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      }),
    },
  });
}
