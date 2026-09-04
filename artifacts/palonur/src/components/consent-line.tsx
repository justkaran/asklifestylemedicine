/**
 * Tiny shared consent line shown at signup / subscribe / checkout decision
 * points: "By continuing you agree to the Terms of Use and Privacy Policy."
 * Link-only — no backend involvement. Styling adapts via props so it fits
 * consumer pages.
 */
export function ConsentLine({
  action = "continuing",
  color = "#b3a3a3",
  linkColor,
  fontFamily,
  fontSize = 12,
  align = "center",
  style,
}: {
  action?: string;
  color?: string;
  linkColor?: string;
  fontFamily?: string;
  fontSize?: number;
  align?: "left" | "center";
  style?: React.CSSProperties;
}) {
  const link: React.CSSProperties = {
    color: linkColor ?? color,
    textDecoration: "underline",
    textUnderlineOffset: 2,
  };
  return (
    <p
      style={{
        fontSize,
        color,
        margin: 0,
        textAlign: align,
        lineHeight: 1.5,
        ...(fontFamily ? { fontFamily } : {}),
        ...style,
      }}
    >
      By {action} you agree to our{" "}
      <a href="/terms" target="_blank" rel="noopener" style={link}>
        Terms of Use
      </a>{" "}
      and{" "}
      <a href="/privacy" target="_blank" rel="noopener" style={link}>
        Privacy Policy
      </a>
      .
    </p>
  );
}
