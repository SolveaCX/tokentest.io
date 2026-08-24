const FORMATS = new Set(["summary", "json", "junit"]);

export function parseCliArgs(argv = [], env = process.env) {
  const args = [...argv];
  let command;
  if (args[0] && !args[0].startsWith("-")) command = args.shift();
  command ||= "evaluate";

  const values = { baseUrl: undefined, apiKey: undefined, models: [], provider: undefined, minScore: undefined, deep: false, format: undefined, output: undefined };
  const explicit = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--deep") { values.deep = true; explicit.add("deep"); continue; }
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) throw configError(`Unknown argument: ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined || value.startsWith("--")) throw configError(`Missing value for --${key}`);
    }
    if (key === "model") values.models.push(...splitModels(value));
    else if (key === "base-url") values.baseUrl = value;
    else if (key === "api-key") values.apiKey = value;
    else if (key === "provider") values.provider = value;
    else if (key === "min-score") values.minScore = parseScore(value);
    else if (key === "format") values.format = value;
    else if (key === "output") values.output = value;
    else throw configError(`Unknown argument: ${arg}`);
    explicit.add(keyToField(key));
  }

  if (!explicit.has("baseUrl")) values.baseUrl = env.TOKENTEST_BASE_URL;
  if (!explicit.has("apiKey")) values.apiKey = env.TOKENTEST_API_KEY;
  if (!explicit.has("models")) values.models = splitModels(env.TOKENTEST_MODELS);
  if (!explicit.has("minScore")) values.minScore = env.TOKENTEST_MIN_SCORE === undefined ? 80 : parseScore(env.TOKENTEST_MIN_SCORE);
  if (!explicit.has("provider")) values.provider = env.TOKENTEST_PROVIDER;
  if (!explicit.has("format")) values.format = env.TOKENTEST_FORMAT || "summary";
  if (!explicit.has("output")) values.output = env.TOKENTEST_OUTPUT;
  if (values.format && !FORMATS.has(values.format)) throw configError(`Unsupported format: ${values.format}`);
  if (values.provider && !["openai", "anthropic"].includes(values.provider)) throw configError(`Unsupported provider: ${values.provider}`);
  return { command, ...values, models: [...new Set(values.models)] };
}

export function validateCliConfig(config) {
  if (config.command !== "evaluate") throw configError(`Unsupported command: ${config.command}`);
  if (!config.baseUrl) throw configError("base URL is required (--base-url or TOKENTEST_BASE_URL)");
  try { new URL(config.baseUrl); } catch { throw configError("base URL must be a valid URL"); }
  if (!config.apiKey) throw configError("API key is required (--api-key or TOKENTEST_API_KEY)");
  if (!config.models?.length) throw configError("at least one model is required (--model or TOKENTEST_MODELS)");
  return config;
}

export function configError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function keyToField(key) {
  return ({ "base-url": "baseUrl", "api-key": "apiKey", model: "models", "min-score": "minScore", provider: "provider", format: "format", output: "output" })[key] || key;
}

function splitModels(value) {
  return String(value || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function parseScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw configError("min score must be a number from 0 to 100");
  return score;
}
