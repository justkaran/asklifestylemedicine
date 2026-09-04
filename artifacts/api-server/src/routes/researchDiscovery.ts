import { Router, type IRouter, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, facultyUsersTable, pillarsTable, researchDiscoveryCandidatesTable, researchDiscoveryRunsTable } from "@workspace/db";
import { requireFacultyAuth, type FacultyRequest } from "../middlewares/facultyAuth.js";
import { startResearchDiscoveryRun } from "../lib/researchDiscovery.js";

const router: IRouter = Router();
const startSchema = z.object({ facultyUserId: z.coerce.number().int().positive(), pillarId: z.coerce.number().int().positive() });
const admin = (req: FacultyRequest, res: Response) => {
  if (req.faculty?.user.isPlatformAdmin !== "true") { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
};

router.post("/faculty/admin/research-discovery", requireFacultyAuth, async (req: FacultyRequest, res: Response) => {
  if (!admin(req, res)) return;
  if (process.env.RESEARCH_DISCOVERY_ENABLED !== "true") { res.status(404).json({ error: "Research discovery is disabled." }); return; }
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [faculty] = await db.select({ id: facultyUsersTable.id, fullName: facultyUsersTable.fullName }).from(facultyUsersTable).where(eq(facultyUsersTable.id, parsed.data.facultyUserId)).limit(1);
  const [pillar] = await db.select({ id: pillarsTable.id, name: pillarsTable.name, description: pillarsTable.description }).from(pillarsTable).where(eq(pillarsTable.id, parsed.data.pillarId)).limit(1);
  if (!faculty || !pillar) { res.status(404).json({ error: !faculty ? "Faculty member not found" : "Pillar not found" }); return; }
  if (!faculty.fullName?.trim()) { res.status(400).json({ error: "Faculty member has no full name to search." }); return; }
  let runId: number;
  try {
    runId = await startResearchDiscoveryRun({ facultyUserId: faculty.id, pillarId: pillar.id, startedByUserId: req.faculty!.user.id, facultyName: faculty.fullName.trim(), pillarTopic: pillar.description?.trim() || pillar.name });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "A conflicting discovery run exists." }); return;
  }
  res.status(201).json({ runId });
});

router.get("/faculty/admin/research-discovery", requireFacultyAuth, async (req: FacultyRequest, res: Response) => {
  if (!admin(req, res)) return;
  const runs = await db.select({ id: researchDiscoveryRunsTable.id, facultyUserId: researchDiscoveryRunsTable.facultyUserId, pillarId: researchDiscoveryRunsTable.pillarId, facultyName: researchDiscoveryRunsTable.facultyName, pillarTopic: researchDiscoveryRunsTable.pillarTopic, status: researchDiscoveryRunsTable.status, error: researchDiscoveryRunsTable.error, createdAt: researchDiscoveryRunsTable.createdAt, updatedAt: researchDiscoveryRunsTable.updatedAt }).from(researchDiscoveryRunsTable).orderBy(desc(researchDiscoveryRunsTable.createdAt)).limit(50);
  res.json({ enabled: process.env.RESEARCH_DISCOVERY_ENABLED === "true", runs });
});

router.get("/faculty/admin/research-discovery/:id", requireFacultyAuth, async (req: FacultyRequest, res: Response) => {
  if (!admin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid run id" }); return; }
  const [run] = await db.select().from(researchDiscoveryRunsTable).where(eq(researchDiscoveryRunsTable.id, id)).limit(1);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  const candidates = await db.select().from(researchDiscoveryCandidatesTable).where(eq(researchDiscoveryCandidatesTable.discoveryRunId, id)).orderBy(researchDiscoveryCandidatesTable.id);
  res.json({ run, candidates });
});

export default router;