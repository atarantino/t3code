import { describe, expect, it } from "vite-plus/test";

import { parseCopilotEventsJsonl } from "./CopilotSessionParser.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

const lines = (...events: ReadonlyArray<unknown>) =>
  events.map((event) => JSON.stringify(event)).join("\n");

const fixture = lines(
  {
    type: "session.start",
    id: "evt-start",
    parentId: null,
    timestamp: "2026-01-01T10:00:00.000Z",
    data: {
      sessionId: SESSION_ID,
      startTime: "2026-01-01T10:00:00.000Z",
      context: {
        cwd: "/work/project",
        gitRoot: "/work/project",
        repository: "octo/project",
        branch: "main",
      },
    },
  },
  {
    type: "session.model_change",
    id: "evt-model",
    parentId: "evt-start",
    timestamp: "2026-01-01T10:00:01.000Z",
    data: { newModel: "model-alpha" },
  },
  {
    type: "system.message",
    id: "evt-system",
    parentId: "evt-model",
    timestamp: "2026-01-01T10:00:02.000Z",
    data: { content: "synthetic system prompt" },
  },
  {
    type: "user.message",
    id: "evt-user-1",
    parentId: "evt-system",
    timestamp: "2026-01-01T10:00:03.000Z",
    data: { content: "list the files", transformedContent: "ignored", source: "user" },
  },
  {
    type: "assistant.message",
    id: "evt-assistant-1",
    parentId: "evt-user-1",
    timestamp: "2026-01-01T10:00:04.000Z",
    data: {
      messageId: "msg-1",
      content: "",
      model: "model-beta",
      toolRequests: [
        {
          toolCallId: "call-ok",
          name: "bash",
          arguments: { command: "ls -la" },
          toolTitle: "Listing files",
        },
      ],
    },
  },
  {
    type: "tool.execution_start",
    id: "evt-tool-start-ok",
    parentId: "evt-assistant-1",
    timestamp: "2026-01-01T10:00:05.000Z",
    data: { toolCallId: "call-ok", toolName: "bash", arguments: { command: "ls -la" } },
  },
  {
    type: "tool.execution_complete",
    id: "evt-tool-complete-ok",
    parentId: "evt-tool-start-ok",
    timestamp: "2026-01-01T10:00:06.000Z",
    data: { toolCallId: "call-ok", success: true, result: { content: "a.txt\nb.txt" } },
  },
  {
    type: "assistant.message",
    id: "evt-assistant-2",
    parentId: "evt-tool-complete-ok",
    timestamp: "2026-01-01T10:00:07.000Z",
    data: {
      messageId: "msg-2",
      content: "There are two files.",
      model: "model-beta",
      toolRequests: [
        {
          toolCallId: "call-rejected",
          name: "write_file",
          arguments: { path: "synthetic.txt" },
        },
      ],
    },
  },
  {
    type: "tool.execution_start",
    id: "evt-tool-start-rejected",
    parentId: "evt-assistant-2",
    timestamp: "2026-01-01T10:00:08.000Z",
    data: { toolCallId: "call-rejected", toolName: "write_file", arguments: { path: "x" } },
  },
  {
    type: "tool.execution_complete",
    id: "evt-tool-complete-rejected",
    parentId: "evt-tool-start-rejected",
    timestamp: "2026-01-01T10:00:09.000Z",
    data: {
      toolCallId: "call-rejected",
      success: false,
      error: { message: "Permission denied by user", code: "rejected" },
    },
  },
  {
    type: "session.resume",
    id: "evt-resume",
    parentId: "evt-tool-complete-rejected",
    timestamp: "2026-01-01T10:01:00.000Z",
    data: {
      selectedModel: "model-gamma",
      context: { cwd: "/work/project/sub", branch: "feature" },
    },
  },
  {
    type: "reasoning.delta",
    id: "evt-reasoning",
    parentId: "evt-resume",
    timestamp: "2026-01-01T10:01:01.000Z",
    data: { encryptedContent: "opaque" },
  },
  "{ this is not json",
  "",
  {
    type: "user.message",
    id: "evt-user-2",
    parentId: "evt-reasoning",
    timestamp: "2026-01-01T10:02:00.000Z",
    data: { content: "thanks", source: "user" },
  },
);

