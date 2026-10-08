import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CopilotBatchImportResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ProjectService } from "../project/ProjectService.ts";
import type { CopilotTranscriptEntry, ParsedCopilotSession } from "./CopilotSessionParser.ts";
import { CopilotSessionStore, type CopilotSessionSummary } from "./CopilotSessionStore.ts";

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "powershell", "run_in_terminal"]);
const COPILOT_PROVIDER_INSTANCE_ID = ProviderInstanceId.make("copilot");
const EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

export interface CopilotSessionImportInput {
  readonly sessionId: string;
  readonly projectId: ProjectId;
}

export interface CopilotSessionImportResult {
  readonly threadId: ThreadId;
  readonly alreadyImported: boolean;
  readonly importedItemCount: number;
}

export class CopilotSessionImportError extends Schema.TaggedErrorClass<CopilotSessionImportError>()(
  "CopilotSessionImportError",
  {
    operation: Schema.String,
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} Copilot session ${this.sessionId}.`;
  }
}

export interface CopilotSessionImporterShape {
  readonly importAll: Effect.Effect<
    OrchestrationV2CopilotBatchImportResult,
    CopilotSessionImportError,
    ProjectService
  >;
  readonly importSession: (
    input: CopilotSessionImportInput,
  ) => Effect.Effect<CopilotSessionImportResult, CopilotSessionImportError>;
}

export class CopilotSessionImporter extends Context.Service<
  CopilotSessionImporter,
  CopilotSessionImporterShape
>()("t3/copilotImport/CopilotSessionImporter") {}

/** Deterministic thread id so re-importing the same Copilot session is idempotent. */
export function copilotImportThreadId(sessionId: string): ThreadId {
  return ThreadId.make(`copilot-import-${sessionId}`);
}

function importPrefix(sessionId: string): string {
  return `import:copilot:${sessionId}`;
}

const decodeDateTime = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);
const isCopilotSessionImportError = Schema.is(CopilotSessionImportError);

function dateTimeOr(value: string | null | undefined, fallback: DateTime.Utc): DateTime.Utc {
  if (value === null || value === undefined) return fallback;
  return Option.getOrElse(decodeDateTime(value), () => fallback);
}

function commandInput(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = (input as { readonly command: unknown }).command;
    if (typeof command === "string") return command;
  }
  return JSON.stringify(input) ?? "";
}

function threadFor(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly summary: CopilotSessionSummary;
  readonly session: ParsedCopilotSession;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "system",
    creationSource: "server",
    id: input.threadId,
    projectId: input.projectId,
    title: input.summary.title,
    providerInstanceId: COPILOT_PROVIDER_INSTANCE_ID,
    modelSelection: {
      instanceId: COPILOT_PROVIDER_INSTANCE_ID,
      model: input.session.model ?? "auto",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.session.branch,
    worktreePath: null,
    activeProviderThreadId: null,
    historyOrigin: "copilot_import",
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

/**
 * Builds the message/turn-item events for one transcript entry. Tool entries
 * only produce a turn-item (their output is carried on the item itself).
 */
function entryEvents(input: {
  readonly threadId: ThreadId;
  readonly prefix: string;
  readonly entry: CopilotTranscriptEntry;
  readonly ordinal: number;
}): {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly turnItemId: TurnItemId;
} {
  const { threadId, prefix, entry, ordinal } = input;
  const turnItemId = TurnItemId.make(`${prefix}:turn-item:${entry.id}`);
  const eventIdBase = `${prefix}:turn-item:${entry.id}`;

  if (entry.kind === "tool") {
    const startedAt = dateTimeOr(entry.startedAt, dateTimeOr(entry.completedAt, EPOCH));
    const completedAt = dateTimeOr(entry.completedAt, startedAt);
    const base = {
      id: turnItemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: entry.status,
      title: entry.title,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    };
    const turnItem: OrchestrationV2TurnItem = SHELL_TOOL_NAMES.has(entry.toolName)
      ? {
          ...base,
          type: "command_execution",
          input: commandInput(entry.input),
          ...(entry.output === null ? {} : { output: entry.output }),
        }
      : {
          ...base,
          type: "dynamic_tool",
          toolName: entry.toolName.trim() === "" ? null : entry.toolName,
          input: entry.input,
          ...(entry.output === null ? {} : { output: entry.output }),
        };
    return {
      turnItemId,
      events: [
        {
          id: EventId.make(eventIdBase),
          type: "turn-item.updated",
          threadId,
          occurredAt: completedAt,
          payload: turnItem,
        },
      ],
    };
  }

  const createdAt = dateTimeOr(entry.timestamp, EPOCH);
  const messageId = MessageId.make(`${prefix}:message:${entry.id}`);
  const attachments: OrchestrationV2ConversationMessage["attachments"] = [];

  if (entry.kind === "user") {
    const message: OrchestrationV2ConversationMessage = {
      createdBy: "user",
      creationSource: "server",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: entry.text,
      attachments,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: turnItemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: createdAt,
      completedAt: createdAt,
      updatedAt: createdAt,
      createdBy: "user",
      creationSource: "server",
      type: "user_message",
      messageId,
      inputIntent: "turn_start",
      text: entry.text,
      attachments,
    };
    return {
      turnItemId,
      events: [
        {
          id: EventId.make(`${prefix}:message:${entry.id}`),
          type: "message.updated",
          threadId,
          occurredAt: createdAt,
          payload: message,
        },
        {
          id: EventId.make(eventIdBase),
          type: "turn-item.updated",
          threadId,
          occurredAt: createdAt,
          payload: turnItem,
        },
      ],
    };
  }

  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: "assistant",
    text: entry.text,
    attachments,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
  const turnItem: OrchestrationV2TurnItem = {
    id: turnItemId,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: createdAt,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "assistant_message",
    messageId,
    text: entry.text,
    streaming: false,
  };
  return {
    turnItemId,
    events: [
      {
        id: EventId.make(`${prefix}:message:${entry.id}`),
        type: "message.updated",
        threadId,
        occurredAt: createdAt,
        payload: message,
      },
      {
        id: EventId.make(eventIdBase),
        type: "turn-item.updated",
        threadId,
        occurredAt: createdAt,
        payload: turnItem,
      },
    ],
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* CopilotSessionStore;
  const eventSink = yield* EventSinkV2;
  const path = yield* Path.Path;
  const sessionImports = yield* makeKeyedSerialExecutor<string>();

  const threadExists = (threadId: ThreadId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'thread.created'
    `.pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0));

  const projectExists = (projectId: ProjectId) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_projects
      WHERE project_id = ${projectId}
        AND deleted_at IS NULL
    `.pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0));

  const importLocked = (input: CopilotSessionImportInput) =>
    Effect.gen(function* () {
      const threadId = copilotImportThreadId(input.sessionId);
      if (yield* threadExists(threadId)) {
        return { threadId, alreadyImported: true, importedItemCount: 0 };
      }
      if (!(yield* projectExists(input.projectId))) {
        return yield* new CopilotSessionImportError({
          operation: "import",
          sessionId: input.sessionId,
          cause: new Error(`Project ${input.projectId} does not exist.`),
        });
      }

      const { summary, session } = yield* store.read(input.sessionId);
      const prefix = importPrefix(input.sessionId);
      const createdAt = dateTimeOr(summary.createdAt, dateTimeOr(session.startedAt, EPOCH));
      const updatedAt = dateTimeOr(summary.updatedAt, createdAt);
      const thread = threadFor({
        threadId,
        projectId: input.projectId,
        summary,
        session,
        createdAt,
        updatedAt,
      });

      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(`${prefix}:thread:created`),
          type: "thread.created",
          threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: createdAt,
          payload: thread,
        },
      ];
      session.entries.forEach((entry, index) => {
        const ordinal = index + 1;
        const built = entryEvents({ threadId, prefix, entry, ordinal });
        events.push(...built.events);
      });
      events.push({
        id: EventId.make(`${prefix}:thread:shell`),
        type: "thread.metadata-updated",
        threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: updatedAt,
        payload: thread,
      });

      // The sink allocates positions and commits events and projections together,
      // then publishes the committed history to connected clients.
      yield* eventSink.write({ events });

      return {
        threadId,
        alreadyImported: false,
        importedItemCount: session.entries.length,
      };
    });

  const importSession = (input: CopilotSessionImportInput) =>
    sessionImports.withLock(input.sessionId, importLocked(input)).pipe(
      Effect.mapError((cause) =>
        isCopilotSessionImportError(cause)
          ? cause
          : new CopilotSessionImportError({
              operation: "import",
              sessionId: input.sessionId,
              cause,
            }),
      ),
    );

  const importAll = sessionImports
    .withLock(
      "batch",
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const sessions = yield* store.list;
        let importedCount = 0;
        let alreadyImportedCount = 0;
        const failures: Array<OrchestrationV2CopilotBatchImportResult["failures"][number]> = [];
        const projectIds = new Map<string, ProjectId>();
        for (const summary of sessions) {
          const workspaceRoot = summary.gitRoot ?? summary.cwd;
          yield* sessionImports
            .withLock(
              summary.sessionId,
              Effect.gen(function* () {
                if (yield* threadExists(copilotImportThreadId(summary.sessionId))) {
                  alreadyImportedCount++;
                  return;
                }
                if (workspaceRoot === null || !path.isAbsolute(workspaceRoot)) {
                  return yield* new CopilotSessionImportError({
                    operation: "find an absolute local workspace for",
                    sessionId: summary.sessionId,
                  });
                }
                const normalizedRoot = path.normalize(workspaceRoot);
                let projectId = projectIds.get(normalizedRoot);
                if (projectId === undefined) {
                  const { project } = yield* projects.bootstrap({
                    commandId: CommandId.make(yield* randomUuidV4),
                    projectId: ProjectId.make(yield* randomUuidV4),
                    title: path.basename(normalizedRoot) || normalizedRoot,
                    workspaceRoot: normalizedRoot,
                    createWorkspaceRootIfMissing: false,
                  });
                  projectId = project.id;
                  projectIds.set(normalizedRoot, projectId);
                }
                yield* importLocked({ sessionId: summary.sessionId, projectId });
                importedCount++;
              }),
            )
            .pipe(
              Effect.catch((cause) =>
                Effect.sync(() => {
                  failures.push({
                    sessionId: summary.sessionId,
                    title: summary.title,
                    workspaceRoot,
                    message: cause.message,
                  });
                }),
              ),
            );
        }
        return { importedCount, alreadyImportedCount, failures };
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CopilotSessionImportError({
            operation: "list sessions for importing",
            sessionId: "all",
            cause,
          }),
      ),
    );

  return CopilotSessionImporter.of({ importSession, importAll });
});

export const layer: Layer.Layer<
  CopilotSessionImporter,
  never,
  CopilotSessionStore | EventSinkV2 | SqlClient.SqlClient | Path.Path
> = Layer.effect(CopilotSessionImporter, make);
