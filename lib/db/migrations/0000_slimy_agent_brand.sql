CREATE TYPE "public"."crawl_candidate_status" AS ENUM('discovered', 'fetching', 'transcribed', 'ingested', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."crawl_run_status" AS ENUM('pending', 'discovering', 'review', 'collecting', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."eval_expected_outcome" AS ENUM('covered', 'uncovered', 'refuse');--> statement-breakpoint
CREATE TYPE "public"."faculty_application_status" AS ENUM('applied', 'under_review', 'admitted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."faculty_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."faculty_role" AS ENUM('steward', 'contributor', 'advisor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."interpretation_origin" AS ENUM('palonur_ai', 'faculty');--> statement-breakpoint
CREATE TYPE "public"."interpretation_status" AS ENUM('proposed', 'approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."knowledge_relation_type" AS ENUM('supports', 'refines', 'qualifies', 'contradicts');--> statement-breakpoint
CREATE TYPE "public"."knowledge_version_chunk_kind" AS ENUM('interpretation', 'source');--> statement-breakpoint
CREATE TYPE "public"."research_discovery_candidate_status" AS ENUM('discovered', 'review', 'ingested', 'auto_approved', 'duplicate', 'failed');--> statement-breakpoint
CREATE TYPE "public"."research_discovery_run_status" AS ENUM('pending', 'discovering', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_assessment_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('paper', 'slm_article', 'note', 'talk');--> statement-breakpoint
CREATE TYPE "public"."source_retention_status" AS ENUM('needs_review', 'review_window', 'retained_with_rights', 'purged_no_full_text_rights');--> statement-breakpoint
CREATE TYPE "public"."source_rights_basis" AS ENUM('open_license', 'permission', 'public_domain', 'no_documented_full_text_rights');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('draft', 'in_review', 'approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."voice_profile_source" AS ENUM('manual', 'ai_distilled', 'manual_edit');--> statement-breakpoint
CREATE TABLE "advice_guard_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"phrase" text NOT NULL,
	"added_by" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"question" text NOT NULL,
	"question_embedding" halfvec,
	"embedding_model" text,
	"source" text DEFAULT 'sleep-agent' NOT NULL,
	"pillar_ids" integer[] DEFAULT ARRAY[]::int[] NOT NULL,
	"retrieved_source_ids" integer[] DEFAULT ARRAY[]::int[] NOT NULL,
	"retrieved_interpretation_ids" integer[] DEFAULT ARRAY[]::int[] NOT NULL,
	"knowledge_version_id" integer,
	"top_score" real DEFAULT 0 NOT NULL,
	"was_uncovered" boolean DEFAULT false NOT NULL,
	"answer_text" text DEFAULT '' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"user_flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"cluster_id" integer,
	"partner_key_id" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumer_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"email_verified_at" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "consumer_login_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"magic_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_login_tokens_magic_token_unique" UNIQUE("magic_token")
);
--> statement-breakpoint
CREATE TABLE "crawl_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"crawl_run_id" integer NOT NULL,
	"status" "crawl_candidate_status" DEFAULT 'discovered' NOT NULL,
	"title" text NOT NULL,
	"source_type" text DEFAULT 'other' NOT NULL,
	"event_name" text,
	"talk_date" text,
	"primary_url" text NOT NULL,
	"audio_url" text,
	"transcript_url" text,
	"transcript_available" boolean DEFAULT false NOT NULL,
	"transcript" text,
	"source_id" integer,
	"interpretation_id" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"faculty_user_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"started_by_user_id" integer,
	"speaker_name" text NOT NULL,
	"rights_basis" "source_rights_basis",
	"status" "crawl_run_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_rate_limit_hits" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"hit_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_gradings" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"grader_user_id" integer NOT NULL,
	"groundedness" integer NOT NULL,
	"helpfulness" integer NOT NULL,
	"accuracy" integer NOT NULL,
	"hallucinated" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"seed_index" integer NOT NULL,
	"question" text NOT NULL,
	"expected_outcome" "eval_expected_outcome" NOT NULL,
	"category" text NOT NULL,
	"answer_text" text DEFAULT '' NOT NULL,
	"citation_verification" text,
	"was_uncovered" boolean DEFAULT false NOT NULL,
	"was_refused" boolean DEFAULT false NOT NULL,
	"governed_used" boolean DEFAULT false NOT NULL,
	"top_score" real DEFAULT 0 NOT NULL,
	"retrieved_source_ids" integer[] DEFAULT ARRAY[]::int[] NOT NULL,
	"retrieved_interpretation_ids" integer[] DEFAULT ARRAY[]::int[] NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"run_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"build_ref" text,
	"target_url" text NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"completed_items" integer DEFAULT 0 NOT NULL,
	"citation_verified_rate" real,
	"citation_unmatched_rate" real,
	"citation_missing_rate" real,
	"coverage_rate" real,
	"refusal_compliance_rate" real,
	"uncovered_honesty_rate" real,
	"median_latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "faculty_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"institution" text NOT NULL,
	"field" text NOT NULL,
	"work_url" text,
	"institutional_email" text NOT NULL,
	"institutional_email_verified_at" timestamp with time zone,
	"verification_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"verification_expires_at" timestamp with time zone NOT NULL,
	"status" "faculty_application_status" DEFAULT 'applied' NOT NULL,
	"decline_note" text,
	"admitted_pillar_id" integer,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faculty_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"pillar_id" integer NOT NULL,
	"role" "faculty_role" NOT NULL,
	"institution" text,
	"registration_channel" text,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" "faculty_invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faculty_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "faculty_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"role" "faculty_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faculty_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"institution" text,
	"photo_url" text,
	"achievements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tavus_replica_id" text,
	"is_platform_admin" text DEFAULT 'false' NOT NULL,
	"registration_channel" text,
	"onboarded_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faculty_users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "faculty_voice_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"faculty_user_id" integer NOT NULL,
	"tone_summary" text DEFAULT '' NOT NULL,
	"guidance" text DEFAULT '' NOT NULL,
	"signature_phrases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"avoid_phrases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"distilled_from" jsonb,
	"source" "voice_profile_source" DEFAULT 'manual' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gap_discovery_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"pillar_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_agreements" (
	"id" serial PRIMARY KEY NOT NULL,
	"institution" text NOT NULL,
	"agreement_active" text DEFAULT 'false' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretation_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"interpretation_id" integer NOT NULL,
	"source_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec,
	"embedding_model" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretation_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"interpretation_id" integer NOT NULL,
	"author_id" integer,
	"body" text NOT NULL,
	"quoted_text" text,
	"parent_comment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretation_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"interpretation_id" integer NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"approver_id" integer,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interpretations" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"author_id" integer,
	"origin" "interpretation_origin" DEFAULT 'faculty' NOT NULL,
	"drafted_at" timestamp with time zone,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp with time zone,
	"last_edited_by_user_id" integer,
	"last_edited_at" timestamp with time zone,
	"status" "interpretation_status" DEFAULT 'proposed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"answer" text NOT NULL,
	"interpretation" text NOT NULL,
	"not_proven" text,
	"action" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"approver_id" integer,
	"approved_at" timestamp with time zone,
	"parent_interpretation_id" integer,
	"ai_draft" text,
	"ai_draft_similarity" real,
	"ai_draft_acceptance" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"from_interpretation_id" integer NOT NULL,
	"to_interpretation_id" integer NOT NULL,
	"relation" "knowledge_relation_type" NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_version_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_version_id" integer NOT NULL,
	"kind" "knowledge_version_chunk_kind" NOT NULL,
	"source_id" integer NOT NULL,
	"interpretation_id" integer,
	"pillar_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec NOT NULL,
	"embedding_model" text NOT NULL,
	"source_title" text NOT NULL,
	"source_authors" text,
	"source_year" integer,
	"source_journal" text,
	"source_doi" text,
	"source_url" text,
	"source_retention_status" text NOT NULL,
	"source_study_design" text,
	"source_reliability_rubric" jsonb,
	"pillar_slug" text NOT NULL,
	"pillar_name" text NOT NULL,
	"interpretation_author" text,
	"interpretation_origin" text,
	"interpretation_reviewer" text,
	"advisor_lens_slug" text,
	"advisor_lens_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"relation_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"published_by_user_id" integer,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pillar_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"category" text,
	"coach_lesson_id" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pillars" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pillars_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "query_clusters" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"representative_question" text NOT NULL,
	"representative_embedding" halfvec,
	"embedding_model" text,
	"size" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_discovery_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"discovery_run_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"doi" text,
	"pmid" text,
	"title" text NOT NULL,
	"authors" text,
	"journal" text,
	"year" integer,
	"abstract" text,
	"source_url" text,
	"status" "research_discovery_candidate_status" DEFAULT 'discovered' NOT NULL,
	"review_reason" text,
	"source_id" integer,
	"interpretation_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_discovery_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"faculty_user_id" integer NOT NULL,
	"pillar_id" integer NOT NULL,
	"started_by_user_id" integer,
	"faculty_name" text NOT NULL,
	"pillar_topic" text NOT NULL,
	"status" "research_discovery_run_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rubric_check_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"check_id" integer NOT NULL,
	"interpretation_id" integer NOT NULL,
	"verdict" text NOT NULL,
	"rationale" text,
	"content_hash" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rubric_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slm_answer_links" (
	"id" text PRIMARY KEY NOT NULL,
	"query_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer_text" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slm_answer_links_query_id_unique" UNIQUE("query_id")
);
--> statement-breakpoint
CREATE TABLE "source_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"actor_user_id" integer,
	"action" text NOT NULL,
	"from_status" "source_status",
	"to_status" "source_status",
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec,
	"embedding_model" text,
	"content_hash" text,
	"page" integer,
	"section" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"pillar_id" integer NOT NULL,
	"kind" "source_kind" NOT NULL,
	"title" text NOT NULL,
	"authors" text,
	"year" integer,
	"journal" text,
	"doi" text,
	"abstract" text,
	"full_text" text,
	"source_url" text,
	"study_design" text,
	"rights_basis" "source_rights_basis",
	"retention_status" "source_retention_status" DEFAULT 'needs_review' NOT NULL,
	"rights_recorded_by_user_id" integer,
	"rights_recorded_at" timestamp with time zone,
	"purged_by_user_id" integer,
	"purged_at" timestamp with time zone,
	"speaker_faculty_user_id" integer,
	"speaker_name" text,
	"event_name" text,
	"talk_date" text,
	"status" "source_status" DEFAULT 'draft' NOT NULL,
	"uploaded_by_user_id" integer,
	"rigor_score" integer,
	"reproducibility_score" integer,
	"openness_score" integer,
	"assessment_rubric" jsonb,
	"assessment_status" "source_assessment_status",
	"assessed_by_user_id" integer,
	"assessed_at" timestamp with time zone,
	"assessment_ai_draft" jsonb,
	"assessment_ai_acceptance" text,
	"topic_fit_score" real,
	"off_topic_suspect" boolean DEFAULT false NOT NULL,
	"topic_fit_checked_at" timestamp with time zone,
	"content_hash" text,
	"is_canary" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uncovered_escalations" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"surface" text NOT NULL,
	"user_email" text,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumer_account_id" integer,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crawl_candidates" ADD CONSTRAINT "crawl_candidates_crawl_run_id_crawl_runs_id_fk" FOREIGN KEY ("crawl_run_id") REFERENCES "public"."crawl_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_candidates" ADD CONSTRAINT "crawl_candidates_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_candidates" ADD CONSTRAINT "crawl_candidates_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_faculty_user_id_faculty_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_started_by_user_id_faculty_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_gradings" ADD CONSTRAINT "eval_gradings_item_id_eval_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."eval_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_gradings" ADD CONSTRAINT "eval_gradings_grader_user_id_faculty_users_id_fk" FOREIGN KEY ("grader_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_applications" ADD CONSTRAINT "faculty_applications_user_id_faculty_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_applications" ADD CONSTRAINT "faculty_applications_admitted_pillar_id_pillars_id_fk" FOREIGN KEY ("admitted_pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_applications" ADD CONSTRAINT "faculty_applications_decided_by_user_id_faculty_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_invitations" ADD CONSTRAINT "faculty_invitations_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_invitations" ADD CONSTRAINT "faculty_invitations_invited_by_user_id_faculty_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_memberships" ADD CONSTRAINT "faculty_memberships_user_id_faculty_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_memberships" ADD CONSTRAINT "faculty_memberships_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faculty_voice_profiles" ADD CONSTRAINT "faculty_voice_profiles_faculty_user_id_faculty_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_discovery_events" ADD CONSTRAINT "gap_discovery_events_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_discovery_events" ADD CONSTRAINT "gap_discovery_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_chunks" ADD CONSTRAINT "interpretation_chunks_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_chunks" ADD CONSTRAINT "interpretation_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_chunks" ADD CONSTRAINT "interpretation_chunks_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_comments" ADD CONSTRAINT "interpretation_comments_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_comments" ADD CONSTRAINT "interpretation_comments_author_id_faculty_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_versions" ADD CONSTRAINT "interpretation_versions_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretation_versions" ADD CONSTRAINT "interpretation_versions_approver_id_faculty_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_author_id_faculty_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_reviewed_by_user_id_faculty_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_last_edited_by_user_id_faculty_users_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_approver_id_faculty_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_from_interpretation_id_interpretations_id_fk" FOREIGN KEY ("from_interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_to_interpretation_id_interpretations_id_fk" FOREIGN KEY ("to_interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_created_by_user_id_faculty_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_version_chunks" ADD CONSTRAINT "knowledge_version_chunks_knowledge_version_id_knowledge_versions_id_fk" FOREIGN KEY ("knowledge_version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_published_by_user_id_faculty_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_resources" ADD CONSTRAINT "pillar_resources_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD CONSTRAINT "query_clusters_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_candidates" ADD CONSTRAINT "research_discovery_candidates_discovery_run_id_research_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."research_discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_candidates" ADD CONSTRAINT "research_discovery_candidates_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_candidates" ADD CONSTRAINT "research_discovery_candidates_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_candidates" ADD CONSTRAINT "research_discovery_candidates_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_runs" ADD CONSTRAINT "research_discovery_runs_faculty_user_id_faculty_users_id_fk" FOREIGN KEY ("faculty_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_runs" ADD CONSTRAINT "research_discovery_runs_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_discovery_runs" ADD CONSTRAINT "research_discovery_runs_started_by_user_id_faculty_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_check_results" ADD CONSTRAINT "rubric_check_results_check_id_rubric_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."rubric_checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_check_results" ADD CONSTRAINT "rubric_check_results_interpretation_id_interpretations_id_fk" FOREIGN KEY ("interpretation_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_checks" ADD CONSTRAINT "rubric_checks_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_checks" ADD CONSTRAINT "rubric_checks_created_by_id_faculty_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_audit_log" ADD CONSTRAINT "source_audit_log_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_audit_log" ADD CONSTRAINT "source_audit_log_actor_user_id_faculty_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunks" ADD CONSTRAINT "source_chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_rights_recorded_by_user_id_faculty_users_id_fk" FOREIGN KEY ("rights_recorded_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_purged_by_user_id_faculty_users_id_fk" FOREIGN KEY ("purged_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_speaker_faculty_user_id_faculty_users_id_fk" FOREIGN KEY ("speaker_faculty_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_uploaded_by_user_id_faculty_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_assessed_by_user_id_faculty_users_id_fk" FOREIGN KEY ("assessed_by_user_id") REFERENCES "public"."faculty_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_consumer_account_id_consumer_accounts_id_fk" FOREIGN KEY ("consumer_account_id") REFERENCES "public"."consumer_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "advice_guard_terms_category_phrase_idx" ON "advice_guard_terms" USING btree ("category",lower("phrase"));--> statement-breakpoint
CREATE INDEX "agent_queries_pillar_uncovered_created_idx" ON "agent_queries" USING btree ("was_uncovered","created_at");--> statement-breakpoint
CREATE INDEX "agent_queries_session_idx" ON "agent_queries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_queries_embedding_hnsw_idx" ON "agent_queries" USING hnsw (("question_embedding"::halfvec(384)) halfvec_cosine_ops) WHERE embedding_model = 'Xenova/gte-small';--> statement-breakpoint
CREATE INDEX "crawl_candidates_run_idx" ON "crawl_candidates" USING btree ("crawl_run_id");--> statement-breakpoint
CREATE INDEX "crawl_candidates_status_idx" ON "crawl_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crawl_runs_faculty_idx" ON "crawl_runs" USING btree ("faculty_user_id");--> statement-breakpoint
CREATE INDEX "crawl_runs_status_idx" ON "crawl_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_rate_limit_hits_scope_key_hit_at_idx" ON "email_rate_limit_hits" USING btree ("scope","key","hit_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_gradings_item_grader_unique" ON "eval_gradings" USING btree ("item_id","grader_user_id");--> statement-breakpoint
CREATE INDEX "eval_items_run_idx" ON "eval_items" USING btree ("run_id","seed_index");--> statement-breakpoint
CREATE INDEX "eval_runs_created_idx" ON "eval_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "faculty_applications_user_unique" ON "faculty_applications" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "faculty_applications_token_unique" ON "faculty_applications" USING btree ("verification_token");--> statement-breakpoint
CREATE UNIQUE INDEX "faculty_memberships_user_pillar_unique" ON "faculty_memberships" USING btree ("user_id","pillar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "faculty_voice_profiles_user_unique" ON "faculty_voice_profiles" USING btree ("faculty_user_id");--> statement-breakpoint
CREATE INDEX "gap_discovery_events_created_idx" ON "gap_discovery_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_agreements_institution_unique" ON "institution_agreements" USING btree ("institution");--> statement-breakpoint
CREATE INDEX "interpretation_chunks_interp_idx" ON "interpretation_chunks" USING btree ("interpretation_id");--> statement-breakpoint
CREATE INDEX "interpretation_chunks_pillar_idx" ON "interpretation_chunks" USING btree ("pillar_id");--> statement-breakpoint
CREATE INDEX "interpretation_chunks_embedding_hnsw_idx" ON "interpretation_chunks" USING hnsw (("embedding"::halfvec(384)) halfvec_cosine_ops) WHERE embedding_model = 'Xenova/gte-small';--> statement-breakpoint
CREATE INDEX "interpretation_comments_interp_idx" ON "interpretation_comments" USING btree ("interpretation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interpretation_versions_interp_version_unique" ON "interpretation_versions" USING btree ("interpretation_id","version");--> statement-breakpoint
CREATE INDEX "interpretations_source_status_idx" ON "interpretations" USING btree ("source_id","status");--> statement-breakpoint
CREATE INDEX "interpretations_pillar_status_idx" ON "interpretations" USING btree ("pillar_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "interpretations_one_approved_per_source" ON "interpretations" USING btree ("source_id") WHERE status = 'approved';--> statement-breakpoint
CREATE INDEX "knowledge_relations_pillar_idx" ON "knowledge_relations" USING btree ("pillar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_relations_unique_edge" ON "knowledge_relations" USING btree ("from_interpretation_id","to_interpretation_id","relation");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_version_chunks_version_kind_source_chunk_unique" ON "knowledge_version_chunks" USING btree ("knowledge_version_id","kind","source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "knowledge_version_chunks_version_idx" ON "knowledge_version_chunks" USING btree ("knowledge_version_id");--> statement-breakpoint
CREATE INDEX "knowledge_version_chunks_embedding_hnsw_idx" ON "knowledge_version_chunks" USING hnsw (("embedding"::halfvec(384)) halfvec_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_versions_pillar_version_unique" ON "knowledge_versions" USING btree ("pillar_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_versions_pillar_published_idx" ON "knowledge_versions" USING btree ("pillar_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pillar_resources_url_idx" ON "pillar_resources" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "pillar_resources_coach_lesson_idx" ON "pillar_resources" USING btree ("coach_lesson_id") WHERE "pillar_resources"."coach_lesson_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "query_clusters_pillar_idx" ON "query_clusters" USING btree ("pillar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_discovery_provider_unique" ON "research_discovery_candidates" USING btree ("pillar_id","provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_discovery_pillar_doi_unique" ON "research_discovery_candidates" USING btree ("pillar_id","doi") WHERE "research_discovery_candidates"."doi" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "research_discovery_candidates_run_idx" ON "research_discovery_candidates" USING btree ("discovery_run_id");--> statement-breakpoint
CREATE INDEX "research_discovery_runs_target_idx" ON "research_discovery_runs" USING btree ("faculty_user_id","pillar_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "research_discovery_one_active_target" ON "research_discovery_runs" USING btree ("faculty_user_id","pillar_id") WHERE "research_discovery_runs"."status" IN ('pending', 'discovering');--> statement-breakpoint
CREATE UNIQUE INDEX "rubric_check_results_check_interp_unique" ON "rubric_check_results" USING btree ("check_id","interpretation_id");--> statement-breakpoint
CREATE INDEX "rubric_check_results_interp_idx" ON "rubric_check_results" USING btree ("interpretation_id");--> statement-breakpoint
CREATE INDEX "rubric_checks_pillar_idx" ON "rubric_checks" USING btree ("pillar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunks_source_chunk_unique" ON "source_chunks" USING btree ("source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "source_chunks_embedding_hnsw_idx" ON "source_chunks" USING hnsw (("embedding"::halfvec(384)) halfvec_cosine_ops) WHERE embedding_model = 'Xenova/gte-small';--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_source_version_unique" ON "source_versions" USING btree ("source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_pillar_doi_unique" ON "sources" USING btree ("pillar_id","doi") WHERE "sources"."doi" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sources_pillar_status_idx" ON "sources" USING btree ("pillar_id","status");--> statement-breakpoint
CREATE INDEX "sources_pillar_assessment_idx" ON "sources" USING btree ("pillar_id","assessment_status");--> statement-breakpoint
CREATE INDEX "visitor_sessions_consumer_account_idx" ON "visitor_sessions" USING btree ("consumer_account_id");