describe("parseCopilotEventsJsonl", () => {
  it("parses session metadata, model, and timestamps", () => {
    const session = parseCopilotEventsJsonl(SESSION_ID, fixture);

    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.cwd).toBe("/work/project/sub");
    expect(session.gitRoot).toBe("/work/project");
    expect(session.repository).toBe("octo/project");
    expect(session.branch).toBe("feature");
    expect(session.model).toBe("model-gamma");
    expect(session.startedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(session.updatedAt).toBe("2026-01-01T10:02:00.000Z");
    expect(session.firstUserMessage).toBe("list the files");
  });

  it("emits user, assistant, and tool entries in completion order", () => {
    const { entries } = parseCopilotEventsJsonl(SESSION_ID, fixture);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    expect(entries[0]).toEqual({
      kind: "user",
      id: "evt-user-1",
      text: "list the files",
      timestamp: "2026-01-01T10:00:03.000Z",
    });
  });

  it("maps successful and rejected tool executions", () => {
    const { entries } = parseCopilotEventsJsonl(SESSION_ID, fixture);
    const okTool = entries[1];
    const rejectedTool = entries[3];

    expect(okTool).toEqual({
      kind: "tool",
      id: "call-ok",
      toolName: "bash",
      title: "Listing files",
      input: { command: "ls -la" },
      status: "completed",
      output: "a.txt\nb.txt",
      startedAt: "2026-01-01T10:00:05.000Z",
      completedAt: "2026-01-01T10:00:06.000Z",
    });
    expect(rejectedTool).toMatchObject({
      kind: "tool",
      id: "call-rejected",
      toolName: "write_file",
      title: null,
      status: "failed",
      output: "Permission denied by user",
    });
  });

  it("drops assistant messages with empty text but keeps their tool calls", () => {
    const { entries } = parseCopilotEventsJsonl(SESSION_ID, fixture);

    expect(entries.some((entry) => entry.kind === "assistant" && entry.id === "msg-1")).toBe(false);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: "assistant", id: "msg-2", text: "There are two files." }),
    );
  });

  it("ignores system messages, reasoning blobs, and malformed lines", () => {
    const { entries } = parseCopilotEventsJsonl(SESSION_ID, fixture);

    expect(entries.map((entry) => entry.id)).not.toContain("evt-system");
    expect(entries.map((entry) => entry.id)).not.toContain("evt-reasoning");
    expect(entries).toHaveLength(5);
  });

  it("emits a started-but-never-completed tool as failed with null output", () => {
    const jsonl = lines(
      {
        type: "assistant.message",
        id: "evt-a",
        timestamp: "2026-02-01T00:00:00.000Z",
        data: {
          messageId: "msg-a",
          content: "running",
          toolRequests: [
            { toolCallId: "call-hang", name: "bash", arguments: { command: "sleep 9" } },
          ],
        },
      },
      {
        type: "tool.execution_start",
        id: "evt-s",
        timestamp: "2026-02-01T00:00:01.000Z",
        data: { toolCallId: "call-hang", toolName: "bash", arguments: { command: "sleep 9" } },
      },
    );

    const { entries } = parseCopilotEventsJsonl(SESSION_ID, jsonl);

    expect(entries).toEqual([
      expect.objectContaining({ kind: "assistant", id: "msg-a", text: "running" }),
      {
        kind: "tool",
        id: "call-hang",
        toolName: "bash",
        title: null,
        input: { command: "sleep 9" },
        status: "failed",
        output: null,
        startedAt: "2026-02-01T00:00:01.000Z",
        completedAt: "2026-02-01T00:00:01.000Z",
      },
    ]);
  });

  it("skips tool requests that never had execution events", () => {
    const jsonl = lines({
      type: "assistant.message",
      id: "evt-a",
      timestamp: "2026-02-01T00:00:00.000Z",
      data: {
        messageId: "msg-a",
        content: "I will not run this",
        toolRequests: [{ toolCallId: "call-unused", name: "bash", arguments: {} }],
      },
    });

    const { entries } = parseCopilotEventsJsonl(SESSION_ID, jsonl);

    expect(entries.map((entry) => entry.kind)).toEqual(["assistant"]);
  });

  it("returns an empty transcript for empty input", () => {
    const session = parseCopilotEventsJsonl(SESSION_ID, "");

    expect(session.entries).toEqual([]);
    expect(session.firstUserMessage).toBeNull();
    expect(session.model).toBeNull();
    expect(session.cwd).toBeNull();
  });
});
