export const EXTENSION_NAME = "fresh-session-handoff";
export const EXTENSION_VERSION = "0.1.0";

export const CHECKPOINT_PROTOCOL = "fresh-session-handoff";
export const CHECKPOINT_SCHEMA_VERSION = "1";


export const ROOT_RELATIVE_PATH = ".pi/fresh-session-handoff";
export const CHECKPOINTS_DIR_NAME = "checkpoints";
export const STATE_FILE_NAME = "state.json";
export const CONFIG_FILE_NAME = "config.json";
export const DEFAULT_MANIFEST_RELATIVE_PATH = ".pi/fresh-session-handoff/task-manifest.v1.json";

export const DEFAULT_CHECKPOINT_TTL_MINUTES = 240;
export const DEFAULT_LEASE_TTL_SECONDS = 120;
export const DEFAULT_MAX_COMMAND_HISTORY = 128;
export const DEFAULT_MAX_LAUNCH_RECORDS = 256;

export const LAUNCH_ENTRY_TYPE = "fresh-session-handoff-launch";
export const ACK_ENTRY_TYPE = "fresh-session-handoff-ack";
