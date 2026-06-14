/**
 * memex onboard — first-run Onboarding TUI (Phase 11 deliverable #5).
 *
 * Pure config-file operation: writes ~/.memex/config.json (provider registry,
 * gateway port/token). NO graph writes — the Worker-side LLMProvider (ADR 22)
 * reads its own iii-config.yaml; the two layers meet only through this file.
 *
 * Secrets follow the split-storage rule: the key the user pastes is written to
 * .env (gitignored), and config.json keeps only a ${ENV_VAR} reference resolved
 * at boot by loadMemexConfig(). The secret never lands in config.json.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { intro, outro, note, select, text, password, confirm, log, isCancel, multiselect, spinner } from '@clack/prompts';
import {
  CAPABILITY_PRESETS,
  DEFAULT_CONFIG_PATH,
  DEFAULT_GATEWAY_PORT,
  MemexConfigSchema,
  PROVIDER_PROFILES,
  fetchModels,
  getProviderProfile,
  type MemexConfig,
  type ProviderProfile,
} from '@graph/shared';

function bail(value: unknown): asserts value is string | boolean | symbol {
  if (isCancel(value)) {
    outro('Onboarding cancelled.');
    process.exit(0);
  }
}

/**
 * Mask a secret for on-screen confirmation: hide everything but the last 6
 * characters (e.g. `***********j6Udlc`), so a pasted key can be eyeballed for
 * correctness without the full secret ever being printed. Strings of 6 or
 * fewer characters are fully hidden.
 */
function maskSecret(secret: string): string {
  if (secret.length <= 6) return '*'.repeat(secret.length);
  return '*'.repeat(secret.length - 6) + secret.slice(-6);
}

/**
 * Append or update a `KEY=value` line in a .env file, preserving every other
 * line and creating the file if absent. Does not touch the live process env
 * (the next boot's loadDotenv reads it). Env-var names are [A-Z0-9_] so the
 * key is safe to interpolate into the match regex.
 */
function upsertEnvVar(envPath: string, key: string, value: string): void {
  const entry = `${key}=${value}`;
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const lines = existing.length > 0 ? existing.replace(/\n+$/, '').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => new RegExp(`^${key}=`).test(l));
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

/**
 * Collect an API key the onboarding way — paste the key itself, not a variable
 * name. The secret goes to .env; the returned ${VAR} reference is what the
 * config stores. The env-var name is derived from the profile (e.g.
 * GEMINI_API_KEY), never asked. A 'custom' endpoint may legitimately need no
 * key, so an empty paste returns undefined there.
 */
async function collectApiKey(
  profile: ProviderProfile,
  providerKey: string,
  envPath: string,
): Promise<{ ref: string; secret: string } | undefined> {
  const varName = profile.envVar ?? `${providerKey.toUpperCase()}_API_KEY`;
  const optional = profile.envVar === undefined;
  const key = await password({
    message: optional
      ? `Paste your ${profile.displayName} API key — leave blank if the endpoint needs none`
      : `Paste your ${profile.displayName} API key`,
  });
  bail(key);
  if ((key as string).length === 0) return undefined;
  upsertEnvVar(envPath, varName, key as string);
  log.success(
    `Saved ${maskSecret(key as string)} to ${envPath} as ${varName} — your key never goes in config.json.`,
  );
  // ref is what config.json stores; secret is held transiently in memory only to
  // list the provider's models below — it is never returned beyond onboarding.
  return { ref: '${' + varName + '}', secret: key as string };
}

/** Sentinel select value: drop out of the live pick-list to type a model id. */
const MANUAL_MODEL = '__manual__';

/** Free-text model entry — the fallback when the live list is empty. */
async function promptModelText(profile: ProviderProfile): Promise<string> {
  const model = await text({
    message: 'Model name',
    // placeholder shows the suggestion as a grey hint (no need to delete it);
    // defaultValue means pressing Enter on an empty line accepts the suggestion.
    placeholder: profile.defaultModel,
    ...(profile.defaultModel !== undefined ? { defaultValue: profile.defaultModel } : {}),
    validate: (v) =>
      v.length === 0 && profile.defaultModel === undefined ? 'model is required' : undefined,
  });
  bail(model);
  return model as string;
}

