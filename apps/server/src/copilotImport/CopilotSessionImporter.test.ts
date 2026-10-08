import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layer as eventSinkLayer } from "../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import type { CopilotTranscriptEntry, ParsedCopilotSession } from "./CopilotSessionParser.ts";
import {
  CopilotSessionImporter,
  layer as copilotSessionImporterLayer,
} from "./CopilotSessionImporter.ts";
import {
  CopilotSessionStore,
  CopilotSessionStoreError,
  type CopilotSessionSummary,
} from "./CopilotSessionStore.ts";
import { ProjectOperationError, ProjectService } from "../project/ProjectService.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ID = ProjectId.make("project:copilot-import");

const summary: CopilotSessionSummary = {
  sessionId: SESSION_ID,
  title: "Fix flaky test",
  cwd: "/tmp/copilot-project",
  gitRoot: "/tmp/copilot-project",
  repository: "acme/app",
  branch: "main",
  clientName: "copilot-cli",
  createdAt: "2026-02-01T10:00:00.000Z",
  updatedAt: "2026-02-01T10:05:00.000Z",
  messageCount: 3,
  inUse: false,
};

const entries: ReadonlyArray<CopilotTranscriptEntry> = [
  {
    kind: "user",
    id: "user-1",
    text: "Why is the test flaky?",
    timestamp: "2026-02-01T10:00:01.000Z",
  },
  {
    kind: "tool",
    id: "tool-1",
    toolName: "bash",
    title: "Run tests",
    input: { command: "pnpm test" },
    status: "completed",
    output: "1 failed",
    startedAt: "2026-02-01T10:00:02.000Z",
    completedAt: "2026-02-01T10:00:03.000Z",
  },
  {
    kind: "assistant",
    id: "assistant-1",
    text: "It races on the timer.",
    model: "gpt-5",
    timestamp: "2026-02-01T10:00:04.000Z",
  },
  {
    kind: "user",
    id: "user-2",
    text: "Can you check the view?",
    timestamp: "2026-02-01T10:01:00.000Z",
  },
  {
    kind: "tool",
    id: "tool-2",
    toolName: "view",
    title: null,
    input: { path: "/tmp/copilot-project/timer.ts" },
    status: "failed",
    output: "denied",
    startedAt: "2026-02-01T10:01:01.000Z",
    completedAt: "2026-02-01T10:01:02.000Z",
  },
];

const OTHER_SESSION_ID = "66666666-7777-8888-9999-000000000000";
const otherSummary: CopilotSessionSummary = {
  ...summary,
  sessionId: OTHER_SESSION_ID,
  title: "Other",
};
const otherSession: ParsedCopilotSession = {
  sessionId: OTHER_SESSION_ID,
  cwd: null,
  gitRoot: null,
  repository: null,
  branch: null,
  model: null,
  startedAt: "2026-02-02T10:00:00.000Z",
  updatedAt: "2026-02-02T10:00:00.000Z",
  firstUserMessage: null,
  entries: [],
};

const MALFORMED_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const malformedSession: ParsedCopilotSession = {
  ...otherSession,
  sessionId: MALFORMED_SESSION_ID,
  startedAt: "invalid",
  entries: [
    {
      kind: "tool",
      id: "bad-time-tool",
      toolName: "bash",
      title: null,
      input: { command: "pwd" },
      status: "completed",
      output: "/tmp",
      startedAt: "2026-02-02T10:00:00.000Z",
      completedAt: "invalid",
    },
  ],
};

const session: ParsedCopilotSession = {
  sessionId: SESSION_ID,
  cwd: "/tmp/copilot-project",
  gitRoot: "/tmp/copilot-project",
  repository: "acme/app",
  branch: "main",
  model: "gpt-5",
  startedAt: "2026-02-01T10:00:00.000Z",
  updatedAt: "2026-02-01T10:05:00.000Z",
  firstUserMessage: "Why is the test flaky?",
  entries,
};

const batchSummaries = [
  { ...summary, sessionId: "batch-existing" },
  { ...summary, sessionId: "batch-new", gitRoot: "/tmp/new-project" },
  {
    ...summary,
    sessionId: "batch-same-root",
    gitRoot: "/tmp/new-project",
    cwd: "/tmp/new-project/subdir",
  },
  { ...summary, sessionId: "batch-no-folder", gitRoot: null, cwd: null },
  { ...summary, sessionId: "batch-missing-folder", gitRoot: "/tmp/missing-project" },
  { ...summary, sessionId: "batch-broken-transcript" },
  { ...summary, sessionId: "batch-cwd", gitRoot: null, cwd: "/tmp/cwd-project" },
];

