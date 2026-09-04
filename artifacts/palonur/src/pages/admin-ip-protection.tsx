import { useState, useEffect, useCallback } from "react";

const API_BASE = "/api";

const CARDINAL = "#8B1A1A";
const BORDER = "#e8e0e0";

interface ManifestRow {
  id: number;
  manifestHash: string;
  sourceCount: number;
  chunkCount: number;
  reason: string;
  createdAt: string;
}

interface CanaryRow {
  doi: string;
  title: string;
  token: string;
  seeded: boolean;
  sourceId: number | null;
  pillarId: number | null;
}

interface FingerprintRow {
  partnerKeyId: number;
  partnerName: string;
  revoked: boolean;
  markerCode: string;
  canaryVariant: number;
  canaryDoi: string | null;
  createdAt: string;
}

interface ProbeRow {
  id: number;
  label: string;
  prompt: string;
  targetKind: string;
  canaryDoi: string | null;
  expectedSignals: Array<{ type: string; note?: string }>;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

interface SessionRow {
  id: number;
  label: string;
  mode: string;
  stats: {
    probeCount: number;
    respondedCount: number;
    hitProbeCount: number;
    confidence: string;
    interpretation: string;
  };
  attribution: {
    best: { partnerName: string; partnerKeyId: number } | null;
    ambiguous: boolean;
    note: string;
  };
  createdAt: string;
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 20,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: "#8a7d7d",
  padding: "6px 10px",
  borderBottom: `1px solid ${BORDER}`,
};

const tdStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "8px 10px",
  borderBottom: `1px solid #f2ecec`,
  color: "#3d3333",
  verticalAlign: "top",
};

/**
 * Admin IP-protection panel: corpus manifest history, canary registry, and
 * per-licensee fingerprint assignments. Everything shown here (marker
 * codes, canary tokens) is admin-only and never serialized to public or
 * partner-facing endpoints.
 */
