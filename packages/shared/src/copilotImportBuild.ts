export const COPILOT_IMPORT_APP_NAME = "T3 Code Copilot Import (Nightly)";
export const COPILOT_IMPORT_APP_ID = "com.t3tools.t3code.copilot-import";
export const COPILOT_IMPORT_HOME_NAME = ".t3-copilot-import";
export const COPILOT_IMPORT_USER_DATA_NAME = "t3code-copilot-import";

/** The fork's installable test build must not share state with official releases. */
export function isCopilotImportBuild(version: string): boolean {
  return /-copilot-import-nightly\.\d{8}\.\d+$/.test(version);
}
