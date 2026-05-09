// Helper de HTTP com timeout via AbortController.
//
// Por que: fetch() nativo nao tem timeout. Sem isso, uma chamada lenta a
// Azure / GHL / Supabase pode travar o handler do webhook por > 30s,
// estourando o timeout do GHL Workflow (30s) e disparando webhook retry —
// que por sua vez vira mensagem duplicada se nao tiver dedup.
//
// Default: 15s. Caller pode override via 3o argumento.

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
