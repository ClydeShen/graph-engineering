// Live turn — config-share: drive a real NVIDIA turn through pi using Core's
// onboarded provider config. Proves ADR-57 D-2 (config-share) end-to-end before
// the in-repo packaging swap (read config.json here -> loadMemexConfig() in repo).
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  ModelRegistry,
  AuthStorage,
} from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const log = (...a) => console.log('[nvidia]', ...a);

// 1. Load NVIDIA_API_KEY from the main checkout .env (worktree lacks it — .env is
//    gitignored, the suspected "bug"). Manual parse, no dotenv dep.
const envText = fs.readFileSync('D:/Repo/graph-enginerring/.env', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
log('NVIDIA_API_KEY present?', !!process.env.NVIDIA_API_KEY, 'len', (process.env.NVIDIA_API_KEY || '').length);

// 2. Read Core's onboarded provider (in repo: loadMemexConfig() + resolveProfile).
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.memex', 'config.json'), 'utf8'));
const core = (cfg.providers || []).sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9))[0];
log('core provider:', core.name, core.model, core.baseUrl);

// 3. Core config -> pi models.json ({ providers: { <name>: ProviderConfig } }).
const modelsJson = {
  providers: {
    [core.name]: {
      baseUrl: core.baseUrl,
      apiKey: '${NVIDIA_API_KEY}', // pi-ai interpolates from process.env
      api: 'openai-completions',
      authHeader: true,
      models: [{
        id: core.model,
        name: core.model,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      }],
    },
  },
};
const modelsPath = path.join(process.cwd(), 'models.tmp.json');
fs.writeFileSync(modelsPath, JSON.stringify(modelsJson, null, 2));

// 4. Registry from that models.json; find the Core model.
const authStorage = AuthStorage.create?.() ?? AuthStorage.inMemory?.();
const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
modelRegistry.refresh?.();
if (modelRegistry.getError?.()) log('registry error:', modelRegistry.getError());
const model = modelRegistry.find(core.name, core.model);
log('model resolved?', !!model, 'configuredAuth?', model ? modelRegistry.hasConfiguredAuth?.(model) : 'n/a');
if (!model) { log('FAIL: model not in registry — schema/injection issue'); process.exit(1); }

// 5. Build session (no pi builtins) and run a real turn.
const services = await createAgentSessionServices({ cwd: process.cwd(), authStorage, modelRegistry });
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(),
  model,
  noTools: 'builtin',
});

let assistant = '';
session.subscribe?.((e) => {
  if (e.type === 'message_update' && e.message?.role === 'assistant') {
    const txt = (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    assistant = txt;
  }
  if (e.type === 'agent_end') log('EVENT agent_end; messages:', e.messages?.length);
});

log('prompting nvidia...');
await session.prompt('Reply with exactly: MEMEX-PI-OK');
log('ASSISTANT >>', assistant || '(empty)');
process.exit(0);
