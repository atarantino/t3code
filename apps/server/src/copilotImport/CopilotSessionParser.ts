/**
 * CopilotSessionParser - Pure transcript parser for GitHub Copilot CLI sessions.
 *
 * Converts the newline-delimited `events.jsonl` log of a Copilot CLI session into
 * a normalized transcript. Malformed and unknown events are ignored so a partially
 * corrupted log still yields the readable portion of the conversation.
 *
 * @module CopilotSessionParser
 */

export type CopilotTranscriptEntry =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      readonly timestamp: string;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly model: string | null;
      readonly timestamp: string;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly toolName: string;
      readonly title: string | null;
      readonly input: unknown;
      readonly status: "completed" | "failed";
      readonly output: string | null;
      readonly startedAt: string;
      readonly completedAt: string;
    };

export interface ParsedCopilotSession {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly gitRoot: string | null;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly firstUserMessage: string | null;
  readonly entries: ReadonlyArray<CopilotTranscriptEntry>;
}

interface SessionContext {
  readonly cwd: string | null;
  readonly gitRoot: string | null;
  readonly repository: string | null;
  readonly branch: string | null;
}

interface ToolRequestInfo {
  readonly name: string;
  readonly title: string | null;
  readonly arguments: unknown;
  readonly timestamp: string;
}

interface PendingToolStart {
  readonly toolName: string;
  readonly title: string | null;
  readonly input: unknown;
  readonly startedAt: string;
}

type JsonRecord = Record<string, unknown>;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseEventLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function contextFromData(data: JsonRecord): SessionContext | null {
  const context = data.context;
  if (!isRecord(context)) {
    return null;
  }
  return {
    cwd: nonEmptyString(context.cwd),
    gitRoot: nonEmptyString(context.gitRoot),
    repository: nonEmptyString(context.repository),
    branch: nonEmptyString(context.branch),
  };
}

function stringifyOutput(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Parse the contents of a Copilot CLI `events.jsonl` file.
 *
 * Entries are emitted in event order. A tool entry is emitted when its
 * `tool.execution_complete` event is seen; tool executions that started but never
 * completed are emitted at the end as `failed` with a null output.
 */
export function parseCopilotEventsJsonl(sessionId: string, jsonl: string): ParsedCopilotSession {
  let context: SessionContext = {
    cwd: null,
    gitRoot: null,
    repository: null,
    branch: null,
  };
  let model: string | null = null;
  let startedAt: string | null = null;
  let updatedAt: string | null = null;
  let firstUserMessage: string | null = null;
  const entries: CopilotTranscriptEntry[] = [];
  const toolRequests = new Map<string, ToolRequestInfo>();
  const pendingStarts = new Map<string, PendingToolStart>();

  for (const line of jsonl.split(/\r?\n/)) {
    const event = parseEventLine(line);
    if (event === null) {
      continue;
    }

    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (timestamp !== null) {
      startedAt ??= timestamp;
      updatedAt = timestamp;
    }
    const data = isRecord(event.data) ? event.data : {};
    const eventId = typeof event.id === "string" ? event.id : null;

    switch (event.type) {
      case "session.start":
      case "session.resume": {
        const nextContext = contextFromData(data);
        if (nextContext !== null) {
          context = {
            cwd: nextContext.cwd ?? context.cwd,
            gitRoot: nextContext.gitRoot ?? context.gitRoot,
            repository: nextContext.repository ?? context.repository,
            branch: nextContext.branch ?? context.branch,
          };
        }
        if (event.type === "session.resume") {
          model = nonEmptyString(data.selectedModel) ?? model;
        }
        break;
      }

      case "session.model_change": {
        model = nonEmptyString(data.newModel) ?? model;
        break;
      }

      case "user.message": {
        const text = typeof data.content === "string" ? data.content : "";
        if (text.trim().length === 0 || eventId === null || timestamp === null) {
          break;
        }
        entries.push({ kind: "user", id: eventId, text, timestamp });
        firstUserMessage ??= text.trim();
        break;
      }

      case "assistant.message": {
        const messageModel = nonEmptyString(data.model);
        if (messageModel !== null) {
          model = messageModel;
        }
        const messageId =
          nonEmptyString(data.messageId) ?? eventId ?? `assistant:${entries.length}`;
        const messageTimestamp = timestamp ?? EPOCH_ISO;
        const toolRequestList = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of toolRequestList) {
          if (!isRecord(request)) {
            continue;
          }
          const toolCallId = nonEmptyString(request.toolCallId);
          const name = nonEmptyString(request.name);
          if (toolCallId === null || name === null) {
            continue;
          }
          toolRequests.set(toolCallId, {
            name,
            title: nonEmptyString(request.toolTitle),
            arguments: request.arguments,
            timestamp: messageTimestamp,
          });
        }
        const text = typeof data.content === "string" ? data.content : "";
        if (text.trim().length > 0) {
          entries.push({
            kind: "assistant",
            id: messageId,
            text,
            model: messageModel,
            timestamp: messageTimestamp,
          });
        }
        break;
      }

      case "tool.execution_start": {
        const toolCallId = nonEmptyString(data.toolCallId);
        if (toolCallId === null) {
          break;
        }
        const request = toolRequests.get(toolCallId);
        pendingStarts.set(toolCallId, {
          toolName: nonEmptyString(data.toolName) ?? request?.name ?? "unknown",
          title: request?.title ?? null,
          input: data.arguments !== undefined ? data.arguments : request?.arguments,
          startedAt: timestamp ?? EPOCH_ISO,
        });
        break;
      }

      case "tool.execution_complete": {
        const toolCallId = nonEmptyString(data.toolCallId);
        if (toolCallId === null) {
          break;
        }
        const pending = pendingStarts.get(toolCallId);
        const request = toolRequests.get(toolCallId);
        if (pending === undefined && request === undefined) {
          break;
        }
        pendingStarts.delete(toolCallId);

        const error = isRecord(data.error) ? data.error : null;
        const result = isRecord(data.result) ? data.result : null;
        const failed = data.success === false || error !== null;
        const output =
          error !== null ? stringifyOutput(error.message) : stringifyOutput(result?.content);

        const completedAt = timestamp ?? EPOCH_ISO;
        entries.push({
          kind: "tool",
          id: toolCallId,
          toolName: pending?.toolName ?? request?.name ?? "unknown",
          title: pending?.title ?? request?.title ?? null,
          input: pending !== undefined ? pending.input : request?.arguments,
          status: failed ? "failed" : "completed",
          output,
          startedAt: pending?.startedAt ?? request?.timestamp ?? completedAt,
          completedAt,
        });
        break;
      }

      default:
        break;
    }
  }

  const endTimestamp = updatedAt ?? EPOCH_ISO;
  for (const [toolCallId, pending] of pendingStarts) {
    entries.push({
      kind: "tool",
      id: toolCallId,
      toolName: pending.toolName,
      title: pending.title,
      input: pending.input,
      status: "failed",
      output: null,
      startedAt: pending.startedAt,
      completedAt: endTimestamp,
    });
  }

  return {
    sessionId,
    cwd: context.cwd,
    gitRoot: context.gitRoot,
    repository: context.repository,
    branch: context.branch,
    model,
    startedAt: startedAt ?? EPOCH_ISO,
    updatedAt: endTimestamp,
    firstUserMessage,
    entries,
  };
}
