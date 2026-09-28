import { PiRpcClient, requiredModel } from "./benchmark-live-rpc.mjs";

function assertSelectedModel(model) {
  if (!model || typeof model !== "object") {
    throw new Error("selected model is missing");
  }
  if (model.provider !== requiredModel.provider || model.id !== requiredModel.id) {
    throw new Error(`selected model must be ${requiredModel.provider}/${requiredModel.id}`);
  }
  if (typeof model.route === "string" && model.route !== requiredModel.route) {
    throw new Error(`selected model route must be ${requiredModel.route}`);
  }
  if (model.id === "forbidden-model" || model.id === "example-provider/forbidden-model") {
    throw new Error("forbidden-model substitution is forbidden");
  }
}

async function run() {
  const rpc = PiRpcClient.spawn({
    cwd: process.cwd(),
    persistSession: false,
    tools: null,
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    provider: requiredModel.provider,
    modelId: requiredModel.id,
  });

  try {
    await rpc.waitForIdle({ timeoutMs: 30000, pollMs: 100 });
    const state = await rpc.getState({ timeoutMs: 30000 });
    assertSelectedModel(state?.model);

    const available = await rpc.getAvailableModels({ timeoutMs: 30000 });
    const matches = available.filter(
      (entry) =>
        entry &&
        entry.provider === requiredModel.provider &&
        entry.id === requiredModel.id &&
        (typeof entry.route !== "string" || entry.route === requiredModel.route),
    );

    if (matches.length === 0) {
      throw new Error(`required model ${requiredModel.provider}/${requiredModel.id} is not available`);
    }

    console.log(
      JSON.stringify(
        {
          selectedModel: {
            provider: state.model.provider,
            id: state.model.id,
            route: typeof state.model.route === "string" ? state.model.route : null,
            name: typeof state.model.name === "string" ? state.model.name : null,
          },
          matchingAvailableModels: matches.map((entry) => ({
            provider: entry.provider,
            id: entry.id,
            route: typeof entry.route === "string" ? entry.route : null,
            name: typeof entry.name === "string" ? entry.name : null,
          })),
          availableCount: available.length,
          confirmedExactModel: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await rpc.close().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
