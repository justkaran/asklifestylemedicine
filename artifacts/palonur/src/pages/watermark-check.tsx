import { useState } from "react";
import { extractPalonurWatermark } from "@/lib/watermark";

// Private checker: paste any text and see whether it carries the invisible
// Palonur signature. Not linked from anywhere; direct URL only.
export default function WatermarkCheck() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null | undefined>(undefined);

  const check = () => setResult(extractPalonurWatermark(text));

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px", fontFamily: "Georgia, serif" }}>
      <h1 style={{ fontSize: 26, marginBottom: 8 }}>Palonur text check</h1>
      <p style={{ color: "#555", fontSize: 15, lineHeight: 1.5 }}>
        Paste text below to see whether it carries the invisible Palonur
        signature. The signature only survives verbatim copy and paste, so a
        clean result does not prove the text is not ours.
      </p>
      <textarea
        data-testid="input-watermark-text"
        value={text}
        onChange={(e) => { setText(e.target.value); setResult(undefined); }}
        placeholder="Paste text here"
        rows={10}
        style={{ width: "100%", marginTop: 16, padding: 12, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, fontFamily: "inherit" }}
      />
      <button
        data-testid="button-check-watermark"
        onClick={check}
        style={{ marginTop: 12, padding: "10px 22px", background: "#8C1515", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, cursor: "pointer" }}
      >
        Check
      </button>
      {result !== undefined && (
        <div
          data-testid="text-watermark-result"
          style={{ marginTop: 20, padding: 16, borderRadius: 8, background: result ? "#f3f9f3" : "#faf6ef", border: `1px solid ${result ? "#9dbf9d" : "#d9c9a3"}` }}
        >
          {result ? (
            <>
              <strong>Palonur marker found.</strong>
              <div style={{ marginTop: 6, fontSize: 14, color: "#333" }}>Marker: <code>{result}</code></div>
              <div style={{ marginTop: 6, fontSize: 13, color: "#555" }}>
                This is a strong hint the text was copied from Palonur, not cryptographic proof: the marker is technically forgeable by someone who knows the scheme.
              </div>
            </>
          ) : (
            <>
              <strong>No Palonur signature found.</strong>
              <div style={{ marginTop: 6, fontSize: 14, color: "#555" }}>
                The text may have been retyped, paraphrased, or cleaned. Absence of the signature is not proof of origin either way.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