// Fake store: the importer only depends on `list` and `read`, so the fixture
// is served straight from memory instead of ~/.copilot.
const fakeStoreLayer = Layer.succeed(
  CopilotSessionStore,
  CopilotSessionStore.of({
    list: Effect.succeed(batchSummaries),
    read: (sessionId) => {
      if (sessionId === SESSION_ID) return Effect.succeed({ summary, session });
      if (sessionId === OTHER_SESSION_ID) {
        return Effect.succeed({ summary: otherSummary, session: otherSession });
      }
      if (sessionId === MALFORMED_SESSION_ID) {
        return Effect.succeed({
          summary: { ...summary, sessionId, createdAt: "invalid" },
          session: malformedSession,
        });
      }
      const batchSummary = batchSummaries.find((item) => item.sessionId === sessionId);
      if (batchSummary !== undefined && sessionId !== "batch-broken-transcript") {
        return Effect.succeed({ summary: batchSummary, session: { ...session, sessionId } });
      }
      return Effect.fail(new CopilotSessionStoreError({ operation: "read", sessionId }));
    },
  }),
);

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const projectServiceProvided = Layer.effect(
  ProjectService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ProjectService.of({
      create: () => Effect.die("Unexpected project create"),
      update: () => Effect.die("Unexpected project update"),
      delete: () => Effect.die("Unexpected project delete"),
      getById: () => Effect.die("Unexpected project read"),
      getByWorkspaceRoot: () => Effect.die("Unexpected workspace read"),
      snapshot: Effect.die("Unexpected project snapshot"),
      bootstrap: (input) =>
        Effect.gen(function* () {
          assert.equal(input.createWorkspaceRootIfMissing, false);
          if (input.workspaceRoot === "/tmp/missing-project") {
            return yield* new ProjectOperationError({
              operation: "normalize-workspace",
              workspaceRoot: input.workspaceRoot,
              cause: "Folder not found",
            });
          }
          const rows = yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM projection_projects WHERE workspace_root = ${input.workspaceRoot} AND deleted_at IS NULL`;
          const existing = rows[0];
          const projectId = existing ? ProjectId.make(existing.project_id) : input.projectId;
          if (!existing) {
            yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
          VALUES (${projectId}, ${input.title}, ${input.workspaceRoot}, NULL, '[]', ${summary.createdAt}, ${summary.updatedAt}, NULL)`;
          }
          return {
            created: !existing,
            project: {
              id: projectId,
              title: input.title,
              workspaceRoot: input.workspaceRoot,
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: summary.createdAt,
              updatedAt: summary.updatedAt,
              deletedAt: null,
            },
          };
        }).pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "dispatch-project-command", cause }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(databaseLayer));
const importerProvided = copilotSessionImporterLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      storesProvided,
      eventSinkProvided,
      fakeStoreLayer,
      projectServiceProvided,
      NodeServices.layer,
    ),
  ),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  importerProvided,
  projectServiceProvided,
);

