import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ensureCaptureLoopSchema } from "./testHelpers.js";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "research-exclusion-test";
});

let signedInUserId = 0;
vi.mock("../middlewares/facultyAuth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../middlewares/facultyAuth.js")>(
      "../middlewares/facultyAuth.js",
    );
  const { db, facultyMembershipsTable, facultyUsersTable } = await import(
    "@workspace/db"
  );
  const { eq } = await import("drizzle-orm");
  return {
    ...actual,
    requireFacultyAuth: async (
      req: { faculty?: unknown },
      res: { status: (n: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const [user] = await db
        .select()
        .from(facultyUsersTable)
        .where(eq(facultyUsersTable.id, signedInUserId));
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const memberships = await db
        .select()
        .from(facultyMembershipsTable)
        .where(eq(facultyMembershipsTable.userId, user.id));
      req.faculty = { user, memberships };
      next();
    },
  };
});

vi.mock("../lib/embeddings.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/embeddings.js")>(
      "../lib/embeddings.js",
    );
  return {
    ...actual,
    embedTexts: async (texts: string[]) =>
      texts.map(() => Array(actual.EMBEDDING_DIMENSIONS).fill(0.01)),
  };
});

import request from "supertest";
import app from "../app.js";
import pool from "../lib/db.js";

const stamp = Date.now().toString(36);
const discoveredDoi = `10.5555/excluded-${stamp}`;
let pillarId = 0;
let sourceId = 0;
let stewardId = 0;
let contributorId = 0;
let runId = 0;

