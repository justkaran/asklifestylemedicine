/**
 * Steward Q&A earnings — the read surfaces over the 80/20 ledger.
 *
 * - Faculty portal: a steward sees THEIR OWN entries + totals (Clerk auth;
 *   honors the admin view-as preview because it's GET-only).
 * - Palonur admin: per-publication rollup across all stewards + CSV export
 *   (shared `palonur_admin` cookie, same gate as the rest of /admin).
 *
 * Both surfaces lazily mint pending ledger rows from the synced Stripe
 * invoices before reading (idempotent — see lib/stewardBilling.ts). This is a
 * reimbursement record only; no money moves here.
 */
import { Router, type IRouter, type Response } from "express";
import {
  requireFacultyAuth,
  type FacultyRequest,
} from "../middlewares/facultyAuth";
import { checkAdmin } from "./admin";
import {
  listEarningsForFacultyUser,
  listStewardEarningsSummaries,
  countStewardSubscribers,
  mintStewardEarnings,
  STEWARD_SHARE,
} from "../lib/stewardBilling";

const router: IRouter = Router();

router.get(
  "/faculty/earnings",
  requireFacultyAuth,
  async (req: FacultyRequest, res: Response) => {
    const facultyUserId = req.faculty?.user.id;
    if (!facultyUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Lazily mint any not-yet-recorded paid invoices before reading —
      // idempotent per Stripe invoice, best-effort (a mint failure must not
      // hide the already-recorded ledger).
      await mintStewardEarnings().catch((err) =>
        req.log.warn({ err }, "steward earnings mint failed"),
      );
      const entries = await listEarningsForFacultyUser(facultyUserId);
      const totals = entries.reduce(
        (acc, e) => {
          acc.grossCents += e.grossCents;
          acc.stewardCents += e.stewardCents;
          acc.palonurCents += e.palonurCents;
          return acc;
        },
        { grossCents: 0, stewardCents: 0, palonurCents: 0 },
      );
      // Active subscriber count per publication the steward earns from —
      // the forward-looking number next to the historical ledger.
      const pubIds = Array.from(new Set(entries.map((e) => e.publicationId)));
      const subscribers: Record<number, number> = {};
      for (const id of pubIds) {
        subscribers[id] = await countStewardSubscribers(id);
      }
      return res.json({
        sharePercent: Math.round(STEWARD_SHARE * 100),
        totals,
        invoiceCount: entries.length,
        entries,
        subscribers,
      });
    } catch (e) {
      req.log.error({ err: e }, "faculty earnings load failed");
      return res.status(500).json({ error: "Failed to load earnings" });
    }
  },
);

router.get("/admin/steward-earnings", checkAdmin, async (req, res) => {
  try {
    await mintStewardEarnings().catch((err) =>
      req.log.warn({ err }, "steward earnings mint failed"),
    );
    const summaries = await listStewardEarningsSummaries();
    const totals = summaries.reduce(
      (acc, s) => {
        acc.grossCents += s.grossCents;
        acc.stewardCents += s.stewardCents;
        acc.palonurCents += s.palonurCents;
        acc.invoiceCount += s.invoiceCount;
        return acc;
      },
      { grossCents: 0, stewardCents: 0, palonurCents: 0, invoiceCount: 0 },
    );
    return res.json({
      sharePercent: Math.round(STEWARD_SHARE * 100),
      totals,
      publications: summaries,
    });
  } catch (e) {
    req.log.error({ err: e }, "admin steward earnings load failed");
    return res.status(500).json({ error: "Failed to load earnings" });
  }
});

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/admin/steward-earnings.csv", checkAdmin, async (req, res) => {
  try {
    await mintStewardEarnings().catch((err) =>
      req.log.warn({ err }, "steward earnings mint failed"),
    );
    const summaries = await listStewardEarningsSummaries();
    const header =
      "publication,slug,steward,invoices,gross_cents,steward_cents,palonur_cents,currency";
    const lines = summaries.map((s) =>
      [
        csvCell(s.publicationName),
        csvCell(s.publicationSlug),
        csvCell(s.stewardName),
        s.invoiceCount,
        s.grossCents,
        s.stewardCents,
        s.palonurCents,
        csvCell(s.currency),
      ].join(","),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="steward-earnings.csv"',
    );
    return res.send([header, ...lines].join("\n") + "\n");
  } catch (e) {
    req.log.error({ err: e }, "admin steward earnings csv failed");
    return res.status(500).json({ error: "Failed to export earnings" });
  }
});

export default router;
