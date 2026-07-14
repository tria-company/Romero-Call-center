// Helper compartilhado para envio de avisos ao grupo SUPORTE CAMINHO DE RAINHA - IA.
// Usado por:
//  - handoff-humano (avisa que IA pausou e humano precisa assumir)
//  - notificar-time (avisa o time mas IA continua atendendo)
//
// LIMITACAO no GHL: a API oficial nao envia pra grupos do WhatsApp. Se
// SUPORTE_GRUPO_JID for um JID de grupo (formato @g.us, herdado da Evolution),
// o aviso e logado mas nao chega no WhatsApp. Pra notificar o time hoje:
// olhar logs do agente OU dashboard /api/dashboard (section "Erros do agente"
// e tabela de Conversas). Pra futuro: trocar destino pra Slack/email/SMS.

import { enviarMensagem } from './ghl';
import { SUPORTE_GRUPO_JID } from './config';

// Cache de idempotencia: rastreia (telefone, motivo) ja notificados pra
// evitar spam no grupo quando a Sofia (por perda de memoria, multi-step,
// ou outra anomalia) chama a mesma tool varias vezes pro mesmo contato.
// Janela: 1 hora. Apos isso, considera nova situacao.
const JANELA_IDEMPOTENCIA_MS = 60 * 60 * 1000;
const cacheNotificacoes = new Map<string, number>();

setInterval(() => {
  const agora = Date.now();
  for (const [key, ts] of cacheNotificacoes) {
    if (agora - ts > JANELA_IDEMPOTENCIA_MS) cacheNotificacoes.delete(key);
  }
}, 10 * 60 * 1000); // limpeza a cada 10 min

/**
 * Verifica se ja notificamos esse contato pelo mesmo motivo na ultima 1h.
 * Se sim, retorna true (e nao deve renotificar). Se nao, registra e
 * retorna false (caller pode prosseguir).
 *
 * Equivale a `consultarNotificacao` seguido de `registrarNotificacao` quando
 * o resultado da consulta for false — ou seja, e um consultar+registrar
 * ATOMICO (registra ANTES de qualquer tentativa do caller). Por isso so deve
 * ser usado quando a acao apos a consulta e best-effort e nao precisa de
 * retry honesto (index.ts: audio_falhou/erro_agente/camila_json_invalido/
 * qualificador_falhou; handoff-humano.ts) — nesses casos, "consumir" a
 * janela mesmo se o aviso falhar e aceitavel (anti-spam vence).
 *
 * Quem tem uma tentativa que PODE FALHAR apos a consulta usa o split abaixo
 * (`consultarNotificacao` + `registrarNotificacao` APOS sucesso real):
 * escalate-to-human.ts (task/move/grupo) e tools/create-task.ts (POST na
 * GHL pode falhar por PIT token ausente, contactId nao resolvido ou erro de
 * rede — CR-01 da 3a rodada: registrar antes fazia o retry devolver
 * {sucesso:true} fake sem criar task nenhuma).
 */
export function jaNotificouRecentemente(telefone: string, motivo: string): boolean {
  const key = `${telefone}:${motivo}`;
  const ts = cacheNotificacoes.get(key);
  if (ts && Date.now() - ts < JANELA_IDEMPOTENCIA_MS) {
    return true;
  }
  cacheNotificacoes.set(key, Date.now());
  return false;
}

/**
 * Consulta READ-ONLY da janela de idempotencia: retorna true se a chave
 * `telefone:chave` foi registrada ha menos que JANELA_IDEMPOTENCIA_MS.
 * NUNCA grava no cacheNotificacoes — chamar 2x seguidas sem
 * `registrarNotificacao` no meio retorna o mesmo resultado nas duas vezes.
 */
export function consultarNotificacao(telefone: string, chave: string): boolean {
  const key = `${telefone}:${chave}`;
  const ts = cacheNotificacoes.get(key);
  return !!ts && Date.now() - ts < JANELA_IDEMPOTENCIA_MS;
}

/**
 * Registra a chave `telefone:chave` no cacheNotificacoes com o timestamp
 * atual, marcando a janela de idempotencia. Usar SOMENTE apos confirmar
 * sucesso real da acao que a chave representa (ver escalate-to-human.ts).
 */
export function registrarNotificacao(telefone: string, chave: string): void {
  const key = `${telefone}:${chave}`;
  cacheNotificacoes.set(key, Date.now());
}

/**
 * "Envia" um aviso ao grupo de suporte. No GHL, mensagens 1:1 com leads
 * funcionam normalmente, MAS grupos do WhatsApp nao sao suportados pela API
 * oficial. Se SUPORTE_GRUPO_JID for um JID de grupo (legacy Evolution), o
 * aviso e LOGADO de forma estruturada (pra leitura no docker logs ou
 * dashboard), mas nao e entregue como mensagem.
 *
 * Quando o destino e um telefone valido (sem @g.us), o aviso e enviado
 * normalmente via GHL.
 *
 * Retorna true se conseguiu logar/enviar; false se SUPORTE_GRUPO_JID nao
 * estiver configurado.
 */
export async function enviarAvisoAoSuporte(linhas: string[]): Promise<boolean> {
  if (!SUPORTE_GRUPO_JID) {
    console.log('[notificacoes] SUPORTE_GRUPO_JID nao configurado, pulando aviso');
    return false;
  }

  const ehGrupo = SUPORTE_GRUPO_JID.includes('@g.us') || SUPORTE_GRUPO_JID.includes('@broadcast');
  if (ehGrupo) {
    // GHL nao manda pra grupo — log estruturado pra captura via dashboard/CI.
    console.log('[notificacoes][grupo-skip]\n' + linhas.join('\n') + '\n[/notificacoes]');
    return true;
  }

  try {
    await enviarMensagem(SUPORTE_GRUPO_JID, linhas.join('\n'), { quebrar: false });
    return true;
  } catch (e) {
    console.error('[notificacoes] Falha ao notificar:', e);
    return false;
  }
}