beforeAll(async () => {
  await ensureCaptureLoopSchema();
  const pillar = await pool.query<{ id: number }>(
    `INSERT INTO pillars (slug, name) VALUES ($1, 'Exclusion Test') RETURNING id`,
    [`discovery-exclusion-${stamp}`],
  );
  pillarId = pillar.rows[0].id;
  const users = await pool.query<{ id: number }>(
    `INSERT INTO faculty_users (clerk_user_id, email, full_name)
     VALUES ($1, $2, 'Exclusion Steward'), ($3, $4, 'Exclusion Contributor')
     RETURNING id`,
    [
      `exclude-steward-${stamp}`,
      `exclude-steward-${stamp}@example.com`,
      `exclude-contributor-${stamp}`,
      `exclude-contributor-${stamp}@example.com`,
    ],
  );
  stewardId = users.rows[0].id;
  contributorId = users.rows[1].id;
  await pool.query(
    `INSERT INTO faculty_memberships (user_id, pillar_id, role)
     VALUES ($1, $3, 'steward'), ($2, $3, 'contributor')`,
    [stewardId, contributorId, pillarId],
  );
  const source = await pool.query<{ id: number }>(
    `INSERT INTO sources
       (pillar_id, kind, title, abstract, full_text, rights_basis,
        retention_status, status, uploaded_by_user_id)
     VALUES ($1, 'paper', 'Discovered paper', 'abstract', 'temporary text',
              'no_documented_full_text_rights', 'review_window', 'approved', $2)
     RETURNING id`,
    [pillarId, stewardId],
  );
  sourceId = source.rows[0].id;
  const run = await pool.query<{ id: number }>(
    `INSERT INTO research_discovery_runs
       (faculty_user_id, pillar_id, started_by_user_id, faculty_name,
        pillar_topic, status)
     VALUES ($1, $2, $1, 'Exclusion Steward', 'test', 'done')
     RETURNING id`,
    [stewardId, pillarId],
  );
  runId = run.rows[0].id;
  await pool.query(
    `INSERT INTO research_discovery_candidates
       (discovery_run_id, pillar_id, provider, provider_id, doi, title, status,
         source_id)
      VALUES ($1, $2, 'crossref', $3, $4, 'Discovered paper', 'auto_approved', $5)`,
    [runId, pillarId, `exclude-provider-${stamp}`, discoveredDoi, sourceId],
  );
  await pool.query(`UPDATE sources SET doi = $1 WHERE id = $2`, [
    discoveredDoi,
    sourceId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM research_discovery_runs WHERE id = $1`, [runId]);
  await pool.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
  await pool.query(`DELETE FROM faculty_users WHERE id = ANY($1::int[])`, [
    [stewardId, contributorId],
  ]);
  await pool.query(`DELETE FROM pillars WHERE id = $1`, [pillarId]);
});

describe("discovered-work exclusion", () => {
  test("source listing identifies discovered work before exclusion", async () => {
    signedInUserId = stewardId;
    const response = await request(app).get(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources`,
    );
    expect(response.status).toBe(200);
    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceId,
          automaticallyDiscovered: true,
          excluded: false,
        }),
      ]),
    );
  });

  test("contributors cannot exclude discovered work", async () => {
    signedInUserId = contributorId;
    const response = await request(app)
      .post(
        `/api/faculty/pillars/discovery-exclusion-${stamp}/sources/${sourceId}/exclude`,
      )
      .send({ reason: "not mine" });
    expect(response.status).toBe(403);
  });

  test("steward exclusion is durable, purges, hides, and is idempotent", async () => {
    signedInUserId = stewardId;
    const path =
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources/${sourceId}/exclude`;
    const first = await request(app)
      .post(path)
      .send({ reason: "Outside this pillar's scope" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(
      expect.objectContaining({
        id: sourceId,
        status: "archived",
        excluded: true,
        unchanged: false,
        purged: true,
      }),
    );

    const second = await request(app).post(path).send({ reason: "different" });
    expect(second.status).toBe(200);
    expect(second.body.unchanged).toBe(true);

    const active = await request(app).get(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources`,
    );
    expect(active.body.sources).toHaveLength(0);
    const archived = await request(app).get(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources?status=archived`,
    );
    expect(archived.body.sources).toEqual([
      expect.objectContaining({
        id: sourceId,
        automaticallyDiscovered: true,
        excluded: true,
        exclusionReason: "Outside this pillar's scope",
      }),
    ]);

    const persisted = await pool.query<{
      excluded_at: Date | null;
      exclusion_reason: string | null;
      source_id: number | null;
      full_text: string | null;
      retention_status: string;
      audits: string;
    }>(
      `SELECT c.excluded_at, c.exclusion_reason, c.source_id,
              s.full_text, s.retention_status,
              (SELECT count(*)::text FROM source_audit_log a
                WHERE a.source_id = s.id
                  AND a.action = 'discovery_excluded') AS audits
         FROM research_discovery_candidates c
         JOIN sources s ON s.id = c.source_id
        WHERE c.discovery_run_id = $1`,
      [runId],
    );
    expect(persisted.rows[0]).toEqual(
      expect.objectContaining({
        exclusion_reason: "Outside this pillar's scope",
        source_id: sourceId,
        full_text: null,
        retention_status: "purged_no_full_text_rights",
        audits: "1",
      }),
    );
    expect(persisted.rows[0].excluded_at).not.toBeNull();
  });

  test("a deliberate manual re-add detaches historical exclusion provenance", async () => {
    signedInUserId = stewardId;
    const upload = await request(app)
      .post(`/api/faculty/pillars/discovery-exclusion-${stamp}/sources`)
      .send({
        kind: "paper",
        title: "Manually restored paper",
        doi: discoveredDoi,
        text: "The steward deliberately restored this paper to the pillar.",
        rightsBasis: "permission",
      });
    expect(upload.status).toBe(201);
    expect(upload.body.id).toBe(sourceId);

    const active = await request(app).get(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources`,
    );
    expect(active.body.sources).toEqual([
      expect.objectContaining({
        id: sourceId,
        automaticallyDiscovered: false,
        excluded: false,
      }),
    ]);

    const candidate = await pool.query<{
      source_id: number | null;
      excluded_at: Date | null;
    }>(
      `SELECT source_id, excluded_at
         FROM research_discovery_candidates
        WHERE discovery_run_id = $1 AND doi = $2`,
      [runId, discoveredDoi],
    );
    expect(candidate.rows[0].source_id).toBeNull();
    expect(candidate.rows[0].excluded_at).not.toBeNull();

    const excludeAgain = await request(app).post(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources/${sourceId}/exclude`,
    );
    expect(excludeAgain.status).toBe(409);
  });

  test("manual re-upload also supersedes an unexcluded discovery association", async () => {
    signedInUserId = stewardId;
    const doi = `10.5555/manual-${stamp}`;
    const source = await pool.query<{ id: number }>(
      `INSERT INTO sources
         (pillar_id, kind, title, doi, abstract, full_text, rights_basis,
          retention_status, status, uploaded_by_user_id)
       VALUES ($1, 'paper', 'Second discovered paper', $2, 'abstract', 'text',
               'permission', 'retained_with_rights', 'draft', $3)
       RETURNING id`,
      [pillarId, doi, stewardId],
    );
    const secondSourceId = source.rows[0].id;
    await pool.query(
      `INSERT INTO research_discovery_candidates
         (discovery_run_id, pillar_id, provider, provider_id, doi, title,
          status, source_id)
       VALUES ($1, $2, 'crossref', $3, $4, 'Second discovered paper',
               'review', $5)`,
      [runId, pillarId, `manual-provider-${stamp}`, doi, secondSourceId],
    );

    const upload = await request(app)
      .post(`/api/faculty/pillars/discovery-exclusion-${stamp}/sources`)
      .send({
        kind: "paper",
        title: "Second paper, curated manually",
        doi,
        text: "The owner supplied this version directly.",
        rightsBasis: "permission",
      });
    expect(upload.status).toBe(201);

    const active = await request(app).get(
      `/api/faculty/pillars/discovery-exclusion-${stamp}/sources`,
    );
    expect(active.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: secondSourceId,
          automaticallyDiscovered: false,
          excluded: false,
        }),
      ]),
    );
    const candidate = await pool.query<{ source_id: number | null }>(
      `SELECT source_id
         FROM research_discovery_candidates
        WHERE discovery_run_id = $1 AND doi = $2`,
      [runId, doi],
    );
    expect(candidate.rows[0].source_id).toBeNull();
  });
});