/**
 * Resolve the chat model: list what the provider actually serves (key already
 * in hand) and let the user PICK, recommended pinned on top — Hermes' `hermes
 * model` picker flow. Falls back to free-text when the list can't be fetched
 * (offline, no key, an endpoint without /models).
 */
async function selectModel(
  profile: ProviderProfile,
  baseUrl: string | undefined,
  apiKeySecret: string | undefined,
): Promise<string> {
  const sp = spinner();
  sp.start('Listing available models…');
  const models = await fetchModels(profile, baseUrl, apiKeySecret);
  sp.stop(
    models.length > 0
      ? `Found ${models.length} model${models.length === 1 ? '' : 's'}`
      : "Couldn't list models — enter one by name",
  );
  if (models.length === 0) return promptModelText(profile);

  const rec =
    profile.defaultModel !== undefined && models.includes(profile.defaultModel)
      ? profile.defaultModel
      : undefined;
  const picked = await select({
    message: 'Which model should Memex use?',
    options: [
      ...(rec !== undefined ? [{ value: rec, label: rec, hint: 'recommended' }] : []),
      ...[...models]
        .sort()
        .filter((m) => m !== rec)
        .map((m) => ({ value: m, label: m })),
      { value: MANUAL_MODEL, label: 'Enter a different model name…' },
    ],
    ...(rec !== undefined ? { initialValue: rec } : {}),
  });
  bail(picked);
  return picked === MANUAL_MODEL ? promptModelText(profile) : (picked as string);
}

