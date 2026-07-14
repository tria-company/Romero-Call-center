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
// Auto-refresh do dashboard via fetch + DOM swap (sem reload — sem flash).

import { DASHBOARD_USER, DASHBOARD_PASS } from './config';
import {
  buscarConversasAtivas,
  buscarConversaPorId,
  buscarMensagensDaConversa,
  contarConversoes,
  contarFunil,
  contarFollowUps,
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

// Cor do tempo de resposta: verde rapido, amber medio, vermelho lento.
function classeDuracao(ms: number): string {
  if (ms < 10_000) return 'text-emerald-300';
  if (ms < 30_000) return 'text-amber-300';
  return 'text-rose-300';
}

function iniciaisDe(nome: string | undefined | null): string {
  const n = (nome || '').trim();
  if (!n) return '?';
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Mapa de tool_name pra label visual no viewer (usado em badge pill)
function badgeTool(toolName: string | null, toolInput: any): { icone: string; label: string } | null {
  if (!toolName) return null;
  if (toolName === 'enviar-checkout') return { icone: '🔗', label: 'link enviado' };
  if (toolName === 'salvar-dados-sessao') return { icone: '👤', label: 'dados salvos' };
  if (toolName === 'handoff-humano') {
    const motivo = toolInput?.motivo || '?';
    return { icone: '🚨', label: `handoff (${motivo})` };
  }
  if (toolName === 'notificar-time') {
    const motivo = toolInput?.motivo || '?';
    return { icone: '📨', label: `notificou (${motivo})` };
  }
  if (toolName === 'registrar-objecao') {
    const cat = toolInput?.categoria || '?';
    return { icone: '🎯', label: `objeção (${cat})` };
  }
  if (toolName.startsWith('follow-up-')) {
    return { icone: '🔄', label: toolName };
  }
  return { icone: '🔧', label: toolName };
}

// Cor do status badge pra usar nos chips/cards
function classeStatus(status: string): string {
  switch (status) {
    case 'em_atendimento': return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
    case 'aguardando_humano': return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
    case 'encerrada': return 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
    default: return 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
  }
}

// =================== Estilos / chrome ===================

const HEAD_COMUM = `
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0f172a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    .glass { background: rgba(15,23,42,0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
    .mono { font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace; }
    .scrollbar-thin::-webkit-scrollbar { height: 6px; width: 6px; }
    .scrollbar-thin::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
    .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
    /* Bolhas WhatsApp */
    .bubble { max-width: 80%; padding: 10px 14px; border-radius: 16px; line-height: 1.4; word-wrap: break-word; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
    .b-lead { background: #1e293b; color: #f1f5f9; align-self: flex-start; border-bottom-left-radius: 4px; }
    .b-sofia { background: #064e3b; color: #ecfdf5; align-self: flex-end; border-bottom-right-radius: 4px; }
    .b-sys { background: #1e1b4b; color: #c7d2fe; align-self: center; max-width: 92%; font-size: 13px; border-radius: 10px; }
    .meta { font-size: 11px; opacity: 0.65; margin-top: 4px; }
    /* Animações sutis */
    @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .pulse-dot { animation: pulse-dot 2s infinite; }
    /* Mobile: tabela vira card vertical */
    @media (max-width: 640px) {
      .mobile-card-table thead { display: none; }
      .mobile-card-table tbody { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
      .mobile-card-table tr {
        display: flex;
        flex-direction: column;
        padding: 12px;
        border-radius: 12px;
        background: rgba(30,41,59,0.6);
        border: 1px solid rgba(51,65,85,0.5);
        gap: 6px;
      }
      .mobile-card-table td {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 0;
        border: none;
        font-size: 13px;
      }
      .mobile-card-table td::before {
        content: attr(data-label);
        font-weight: 600;
        color: #94a3b8;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        flex-shrink: 0;
      }
      /* Primeira coluna (Lead/Quando) ganha destaque */
      .mobile-card-table tr td:first-child {
        flex-direction: row;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(51,65,85,0.4);
      }
      .mobile-card-table tr td:first-child::before { display: none; }
      /* Tap target maior nos links */
      .mobile-card-table a { padding: 4px 0; min-height: 32px; display: flex; align-items: center; }
    }
    /* Desktop sm+: tap target padrao em links de tabela */
    @media (min-width: 641px) {
      .mobile-card-table a { display: inline-flex; align-items: center; }
    }
  </style>
</head>
`;

// =================== SVG Icons inline ===================

const ICON = {
  bolt: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
  chat: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>`,
  target: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
  alert: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
  arrow: `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>`,
  check: `<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`,
  clock: `<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
};

// =================== Dashboard principal ===================

function gerarHTMLDashboard(dados: {
  conversasAtivas: any[];
  conversoes: { hoje: number; semana: number; mes: number; total: number };
  funil: { total: number; engajou: number; linkEnviado: number };
  followUps: { fup1: number; fup3: number; fup5: number; handoff24h: number; leadsComFup: number };
  objecoesRecentes: any[];
  objecoesPorCategoria: Record<string, number>;
  errosRecentes: any[];
  errosPorCodigo: Record<string, number>;
}): string {
  const { conversasAtivas, conversoes, funil, followUps, objecoesRecentes, objecoesPorCategoria, errosRecentes, errosPorCodigo } = dados;
  const agora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  // ----- Cards de conversoes -----
  const conversoesItems = [
    { label: 'Hoje', n: conversoes.hoje, gradient: 'from-emerald-500 to-emerald-700' },
    { label: 'Semana', n: conversoes.semana, gradient: 'from-emerald-600 to-teal-700' },
    { label: 'Mês', n: conversoes.mes, gradient: 'from-teal-600 to-cyan-700' },
    { label: 'Total', n: conversoes.total, gradient: 'from-cyan-600 to-blue-700' },
  ];
  const cardsConversoes = conversoesItems.map((item) => `
    <div class="relative overflow-hidden rounded-xl sm:rounded-2xl bg-gradient-to-br ${item.gradient} p-3 sm:p-5 shadow-lg ring-1 ring-white/10">
      <div class="flex items-center justify-between text-white/80 text-[10px] sm:text-xs uppercase tracking-wider font-medium">
        <span>${item.label}</span>
        <span class="opacity-50">${ICON.bolt}</span>
      </div>
      <div class="text-2xl sm:text-4xl font-bold text-white mt-1 sm:mt-2">${item.n}</div>
      <div class="text-[10px] sm:text-xs text-white/60 mt-0.5 sm:mt-1">checkouts</div>
    </div>
  `).join('');

  // ----- Funil de vendas (3 etapas, simples) -----
  const totalTopo = funil.total || 1; // evita divisao por zero
  const etapas = [
    { label: 'Conversas',    icon: '💬', n: funil.total,       cor: 'from-emerald-500 to-emerald-600' },
    { label: 'Engajou',      icon: '👋', n: funil.engajou,     cor: 'from-emerald-600 to-teal-600' },
    { label: 'Link enviado', icon: '🔗', n: funil.linkEnviado, cor: 'from-cyan-600 to-blue-600' },
  ];
  const conversaoTotal = funil.total > 0 ? Math.round((funil.linkEnviado / funil.total) * 100) : 0;

  const linhasFunil = etapas.map((et, i) => {
    const pct = funil.total > 0 ? (et.n / totalTopo) * 100 : 0;
    const pctTopo = funil.total > 0 ? Math.round((et.n / funil.total) * 100) : 0;
    let dropHtml = '';
    if (i > 0) {
      const anterior = etapas[i - 1].n;
      const drop = anterior > 0 ? Math.round((1 - et.n / anterior) * 100) : 0;
      const dropClass = drop >= 60 ? 'text-rose-400' : drop >= 35 ? 'text-amber-400' : 'text-slate-400';
      dropHtml = `<div class="text-[10px] sm:text-xs ${dropClass} ml-[7.5rem] sm:ml-32 -mt-0.5 mb-1.5 mono">↓ ${drop}% drop</div>`;
    }
    return `
      ${dropHtml}
      <div class="flex items-center gap-2 sm:gap-3">
        <div class="w-28 sm:w-32 shrink-0 flex items-center gap-1.5 sm:gap-2">
          <span class="text-sm sm:text-base">${et.icon}</span>
          <span class="text-xs sm:text-sm font-medium text-slate-200 truncate">${et.label}</span>
        </div>
        <div class="flex-1 bg-slate-700/30 rounded-lg overflow-hidden h-7 sm:h-8 relative ring-1 ring-slate-700/40">
          <div class="bg-gradient-to-r ${et.cor} h-full transition-all" style="width: ${Math.max(pct, 2)}%"></div>
          <div class="absolute inset-0 flex items-center justify-between px-2 sm:px-3 text-[11px] sm:text-xs">
            <span class="font-mono font-semibold text-white drop-shadow">${et.n}</span>
            <span class="text-white/80 font-mono">${pctTopo}%</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // ----- Follow-ups automaticos (cards separados do funil) -----
  const fupItems = [
    { label: '⏰ Leads c/ FUP',  n: followUps.leadsComFup, gradient: 'from-amber-500 to-amber-700',  hint: '1+ follow-up disparado' },
    { label: 'FUP 1h',           n: followUps.fup1,        gradient: 'from-amber-600 to-orange-600', hint: 'silencio de 1h' },
    { label: 'FUP 3h',           n: followUps.fup3,        gradient: 'from-orange-600 to-orange-700', hint: 'silencio de 3h' },
    { label: 'FUP 5h',           n: followUps.fup5,        gradient: 'from-orange-700 to-rose-700',  hint: 'silencio de 5h' },
    { label: 'Handoff 24h',      n: followUps.handoff24h,  gradient: 'from-rose-700 to-rose-900',    hint: 'silencio de 24h' },
  ];
  const cardsFup = fupItems.map((item) => `
    <div class="relative overflow-hidden rounded-xl sm:rounded-2xl bg-gradient-to-br ${item.gradient} p-3 sm:p-5 shadow-lg ring-1 ring-white/10">
      <div class="flex items-center justify-between text-white/80 text-[10px] sm:text-xs uppercase tracking-wider font-medium">
        <span class="truncate">${item.label}</span>
      </div>
      <div class="text-2xl sm:text-4xl font-bold text-white mt-1 sm:mt-2">${item.n}</div>
      <div class="text-[10px] sm:text-xs text-white/60 mt-0.5 sm:mt-1">${item.hint}</div>
    </div>
  `).join('');

  // ----- Tabela de conversas ativas -----
  const linhasConversas = conversasAtivas.length === 0
    ? `<tr><td colspan="6" class="text-center text-slate-400 py-10">Nenhuma conversa ativa.</td></tr>`
    : conversasAtivas.map((c) => {
        const customer = c.auton_sdr_customers || {};
        const nome = customer.nome || '(sem nome)';
        const tel = customer.telefone || '—';
        const status = c.status;
        const ultimaLead = formatarTempoRelativo(c.last_lead_message_at);
        const ultimaSofia = formatarTempoRelativo(c.last_assistant_message_at);
        const inativ = formatarTempoRelativo(c.data_ultima_mensagem);
        return `
          <tr class="group hover:bg-slate-700/30 transition cursor-pointer">
            <td class="px-3 sm:px-4 py-3" data-label="Lead">
              <a href="/api/dashboard/conversa/${escapeHtml(c.id)}" class="flex items-center gap-2 group-hover:text-emerald-300 transition">
                <span class="flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-white text-xs font-semibold shrink-0">${escapeHtml(iniciaisDe(nome))}</span>
                <span class="font-medium text-slate-200 truncate">${escapeHtml(nome)}</span>
              </a>
            </td>
            <td class="px-3 sm:px-4 py-3 mono text-xs text-slate-400" data-label="Telefone">${escapeHtml(tel)}</td>
            <td class="px-3 sm:px-4 py-3" data-label="Status">
              <span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ring-1 ${classeStatus(status)}">
                ${status === 'em_atendimento' ? '<span class="w-1.5 h-1.5 rounded-full bg-current pulse-dot"></span>' : ''}
                ${escapeHtml(status)}
              </span>
            </td>
            <td class="px-3 sm:px-4 py-3 text-sm text-slate-300" data-label="Lead falou">${ultimaLead}</td>
            <td class="px-3 sm:px-4 py-3 text-sm text-slate-300" data-label="Bot falou">${ultimaSofia}</td>
            <td class="px-3 sm:px-4 py-3 text-sm text-slate-400" data-label="Inatividade">${inativ}</td>
          </tr>
        `;
      }).join('');

  // ----- Objecoes — ranking visual com barras de progresso -----
  const totalObjecoes = Object.values(objecoesPorCategoria).reduce((s, n) => s + (n as number), 0);
  const rankingObjecoes = Object.entries(objecoesPorCategoria).length === 0
    ? '<div class="text-slate-500 text-sm italic px-1 py-2">nenhuma registrada ainda</div>'
    : `<div class="space-y-2 sm:space-y-2.5">${
        Object.entries(objecoesPorCategoria)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 6)
          .map(([cat, n], idx) => {
            const pct = totalObjecoes > 0 ? Math.round((n as number) / totalObjecoes * 100) : 0;
            // Top 1 mais vibrante, demais mais sutis pra destacar o lider
            const corBarra = idx === 0
              ? 'bg-gradient-to-r from-amber-400 to-orange-400'
              : idx === 1
              ? 'bg-amber-500/80'
              : 'bg-amber-600/60';
            const ranking = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `<span class="text-slate-500 mono">#${idx + 1}</span>`;
            return `
              <div class="flex items-center gap-2 sm:gap-3">
                <div class="text-sm w-5 text-center shrink-0">${ranking}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-baseline justify-between mb-1 gap-2">
                    <span class="text-sm font-medium text-amber-200 truncate">${escapeHtml(cat)}</span>
                    <span class="text-xs text-slate-400 mono shrink-0"><span class="text-slate-200 font-bold">${n}</span> · ${pct}%</span>
                  </div>
                  <div class="h-1.5 sm:h-2 bg-slate-700/50 rounded-full overflow-hidden">
                    <div class="h-full ${corBarra} rounded-full transition-all" style="width: ${pct}%"></div>
                  </div>
                </div>
              </div>
            `;
          }).join('')
      }</div>`;

  const linhasObjecoes = objecoesRecentes.length === 0
    ? `<tr><td colspan="4" class="text-center text-slate-400 py-10">Nenhuma objeção registrada.</td></tr>`
    : objecoesRecentes.map((o) => `
      <tr class="hover:bg-slate-700/30 transition">
        <td class="px-3 sm:px-4 py-2.5 text-sm text-slate-400 whitespace-nowrap" data-label="Quando">${formatarTempoRelativo(o.created_at)}</td>
        <td class="px-3 sm:px-4 py-2.5" data-label="Categoria"><span class="inline-block bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30 px-2 py-0.5 rounded text-xs">${escapeHtml(o.categoria)}</span></td>
        <td class="px-3 sm:px-4 py-2.5 mono text-xs text-slate-400 whitespace-nowrap" data-label="Telefone">${escapeHtml(o.telefone)}</td>
        <td class="px-3 sm:px-4 py-2.5 text-sm text-slate-300" data-label="Texto">${escapeHtml(o.texto_original)}</td>
      </tr>
    `).join('');

  // ----- Erros — ranking visual com barras de progresso -----
  const corErroChip = (cod: string): string => {
    if (cod === 'content_filter') return 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
    if (cod === 'timeout') return 'bg-orange-500/15 text-orange-300 ring-orange-500/30';
    if (cod === 'rate_limit') return 'bg-yellow-500/15 text-yellow-300 ring-yellow-500/30';
    return 'bg-slate-500/15 text-slate-300 ring-slate-500/30';
  };
  const corErroBarra = (cod: string): string => {
    if (cod === 'content_filter') return 'bg-gradient-to-r from-rose-400 to-rose-600';
    if (cod === 'timeout') return 'bg-gradient-to-r from-orange-400 to-orange-600';
    if (cod === 'rate_limit') return 'bg-gradient-to-r from-yellow-400 to-amber-500';
    return 'bg-slate-500';
  };
  const corErroTexto = (cod: string): string => {
    if (cod === 'content_filter') return 'text-rose-200';
    if (cod === 'timeout') return 'text-orange-200';
    if (cod === 'rate_limit') return 'text-yellow-200';
    return 'text-slate-200';
  };
  const totalErros = Object.values(errosPorCodigo).reduce((s, n) => s + (n as number), 0);
  const rankingErros = Object.entries(errosPorCodigo).length === 0
    ? '<div class="inline-flex items-center gap-2 text-emerald-400 text-sm px-1 py-2">'+ICON.check+' Sem erros nas últimas 24h</div>'
    : `<div class="space-y-2 sm:space-y-2.5">${
        Object.entries(errosPorCodigo)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 6)
          .map(([cod, n], idx) => {
            const pct = totalErros > 0 ? Math.round((n as number) / totalErros * 100) : 0;
            const ranking = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `<span class="text-slate-500 mono">#${idx + 1}</span>`;
            return `
              <div class="flex items-center gap-2 sm:gap-3">
                <div class="text-sm w-5 text-center shrink-0">${ranking}</div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-baseline justify-between mb-1 gap-2">
                    <span class="text-sm font-medium ${corErroTexto(cod)} truncate">${escapeHtml(cod)}</span>
                    <span class="text-xs text-slate-400 mono shrink-0"><span class="text-slate-200 font-bold">${n}</span> · ${pct}%</span>
                  </div>
                  <div class="h-1.5 sm:h-2 bg-slate-700/50 rounded-full overflow-hidden">
                    <div class="h-full ${corErroBarra(cod)} rounded-full transition-all" style="width: ${pct}%"></div>
                  </div>
                </div>
              </div>
            `;
          }).join('')
      }</div>`;

  const linhasErros = errosRecentes.length === 0
    ? `<tr><td colspan="4" class="text-center text-slate-400 py-10">Sem erros recentes 🎉</td></tr>`
    : errosRecentes.map((e) => `
      <tr class="hover:bg-slate-700/30 transition">
        <td class="px-3 sm:px-4 py-2.5 text-sm text-slate-400 whitespace-nowrap" data-label="Quando">${formatarTempoRelativo(e.created_at)}</td>
        <td class="px-3 sm:px-4 py-2.5 mono text-xs text-slate-400 whitespace-nowrap" data-label="Telefone">${escapeHtml(e.telefone)}</td>
        <td class="px-3 sm:px-4 py-2.5" data-label="Código"><span class="inline-block ${corErroChip(e.error_code || 'outro')} ring-1 px-2 py-0.5 rounded text-xs">${escapeHtml(e.error_code || 'outro')}</span></td>
        <td class="px-3 sm:px-4 py-2.5 text-xs text-slate-300 max-w-md truncate" title="${escapeHtml(e.error_message || '')}" data-label="Mensagem">${escapeHtml((e.error_message || '').slice(0, 200))}</td>
      </tr>
    `).join('');

  return `<!doctype html>
<html lang="pt-BR">
${HEAD_COMUM.replace('</head>', `<title>Dashboard — Rei Delas</title></head>`)}
<body class="min-h-screen bg-slate-900 text-slate-100" style="background-image: radial-gradient(circle at 0% 0%, rgba(16,185,129,0.08) 0%, transparent 50%), radial-gradient(circle at 100% 0%, rgba(59,130,246,0.05) 0%, transparent 50%);">
  <div id="dash-root" class="max-w-7xl mx-auto px-3 sm:px-6 py-3 sm:py-6">
    <!-- Header sticky -->
    <header class="sticky top-0 z-10 -mx-3 sm:-mx-6 px-3 sm:px-6 py-3 sm:py-4 mb-5 sm:mb-6 glass border-b border-slate-700/50">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-lg sm:text-xl shrink-0">👑</div>
          <div class="min-w-0">
            <h1 class="text-base sm:text-xl font-bold tracking-tight truncate">Rei Delas</h1>
            <p class="text-[11px] sm:text-xs text-slate-400 truncate">Dashboard · MCR</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 text-[11px] sm:text-xs text-slate-400 mono shrink-0">
          <span class="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-emerald-400 pulse-dot"></span>
          ${agora}
        </div>
      </div>
    </header>

    <!-- Links enviados (Sofia mandou checkout) -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        ${ICON.bolt} Links enviados <span class="text-slate-500 normal-case font-normal text-xs">(Sofia mandou checkout)</span>
      </h2>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        ${cardsConversoes}
      </div>
    </section>

    <!-- Funil de vendas -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center justify-between gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        <span class="flex items-center gap-2">
          📊 Funil de vendas <span class="text-slate-500 normal-case font-normal text-xs">(historico total)</span>
        </span>
        <span class="text-xs normal-case font-normal text-slate-400 mono">
          Conversao total: <span class="${conversaoTotal >= 10 ? 'text-emerald-300' : conversaoTotal >= 3 ? 'text-amber-300' : 'text-slate-300'} font-semibold">${conversaoTotal}%</span>
        </span>
      </h2>
      <div class="rounded-xl sm:rounded-2xl bg-slate-800/40 ring-1 ring-slate-700/50 p-3 sm:p-5">
        <div class="space-y-1.5 sm:space-y-2">
          ${linhasFunil}
        </div>
      </div>
    </section>

    <!-- Follow-ups automaticos (sistema cuida do silencio) -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        ⏰ Follow-ups automaticos <span class="text-slate-500 normal-case font-normal text-xs">(scheduler cutucando leads silenciados)</span>
      </h2>
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-2 sm:gap-3">
        ${cardsFup}
      </div>
    </section>

    <!-- Conversas ativas -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        ${ICON.chat} Conversas ativas
        <span class="text-slate-500 normal-case font-normal text-xs">(${conversasAtivas.length})</span>
      </h2>
      <div class="rounded-xl sm:rounded-2xl ring-1 ring-slate-700/50 overflow-hidden bg-slate-800/40">
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-left mobile-card-table">
            <thead class="bg-slate-800/60 text-[10px] uppercase tracking-wider text-slate-400 hidden sm:table-header-group">
              <tr>
                <th class="px-3 sm:px-4 py-3 font-medium">Lead</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Telefone</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Status</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Lead falou</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Bot falou</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Inativ.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/30">${linhasConversas}</tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Objecoes -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        ${ICON.target} Objeções
        ${totalObjecoes > 0 ? `<span class="text-slate-500 normal-case font-normal text-xs">${totalObjecoes} total</span>` : ''}
      </h2>
      <div class="rounded-xl sm:rounded-2xl ring-1 ring-slate-700/50 bg-slate-800/40 p-3 sm:p-4 mb-3">
        ${rankingObjecoes}
      </div>
      <div class="rounded-2xl ring-1 ring-slate-700/50 overflow-hidden bg-slate-800/40">
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-left mobile-card-table">
            <thead class="bg-slate-800/60 text-[10px] uppercase tracking-wider text-slate-400 hidden sm:table-header-group">
              <tr>
                <th class="px-3 sm:px-4 py-3 font-medium">Quando</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Categoria</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Telefone</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Texto original</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/30">${linhasObjecoes}</tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Erros -->
    <section class="mb-6 sm:mb-8">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
        ${ICON.alert} Erros do agente <span class="text-slate-500 normal-case font-normal text-xs">(últimas 24h${totalErros > 0 ? ` · ${totalErros} total` : ''})</span>
      </h2>
      <div class="rounded-xl sm:rounded-2xl ring-1 ring-slate-700/50 bg-slate-800/40 p-3 sm:p-4 mb-3">
        ${rankingErros}
      </div>
      <div class="rounded-2xl ring-1 ring-slate-700/50 overflow-hidden bg-slate-800/40">
        <div class="overflow-x-auto scrollbar-thin">
          <table class="w-full text-left mobile-card-table">
            <thead class="bg-slate-800/60 text-[10px] uppercase tracking-wider text-slate-400 hidden sm:table-header-group">
              <tr>
                <th class="px-3 sm:px-4 py-3 font-medium">Quando</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Telefone</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Código</th>
                <th class="px-3 sm:px-4 py-3 font-medium">Mensagem</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-700/30">${linhasErros}</tbody>
          </table>
        </div>
      </div>
    </section>

    <footer class="text-center text-[11px] sm:text-xs text-slate-500 mt-8 sm:mt-12 pb-4 sm:pb-6">
      Auto-refresh 30s · Rei Delas · ${agora}
    </footer>
  </div>
  <script>
  // Auto-refresh sem reload da pagina: a cada 30s busca a propria URL,
  // parseia o HTML retornado e substitui so o #dash-root. Mantem o scroll,
  // nao causa flash, nao fecha dropdowns. Basic Auth e enviado automatico
  // pelo browser (cache da sessao same-origin).
  (function() {
    const INTERVAL_MS = 30000;
    let inFlight = false;
    async function refresh() {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const r = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return;
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const novo = doc.getElementById('dash-root');
        const atual = document.getElementById('dash-root');
        if (novo && atual) atual.replaceWith(novo);
      } catch (e) {
        console.error('[dash-refresh]', e);
      } finally {
        inFlight = false;
      }
    }
    setInterval(refresh, INTERVAL_MS);
    // Atualiza quando a aba volta a ficar visivel apos ter ficado oculta
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  })();
  </script>
</body>
</html>`;
}

// =================== Viewer de conversa ===================

function gerarHTMLConversa(conversa: any, mensagens: any[]): string {
  const customer = conversa.auton_sdr_customers || {};
  const nome = customer.nome || '(sem nome)';
  const telefone = customer.telefone || '—';
  const status = conversa.status;
  const inicio = formatarDataHora(conversa.started_at);
  const linkEnv = conversa.link_enviado
    ? `${ICON.check} ${formatarDataHora(conversa.link_enviado_em)}`
    : '—';

  // Itera mensagens em ordem cronologica e calcula tempo de resposta da Sofia.
  let ultimaUserTs: number | null = null;
  const bolhas = mensagens.map((m) => {
    const ts = new Date(m.created_at).getTime();
    const hora = formatarHora(m.created_at);
    const conteudo = escapeHtml(m.content || '').replace(/\n/g, '<br>');
    const tool = badgeTool(m.tool_name, m.tool_input);
    const toolBadge = tool
      ? `<div class="inline-flex items-center gap-1 mt-2 px-2 py-0.5 bg-white/10 rounded text-[11px] font-medium"><span>${tool.icone}</span><span>${escapeHtml(tool.label)}</span></div>`
      : '';

    if (m.role === 'user') {
      ultimaUserTs = ts;
      return `
        <div class="flex flex-col mb-3">
          <div class="bubble b-lead">
            <div>${conteudo}</div>
            <div class="meta text-slate-400">${hora}</div>
          </div>
        </div>
      `;
    }

    if (m.role === 'assistant') {
      let medidor = '';
      if (m.tool_name && m.tool_name.startsWith('follow-up-')) {
        const horas = m.tool_name.replace('follow-up-', '').replace('h', '');
        medidor = `<span class="text-violet-300">${ICON.clock} FUP ${escapeHtml(horas)}h</span>`;
      } else if (ultimaUserTs) {
        const diff = ts - ultimaUserTs;
        medidor = `<span class="${classeDuracao(diff)}">${ICON.clock} ${formatarDuracao(diff)}</span>`;
      }
      return `
        <div class="flex flex-col mb-3 items-end">
          <div class="bubble b-sofia">
            <div>${conteudo}</div>
            ${toolBadge}
            <div class="meta text-emerald-200/70 text-right flex items-center justify-end gap-2 mt-1">
              ${medidor}
              <span>${hora}</span>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="flex justify-center mb-3">
        <div class="bubble b-sys">
          <div>${conteudo}</div>
          ${toolBadge}
          <div class="meta text-center">${hora}</div>
        </div>
      </div>
    `;
  }).join('');

  return `<!doctype html>
<html lang="pt-BR">
${HEAD_COMUM.replace('</head>', `<title>${escapeHtml(nome)} — Rei Delas</title></head>`)}
<body class="min-h-screen bg-slate-900 text-slate-100" style="background-image: radial-gradient(circle at 50% 0%, rgba(16,185,129,0.08) 0%, transparent 50%);">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
    <!-- Top bar com voltar -->
    <div class="mb-4">
      <a href="/api/dashboard" aria-label="Voltar ao dashboard" class="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-emerald-300 transition">
        ${ICON.arrow} Voltar
      </a>
    </div>

    <!-- Header da conversa estilo WhatsApp -->
    <header class="sticky top-2 z-10 mb-4 glass rounded-2xl ring-1 ring-slate-700/50 p-4 shadow-lg">
      <div class="flex items-center gap-3 flex-wrap">
        <div class="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white font-bold shrink-0">${escapeHtml(iniciaisDe(nome))}</div>
        <div class="flex-1 min-w-0">
          <h1 class="text-lg font-semibold text-slate-100 truncate">${escapeHtml(nome)}</h1>
          <div class="flex items-center gap-2 text-xs text-slate-400 mono mt-0.5">
            <span>${escapeHtml(telefone)}</span>
            <span class="text-slate-600">·</span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full ring-1 ${classeStatus(status)}">
              ${status === 'em_atendimento' ? '<span class="w-1.5 h-1.5 rounded-full bg-current pulse-dot"></span>' : ''}
              ${escapeHtml(status)}
            </span>
          </div>
        </div>
      </div>
      <div class="mt-3 pt-3 border-t border-slate-700/50 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div class="text-slate-500 uppercase tracking-wider">Início</div>
          <div class="text-slate-300 mt-0.5">${inicio}</div>
        </div>
        <div>
          <div class="text-slate-500 uppercase tracking-wider">Link de checkout</div>
          <div class="text-slate-300 mt-0.5 flex items-center gap-1 ${conversa.link_enviado ? 'text-emerald-300' : ''}">${linkEnv}</div>
        </div>
      </div>
    </header>

    <!-- Thread de mensagens -->
    <main class="bg-slate-800/30 rounded-2xl ring-1 ring-slate-700/50 p-4 sm:p-5 flex flex-col" style="min-height: 400px;">
      ${mensagens.length === 0
        ? '<div class="text-center text-slate-500 py-16">Nenhuma mensagem nesta conversa.</div>'
        : bolhas}
    </main>

    <footer class="text-center text-xs text-slate-500 mt-4 pb-4">
      ${mensagens.length} mensagem(ns) · <span class="mono">${escapeHtml(conversa.id)}</span>
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
    const [conversasAtivas, conversoes, funil, followUps, objecoesRecentes, objecoesPorCategoria, errosRecentes, errosPorCodigo] = await Promise.all([
      buscarConversasAtivas(50),
      contarConversoes(),
      contarFunil(),
      contarFollowUps(),
      buscarObjecoesRecentes(30),
      contarObjecoesPorCategoria(),
      buscarErrosRecentes(30),
      contarErrosPorCodigo(),
    ]);
    const html = gerarHTMLDashboard({
      conversasAtivas,
      conversoes,
      funil,
      followUps,
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
