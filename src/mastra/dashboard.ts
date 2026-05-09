// Dashboard de metricas + viewer de conversas, servido pelo proprio Mastra.
//
// Rotas (registradas em index.ts):
//   GET /api/dashboard                    — pagina principal com 4 sections
//   GET /api/dashboard/conversa/:id       — viewer de uma conversa em estilo WhatsApp
//
// Auth: Basic Auth contra DASHBOARD_USER/DASHBOARD_PASS. Se ambos vazios na
// env, retorna 503 (nao habilitado).
//
// HTML: server-rendered com Tailwind via CDN. Sem JS pesado, sem build step.
// Auto-refresh do dashboard via <meta http-equiv="refresh" content="30">.

import { DASHBOARD_USER, DASHBOARD_PASS } from './config';
import {
  buscarConversasAtivas,
  buscarConversaPorId,
  buscarMensagensDaConversa,
  contarConversoes,
  buscarObjecoesRecentes,
  contarObjecoesPorCategoria,
  buscarErrosRecentes,
  contarErrosPorCodigo,
} from './supabase';

// =================== Auth ===================

function dashboardHabilitado(): boolean {
  return Boolean(DASHBOARD_USER && DASHBOARD_PASS);
}

function verificarAuth(authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  try {
    const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const sep = credentials.indexOf(':');
    if (sep < 0) return false;
    const user = credentials.slice(0, sep);
    const pass = credentials.slice(sep + 1);
    return user === DASHBOARD_USER && pass === DASHBOARD_PASS;
  } catch {
    return false;
  }
}