export async function runOnboard(
  configPath: string = DEFAULT_CONFIG_PATH,
  envPath: string = resolve(process.cwd(), '.env'),
): Promise<void> {
  intro("Welcome to MemexOS — let's get you set up");

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
    message: 'Which AI provider should power Memex?',
    options: PROVIDER_PROFILES.map((p) => ({
      value: p.name,
      label: p.displayName,
      ...(p.signupUrl !== undefined ? { hint: `get a key → ${p.signupUrl}` } : {}),
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

  // The LLM's key comes FIRST — with it in hand we can list the provider's live
  // models below so the user picks one instead of typing an id from memory. Paste
  // the key itself — it goes to .env; config keeps a ${VAR} ref.
  let apiKeyRef: string | undefined;
  let apiKeySecret: string | undefined;
  if (profile.envVar !== undefined || profile.name === 'custom') {
    const collected = await collectApiKey(profile, providerKey as string, envPath);
    apiKeyRef = collected?.ref;
    apiKeySecret = collected?.secret;
  }

  const model = await selectModel(profile, customBaseUrl ?? profile.baseUrl, apiKeySecret);

  // ── Embeddings (semantic memory index) ───────────────────────────────────
  // Optional system-wide (ADR 55): skipping means keyword retrieval until added.
  // Always an explicit, clearly-labelled step so it can't be mistaken for the
  // LLM provider above, and so a different embedding method can be chosen.
  let embeddingSection: MemexConfig['embedding'];
  const canReuse = profile.supportsEmbedding && profile.defaultEmbeddingModel !== undefined;
  const embChoice = canReuse
    ? await select({
        message: 'How should Memex create embeddings? (powers semantic memory)',
        options: [
          {
            value: 'reuse',
            label: `Use ${profile.displayName} (${profile.defaultEmbeddingModel})`,
            hint: 'recommended',
          },
          { value: 'other', label: 'Use a different provider' },
          { value: 'skip', label: 'Skip — keyword search only' },
        ],
      })
    : await select({
        message: `${profile.displayName} can't create embeddings — pick a provider for semantic memory`,
        options: [
          { value: 'other', label: 'Choose an embedding provider' },
          { value: 'skip', label: 'Skip — keyword search only', hint: 'default' },
        ],
      });
  bail(embChoice);

  if (embChoice === 'reuse') {
    embeddingSection = { provider: profile.name, model: profile.defaultEmbeddingModel! };
  } else if (embChoice === 'other') {
    const embeddable = PROVIDER_PROFILES.filter(
      (p) => p.supportsEmbedding && p.defaultEmbeddingModel !== undefined,
    );
    const embPick = await select({
      message: 'Embedding provider',
      options: embeddable.map((p) => ({
        value: p.name,
        label: `${p.displayName} (${p.defaultEmbeddingModel})`,
      })),
    });
    bail(embPick);
    const embProfile = getProviderProfile(embPick as string)!;
    // Reuse the LLM key if it's the same provider; otherwise collect this one
    // the same paste→.env way so users can bring their preferred embedding key.
    let embKeyRef: string | undefined;
    if (embProfile.envVar !== undefined) {
      embKeyRef =
        embProfile.name === profile.name
          ? apiKeyRef
          : (await collectApiKey(embProfile, embProfile.name, envPath))?.ref;
    }
    embeddingSection = {
      provider: embProfile.name,
      model: embProfile.defaultEmbeddingModel!,
      ...(embKeyRef !== undefined ? { apiKey: embKeyRef } : {}),
    };
  }

  const portInput = await text({
    message: 'Local gateway port',
    placeholder: String(DEFAULT_GATEWAY_PORT),
    defaultValue: String(DEFAULT_GATEWAY_PORT),
    // Empty is allowed here so Enter falls through to defaultValue (the suggestion).
    validate: (v) =>
      v.length === 0 || (Number.isInteger(Number(v)) && Number(v) > 0)
        ? undefined
        : 'enter a positive whole number',
  });
  bail(portInput);

  const wantToken = await confirm({
    message:
      'Protect the gateway with an access token? (only needed if you expose it beyond this computer — press Enter to skip)',
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
      message: 'Paste the bot token from @BotFather',
      validate: (v) => (/^\d+:[\w-]+$/.test(v) ? undefined : 'expected <digits>:<secret> shape'),
    });
    if (!isCancel(botToken)) {
      try {
        const { validateBotToken } = await import('./connect/telegram.js');
        const username = await validateBotToken(botToken as string);
        log.success(`Token valid — bot @${username}`);
        telegramConfigured = true;
        upsertEnvVar(envPath, 'TELEGRAM_BOT_TOKEN', botToken as string);
        log.success(`Saved ${maskSecret(botToken as string)} to ${envPath} as TELEGRAM_BOT_TOKEN.`);
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
  // The dashboard is the Console (Next.js), served on :3000 by `npm run dev` —
  // not the gateway port. The gateway's own /dashboard remains a minimal live
  // view, but the Console is the UI we send people to.
  const consoleUrl = 'http://localhost:3000';
  log.success(`Wrote ${configPath}`);
  if (token !== undefined) {
    log.info(`Realtime token (shown once — also stored in the config file):\n  ${token}`);
  }
  log.message(
    [
      'Configured',
      `  provider   ${providerKey as string} / ${model as string}`,
      `  embedding  ${embeddingSection ? `${embeddingSection.provider}/${embeddingSection.model}` : 'none (keyword search)'}`,
      `  gateway    port ${port}${token !== undefined ? ' (token auth on)' : ''}`,
      `  channels   ${telegramConfigured ? 'telegram' : 'none yet'}`,
      ...(apiKeyRef !== undefined
        ? [`  key        saved to ${envPath} (${apiKeyRef.slice(2, -1)})`]
        : []),
    ].join('\n'),
  );

  // Getting-started guide — the actual reason most people re-read this screen.
  // Grounded in docs/QUICKSTART.md: doctor → npm run dev (auto-opens chat) →
  // open the Console → connect a channel. `npm run dev` brings the whole stack
  // up and drops you into chat, so we do NOT tell people to run `memex chat`.
  note(
    [
      `1  Check setup    ${' '}memex doctor`,
      `2  Start Memex    ${' '}npm run dev`,
      `     ↳ brings the stack up and drops you into chat`,
      `3  Open the app   ${' '}${consoleUrl}`,
      `4  Add a channel  ${' '}memex connect`,
      ...(followUps.length > 0
        ? ['', 'Finish installing the skills you picked:', ...followUps.map((f) => `   ${f}`)]
        : []),
    ].join('\n'),
    'Next steps',
  );

  // If the Console is already serving (a re-run while `npm run dev` is up), open
  // it; on a fresh setup nothing is running yet, so the guide above is the path.
  try {
    const res = await fetch(consoleUrl, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const { openUrl } = await import('./wsl.js');
      openUrl(consoleUrl);
      log.info('Console is live — opening it now.');
    }
  } catch {
    /* not running yet — the Next steps guide shows how to start it */
  }

  outro('MemexOS configured — see “Next steps” above to start.');
}
