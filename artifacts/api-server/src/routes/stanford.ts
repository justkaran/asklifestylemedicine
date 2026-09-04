import { Router, type IRouter, type RequestHandler } from "express";
import healthRouter from "./health";
import slmAgentRouter from "./slm-agent";
import slmAnswerLinksRouter from "./slm-answer-links";
import billingRouter from "./billing";
import facultyRouter from "./faculty";
import facultyApplicationsRouter from "./facultyApplications";
import voiceProfileRouter from "./voiceProfile";
import sourcesRouter from "./sources";
import interpretationsRouter from "./interpretations";
import knowledgeRouter from "./knowledge";
import coverageRouter from "./coverage";
import evalsRouter from "./evals";
import storageRouter from "./storage";
import researchDiscoveryRouter from "./researchDiscovery";
import uncoveredEscalationRouter from "./uncoveredEscalation";
import pillarResourcesRouter from "./pillarResources";

/**
 * The Stanford database intentionally contains only the SLM/Faculty tables.
 * Keep this router as the composition boundary: adding a legacy router here
 * can make a request reach tables that do not exist in that database.
 */
const router: IRouter = Router();

function allowPaths(
  target: IRouter,
  ownsPath: (path: string) => boolean,
  allowed: (path: string) => boolean,
): IRouter {
  const guarded = Router();
  guarded.use((req, res, next) => {
    if (allowed(req.path)) {
      (target as unknown as RequestHandler)(req, res, next);
      return;
    }
    if (ownsPath(req.path)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
    return;
  });
  return guarded;
}

const consumerPath = (path: string) =>
  [
    "/consumer/auth/request",
    "/consumer/auth/register",
    "/consumer/auth/consume",
    "/consumer/auth/logout",
    "/consumer/me",
  ].includes(path);

// billing.ts also owns consumer authentication. Its Stripe handlers must never
// be reachable in Stanford mode, even if a platform-admin session is present.
const facultyPath = (path: string) => {
  if (
    /^\/faculty\/(?:newsletter-(?:offers|credits)|communication-offers|parentdata(?:-|\/)|channel-interest(?:\/|$)|admin\/(?:channel-interest|distribution-channels)(?:\/|$)|distribution-channels(?:\/|$))/.test(
      path,
    )
  ) {
    return false;
  }
  return (
    path === "/faculty/public/pillars" ||
    path === "/faculty/me" ||
    /^\/faculty\/pillars\/[^/]+$/.test(path) ||
    path === "/faculty/onboarding/complete" ||
    /^\/faculty\/invitations(?:\/[^/]+(?:\/accept)?)?$/.test(path) ||
    /^\/faculty\/admin\/(?:members|pillars|pillar-data)(?:\/.*)?$/.test(path) ||
    path === "/faculty/aslm/usage"
  );
};

router.use(healthRouter);
router.use(slmAgentRouter);
router.use(slmAnswerLinksRouter);
router.use(
  allowPaths(
    billingRouter,
    (path) => /^\/(?:consumer|billing)(?:\/|$)/.test(path),
    consumerPath,
  ),
);
router.use(facultyApplicationsRouter);
router.use(sourcesRouter);
router.use(interpretationsRouter);
router.use(knowledgeRouter);
router.use(coverageRouter);
router.use(evalsRouter);
// Stanford does not use Replit private object storage. Keep only intentionally
// public assets reachable; presigned uploads and private-object reads are not
// part of the Stanford deployment boundary.
router.use(
  allowPaths(
    storageRouter,
    (path) => /^\/storage(?:\/|$)/.test(path),
    (path) => /^\/storage\/public-objects(?:\/|$)/.test(path),
  ),
);
router.use(researchDiscoveryRouter);
router.use(uncoveredEscalationRouter);
router.use(pillarResourcesRouter);
router.use(voiceProfileRouter);
// This must follow the other selected Faculty routers: their more specific
// paths retain their handlers, while the monolithic router remains fenced.
router.use(
  allowPaths(
    facultyRouter,
    (path) => /^\/faculty(?:\/|$)/.test(path),
    facultyPath,
  ),
);

// These families are deliberately explicit rather than relying on Express's
// terminal 404, so excluded products cannot become visible through a later
// catch-all route or an accidentally mounted legacy router.
const excludedPath =
  /^\/(?:billing(?:\/|$)|sleep(?:-|\/|$)|newsletter(?:-|\/|$)|investors?(?:\/|$)|partner(?:-|\/|$)|analytics(?:\/|$)|decision-room(?:\/|$)|mcp(?:\/|$)|support(?:\/|$)|phone(?:\/|$)|contact(?:\/|$)|faculty\/(?:newsletter-(?:offers|credits)|communication-offers|parentdata(?:-|\/|$)|channel-interest(?:\/|$)|distribution-channels(?:\/|$)|admin\/(?:channel-interest|distribution-channels|newsletter-session|command-center-session)(?:\/|$)))/;

router.use((req, res, next) => {
  if (excludedPath.test(req.path)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

export default router;
