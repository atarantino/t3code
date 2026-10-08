-- Schema from official v0.0.46-nightly.20261008.2833; no user data.
CREATE TABLE "effect_sql_migrations" (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT, auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT);

CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, pinned_at TEXT, pin_order_key TEXT, linked_pull_request_json TEXT, unsettled_at TEXT, branch_pull_request_json TEXT, active_order_key TEXT, title_state_json TEXT, auto_settle_disabled_at TEXT);

CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , attachments_json TEXT, context_json TEXT);

CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      default_provider TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      active_provider_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      payload_json TEXT NOT NULL
    , provider_instance_id TEXT);

INSERT INTO effect_sql_migrations(migration_id,name) VALUES (1,'OrchestrationEvents');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (2,'OrchestrationCommandReceipts');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (3,'CheckpointDiffBlobs');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (4,'ProviderSessionRuntime');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (5,'Projections');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (6,'ProjectionThreadSessionRuntimeModeColumns');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (7,'ProjectionThreadMessageAttachments');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (8,'ProjectionThreadActivitySequence');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (9,'ProviderSessionRuntimeMode');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (10,'ProjectionThreadsRuntimeMode');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (11,'OrchestrationThreadCreatedRuntimeMode');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (12,'ProjectionThreadsInteractionMode');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (13,'ProjectionThreadProposedPlans');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (14,'ProjectionThreadProposedPlanImplementation');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (15,'ProjectionTurnsSourceProposedPlan');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (16,'CanonicalizeModelSelections');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (17,'ProjectionThreadsArchivedAt');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (18,'ProjectionThreadsArchivedAtIndex');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (19,'ProjectionSnapshotLookupIndexes');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (20,'AuthAccessManagement');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (21,'AuthSessionClientMetadata');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (22,'AuthSessionLastConnectedAt');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (23,'ProjectionThreadShellSummary');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (24,'BackfillProjectionThreadShellSummary');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (25,'CleanupInvalidProjectionPendingApprovals');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (26,'CanonicalizeModelSelectionOptions');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (27,'ProviderSessionRuntimeInstanceId');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (28,'ProjectionThreadSessionInstanceId');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (29,'ProjectionThreadDetailOrderingIndexes');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (30,'ProjectionThreadShellArchiveIndexes');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (31,'AuthAuthorizationScopes');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (32,'AuthPairingProofKeyThumbprint');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (33,'ProjectionThreadsSettled');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (34,'ProjectionThreadsSnoozed');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (35,'ProjectionThreadTitleRegeneration');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (36,'ProjectionThreadsPinned');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (37,'ProjectionTurnsKeysetIndex');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (38,'ProjectionThreadsPinOrderKey');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (39,'ProjectionProjectsDefaultThreadEnvMode');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (40,'ProjectionProjectFaviconPath');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (41,'AuthSessionClientConnection');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (42,'ProjectionThreadLinkedPullRequest');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (43,'ProjectionThreadsUnsettledAt');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (44,'ClearAutomaticProjectModelDefaults');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (45,'ProjectionProjectsAutoPull');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (46,'RepairAutomaticSettlementTimestamps');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (47,'ProjectionProjectIcon');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (48,'ProjectionThreadBranchPullRequest');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (49,'ProjectionThreadsActiveOrderKey');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (50,'ProjectionThreadPullRequests');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (51,'ProjectionThreadMessageContext');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (52,'ProjectionThreadTitleState');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (53,'PullRequestFilesViewed');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (54,'ProjectionThreadsAutoSettleDisabledAt');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (55,'OrchestrationV2');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (56,'RemoveRedundantProjectionIndexes');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (57,'ScheduledTaskWebhooks');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (58,'WebhookRelayDeliveries');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (59,'McpAppModelContext');
INSERT INTO effect_sql_migrations(migration_id,name) VALUES (60,'ThreadSnapshotWindowIndexes');
