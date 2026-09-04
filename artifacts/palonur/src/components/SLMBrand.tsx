export function SLMBrand({ size = "md" }: { size?: "sm" | "md" }) {
  const sc = size === "sm" ? 11 : 13;
  const lc = size === "sm" ? 10.5 : 12;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
      <span style={{
        color: "#8B1A1A",
        fontWeight: 700,
        fontSize: sc,
        fontFamily: "'Georgia', 'Times New Roman', serif",
        letterSpacing: "0.01em",
      }}>Stanford</span>
      <span style={{ color: "rgba(139,26,26,0.25)", fontSize: sc, lineHeight: 1 }}>|</span>
      <span style={{
        color: "#4a3333",
        fontSize: lc,
        fontFamily: "'Georgia', 'Times New Roman', serif",
        letterSpacing: "0.02em",
      }}>Lifestyle Medicine</span>
    </div>
  );
}
