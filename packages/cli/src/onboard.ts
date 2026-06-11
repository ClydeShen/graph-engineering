/**
 * memex onboard — first-run Onboarding TUI (Phase 11 deliverable #5).
 *
 * Pure config-file operation: writes ~/.memex/config.json (provider registry,
 * gateway port/token). NO graph writes — the Worker-side LLMProvider (ADR 22)
 * reads its own iii-config.yaml; the two layers meet only through this file.
 *
 * API keys are stored as ${ENV_VAR} references by default — resolved at boot
 * by loadMemexConfig(), never written back resolved.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { intro, outro, select, text, confirm, log, isCancel } from '@clack/prompts';
import { DEFAULT_CONFIG_PATH, MemexConfigSchema, type MemexConfig } from '@graph/shared';

interface ProviderPreset {
  type: string;
  baseUrl?: string;
  defaultModel: string;
  envVar?: string;
}

const PRESETS: Record<string, ProviderPreset> = {
  anthropic: { type: 'anthropic', defaultModel: 'claude-sonnet-4-6', envVar: 'ANTHROPIC_API_KEY' },
  ollama: { type: 'openai-compatible', baseUrl: 'http://localhost:11434', defaultModel: 'llama3' },
  vllm: { type: 'openai-compatible', baseUrl: 'http://localhost:8000', defaultModel: '' },
  lmstudio: { type: 'openai-compatible', baseUrl: 'http://localhost:1234', defaultModel: '' },
  deepseek: { type: 'openai-compatible', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', envVar: 'DEEPSEEK_API_KEY' },
};

function bail(value: unknown): asserts value is string | boolean | symbol {
  if (isCancel(value)) {
    outro('Onboarding cancelled.');
    process.exit(0);
  }
}

export async function runOnboard(configPath: string = DEFAULT_CONFIG_PATH): Promise<void> {
  intro('MemexOS onboarding');

  if (existsSync(configPath)) {
    const overwrite = await confirm({
      message: `${configPath} already exists. Reconfigure? (a .bak backup is kept)`,
    });
    bail(overwrite);
    if (overwrite !== true) {
      outro('Keeping the existing config.');
      return;
    }
    writeFileSync(configPath + '.bak', readFileSync(configPath));
  }

  const providerKey = await select({
    message: 'LLM provider',
    options: [
      { value: 'anthropic', label: 'Anthropic (Claude)' },
      { value: 'ollama', label: 'Ollama (local)' },
      { value: 'vllm', label: 'vLLM (local)' },
      { value: 'lmstudio', label: 'LM Studio (local)' },
      { value: 'deepseek', label: 'DeepSeek' },
    ],
  });
  bail(providerKey);
  const preset = PRESETS[providerKey as string]!;

  const model = await text({
    message: 'Model',
    initialValue: preset.defaultModel,
    validate: (v) => (v.length === 0 ? 'model is required' : undefined),
  });
  bail(model);

  let apiKeyRef: string | undefined;
  if (preset.envVar) {
    const envVar = await text({
      message: 'API key env var (stored as ${VAR} reference, never the key itself)',
      initialValue: preset.envVar,
    });
    bail(envVar);
    apiKeyRef = '${' + (envVar as string) + '}';
  }

  const portInput = await text({
    message: 'Gateway port',
    initialValue: '3000',
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'positive integer'),
  });
  bail(portInput);

  const wantToken = await confirm({
    message: 'Generate a realtime API token? (required if the gateway is ever exposed beyond localhost)',
  });
  bail(wantToken);
  const token = wantToken === true ? randomBytes(24).toString('hex') : undefined;

  const config: MemexConfig = {
    gateway: {
      port: Number(portInput),
      websocket: true,
      ...(token !== undefined ? { token } : {}),
    },
    providers: [
      {
        name: providerKey as string,
        type: preset.type,
        model: model as string,
        priority: 1,
        ...(preset.baseUrl !== undefined ? { baseUrl: preset.baseUrl } : {}),
        ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}),
      },
    ],
  };

  // Self-check before write: never persist a config loadMemexConfig would reject.
  MemexConfigSchema.parse(config);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  log.success(`Wrote ${configPath}`);
  if (token !== undefined) {
    log.info(`Realtime token (shown once — also stored in the config file):\n  ${token}`);
  }
  outro('MemexOS configured. Start the gateway, then run: memex connect');
}