function respond401(c: any) {
  return c.text('Acesso negado.', 401, {
    'WWW-Authenticate': 'Basic realm="Roberth Dashboard"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

function respondHTML(c: any, html: string, status: number = 200) {
  // c.html() existe no Hono mas alguns provedores Mastra so expoem c.text/c.body.
  // Fallback seguro: c.body com header.
  if (typeof c.html === 'function') {
    return c.html(html, status as any);
  }
  return c.body(html, status, { 'Content-Type': 'text/html; charset=utf-8' });
}

// =================== Helpers de formatacao ===================

function escapeHtml(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatarTempoRelativo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (isNaN(ts)) return '—';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatarHora(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatarDataHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatarDuracao(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sRest = Math.round(s - m * 60);
  return `${m}m${sRest}s`;
}

// Mapa de tool_name pra emoji+label exibido no viewer
function badgeTool(toolName: string | null, toolInput: any): string {
  if (!toolName) return '';
  const map: Record<string, string> = {
    'enviar-checkout': '🔗 link de checkout enviado',
    'salvar-dados-sessao': '👤 dados da sessao salvos',
    'handoff-humano': '🚨 handoff humano',
    'notificar-time': '📨 time notificado',
  };
  if (toolName === 'registrar-objecao') {
    const cat = toolInput?.categoria || '?';
    return `🎯 objecao registrada (${escapeHtml(cat)})`;
  }
  if (toolName.startsWith('follow-up-')) {
    return `🔄 ${escapeHtml(toolName)} (sistema)`;
  }
  return map[toolName] || `🔧 ${escapeHtml(toolName)}`;
}

// =================== Estilos / chrome ===================

const HEAD_COMUM = `
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .bubble { max-width: 75%; padding: 8px 12px; border-radius: 12px; }
    .b-lead { background: #374151; color: #f9fafb; align-self: flex-start; border-bottom-left-radius: 4px; }
    .b-sofia { background: #14532d; color: #f0fdf4; align-self: flex-end; border-bottom-right-radius: 4px; }
    .b-sys { background: #0f172a; color: #cbd5e1; align-self: center; max-width: 90%; font-size: 13px; }
    .meta { font-size: 11px; opacity: 0.7; margin-top: 4px; }
    .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  </style>
</head>
`;

// =================== Dashboard principal ===================

function gerarHTMLDashboard(dados: {
  conversasAtivas: any[];
  conversoes: { hoje: number; semana: number; mes: number; total: number };
  objecoesRecentes: any[];
  objecoesPorCategoria: Record<string, number>;
  errosRecentes: any[];
  errosPorCodigo: Record<string, number>;
}): string {
  const { conversasAtivas, conversoes, objecoesRecentes, objecoesPorCategoria, errosRecentes, errosPorCodigo } = dados;
  const agora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  // ----- Cards de conversoes -----
  const cardsConversoes = [
    ['Hoje', conversoes.hoje, 'bg-emerald-900'],
    ['Semana', conversoes.semana, 'bg-emerald-800'],
    ['Mes', conversoes.mes, 'bg-emerald-700'],
    ['Total', conversoes.total, 'bg-emerald-600'],
  ].map(([label, n, bg]) => `
    <div class="${bg} text-white rounded-lg p-4 shadow">
      <div class="text-xs uppercase tracking-wider opacity-80">${label}</div>
      <div class="text-3xl font-bold mt-1">${n}</div>
    </div>
  `).join('');

  // ----- Tabela de conversas ativas -----
  const linhasConversas = conversasAtivas.length === 0
    ? `<tr><td colspan="6" class="text-center text-gray-500 py-6">Nenhuma conversa ativa.</td></tr>`
    : conversasAtivas.map((c) => {
        const customer = c.customers_roberth || {};
        const nome = escapeHtml(customer.nome || '(sem nome)');
        const tel = escapeHtml(customer.telefone || '—');
        const status = escapeHtml(c.status);
        const ultimaLead = formatarTempoRelativo(c.last_lead_message_at);
        const ultimaSofia = formatarTempoRelativo(c.last_assistant_message_at);
        const inativ = formatarTempoRelativo(c.data_ultima_mensagem);
        return `
          <tr class="hover:bg-gray-50 cursor-pointer">
            <td class="px-3 py-2"><a href="/api/dashboard/conversa/${escapeHtml(c.id)}" class="text-blue-600 hover:underline">${nome}</a></td>
            <td class="px-3 py-2 mono text-sm">${tel}</td>
            <td class="px-3 py-2"><span class="inline-block px-2 py-0.5 text-xs rounded ${status === 'em_atendimento' ? 'bg-blue-100 text-blue-800' : 'bg-orange-100 text-orange-800'}">${status}</span></td>
            <td class="px-3 py-2 text-sm">${ultimaLead}</td>
            <td class="px-3 py-2 text-sm">${ultimaSofia}</td>
            <td class="px-3 py-2 text-sm">${inativ}</td>
          </tr>
        `;
      }).join('');

  // ----- Objecoes -----
  const chipsObjecoes = Object.entries(objecoesPorCategoria).length === 0
    ? '<span class="text-gray-500">nenhuma registrada</span>'
    : Object.entries(objecoesPorCategoria)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .map(([cat, n]) => `<span class="inline-block bg-amber-100 text-amber-900 px-3 py-1 rounded-full text-sm mr-2 mb-1">${escapeHtml(cat)}: <b>${n}</b></span>`)
        .join('');

  const linhasObjecoes = objecoesRecentes.length === 0
    ? `<tr><td colspan="4" class="text-center text-gray-500 py-6">Nenhuma objecao registrada.</td></tr>`
    : objecoesRecentes.map((o) => `
      <tr class="hover:bg-gray-50">
        <td class="px-3 py-2 text-sm">${formatarTempoRelativo(o.created_at)}</td>
        <td class="px-3 py-2"><span class="inline-block bg-amber-100 text-amber-900 px-2 py-0.5 rounded text-xs">${escapeHtml(o.categoria)}</span></td>
        <td class="px-3 py-2 mono text-xs">${escapeHtml(o.telefone)}</td>
        <td class="px-3 py-2 text-sm">${escapeHtml(o.texto_original)}</td>
      </tr>
    `).join('');

  // ----- Erros -----
  const chipsErros = Object.entries(errosPorCodigo).length === 0
    ? '<span class="text-gray-500">nenhum nas ultimas 24h</span>'
    : Object.entries(errosPorCodigo)
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .map(([cod, n]) => {
          const cor = cod === 'content_filter' ? 'bg-red-100 text-red-900'
            : cod === 'timeout' ? 'bg-orange-100 text-orange-900'
            : cod === 'rate_limit' ? 'bg-yellow-100 text-yellow-900'
            : 'bg-gray-100 text-gray-900';
          return `<span class="inline-block ${cor} px-3 py-1 rounded-full text-sm mr-2 mb-1">${escapeHtml(cod)}: <b>${n}</b></span>`;
        })
        .join('');

  const linhasErros = errosRecentes.length === 0
    ? `<tr><td colspan="4" class="text-center text-gray-500 py-6">Sem erros recentes. 🎉</td></tr>`
    : errosRecentes.map((e) => `
      <tr class="hover:bg-gray-50">
        <td class="px-3 py-2 text-sm">${formatarTempoRelativo(e.created_at)}</td>
        <td class="px-3 py-2 mono text-xs">${escapeHtml(e.telefone)}</td>
        <td class="px-3 py-2"><span class="inline-block bg-red-100 text-red-900 px-2 py-0.5 rounded text-xs">${escapeHtml(e.error_code || 'outro')}</span></td>
        <td class="px-3 py-2 text-xs text-gray-700">${escapeHtml((e.error_message || '').slice(0, 200))}</td>
      </tr>
    `).join('');

  return `<!doctype html>
<html lang="pt-BR">
${HEAD_COMUM.replace('</head>', `<title>Dashboard — Roberth Sofia (MCR)</title><meta http-equiv="refresh" content="30"></head>`)}
<body class="bg-gray-100 text-gray-900">
  <div class="max-w-7xl mx-auto p-4 md:p-6">
    <header class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl md:text-3xl font-bold">Dashboard — Sofia (MCR)</h1>
        <p class="text-sm text-gray-600">Atualizacao automatica a cada 30s</p>
      </div>
      <div class="text-sm text-gray-600 mono">⏰ ${agora}</div>
    </header>

    <!-- Conversoes -->
    <section class="mb-8">
      <h2 class="text-lg font-semibold mb-3">Conversoes (link enviado)</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${cardsConversoes}
      </div>
    </section>

    <!-- Conversas ativas -->
    <section class="mb-8">
      <h2 class="text-lg font-semibold mb-3">Conversas ativas <span class="text-sm font-normal text-gray-500">(${conversasAtivas.length})</span></h2>
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 text-xs uppercase tracking-wider text-gray-600">
            <tr>
              <th class="px-3 py-2">Nome</th>
              <th class="px-3 py-2">Telefone</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Ultima msg lead</th>
              <th class="px-3 py-2">Ultima msg Sofia</th>
              <th class="px-3 py-2">Inativ.</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">${linhasConversas}</tbody>
        </table>
      </div>
    </section>

    <!-- Objecoes -->
    <section class="mb-8">
      <h2 class="text-lg font-semibold mb-3">Objecoes</h2>
      <div class="mb-3">${chipsObjecoes}</div>
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 text-xs uppercase tracking-wider text-gray-600">
            <tr>
              <th class="px-3 py-2">Quando</th>
              <th class="px-3 py-2">Categoria</th>
              <th class="px-3 py-2">Telefone</th>
              <th class="px-3 py-2">Texto original</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">${linhasObjecoes}</tbody>
        </table>
      </div>
    </section>

    <!-- Erros -->
    <section class="mb-8">
      <h2 class="text-lg font-semibold mb-3">Erros do agente <span class="text-sm font-normal text-gray-500">(ultimas 24h)</span></h2>
      <div class="mb-3">${chipsErros}</div>
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 text-xs uppercase tracking-wider text-gray-600">
            <tr>
              <th class="px-3 py-2">Quando</th>
              <th class="px-3 py-2">Telefone</th>
              <th class="px-3 py-2">Codigo</th>
              <th class="px-3 py-2">Mensagem</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">${linhasErros}</tbody>
        </table>
      </div>
    </section>

    <footer class="text-center text-xs text-gray-500 mt-8">
      Auto-refresh em 30s. Ultima carga: ${agora}.
    </footer>
  </div>
</body>
</html>`;
}

// =================== Viewer de conversa ===================

function gerarHTMLConversa(conversa: any, mensagens: any[]): string {
  const customer = conversa.customers_roberth || {};
  const nome = escapeHtml(customer.nome || '(sem nome)');
  const telefone = escapeHtml(customer.telefone || '—');
  const status = escapeHtml(conversa.status);
  const inicio = formatarDataHora(conversa.started_at);
  const linkEnv = conversa.link_enviado
    ? `✅ ${formatarDataHora(conversa.link_enviado_em)} (${escapeHtml(conversa.oferta_enviada || 'principal')})`
    : '—';

  // Itera mensagens em ordem cronologica e calcula tempo de resposta da Sofia.
  // Pra cada msg role='assistant', diff = ts(assistant) - ts(ultima role='user' antes).
  let ultimaUserTs: number | null = null;
  const bolhas = mensagens.map((m) => {
    const ts = new Date(m.created_at).getTime();
    const hora = formatarHora(m.created_at);
    const conteudo = escapeHtml(m.content || '').replace(/\n/g, '<br>');
    const tool = badgeTool(m.tool_name, m.tool_input);

    if (m.role === 'user') {
      ultimaUserTs = ts;
      return `
        <div class="flex flex-col mb-2">
          <div class="bubble b-lead">
            ${conteudo}
            <div class="meta">${hora}</div>
          </div>
        </div>
      `;
    }

    if (m.role === 'assistant') {
      let medidor = '';
      if (m.tool_name && m.tool_name.startsWith('follow-up-')) {
        // FUP do scheduler — nao tem msg de lead anterior necessariamente.
        const horas = m.tool_name.replace('follow-up-', '').replace('h', '');
        medidor = `⏱ FUP ${horas}h`;
      } else if (ultimaUserTs) {
        medidor = `⏱ ${formatarDuracao(ts - ultimaUserTs)}`;
      }
      return `
        <div class="flex flex-col mb-2 items-end">
          <div class="bubble b-sofia">
            ${conteudo}
            ${tool ? `<div class="text-xs mt-1 opacity-90">${tool}</div>` : ''}
            <div class="meta text-right">${medidor ? medidor + ' · ' : ''}${hora}</div>
          </div>
        </div>
      `;
    }

    // role 'system' ou outro — bolha central
    return `
      <div class="flex justify-center mb-2">
        <div class="bubble b-sys">
          ${conteudo}
          ${tool ? `<div class="text-xs mt-1">${tool}</div>` : ''}
          <div class="meta text-center">${hora}</div>
        </div>
      </div>
    `;
  }).join('');

  return `<!doctype html>
<html lang="pt-BR">
${HEAD_COMUM.replace('</head>', `<title>Conversa — ${nome} (${telefone})</title></head>`)}
<body class="bg-gray-100 text-gray-900">
  <div class="max-w-3xl mx-auto p-4 md:p-6">
    <a href="/api/dashboard" aria-label="Voltar ao dashboard" class="text-blue-600 hover:underline text-sm mb-4 inline-block">← Voltar ao dashboard</a>

    <header class="bg-white rounded-lg shadow p-4 mb-4">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 class="text-xl font-bold">${nome}</h1>
          <div class="text-sm text-gray-600 mono">${telefone}</div>
        </div>
        <div class="text-right text-sm">
          <div>Status: <span class="font-medium">${status}</span></div>
          <div class="text-gray-600">Inicio: ${inicio}</div>
          <div class="text-gray-600">Link: ${linkEnv}</div>
        </div>
      </div>
    </header>

    <main class="bg-gray-200 rounded-lg shadow p-4 flex flex-col" style="min-height: 400px;">
      ${mensagens.length === 0
        ? '<div class="text-center text-gray-500 py-12">Nenhuma mensagem nesta conversa.</div>'
        : bolhas}
    </main>

    <footer class="text-center text-xs text-gray-500 mt-4">
      ${mensagens.length} mensagem(ns) | conversation_id: <span class="mono">${escapeHtml(conversa.id)}</span>
    </footer>
  </div>
</body>
</html>`;
}

// =================== Handlers (registrados em index.ts) ===================

export async function handlerDashboard(c: any) {
  if (!dashboardHabilitado()) {
    return c.text('Dashboard desabilitado: configure DASHBOARD_USER e DASHBOARD_PASS.', 503);
  }
  const auth = c.req.header('Authorization');
  if (!verificarAuth(auth)) return respond401(c);

  try {
    const [conversasAtivas, conversoes, objecoesRecentes, objecoesPorCategoria, errosRecentes, errosPorCodigo] = await Promise.all([
      buscarConversasAtivas(50),
      contarConversoes(),
      buscarObjecoesRecentes(30),
      contarObjecoesPorCategoria(),
      buscarErrosRecentes(30),
      contarErrosPorCodigo(),
    ]);
    const html = gerarHTMLDashboard({
      conversasAtivas,
      conversoes,
      objecoesRecentes,
      objecoesPorCategoria,
      errosRecentes,
      errosPorCodigo,
    });
    return respondHTML(c, html);
  } catch (e) {
    console.error('[dashboard] Erro ao gerar pagina:', e);
    return c.text('Erro ao carregar dashboard. Veja logs.', 500);
  }
}

export async function handlerConversa(c: any) {
  if (!dashboardHabilitado()) {
    return c.text('Dashboard desabilitado: configure DASHBOARD_USER e DASHBOARD_PASS.', 503);
  }
  const auth = c.req.header('Authorization');
  if (!verificarAuth(auth)) return respond401(c);

  const id = c.req.param('id');
  if (!id) return c.text('Conversa nao especificada.', 400);

  try {
    const [conversa, mensagens] = await Promise.all([
      buscarConversaPorId(id),
      buscarMensagensDaConversa(id),
    ]);
    if (!conversa) return c.text('Conversa nao encontrada.', 404);
    const html = gerarHTMLConversa(conversa, mensagens);
    return respondHTML(c, html);
  } catch (e) {
    console.error('[dashboard] Erro ao gerar viewer de conversa:', e);
    return c.text('Erro ao carregar conversa. Veja logs.', 500);
  }
}
