// Thin HTTP wrapper around Ollama's `/api/generate` endpoint. The model is
// hosted on the Windows host (RTX 4060), reachable from this Linux container
// via OLLAMA_URL (typically http://host.docker.internal:11434 or the bridge
// gateway IP). All callers expect strict-JSON output — they pass `format:json`
// and parse the response text themselves.

// First call after model unload (cold start) takes ~7s on RTX 4060; warm calls
// run ~1.5–3s. 8s gives cold-start headroom; once warm and keep_alive holds
// the model in VRAM the actual latency stays well under this.
const DEFAULT_TIMEOUT_MS = 8000;
const KEEP_ALIVE = '10m';

export type OllamaOptions = {
  url: string;
  model: string;
  timeoutMs?: number;
};

export type OllamaResponse = {
  ok: true;
  text: string;
  totalDurationMs: number;
  evalCount: number;
} | {
  ok: false;
  error: string;
  kind: 'timeout' | 'http' | 'network' | 'parse';
};

export async function generate(
  opts: OllamaOptions,
  prompt: string,
  options: { numPredict?: number; temperature?: number } = {},
): Promise<OllamaResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${opts.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model,
        prompt,
        stream: false,
        format: 'json',
        keep_alive: KEEP_ALIVE,
        options: {
          temperature: options.temperature ?? 0.7,
          num_predict: options.numPredict ?? 120,
        },
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, kind: 'http' };
    }
    const json = (await res.json()) as {
      response?: string;
      total_duration?: number;
      eval_count?: number;
    };
    if (typeof json.response !== 'string') {
      return { ok: false, error: 'no response field', kind: 'parse' };
    }
    return {
      ok: true,
      text: json.response,
      totalDurationMs: Math.round((json.total_duration ?? 0) / 1_000_000),
      evalCount: json.eval_count ?? 0,
    };
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    if (err.name === 'AbortError') {
      return { ok: false, error: `timeout after ${timeoutMs}ms`, kind: 'timeout' };
    }
    return { ok: false, error: err.message ?? 'unknown', kind: 'network' };
  }
}
