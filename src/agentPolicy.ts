/** Tool lists and idle cap shared by every agent session the extension starts. */

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const EDIT_TOOLS = [...READ_ONLY_TOOLS, "bash", "edit", "write"];
/** A session with no event for this long is aborted as a hang. */
export const AGENT_IDLE_TIMEOUT_MS = 600_000;
