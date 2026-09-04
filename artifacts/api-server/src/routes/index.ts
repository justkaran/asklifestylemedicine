import { Router, type IRouter } from "express";
import healthRouter from "./health";
import landingDemoRouter from "./landingDemo";
import slidesRouter from "./slides";
import sleepAgentRouter from "./sleep-agent";
import dinnerEditsRouter from "./dinner-edits";
import reachDeckRouter from "./reach-deck";
import reachTechRouter from "./reach-tech";
import demoAuthRouter from "./demo-auth";
import onboardingRouter from "./onboarding";
import adminRouter from "./admin";
import ipProtectionRouter from "./ipProtection";
import adminAdviceRouter from "./adminAdvice";
import adminDoorwayRouter from "./adminDoorway";
import ttsRouter from "./tts";
import analyticsRouter from "./analytics";
import waitlistRouter from "./waitlist";
import appleHealthRouter from "./apple-health";
import agentRouter from "./agent";
import facultyRouter from "./faculty";
import facultyApplicationsRouter from "./facultyApplications";
import facultyNewsletterRouter from "./facultyNewsletter";
import voiceProfileRouter from "./voiceProfile";
import sourcesRouter from "./sources";
import interpretationsRouter from "./interpretations";
import coverageRouter from "./coverage";
import reputationRouter from "./reputation";
import evalsRouter from "./evals";
import storageRouter from "./storage";
import storiesRouter from "./stories";
import embedRouter from "./embed";
import embedAgentRouter from "./embed-agent";
import newsletterRouter from "./newsletter";
import newsletterQaRouter from "./newsletter-qa";
import membersRouter from "./members";
import newsletterReplyRouter from "./newsletter-reply";
import communicationRouter from "./communication";
import parentdataRouter from "./parentdata";
import crossPillarRouter from "./cross-pillar";
import businessPlanRouter from "./business-plan";
import investorsRouter from "./investors";
import aiNewsletterDocRouter from "./ai-newsletter";
import otlDocRouter from "./otl";
import growthRouter from "./growth";
import crawlsRouter from "./crawls";
import researchDiscoveryRouter from "./researchDiscovery";
import sleepzeitRouter from "./sleepzeit";
import billingRouter from "./billing";
import accountRouter from "./account";
import consumerDataRouter from "./consumerData";
import saveAnswerRouter from "./saveAnswer";
import frameworksRouter from "./frameworks";
import quickAnswerRouter from "./quickAnswer";
import partnerAccessRouter from "./partnerAccess";
import partnerPortalRouter from "./partnerPortal";
import mcpRouter from "./mcp";
import supportRouter from "./support";
import phoneRouter from "./phone";
import doorwayRouter from "./doorway";
import stewardEarningsRouter from "./stewardEarnings";
import topicsRouter from "./topics";
import journeyRouter from "./journey";
import formatVotesRouter from "./formatVotes";
import slmAgentRouter from "./slm-agent";
import slmAnswerLinksRouter from "./slm-answer-links";
import betaRouter from "./beta";
import uncoveredEscalationRouter from "./uncoveredEscalation";
import referralRouter from "./referral";
import pillarResourcesRouter from "./pillarResources";
import pillarAnalyticsRouter from "./pillarAnalytics";
import tavusRouter from "./tavus";
import contactRouter from "./contact";
import stewardInterestRouter from "./stewardInterest";
import decisionRoomRouter from "./decisionRoom";
import decisionMemosRouter from "./decisionMemos";
import cvoReleasesRouter from "./cvoReleases";
import aiVisibilityRouter from "./aiVisibility";
import knowledgeRouter from "./knowledge";

const router: IRouter = Router();

router.use(healthRouter);
router.use(landingDemoRouter);
router.use(slidesRouter);
router.use(sleepAgentRouter);
router.use(dinnerEditsRouter);
router.use(reachDeckRouter);
router.use(reachTechRouter);
router.use(demoAuthRouter);
// journeyRouter must mount BEFORE onboardingRouter: onboarding registers
// GET /journey/:userId, which would otherwise swallow /journey/status with a
// 400 "invalid userId". Journey's paths are all literal, so numeric
// /journey/123 still falls through to onboarding.
router.use(journeyRouter);
router.use(onboardingRouter);
router.use(adminRouter);
router.use(ipProtectionRouter);
router.use(adminAdviceRouter);
router.use(adminDoorwayRouter);
router.use(ttsRouter);
router.use(analyticsRouter);
router.use(waitlistRouter);
router.use(appleHealthRouter);
router.use(agentRouter);
// aiVisibilityRouter mounts BEFORE facultyRouter so its literal
// /faculty/ai-visibility/* paths are never shadowed by param routes.
router.use(aiVisibilityRouter);
// Applications router mounts before the main faculty router so its literal
// /faculty/* routes can never be shadowed by param captures added there later.
router.use(facultyApplicationsRouter);
router.use(facultyRouter);
router.use(decisionMemosRouter);
router.use(facultyNewsletterRouter);
router.use(voiceProfileRouter);
router.use(sourcesRouter);
router.use(interpretationsRouter);
router.use(knowledgeRouter);
router.use(coverageRouter);
router.use(reputationRouter);
router.use(evalsRouter);
router.use(storageRouter);
router.use(storiesRouter);
router.use(embedRouter);
router.use(embedAgentRouter);
router.use(newsletterRouter);
router.use(newsletterQaRouter);
router.use(membersRouter);
router.use(newsletterReplyRouter);
router.use(communicationRouter);
router.use(parentdataRouter);
router.use(crossPillarRouter);
router.use(businessPlanRouter);
router.use(investorsRouter);
router.use(aiNewsletterDocRouter);
router.use(otlDocRouter);
router.use(growthRouter);
router.use(crawlsRouter);
router.use(researchDiscoveryRouter);
router.use(sleepzeitRouter);
// Consumer sign-in and /consumer/me live beside the billing endpoints in this
// router and remain available when paid billing is disabled. The /billing/*
// handlers themselves enforce BILLING_ENABLED.
router.use(billingRouter);
router.use(accountRouter);
router.use(consumerDataRouter);
router.use(saveAnswerRouter);
router.use(frameworksRouter);
router.use(quickAnswerRouter);
router.use(partnerAccessRouter);
router.use(partnerPortalRouter);
router.use(mcpRouter);
router.use(supportRouter);
router.use(phoneRouter);
router.use(doorwayRouter);
router.use(stewardEarningsRouter);
router.use(topicsRouter);
router.use(formatVotesRouter);
router.use(slmAgentRouter);
router.use(slmAnswerLinksRouter);
router.use(betaRouter);
router.use(uncoveredEscalationRouter);
router.use(referralRouter);
router.use(pillarResourcesRouter);
router.use(pillarAnalyticsRouter);
router.use(tavusRouter);
router.use(contactRouter);
router.use(stewardInterestRouter);
router.use(decisionRoomRouter);
// CVO Release Governance — mode-scoped release management (task #845).
// Must mount BEFORE decisionRoomRouter's generic /decision-room/* routes would
// shadow /decision-room/:mode/... if order mattered — they don't conflict here
// since the mode segment is not "decisions", "steps", "summary", or "pillars".
router.use(cvoReleasesRouter);

export default router;