it.layer(TestLayer)("CopilotSessionImporter", (it) => {
  it.effect("imports a Copilot session as a copilot_import thread and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* CopilotSessionImporter;
      const projections = yield* ProjectionStoreV2;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${PROJECT_ID},
          'Copilot project',
          '/tmp/copilot-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;

      const countEvents = (threadId: ThreadId) =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

      const results = yield* Effect.all(
        [0, 1].map(() => importer.importSession({ sessionId: SESSION_ID, projectId: PROJECT_ID })),
        { concurrency: "unbounded" },
      );
      const first = results.find((result) => !result.alreadyImported);
      assert.equal(results.filter((result) => result.alreadyImported).length, 1);
      const threadId = ThreadId.make(`copilot-import-${SESSION_ID}`);
      assert.deepStrictEqual(first, {
        threadId,
        alreadyImported: false,
        importedItemCount: entries.length,
      });

      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.historyOrigin, "copilot_import");
      assert.equal(projection.thread.title, "Fix flaky test");
      assert.equal(projection.thread.projectId, PROJECT_ID);
      assert.equal(projection.thread.branch, "main");
      assert.equal(projection.thread.modelSelection.model, "gpt-5");
      assert.equal(projection.thread.createdBy, "system");
      assert.equal(DateTime.formatIso(projection.thread.createdAt), summary.createdAt);
      assert.equal(DateTime.formatIso(projection.thread.updatedAt), summary.updatedAt);

      const orderedItems = [...projection.turnItems].sort((a, b) => a.ordinal - b.ordinal);
      assert.deepStrictEqual(
        orderedItems.map((item) => [item.ordinal, item.type]),
        [
          [1, "user_message"],
          [2, "command_execution"],
          [3, "assistant_message"],
          [4, "user_message"],
          [5, "dynamic_tool"],
        ],
      );
      const shellItem = orderedItems[1];
      assert.equal(shellItem?.type, "command_execution");
      if (shellItem?.type === "command_execution") {
        assert.equal(shellItem.input, "pnpm test");
        assert.equal(shellItem.output, "1 failed");
        assert.equal(shellItem.status, "completed");
        assert.equal(shellItem.title, "Run tests");
        assert.equal(DateTime.formatIso(shellItem.startedAt!), "2026-02-01T10:00:02.000Z");
        assert.equal(DateTime.formatIso(shellItem.completedAt!), "2026-02-01T10:00:03.000Z");
      }
      const failedTool = orderedItems[4];
      assert.equal(failedTool?.type, "dynamic_tool");
      if (failedTool?.type === "dynamic_tool") {
        assert.equal(failedTool.toolName, "view");
        assert.equal(failedTool.status, "failed");
        assert.equal(failedTool.output, "denied");
      }

      assert.deepStrictEqual(
        projection.messages.map((message) => message.role),
        ["user", "assistant", "user"],
      );
      assert.deepStrictEqual(
        projection.messages.map((message) => message.text),
        ["Why is the test flaky?", "It races on the timer.", "Can you check the view?"],
      );
      assert.deepStrictEqual(
        projection.messages.map((message) => DateTime.formatIso(message.createdAt)),
        ["2026-02-01T10:00:01.000Z", "2026-02-01T10:00:04.000Z", "2026-02-01T10:01:00.000Z"],
      );

      const eventCountAfterFirst = yield* countEvents(threadId);
      // thread.created + 3 message.updated + 5 turn-item.updated + thread.metadata-updated
      // (command/dynamic tool entries only emit a turn-item).
      assert.equal(eventCountAfterFirst, 1 + 3 * 2 + 2 + 1);

      const second = yield* importer.importSession({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
      });
      assert.deepStrictEqual(second, {
        threadId,
        alreadyImported: true,
        importedItemCount: 0,
      });
      assert.equal(yield* countEvents(threadId), eventCountAfterFirst);
    }),
  );

  it.effect("fails when the target project does not exist", () =>
    Effect.gen(function* () {
      const importer = yield* CopilotSessionImporter;
      const error = yield* importer
        .importSession({
          sessionId: OTHER_SESSION_ID,
          projectId: ProjectId.make("project:missing"),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CopilotSessionImportError");
      assert.equal(error.sessionId, OTHER_SESSION_ID);
    }),
  );

  it.effect("imports readable history even when session and tool timestamps are malformed", () =>
    Effect.gen(function* () {
      const importer = yield* CopilotSessionImporter;
      const projections = yield* ProjectionStoreV2;
      const imported = yield* importer.importSession({
        sessionId: MALFORMED_SESSION_ID,
        projectId: PROJECT_ID,
      });
      const projection = yield* projections.getThreadProjection(imported.threadId);
      assert.equal(DateTime.formatIso(projection.thread.createdAt), "1970-01-01T00:00:00.000Z");
      assert.equal(projection.turnItems[0]?.type, "command_execution");
      assert.equal(
        DateTime.formatIso(projection.turnItems[0]!.completedAt!),
        "2026-02-02T10:00:00.000Z",
      );
    }),
  );

  it.effect("surfaces store read failures as import errors", () =>
    Effect.gen(function* () {
      const importer = yield* CopilotSessionImporter;
      const error = yield* importer
        .importSession({
          sessionId: "99999999-0000-0000-0000-000000000000",
          projectId: PROJECT_ID,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CopilotSessionImportError");
    }),
  );

  it.effect(
    "imports all by local folder, reuses projects, continues past failures, and safely retries",
    () =>
      Effect.gen(function* () {
        const importer = yield* CopilotSessionImporter;
        const projections = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const result = yield* importer.importAll;
        assert.equal(result.importedCount, 4);
        assert.equal(result.alreadyImportedCount, 0);
        assert.deepStrictEqual(
          result.failures.map((failure) => failure.sessionId),
          ["batch-no-folder", "batch-missing-folder", "batch-broken-transcript"],
        );
        const projectFor = (sessionId: string) =>
          projections
            .getThreadProjection(ThreadId.make(`copilot-import-${sessionId}`))
            .pipe(Effect.map((projection) => projection.thread.projectId));
        assert.equal(yield* projectFor("batch-existing"), PROJECT_ID);
        const newProject = yield* projectFor("batch-new");
        assert.equal(yield* projectFor("batch-same-root"), newProject);
        assert.notEqual(yield* projectFor("batch-cwd"), newProject);
        const countProjects = sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM projection_projects`.pipe(
          Effect.map((rows) => rows[0]!.count),
        );
        const projectCount = yield* countProjects;
        assert.equal(projectCount, 3);
        const retry = yield* importer.importAll;
        assert.equal(retry.importedCount, 0);
        assert.equal(retry.alreadyImportedCount, 4);
        assert.equal(retry.failures.length, 3);
        assert.equal(yield* countProjects, projectCount);
      }),
  );
});
