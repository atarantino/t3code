import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import {
  importAllCopilotSessions,
  importCopilotSession,
  listCopilotSessions,
  type ImportCopilotSessionInput,
} from "@t3tools/client-runtime/operations";

import { connectionAtomRuntime } from "../connection/runtime";

export const copilotImportEnvironment = {
  importAll: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:copilot-import:all",
    concurrency: { mode: "singleFlight", key: (target) => target.environmentId },
    execute: (_input: Record<string, never>) => importAllCopilotSessions(),
  }),
  list: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:copilot-import:list",
    execute: (_input: Record<string, never>) => listCopilotSessions(),
  }),
  importSession: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:copilot-import:import",
    execute: (input: ImportCopilotSessionInput) => importCopilotSession(input),
  }),
};
