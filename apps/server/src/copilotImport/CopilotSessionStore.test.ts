import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CopilotSessionStore,
  CopilotSessionStoreError,
  type CopilotSessionStoreShape,
  makeLayer,
  parseWorkspaceYaml,
} from "./CopilotSessionStore.ts";

const SESSION_A = "aaaaaaaa-1111-4222-8333-444444444444";
const SESSION_B = "bbbbbbbb-1111-4222-8333-444444444444";
const SESSION_EMPTY = "cccccccc-1111-4222-8333-444444444444";
const SESSION_NO_EVENTS = "dddddddd-1111-4222-8333-444444444444";

const jsonl = (...events: ReadonlyArray<unknown>) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const messageEvents = (id: string, content: string, timestamp: string) => ({
  type: "user.message",
  id,
  timestamp,
  data: { content, source: "user" },
});

const isStoreError = Schema.is(CopilotSessionStoreError);

const writeSession = Effect.fn("writeSession")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly files: Record<string, string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.root, "session-state", input.sessionId);
  yield* fs.makeDirectory(dir, { recursive: true });
  for (const [name, contents] of Object.entries(input.files)) {
    yield* fs.writeFileString(path.join(dir, name), contents);
  }
});

const makeFixtureHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-import-store-" });

  yield* writeSession({
    root,
    sessionId: SESSION_A,
    files: {
      "events.jsonl": jsonl(
        {
          type: "session.start",
          id: "s1",
          timestamp: "2026-03-01T09:00:00.000Z",
          data: {
            sessionId: SESSION_A,
            context: {
              cwd: "/work/alpha",
              gitRoot: "/work/alpha",
              repository: "octo/alpha",
              branch: "main",
            },
          },
        },
        {
          type: "session.model_change",
          id: "s2",
          timestamp: "2026-03-01T09:00:01.000Z",
          data: { newModel: "model-alpha" },
        },
        messageEvents("u1", "first question\nwith a second line", "2026-03-01T09:00:02.000Z"),
        {
          type: "assistant.message",
          id: "a1",
          timestamp: "2026-03-01T09:00:03.000Z",
          data: { messageId: "m1", content: "an answer", model: "model-alpha", toolRequests: [] },
        },
      ),
      "workspace.yaml": [
        "id: aaaaaaaa-1111-4222-8333-444444444444",
        'name: "  Named   session  "',
        "user_named: true",
        "client_name: synthetic-client",
        "git_root: /work/alpha",
        "created_at: 2026-03-01T08:59:00.000Z",
        "updated_at: 2026-03-01T09:00:03.000Z",
        "",
      ].join("\n"),
      "inuse.4242.lock": "",
    },
  });

  yield* writeSession({
    root,
    sessionId: SESSION_B,
    files: {
      "events.jsonl": jsonl(
        {
          type: "session.start",
          id: "b1",
          timestamp: "2026-03-05T12:00:00.000Z",
          data: { sessionId: SESSION_B, context: { cwd: "/work/beta" } },
        },
        messageEvents("bu1", "beta question that is quite long", "2026-03-05T12:00:01.000Z"),
      ),
    },
  });

  yield* writeSession({
    root,
    sessionId: SESSION_EMPTY,
    files: {
      "events.jsonl": jsonl({
        type: "session.start",
        id: "c1",
        timestamp: "2026-03-10T12:00:00.000Z",
        data: { sessionId: SESSION_EMPTY, context: {} },
      }),
    },
  });

  yield* writeSession({
    root,
    sessionId: SESSION_NO_EVENTS,
    files: { "workspace.yaml": "name: orphan\n" },
  });

  return root;
});

const withFixtureHome = <A, E>(body: (store: CopilotSessionStoreShape) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const root = yield* makeFixtureHome;
    return yield* Effect.gen(function* () {
      const store = yield* CopilotSessionStore;
      return yield* body(store);
    }).pipe(Effect.provide(makeLayer({ copilotHome: root })));
  }).pipe(Effect.provide(NodeServices.layer));

describe("parseWorkspaceYaml", () => {
  it("parses flat key/value pairs, strips quotes, and ignores comments", () => {
    const parsed = parseWorkspaceYaml(
      ["# comment", "name: 'quoted name'", 'client_name: "cli"', "branch:", "bare: value"].join(
        "\n",
      ),
    );

    assert.deepStrictEqual(parsed, {
      name: "quoted name",
      client_name: "cli",
      branch: "",
      bare: "value",
    });
  });
});

describe("CopilotSessionStore", () => {
  it.effect("lists sessions with messages, newest first, with metadata and titles", () =>
    withFixtureHome((store) =>
      Effect.gen(function* () {
        const sessions = yield* store.list;

        assert.deepStrictEqual(
          sessions.map((session) => session.sessionId),
          [SESSION_B, SESSION_A],
        );

        const alpha = sessions[1]!;
        assert.strictEqual(alpha.title, "Named session");
        assert.strictEqual(alpha.cwd, "/work/alpha");
        assert.strictEqual(alpha.gitRoot, "/work/alpha");
        assert.strictEqual(alpha.repository, "octo/alpha");
        assert.strictEqual(alpha.branch, "main");
        assert.strictEqual(alpha.clientName, "synthetic-client");
        assert.strictEqual(alpha.createdAt, "2026-03-01T08:59:00.000Z");
        assert.strictEqual(alpha.updatedAt, "2026-03-01T09:00:03.000Z");
        assert.strictEqual(alpha.messageCount, 2);
        assert.strictEqual(alpha.inUse, true);

        const beta = sessions[0]!;
        assert.strictEqual(beta.title, "beta question that is quite long");
        assert.strictEqual(beta.clientName, null);
        assert.strictEqual(beta.inUse, false);
        assert.strictEqual(beta.messageCount, 1);
      }),
    ),
  );

  it.effect("returns an empty list when the Copilot home does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-import-missing-" });
      const sessions = yield* Effect.gen(function* () {
        const store = yield* CopilotSessionStore;
        return yield* store.list;
      }).pipe(Effect.provide(makeLayer({ copilotHome: path.join(root, "absent") })));

      assert.deepStrictEqual(sessions, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads one session's summary and transcript", () =>
    withFixtureHome((store) =>
      Effect.gen(function* () {
        const { summary, session } = yield* store.read(SESSION_A);

        assert.strictEqual(summary.sessionId, SESSION_A);
        assert.strictEqual(session.model, "model-alpha");
        assert.deepStrictEqual(
          session.entries.map((entry) => entry.kind),
          ["user", "assistant"],
        );
      }),
    ),
  );

  it.effect("rejects session ids that are not plain UUID-like strings", () =>
    withFixtureHome((store) =>
      Effect.gen(function* () {
        const error = yield* store.read("../../etc/passwd").pipe(Effect.flip);

        assert.isTrue(isStoreError(error));
        assert.strictEqual(error.operation, "read");
      }),
    ),
  );

  it.effect("fails to read a session without events.jsonl", () =>
    withFixtureHome((store) =>
      Effect.gen(function* () {
        const error = yield* store.read(SESSION_NO_EVENTS).pipe(Effect.flip);

        assert.isTrue(isStoreError(error));
      }),
    ),
  );
});
