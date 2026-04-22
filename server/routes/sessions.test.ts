/** Tests for the sessions API routes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('sessions routes', () => {
  let tmpDir: string;
  let spawnSubagentMock: ReturnType<typeof vi.fn>;
  let configuredAgentWorkspaces: Array<{ agentId: string; workspaceRoot: string }>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-test-'));
    spawnSubagentMock = vi.fn();
    configuredAgentWorkspaces = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function buildApp() {
    // Mock config to use our temp sessions dir
    vi.doMock('../lib/config.js', () => ({
      config: {
        home: tmpDir,
        sessionsDir: tmpDir,
        auth: false,
        port: 3000,
        host: '127.0.0.1',
        sslPort: 3443,
      },
      SESSION_COOKIE_NAME: 'nerve_session_3000',
    }));
    vi.doMock('../middleware/rate-limit.js', () => ({
      rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
    }));
    vi.doMock('../lib/subagent-spawn.js', () => ({
      spawnSubagent: spawnSubagentMock,
    }));
    vi.doMock('../lib/openclaw-config.js', () => ({
      listConfiguredAgentWorkspaces: () => configuredAgentWorkspaces,
    }));

    const mod = await import('./sessions.js');
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  it('rejects invalid session IDs (not UUID)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/not-a-uuid/model');
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Invalid session ID');
  });

  it('returns 200 with missing=true when transcript does not exist', async () => {
    const app = await buildApp();
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBeNull();
    expect(json.thinking).toBeNull();
    expect(json.missing).toBe(true);
  });

  it('returns runtime defaults from transcript entries near the top', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({ type: 'model_change', modelId: 'anthropic/claude-opus-4', ts: Date.now() }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium', ts: Date.now() }),
      JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('anthropic/claude-opus-4');
    expect(json.thinking).toBe('medium');
    expect(json.missing).toBe(false);
  });

  it('returns model: null when transcript has no runtime defaults', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({ type: 'message', role: 'user', content: 'hello' }),
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBeNull();
    expect(json.thinking).toBeNull();
    expect(json.missing).toBe(false);
  });

  it('finds deleted transcripts', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const transcript = JSON.stringify({ type: 'model_change', modelId: 'openai/gpt-4o', ts: Date.now() });
    await fs.writeFile(path.join(tmpDir, `${uuid}.jsonl.deleted-1234`), transcript);

    const res = await app.request(`/api/sessions/${uuid}/model`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('openai/gpt-4o');
    expect(json.thinking).toBeNull();
    expect(json.missing).toBe(false);
  });

  it('reads non-main agent transcripts when agentId is provided', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const agentSessionsDir = path.join(tmpDir, '.openclaw', 'agents', 'smoke257', 'sessions');
    await fs.mkdir(agentSessionsDir, { recursive: true });
    await fs.writeFile(path.join(agentSessionsDir, `${uuid}.jsonl`), [
      JSON.stringify({ type: 'model_change', modelId: 'openai-codex/gpt-5.4', ts: Date.now() }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium', ts: Date.now() }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/${uuid}/model?agentId=smoke257`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('openai-codex/gpt-5.4');
    expect(json.thinking).toBe('medium');
    expect(json.missing).toBe(false);
  });

  it('resolves runtime defaults by sessionKey for non-main agents', async () => {
    const app = await buildApp();
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sessionKey = 'agent:smoke257:main';
    const agentSessionsDir = path.join(tmpDir, '.openclaw', 'agents', 'smoke257', 'sessions');
    await fs.mkdir(agentSessionsDir, { recursive: true });
    await fs.writeFile(path.join(agentSessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId: uuid },
    }));
    await fs.writeFile(path.join(agentSessionsDir, `${uuid}.jsonl`), [
      JSON.stringify({ type: 'model_change', modelId: 'openai-codex/gpt-5.4', ts: Date.now() }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium', ts: Date.now() }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/runtime?sessionKey=${encodeURIComponent(sessionKey)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.model).toBe('openai-codex/gpt-5.4');
    expect(json.thinking).toBe('medium');
    expect(json.missing).toBe(false);
  });

  it('lists persisted session inventory across configured agents', async () => {
    const forgeWorkspace = path.join(tmpDir, 'workspace-forge');
    configuredAgentWorkspaces = [{ agentId: 'forge', workspaceRoot: forgeWorkspace }];

    await fs.mkdir(forgeWorkspace, { recursive: true });
    await fs.writeFile(path.join(forgeWorkspace, 'IDENTITY.md'), '# IDENTITY.md\n\n- Name: Ivy\n');

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      'agent:main:main': { sessionId: '11111111-1111-1111-1111-111111111111', label: 'Main', updatedAt: 100 },
      'agent:main:telegram:direct:1': { sessionId: '22222222-2222-2222-2222-222222222222', label: 'Telegram', updatedAt: 50 },
    }));

    const forgeDir = path.join(tmpDir, '.openclaw', 'agents', 'forge', 'sessions');
    await fs.mkdir(forgeDir, { recursive: true });
    await fs.writeFile(path.join(forgeDir, 'sessions.json'), JSON.stringify({
      'agent:forge:main': { sessionId: '33333333-3333-3333-3333-333333333333', label: 'Forge', updatedAt: 200 },
      'agent:forge:ui:chat-1': { sessionId: '44444444-4444-4444-4444-444444444444', label: 'Forge UI', updatedAt: 150 },
    }));

    const app = await buildApp();
    const res = await app.request('/api/sessions/inventory?limit=10');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);
    expect(json.sessions.map((session) => session.sessionKey)).toEqual([
      'agent:forge:main',
      'agent:forge:ui:chat-1',
      'agent:main:main',
      'agent:main:telegram:direct:1',
    ]);
    expect(json.sessions[0]?.identityName).toBe('Ivy');
  });

  it('synthesizes a root agent session when only descendants are persisted', async () => {
    const athenaWorkspace = path.join(tmpDir, 'workspace-athena');
    configuredAgentWorkspaces = [{ agentId: 'athena', workspaceRoot: athenaWorkspace }];

    await fs.mkdir(athenaWorkspace, { recursive: true });
    await fs.writeFile(path.join(athenaWorkspace, 'IDENTITY.md'), '# IDENTITY.md\n\n- Name: Athena\n');

    const athenaDir = path.join(tmpDir, '.openclaw', 'agents', 'athena', 'sessions');
    await fs.mkdir(athenaDir, { recursive: true });
    await fs.writeFile(path.join(athenaDir, 'sessions.json'), JSON.stringify({
      'agent:athena:subagent:child-1': { sessionId: '55555555-5555-5555-5555-555555555555', label: 'Child', updatedAt: 400 },
      'agent:athena:ui:lesson-1': { sessionId: '66666666-6666-6666-6666-666666666666', label: 'Lesson', updatedAt: 350 },
    }));

    const app = await buildApp();
    const res = await app.request('/api/sessions/inventory?limit=10');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(json.ok).toBe(true);
    expect(json.sessions.map((session) => session.sessionKey)).toEqual([
      'agent:athena:main',
      'agent:athena:subagent:child-1',
      'agent:athena:ui:lesson-1',
    ]);
    expect(json.sessions[0]?.identityName).toBe('Athena');
  });

  it('serves omitted image bytes from a session transcript', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const timestamp = 1775131617235;
    const base64 = Buffer.from('hello-image').toString('base64');

    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId },
    }));
    await fs.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: 'session_start', ts: Date.now() }),
      JSON.stringify({
        type: 'message',
        message: {
          timestamp,
          content: [
            { type: 'text', text: 'testing' },
            { type: 'image', mimeType: 'image/png', data: base64 },
          ],
        },
      }),
    ].join('\n'));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=${timestamp}&imageIndex=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain(`message-${timestamp}-image-0.png`);
    const body = Buffer.from(await res.arrayBuffer()).toString('utf-8');
    expect(body).toBe('hello-image');
  });

  it('returns 404 when session transcript media cannot be resolved', async () => {
    const app = await buildApp();
    const sessionKey = 'agent:main:main';
    await fs.writeFile(path.join(tmpDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    }));

    const res = await app.request(`/api/sessions/media?sessionKey=${encodeURIComponent(sessionKey)}&timestamp=1775131617235&imageIndex=0`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
  });

  // ── POST /api/sessions/spawn-subagent ────────────────────────────

  it('rejects missing body with 400', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  it('rejects body with missing required fields', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'do something' }), // missing parentSessionKey
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('parentSessionKey');
  });

  it('rejects parentSessionKey that is not a top-level root key', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:subagent:child',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('parentSessionKey');
  });

  it('rejects empty task string', async () => {
    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: '',
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
  });

  it('returns direct success payload when helper succeeds with direct mode', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:abc-123',
      runId: 'run-xyz',
      mode: 'direct',
    });

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'Reply with exactly: OK',
        label: 'audit-auth-flow',
        model: 'claude-sonnet-4-6',
        thinking: 'medium',
        cleanup: 'keep',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sessionKey).toBe('agent:reviewer:subagent:abc-123');
    expect(json.runId).toBe('run-xyz');
    expect(json.mode).toBe('direct');
  });

  it('returns marker success payload when helper falls back to marker mode', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:from-marker',
      mode: 'marker',
    });

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sessionKey).toBe('agent:reviewer:subagent:from-marker');
    expect(json.mode).toBe('marker');
    expect(json.runId).toBeUndefined();
  });

  it('returns 500 with error message when helper throws', async () => {
    spawnSubagentMock.mockRejectedValueOnce(new Error('Gateway connection failed'));

    const app = await buildApp();
    const res = await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain('Gateway connection failed');
  });

  it('defaults cleanup to keep when not specified', async () => {
    spawnSubagentMock.mockResolvedValueOnce({
      sessionKey: 'agent:reviewer:subagent:test',
      mode: 'direct',
    });

    const app = await buildApp();
    await app.request('/api/sessions/spawn-subagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentSessionKey: 'agent:reviewer:main',
        task: 'do something',
      }),
    });

    expect(spawnSubagentMock).toHaveBeenCalledWith(expect.objectContaining({
      cleanup: 'keep',
    }));
  });
});
