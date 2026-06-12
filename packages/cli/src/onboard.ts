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
import { intro, outro, select, text, confirm, log, isCancel, multiselect } from '@clack/prompts';
import {
  CAPABILITY_PRESETS,
  DEFAULT_CONFIG_PATH,
  DEFAULT_GATEWAY_PORT,
  MemexConfigSchema,
  PROVIDER_PROFILES,
  getProviderProfile,
  type MemexConfig,
} from '@graph/shared';

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

  // ADR 56 D-2: picker options derive from the ProviderProfile registry —
  // onboarding never maintains its own provider list.
  const providerKey = await select({
    message: 'LLM provider',
    options: PROVIDER_PROFILES.map((p) => ({
      value: p.name,
      label: p.displayName,
      ...(p.signupUrl !== undefined ? { hint: `key: ${p.signupUrl}` } : {}),
    })),
  });
  bail(providerKey);
  const profile = getProviderProfile(providerKey as string)!;

  let customBaseUrl: string | undefined;
  if (profile.baseUrl === undefined && profile.name === 'custom') {
    const url = await text({
      message: 'Endpoint base URL (OpenAI-compatible)',
      validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'http(s):// URL required'),
    });
    bail(url);
    customBaseUrl = url as string;
  }

  const model = await text({
    message: 'Model',
    initialValue: profile.defaultModel ?? '',
    validate: (v) => (v.length === 0 ? 'model is required' : undefined),
  });
  bail(model);

  let apiKeyRef: string | undefined;
  if (profile.envVar !== undefined || profile.name === 'custom') {
    const envVar = await text({
      message: 'API key env var (stored as ${VAR} reference, never the key itself; empty = no key)',
      initialValue: profile.envVar ?? '',
    });
    bail(envVar);
    if ((envVar as string).length > 0) apiKeyRef = '${' + (envVar as string) + '}';
  }

  // ── Optional embedding endpoint (ADR 55: never required) ─────────────────
  let embeddingSection: MemexConfig['embedding'];
  if (profile.supportsEmbedding && profile.defaultEmbeddingModel !== undefined) {
    embeddingSection = { provider: profile.name, model: profile.defaultEmbeddingModel };
    log.info(`Embedding: ${profile.name}/${profile.defaultEmbeddingModel} (semantic memory index)`);
  } else {
    const wantEmbedding = await confirm({
      message: `${profile.displayName} has no embeddings endpoint. Configure a separate one? (optional — skipping means lexical retrieval until one is added)`,
    });
    bail(wantEmbedding);
    if (wantEmbedding === true) {
      const embeddable = PROVIDER_PROFILES.filter(
        (p) => p.supportsEmbedding && p.defaultEmbeddingModel !== undefined,
      );
      const embChoice = await select({
        message: 'Embedding provider',
        options: embeddable.map((p) => ({
          value: p.name,
          label: `${p.displayName} (${p.defaultEmbeddingModel})`,
        })),
      });
      bail(embChoice);
      const embProfile = getProviderProfile(embChoice as string)!;
      embeddingSection = {
        provider: embProfile.name,
        model: embProfile.defaultEmbeddingModel!,
        ...(embProfile.envVar !== undefined ? { apiKey: '${' + embProfile.envVar + '}' } : {}),
      };
    }
  }

  const portInput = await text({
    message: 'Gateway port',
    initialValue: String(DEFAULT_GATEWAY_PORT),
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'positive integer'),
  });
  bail(portInput);

  const wantToken = await confirm({
    message: 'Generate a realtime API token? (required if the gateway is ever exposed beyond localhost)',
  });
  bail(wantToken);
  const token = wantToken === true ? randomBytes(24).toString('hex') : undefined;

  // ── Capability presets (Phase 18 #4, ADR-51) ─────────────────────────────
  // bundled-skill forms install now (file copy); other forms collect their
  // install command for the summary. Bindings are graph state — they happen
  // via `memex capability bind` once the DB is up, not here.
  const presetChoice = await multiselect({
    message: 'Capability presets (space to toggle; meta-skills recommended)',
    options: CAPABILITY_PRESETS.map((p) => ({
      value: p.name,
      label: `${p.name} (${p.category}, ${p.form})`,
      hint: p.description,
    })),
    initialValues: CAPABILITY_PRESETS.filter((p) => p.recommended).map((p) => p.name),
    required: false,
  });
  bail(presetChoice as unknown);
  const followUps: string[] = [];
  for (const name of (presetChoice as string[]) ?? []) {
    const p = CAPABILITY_PRESETS.find((x) => x.name === name)!;
    if (p.form === 'bundled-skill') {
      const { installBundledSkill } = await import('./capability.js');
      try {
        installBundledSkill(p);
        log.success(`installed bundled skill: ${p.name}`);
      } catch (err) {
        log.warn(`could not install ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const { installInstruction } = await import('./capability.js');
      followUps.push(`${p.name}: ${installInstruction(p)}`);
    }
  }

  // ── Optional Telegram pairing (Phase 18 #3; skip never blocks) ────────────
  let telegramConfigured = false;
  const wantTelegram = await confirm({ message: 'Connect a Telegram bot now? (optional)' });
  bail(wantTelegram);
  if (wantTelegram === true) {
    const botToken = await text({
      message: 'Bot token from @BotFather (validated; stored as ${TELEGRAM_BOT_TOKEN} reference)',
      validate: (v) => (/^\d+:[\w-]+$/.test(v) ? undefined : 'expected <digits>:<secret> shape'),
    });
    if (!isCancel(botToken)) {
      try {
        const { validateBotToken } = await import('./connect/telegram.js');
        const username = await validateBotToken(botToken as string);
        log.success(`Token valid — bot @${username}`);
        telegramConfigured = true;
        log.warn('Export the secret: export TELEGRAM_BOT_TOKEN=<the token>');
      } catch {
        log.warn('Telegram validation failed — skipping (configure later: memex connect telegram)');
      }
    }
  }

  const config: MemexConfig = {
    gateway: {
      port: Number(portInput),
      websocket: true,
      ...(token !== undefined ? { token } : {}),
    },
    providers: [
      {
        name: providerKey as string,
        type: profile.api === 'anthropic-messages' ? 'anthropic' : 'openai-compatible',
        model: model as string,
        priority: 1,
        ...(customBaseUrl !== undefined
          ? { baseUrl: customBaseUrl }
          : profile.baseUrl !== undefined
            ? { baseUrl: profile.baseUrl }
            : {}),
        ...(apiKeyRef !== undefined ? { apiKey: apiKeyRef } : {}),
      },
    ],
    ...(embeddingSection !== undefined ? { embedding: embeddingSection } : {}),
    ...(telegramConfigured
      ? { channels: { telegram: { token: '${TELEGRAM_BOT_TOKEN}' } } }
      : {}),
  };

  // Self-check before write: never persist a config loadMemexConfig would reject.
  MemexConfigSchema.parse(config);

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  // ── System summary (Phase 18 #3) ──────────────────────────────────────────
  const port = Number(portInput);
  const dashboardUrl = `http://localhost:${port}/`;
  log.success(`Wrote ${configPath}`);
  if (token !== undefined) {
    log.info(`Realtime token (shown once — also stored in the config file):\n  ${token}`);
  }
  log.message(
    [
      'Summary',
      `  provider   ${providerKey as string} / ${model as string}`,
      `  gateway    port ${port}${token !== undefined ? ' (token auth on)' : ''}`,
      `  channels   ${telegramConfigured ? 'telegram (message your bot once the stack is up)' : 'none yet (memex connect telegram)'}`,
      `  dashboard  ${dashboardUrl}`,
      ...(followUps.length > 0 ? ['  next installs:', ...followUps.map((f) => `    ${f}`)] : []),
      '  next       npm run dev  (or: memex service)  → then: memex connect',
      '  chat       memex chat  (after the gateway is up; one-time: npm link --workspace packages/cli)',
      ...(apiKeyRef !== undefined
        ? [`  key        add ${apiKeyRef.slice(2, -1)}=<your key> to the repo .env (or export it) before starting`]
        : []),
    ].join('\n'),
  );

  // Auto-open the dashboard only when a gateway is actually answering (a
  // fresh install usually has not started services yet — opening a 404 helps
  // nobody). WSL branch: wslview/explorer.exe via openUrl.
  try {
    const health = await fetch(`http://localhost:${port}/v1/sys/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (health.ok) {
      const { openUrl } = await import('./wsl.js');
      openUrl(dashboardUrl);
      log.info('Gateway is live — opening the dashboard.');
    }
  } catch {
    /* not running yet — the summary shows the URL */
  }

  outro('MemexOS configured.');
}
