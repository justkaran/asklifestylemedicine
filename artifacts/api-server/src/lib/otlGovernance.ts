import pool from "./db.js";
import { logger } from "./logger.js";

/**
 * The Governance & Accountability page appended to the OTL brief.
 *
 * The otl_doc DB snapshot is the authoritative render source for otl.html
 * (the static file is only the reset fallback), so a page added to the static
 * file must ALSO be appended to the existing DB snapshot or nobody ever sees
 * it. This mirrors the section added to artifacts/palonur/public/otl.html —
 * keep the two in sync when editing.
 *
 * The `data-gov-page` marker attribute is the idempotency key: the append
 * runs only when no page in the snapshot carries it, so boot re-runs and a
 * steward's later edits are never clobbered.
 */
export const OTL_GOVERNANCE_PAGE_HTML = `<section class="page" data-card data-gov-page="governance-accountability">
  <button class="delete-btn" onclick="deletePage(this)">×</button>
  <div class="page-header"><span>Governance &amp; accountability</span><span>Who stands behind every answer</span></div>
  <h2>Who decides what the system may say — and who answers for it.</h2>
  <p class="lead">Every answer traces to a named Stanford faculty steward's approval. This page states plainly where authority comes from, what the system is allowed to claim, how information is controlled, and who is accountable when it speaks.</p>

  <div class="grid-2" style="margin-top:14px">
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">Authority source</div>
      <ul class="checklist always">
        <li>Named faculty stewards are the sole source of authority: nothing is served unless a steward approved both the source and the interpretation of it.</li>
        <li>Approval is recorded per item — who approved it, and when — and is revocable; unapproved or retired material drops out of retrieval immediately.</li>
        <li>Palonur engineering has no editorial override: the company cannot add or alter claims.</li>
      </ul>
    </div>
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">Allowed claims</div>
      <ul class="checklist always">
        <li>The system may state only what appears in steward-approved material; each covered answer carries a citation to the underlying work.</li>
        <li>A citation guard checks every cited answer against the retrieved provenance; an unverifiable citation is flagged and its source strip is suppressed.</li>
        <li>Outside the approved corpus the system says so plainly or refuses — it never improvises an answer.</li>
      </ul>
    </div>
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">Information control</div>
      <ul class="checklist always">
        <li>The governed corpus lives in Palonur's database; only the minimal excerpts needed for one answer cross to the model provider, under no-training inference terms.</li>
        <li>Private surfaces — this brief, the dashboards — are gated on the server, and the gates fail closed when unconfigured.</li>
        <li>User data is never sold and never used to train models.</li>
      </ul>
    </div>
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">Accountability</div>
      <ul class="checklist always">
        <li>Every question, answer, citation-check outcome, and steward approval is logged, so any answer can be reconstructed after the fact.</li>
        <li>Access to governance surfaces is audited — including who opened this brief, and when.</li>
        <li>A named human answers for each layer: the steward for content, Palonur for operating the platform — <span contenteditable="false">karan@palonur.com</span>.</li>
      </ul>
    </div>
  </div>
  <p class="caption">This statement is mirrored as a live Governance view in Palonur's internal admin console, so what we state here matches what operators see day to day.</p>
  <div class="page-footer"><span>Confidential — prepared for Stanford OTL</span><span>palonur.com</span></div>
</section>`;

/**
 * Security review package pointer appended to the OTL brief. Same contract as
 * the governance page above: mirrored in artifacts/palonur/public/otl.html
 * (keep both in sync), appended to the DB snapshot once, idempotent via the
 * `data-secpkg-page` marker so steward edits are never clobbered.
 */
export const OTL_SECURITY_PACKAGE_PAGE_HTML = `<section class="page" data-card data-secpkg-page="security-review-package">
  <button class="delete-btn" onclick="deletePage(this)">×</button>
  <div class="page-header"><span>Security review</span><span>Written package for IT reviewers</span></div>
  <h2>A written IT security review package exists — threat model, data flows, compliance posture.</h2>
  <p class="lead">For Stanford Medicine IT's governance and security review, the claims summarized in this brief are backed by a structured written package maintained alongside the codebase. Request it from <span contenteditable="false">karan@palonur.com</span>.</p>
  <div class="grid-2" style="margin-top:14px">
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">What the package contains</div>
      <ul>
        <li><strong>Threat model</strong> — assets, trust boundaries, STRIDE-style threats, mitigations with code-level pointers, and an honest accepted-risks list.</li>
        <li><strong>Data-flow inventory, per surface</strong> — every external provider that receives user or research data, what crosses, and when. The asklifestylemedicine.com answer path is documented separately: in-house embeddings and Anthropic Claude only.</li>
        <li><strong>Compliance posture</strong> — no SOC 2 today; infrastructure attestations inherited via Replit on AWS; application controls documented in the package, structured to answer a HECVAT Lite questionnaire.</li>
        <li><strong>One-page posture summary</strong> — authentication, authorization, audit logging, secrets, prompt-injection defenses, and named remediation items.</li>
      </ul>
    </div>
    <div class="card" data-card>
      <button class="delete-btn" onclick="deleteCard(this)">×</button>
      <div class="label">Honest by design</div>
      <ul>
        <li>Known gaps are listed as gaps — shared-password admin, in-memory rate limits, and the observe-only advice guard are documented, not glossed over.</li>
        <li>The same honest-claims rules as this brief apply: provider no-training is a contractual posture, and no zero-retention or "corpus never leaves" claims are made.</li>
        <li>Every claim in the package points at the file in the codebase that implements it.</li>
      </ul>
    </div>
  </div>
  <p class="caption">Package files: threat_model.md, data-flow-inventory.md, compliance-posture.md, security-posture-summary.md — kept in the repository so the code and its review documents cannot drift apart.</p>
  <div class="page-footer"><span>Confidential — prepared for Stanford OTL</span><span>palonur.com</span></div>
</section>`;

/**
 * Append the security-package pointer page to the existing otl_doc snapshot,
 * once. Same narrow, best-effort semantics as ensureOtlGovernancePage.
 */
export async function ensureOtlSecurityPackagePage(): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE otl_doc
          SET content = content || jsonb_build_array($1::text),
              updated_at = NOW()
        WHERE id = 'otl'
          AND jsonb_typeof(content) = 'array'
          AND jsonb_array_length(content) > 0
          AND content::text NOT LIKE '%data-secpkg-page%'`,
      [OTL_SECURITY_PACKAGE_PAGE_HTML],
    );
    if ((result.rowCount ?? 0) > 0) {
      logger.info("OTL brief: security review package page appended to DB snapshot");
    }
  } catch (err) {
    logger.error({ err }, "OTL brief: security package page append failed");
  }
}

/**
 * Append the governance page to the existing otl_doc snapshot, once.
 *
 * Deliberately narrow: only touches a row that already EXISTS with non-empty
 * content (a fresh DB has no snapshot — the static file, which already
 * carries the page, becomes the initial content on first save), and only when
 * the marker is absent. Best-effort: failures are logged, never thrown.
 */
export async function ensureOtlGovernancePage(): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE otl_doc
          SET content = content || jsonb_build_array($1::text),
              updated_at = NOW()
        WHERE id = 'otl'
          AND jsonb_typeof(content) = 'array'
          AND jsonb_array_length(content) > 0
          AND content::text NOT LIKE '%data-gov-page%'`,
      [OTL_GOVERNANCE_PAGE_HTML],
    );
    if ((result.rowCount ?? 0) > 0) {
      logger.info("OTL brief: governance page appended to DB snapshot");
    }
  } catch (err) {
    logger.error({ err }, "OTL brief: governance page append failed");
  }
}
