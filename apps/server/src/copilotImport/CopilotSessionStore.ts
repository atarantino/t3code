/**
 * CopilotSessionStore - Reads GitHub Copilot CLI session history from disk.
 *
 * Scans `<copilotHome>/session-state/<uuid>/` directories, parsing `events.jsonl`
 * (source of truth) plus the small `workspace.yaml` metadata file and the
 * `inuse.<pid>.lock` marker that indicates a live session.
 *
 * @module CopilotSessionStore
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseCopilotEventsJsonl, type ParsedCopilotSession } from "./CopilotSessionParser.ts";

const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;
const LOCK_FILE_PATTERN = /^inuse\.\d+\.lock$/;
const DEFAULT_TITLE = "Copilot session";
const MAX_TITLE_LENGTH = 120;
const SCAN_CONCURRENCY = 8;

export interface CopilotSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly gitRoot: string | null;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly clientName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly inUse: boolean;
}

export class CopilotSessionStoreError extends Schema.TaggedErrorClass<CopilotSessionStoreError>()(
  "CopilotSessionStoreError",
  {
    operation: Schema.String,
    sessionId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const target = this.sessionId === undefined ? "" : ` session ${this.sessionId}`;
    return `Failed to ${this.operation} GitHub Copilot CLI${target}.`;
  }
}

export interface CopilotSessionStoreShape {
  /** All sessions with at least one user/assistant message, most recently updated first. */
  readonly list: Effect.Effect<ReadonlyArray<CopilotSessionSummary>, CopilotSessionStoreError>;
  /** Read one session's summary and parsed transcript. */
  readonly read: (sessionId: string) => Effect.Effect<
    {
      readonly summary: CopilotSessionSummary;
      readonly session: ParsedCopilotSession;
    },
    CopilotSessionStoreError
  >;
}

export class CopilotSessionStore extends Context.Service<
  CopilotSessionStore,
  CopilotSessionStoreShape
>()("t3/copilotImport/CopilotSessionStore") {}

export function defaultCopilotHome(): string {
  const fromEnv = process.env.COPILOT_HOME;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return `${NodeOS.homedir()}/.copilot`;
}

/** Parse the flat `key: value` subset of `workspace.yaml`. */
export function parseWorkspaceYaml(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function nonEmpty(value: string | undefined | null): string | null {
  return value === undefined || value === null || value.trim().length === 0 ? null : value;
}

function toSingleLineTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
}

function resolveTitle(workspaceName: string | null, firstUserMessage: string | null): string {
  const candidates = [workspaceName, firstUserMessage];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const title = toSingleLineTitle(candidate);
    if (title.length > 0) return title;
  }
  return DEFAULT_TITLE;
}

const isNotFound = (error: { readonly reason: { readonly _tag: string } }) =>
  error.reason._tag === "NotFound";

export const make = (copilotHome: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sessionStateDir = path.join(copilotHome, "session-state");

    const readSession = (sessionId: string) =>
      Effect.gen(function* () {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          return yield* new CopilotSessionStoreError({
            operation: "read",
            sessionId,
            cause: new Error("Invalid Copilot session id."),
          });
        }

        const sessionDir = path.join(sessionStateDir, sessionId);
        const entries = yield* fs
          .readDirectory(sessionDir)
          .pipe(
            Effect.mapError(
              (cause) => new CopilotSessionStoreError({ operation: "read", sessionId, cause }),
            ),
          );
        if (!entries.includes("events.jsonl")) {
          return yield* new CopilotSessionStoreError({ operation: "read", sessionId });
        }

        const jsonl = yield* fs
          .readFileString(path.join(sessionDir, "events.jsonl"))
          .pipe(
            Effect.mapError(
              (cause) => new CopilotSessionStoreError({ operation: "read", sessionId, cause }),
            ),
          );

        const workspace = entries.includes("workspace.yaml")
          ? yield* fs.readFileString(path.join(sessionDir, "workspace.yaml")).pipe(
              Effect.map(parseWorkspaceYaml),
              Effect.catch((cause) =>
                Effect.logWarning("Ignoring unreadable Copilot workspace.yaml", {
                  sessionId,
                  cause,
                }).pipe(Effect.as({} as Record<string, string>)),
              ),
            )
          : ({} as Record<string, string>);

        const session = parseCopilotEventsJsonl(sessionId, jsonl);
        const messageCount = session.entries.filter(
          (entry) => entry.kind === "user" || entry.kind === "assistant",
        ).length;

        const summary: CopilotSessionSummary = {
          sessionId,
          title: resolveTitle(nonEmpty(workspace.name), session.firstUserMessage),
          cwd: session.cwd,
          gitRoot: session.gitRoot ?? nonEmpty(workspace.git_root),
          repository: session.repository,
          branch: session.branch,
          clientName: nonEmpty(workspace.client_name),
          createdAt: nonEmpty(workspace.created_at) ?? session.startedAt,
          updatedAt: session.updatedAt,
          messageCount,
          inUse: entries.some((name) => LOCK_FILE_PATTERN.test(name)),
        };

        return { summary, session };
      });

    const list: CopilotSessionStoreShape["list"] = Effect.gen(function* () {
      const dirEntries = yield* fs
        .readDirectory(sessionStateDir)
        .pipe(
          Effect.catch((cause) =>
            isNotFound(cause)
              ? Effect.succeed([] as Array<string>)
              : Effect.fail(new CopilotSessionStoreError({ operation: "list", cause })),
          ),
        );
      const sessionIds = dirEntries.filter((name) => SESSION_ID_PATTERN.test(name));

      const results = yield* Effect.forEach(
        sessionIds,
        (sessionId) =>
          readSession(sessionId).pipe(
            Effect.map((result) => result.summary),
            Effect.catch((error) =>
              // Sessions without events.jsonl (e.g. checkpoint-only dirs) are expected and silent.
              (error.cause === undefined
                ? Effect.void
                : Effect.logWarning("Skipping unreadable GitHub Copilot CLI session", {
                    sessionId,
                    operation: error.operation,
                  })
              ).pipe(Effect.as(null)),
            ),
          ),
        { concurrency: SCAN_CONCURRENCY },
      );

      return results
        .filter(
          (summary): summary is CopilotSessionSummary =>
            summary !== null && summary.messageCount > 0,
        )
        .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    });

    return {
      list,
      read: readSession,
    } satisfies CopilotSessionStoreShape;
  });

/** Build the store layer for an explicit Copilot home directory (used by tests). */
export const makeLayer = (options: { readonly copilotHome: string }) =>
  Layer.effect(CopilotSessionStore, make(options.copilotHome));

/** Store layer reading `COPILOT_HOME` or `~/.copilot`, resolved when the layer is built. */
export const layer = Layer.effect(
  CopilotSessionStore,
  Effect.suspend(() => make(defaultCopilotHome())),
);
