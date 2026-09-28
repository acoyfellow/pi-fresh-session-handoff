export interface PiModel {
  provider?: string;
  providerId?: string;
  id?: string;
  modelId?: string;
  name?: string;
  route?: string;
}

export interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getHeader(): { parentSession?: string };
  getEntries(): unknown[];
}

export interface UiLike {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setEditorText(text: string): void;
}

export interface ExtensionContextLike {
  mode: string;
  hasUI: boolean;
  cwd: string;
  ui: UiLike;
  model: PiModel | undefined;
  scopedModels: unknown[];
  modelRegistry: {
    find(provider: string, id: string): unknown;
    complete?(model: unknown, context: { messages: unknown[] }, options?: Record<string, unknown>): Promise<{ content: unknown[] }>;
  };
  sessionManager: SessionManagerLike;
  getContextUsage(): unknown;
}

export interface ReplacedSessionContextLike extends ExtensionContextLike {
  sendUserMessage?(text: string): Promise<void>;
}

export interface ExtensionCommandContextLike extends ExtensionContextLike {
  waitForIdle(): Promise<void>;
  newSession(options: {
    parentSession?: string;
    setup?: (sessionManager: {
      appendCustomEntry(customType: string, data?: unknown): string;
      appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
    }) => Promise<void> | void;
    withSession?: (ctx: ReplacedSessionContextLike) => Promise<void> | void;
  }): Promise<{ cancelled?: boolean }>;
}

export interface ExtensionApiLike {
  on(eventName: string, handler: (event: unknown, ctx: ExtensionContextLike) => Promise<unknown> | unknown): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContextLike) => Promise<void> | void;
    },
  ): void;
}