export default function IpProtectionPanel() {
  const [manifests, setManifests] = useState<ManifestRow[]>([]);
  const [canaries, setCanaries] = useState<CanaryRow[]>([]);
  const [fingerprints, setFingerprints] = useState<FingerprintRow[]>([]);
  const [probes, setProbes] = useState<ProbeRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [canaryDois, setCanaryDois] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, c, f, p, s] = await Promise.all([
        fetch(`${API_BASE}/admin/ip/manifests`, { credentials: "include" }),
        fetch(`${API_BASE}/admin/ip/canaries`, { credentials: "include" }),
        fetch(`${API_BASE}/admin/ip/fingerprints`, { credentials: "include" }),
        fetch(`${API_BASE}/admin/ip/probes`, { credentials: "include" }),
        fetch(`${API_BASE}/admin/ip/sessions`, { credentials: "include" }),
      ]);
      if (!m.ok || !c.ok || !f.ok || !p.ok || !s.ok) throw new Error("Failed to load");
      setManifests((await m.json()).manifests ?? []);
      setCanaries((await c.json()).canaries ?? []);
      setFingerprints((await f.json()).fingerprints ?? []);
      const pj = await p.json();
      setProbes(pj.probes ?? []);
      setCanaryDois(pj.canaryDois ?? []);
      setSessions((await s.json()).sessions ?? []);
    } catch {
      setError("Could not load IP-protection data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      await fetch(`${API_BASE}/admin/ip/manifests/generate`, {
        method: "POST",
        credentials: "include",
      });
      await load();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      <div style={{ ...cardStyle, background: "#fdf7ef", border: "1px solid #ecd9b8" }}>
        <div style={{ fontSize: 13, color: "#6b5636", lineHeight: 1.55 }}>
          <strong>Honest limits.</strong> Corpus manifests prove what Palonur&apos;s
          corpus contained at a given time. Canary documents and per-licensee
          zero-width markers are <em>statistical evidence</em> mechanisms: they
          are forgeable and strippable in principle and are never cryptographic
          proof that a third party copied the corpus. Treat any match as a
          signal that justifies further investigation, not as proof on its own.
        </div>
      </div>

      {error && <div style={{ color: CARDINAL, marginBottom: 16, fontSize: 13 }}>{error}</div>}
      {loading && <div style={{ fontSize: 13, color: "#8a7d7d" }}>Loading…</div>}

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424" }}>Corpus manifests</div>
          <button
            onClick={generate}
            disabled={generating}
            style={{
              background: CARDINAL, color: "#fff", border: "none", borderRadius: 8,
              padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              opacity: generating ? 0.6 : 1,
            }}
          >{generating ? "Checking…" : "Snapshot now"}</button>
        </div>
        <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
          Append-only, timestamped hash-of-hashes over all approved content
          (canaries included). A new row appears automatically whenever the
          corpus changes.
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={thStyle}>#</th><th style={thStyle}>When</th><th style={thStyle}>Reason</th>
            <th style={thStyle}>Sources</th><th style={thStyle}>Chunks</th>
            <th style={thStyle}>Manifest hash</th><th style={thStyle}></th>
          </tr></thead>
          <tbody>
            {manifests.map((m) => (
              <tr key={m.id}>
                <td style={tdStyle}>{m.id}</td>
                <td style={tdStyle}>{new Date(m.createdAt).toLocaleString()}</td>
                <td style={tdStyle}>{m.reason}</td>
                <td style={tdStyle}>{m.sourceCount}</td>
                <td style={tdStyle}>{m.chunkCount}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>
                  {m.manifestHash.slice(0, 16)}…
                </td>
                <td style={tdStyle}>
                  <a
                    href={`${API_BASE}/admin/ip/manifests/${m.id}/download`}
                    style={{ color: CARDINAL, fontSize: 12, fontWeight: 600 }}
                  >Download</a>
                </td>
              </tr>
            ))}
            {manifests.length === 0 && !loading && (
              <tr><td style={tdStyle} colSpan={7}>No manifests yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424", marginBottom: 6 }}>Canary registry</div>
        <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
          Synthetic, clearly non-clinical documents seeded alongside real
          knowledge. They appear in licensee-facing retrieval and corpus
          exports only — never in consumer answers, public citations, steward
          queues, or coverage statistics.
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={thStyle}>DOI</th><th style={thStyle}>Title</th>
            <th style={thStyle}>Token</th><th style={thStyle}>Status</th>
          </tr></thead>
          <tbody>
            {canaries.map((c) => (
              <tr key={c.doi}>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>{c.doi}</td>
                <td style={tdStyle}>{c.title}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>{c.token}</td>
                <td style={tdStyle}>{c.seeded ? "Seeded" : "Not seeded"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424", marginBottom: 6 }}>Licensee fingerprints</div>
        <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
          Each partner key carries a deterministic secret fingerprint: an
          invisible zero-width marker on keyed responses plus an assigned
          canary variant. First-party and consumer responses never carry
          either. Marker codes below are admin-only.
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={thStyle}>Key</th><th style={thStyle}>Partner</th>
            <th style={thStyle}>Marker code</th><th style={thStyle}>Canary variant</th>
            <th style={thStyle}>Status</th>
          </tr></thead>
          <tbody>
            {fingerprints.map((f) => (
              <tr key={f.partnerKeyId}>
                <td style={tdStyle}>#{f.partnerKeyId}</td>
                <td style={tdStyle}>{f.partnerName}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>{f.markerCode}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>
                  {f.canaryVariant}{f.canaryDoi ? ` (${f.canaryDoi})` : ""}
                </td>
                <td style={tdStyle}>{f.revoked ? "Revoked" : "Active"}</td>
              </tr>
            ))}
            {fingerprints.length === 0 && !loading && (
              <tr><td style={tdStyle} colSpan={5}>No partner keys yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ProbeLibrary probes={probes} canaryDois={canaryDois} onChanged={load} />
      <DetectionRunner probes={probes} onRan={load} />
      <SessionList sessions={sessions} loading={loading} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 13,
  marginBottom: 8,
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  background: CARDINAL,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const smallBtn: React.CSSProperties = {
  background: "none",
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
  color: "#3d3333",
};

function ProbeLibrary({
  probes,
  canaryDois,
  onChanged,
}: {
  probes: ProbeRow[];
  canaryDois: string[];
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [targetKind, setTargetKind] = useState("canary");
  const [canaryDoi, setCanaryDoi] = useState("");
  const [expectToken, setExpectToken] = useState(true);
  const [expectAssoc, setExpectAssoc] = useState(true);
  const [expectMarker, setExpectMarker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const expectedSignals = [
        ...(expectToken ? [{ type: "canary_token" }] : []),
        ...(expectAssoc ? [{ type: "fabricated_association" }] : []),
        ...(expectMarker ? [{ type: "zero_width_marker" }] : []),
      ];
      const r = await fetch(`${API_BASE}/admin/ip/probes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          prompt,
          targetKind,
          canaryDoi: canaryDoi || null,
          expectedSignals,
        }),
      });
      if (!r.ok) throw new Error();
      setLabel(""); setPrompt("");
      onChanged();
    } catch {
      setErr("Could not save probe.");
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (p: ProbeRow) => {
    await fetch(`${API_BASE}/admin/ip/probes/${p.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    });
    onChanged();
  };

  const remove = async (p: ProbeRow) => {
    if (!window.confirm(`Delete probe "${p.label}"?`)) return;
    await fetch(`${API_BASE}/admin/ip/probes/${p.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    onChanged();
  };

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424", marginBottom: 6 }}>
        Probe library (private)
      </div>
      <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
        Prompts designed to elicit canary content from an external RAG system or
        fine-tuned model. Admin-only — probes are never exposed on public or
        partner endpoints, so an external system cannot special-case them.
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14 }}>
        <thead><tr>
          <th style={thStyle}>Label</th><th style={thStyle}>Prompt</th>
          <th style={thStyle}>Target</th><th style={thStyle}>Expected signals</th>
          <th style={thStyle}>Status</th><th style={thStyle}></th>
        </tr></thead>
        <tbody>
          {probes.map((p) => (
            <tr key={p.id}>
              <td style={tdStyle}>{p.label}</td>
              <td style={{ ...tdStyle, maxWidth: 320 }}>{p.prompt}</td>
              <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 11 }}>
                {p.targetKind}{p.canaryDoi ? ` (${p.canaryDoi})` : ""}
              </td>
              <td style={{ ...tdStyle, fontSize: 11 }}>
                {(p.expectedSignals ?? []).map((s) => s.type).join(", ") || "—"}
              </td>
              <td style={tdStyle}>{p.active ? "Active" : "Inactive"}</td>
              <td style={tdStyle}>
                <button style={smallBtn} onClick={() => void toggleActive(p)}>
                  {p.active ? "Deactivate" : "Activate"}
                </button>{" "}
                <button style={{ ...smallBtn, color: CARDINAL }} onClick={() => void remove(p)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {probes.length === 0 && (
            <tr><td style={tdStyle} colSpan={6}>No probes yet — add one below.</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "#2c2424" }}>New probe</div>
        <input style={inputStyle} placeholder="Label (e.g. Veldanir cadence direct question)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <textarea style={{ ...inputStyle, minHeight: 60 }} placeholder='Prompt (e.g. "What is the tessel interval of the ostrelline sequence?")' value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <select style={{ ...inputStyle, width: "auto", marginBottom: 0 }} value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
            <option value="canary">canary</option>
            <option value="fingerprint">fingerprint</option>
            <option value="general">general</option>
          </select>
          <select style={{ ...inputStyle, width: "auto", marginBottom: 0 }} value={canaryDoi} onChange={(e) => setCanaryDoi(e.target.value)}>
            <option value="">No specific canary</option>
            {canaryDois.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={expectToken} onChange={(e) => setExpectToken(e.target.checked)} /> token</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={expectAssoc} onChange={(e) => setExpectAssoc(e.target.checked)} /> association</label>
          <label style={{ fontSize: 12 }}><input type="checkbox" checked={expectMarker} onChange={(e) => setExpectMarker(e.target.checked)} /> zero-width marker</label>
        </div>
        {err && <div style={{ color: CARDINAL, fontSize: 12, marginBottom: 8 }}>{err}</div>}
        <button style={{ ...btnStyle, opacity: busy || !label.trim() || !prompt.trim() ? 0.5 : 1 }} disabled={busy || !label.trim() || !prompt.trim()} onClick={() => void create()}>
          {busy ? "Saving…" : "Add probe"}
        </button>
      </div>
    </div>
  );
}

function DetectionRunner({ probes, onRan }: { probes: ProbeRow[]; onRan: () => void }) {
  const [mode, setMode] = useState<"endpoint" | "transcript">("transcript");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState('{"question": "{{prompt}}"}');
  const [responsePath, setResponsePath] = useState("");
  const [transcript, setTranscript] = useState("");
  const [transcriptProbeId, setTranscriptProbeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      let body: Record<string, unknown>;
      if (mode === "endpoint") {
        const headers: Record<string, string> = {};
        for (const line of headersText.split("\n")) {
          const i = line.indexOf(":");
          if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        body = { mode, label, url, headers, bodyTemplate, responsePath, probeIds: [] };
      } else {
        body = {
          mode,
          label,
          transcripts: [
            {
              probeId: transcriptProbeId ? Number(transcriptProbeId) : null,
              response: transcript,
            },
          ],
        };
      }
      const r = await fetch(`${API_BASE}/admin/ip/detect/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Run failed");
      setMsg(
        `Session #${j.session.id} recorded — confidence: ${j.session.stats.confidence}. ${j.session.stats.interpretation}`,
      );
      setTranscript("");
      onRan();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy(false);
    }
  };

  const canRun =
    label.trim().length > 0 &&
    (mode === "endpoint" ? url.trim().length > 0 : transcript.trim().length > 0);

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424", marginBottom: 6 }}>
        Run detection
      </div>
      <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
        Test an external system for corpus misuse: run the active probes against a
        configured HTTP endpoint, or paste a transcript captured elsewhere. Results
        are scored for canary tokens, fabricated associations, and per-licensee
        zero-width markers, then persisted as a timestamped session.
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
        <label style={{ fontSize: 13 }}>
          <input type="radio" checked={mode === "transcript"} onChange={() => setMode("transcript")} /> Paste transcript
        </label>
        <label style={{ fontSize: 13 }}>
          <input type="radio" checked={mode === "endpoint"} onChange={() => setMode("endpoint")} /> Live endpoint
        </label>
      </div>
      <input style={inputStyle} placeholder="Session label (e.g. Acme RAG spot-check, Aug 2026)" value={label} onChange={(e) => setLabel(e.target.value)} />
      {mode === "endpoint" ? (
        <>
          <input style={inputStyle} placeholder="Endpoint URL (POSTed with each probe prompt)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <textarea style={{ ...inputStyle, minHeight: 44 }} placeholder={"Headers, one per line (Name: value). Values are used for the run but never stored."} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          <input style={inputStyle} placeholder='Body template — {"question": "{{prompt}}"}' value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)} />
          <input style={inputStyle} placeholder="Response JSON path to answer text (e.g. answer or data.text; blank = raw body)" value={responsePath} onChange={(e) => setResponsePath(e.target.value)} />
          <div style={{ fontSize: 12, color: "#8a7d7d", marginBottom: 8 }}>
            Runs all active probes ({probes.filter((p) => p.active).length}).
          </div>
        </>
      ) : (
        <>
          <select style={{ ...inputStyle, width: "auto" }} value={transcriptProbeId} onChange={(e) => setTranscriptProbeId(e.target.value)}>
            <option value="">Not tied to a probe</option>
            {probes.map((p) => <option key={p.id} value={String(p.id)}>{p.label}</option>)}
          </select>
          <textarea style={{ ...inputStyle, minHeight: 100 }} placeholder="Paste the external model's response text here" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
        </>
      )}
      {msg && <div style={{ fontSize: 12.5, color: "#3d3333", background: "#f7f2ec", borderRadius: 8, padding: 10, marginBottom: 10 }}>{msg}</div>}
      <button style={{ ...btnStyle, opacity: busy || !canRun ? 0.5 : 1 }} disabled={busy || !canRun} onClick={() => void run()}>
        {busy ? "Running…" : "Run detection"}
      </button>
    </div>
  );
}

function SessionList({ sessions, loading }: { sessions: SessionRow[]; loading: boolean }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#2c2424", marginBottom: 6 }}>
        Detection sessions
      </div>
      <div style={{ fontSize: 12.5, color: "#8a7d7d", marginBottom: 12 }}>
        Persisted, timestamped runs. The evidence package bundles the corpus
        manifests, the suspected licensee&apos;s fingerprint specification, the
        triggered canary records, the session transcripts, and a methodology
        document with limitations stated honestly.
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={thStyle}>#</th><th style={thStyle}>When</th><th style={thStyle}>Label</th>
          <th style={thStyle}>Mode</th><th style={thStyle}>Probes / hits</th>
          <th style={thStyle}>Confidence</th><th style={thStyle}>Attribution</th>
          <th style={thStyle}></th>
        </tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td style={tdStyle}>{s.id}</td>
              <td style={tdStyle}>{new Date(s.createdAt).toLocaleString()}</td>
              <td style={tdStyle}>{s.label}</td>
              <td style={tdStyle}>{s.mode}</td>
              <td style={tdStyle}>{s.stats?.probeCount ?? 0} / {s.stats?.hitProbeCount ?? 0}</td>
              <td style={{ ...tdStyle, fontWeight: 600, color: s.stats?.confidence === "none" ? "#3d3333" : CARDINAL }}>
                {s.stats?.confidence ?? "—"}
              </td>
              <td style={{ ...tdStyle, maxWidth: 260 }}>
                {s.attribution?.best
                  ? `${s.attribution.best.partnerName} (key #${s.attribution.best.partnerKeyId})${s.attribution.ambiguous ? " — ambiguous" : ""}`
                  : s.attribution?.ambiguous
                    ? "Ambiguous — multiple licensees match"
                    : "—"}
              </td>
              <td style={tdStyle}>
                <a href={`${API_BASE}/admin/ip/sessions/${s.id}/evidence`} style={{ color: CARDINAL, fontSize: 12, fontWeight: 600 }}>
                  Evidence package
                </a>
              </td>
            </tr>
          ))}
          {sessions.length === 0 && !loading && (
            <tr><td style={tdStyle} colSpan={8}>No detection sessions yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
