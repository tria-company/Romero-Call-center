// Mapa de field-ids ClickUp — UMA ÚNICA AUTORIDADE validada no boot (17-03,
// MODELO-06/D-07, .planning/arquitetura/inversao-supabase-fonte-da-verdade.md
// §2.5, R8).
//
// As constantes CAMPOS_LEADS/CAMPOS_LIGACOES/CAMPOS_AUDIOS + OPCOES_LEADS/
// OPCOES_LIGACOES/OPCOES_AUDIOS (clickup.ts) continuam a FONTE DE ESCRITA —
// este módulo NÃO as substitui. O que ele faz: no boot, busca
// `get_custom_fields` das 3 listas UMA vez (`getCustomFields`, clickup.ts) e
// VALIDA que as constantes ainda batem com a realidade do ClickUp. Field_id
// sumiu ou opção de dropdown nova/desconhecida -> `DivergenciaCampoMapa`
// (falha alto, MODELO-06 — nunca segue silencioso, porque no caminho
// reverso, Phase 19, um UUID desconhecido derrubaria o valor no Supabase).
// Em sucesso, cacheia o mapa validado em `clickup_campo_mapa` (cache
// VERSIONADO dessa busca, com origem carimbada — não uma segunda fonte
// manual que pode divergir).
//
// ClickUp inalcançável (erro de rede) NÃO é divergência: `carregarEValidarCampoMapa`
// loga warning e PULA a validação neste boot (retry no próximo boot) — nunca
// brica o processo por causa de uma dependência externa fora do ar (mesmo
// espírito do healthcheck raso do serviço). Só uma resposta ALCANÇÁVEL e
// divergente falha alto.
//
// LGPD: nenhuma função deste módulo loga PII — só nomes lógicos de campo e
// UUIDs de opção de dropdown (não são dado do lead).

import { getCustomFields, CAMPOS_LEADS, CAMPOS_LIGACOES, CAMPOS_AUDIOS, OPCOES_LEADS, OPCOES_LIGACOES, OPCOES_AUDIOS } from './clickup.ts';
import type { CampoClickUpDefinicao } from './clickup.ts';
import { CLICKUP_LIST_LEADS, CLICKUP_LIST_LIGACOES, CLICKUP_LIST_AUDIOS, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_TABLE_CLICKUP_CAMPO_MAPA } from './config.ts';
import { SUPABASE_REST_URL } from './supabase.ts';
import { fetchTimeout } from './http.ts';
import { alertarThreshold } from './alertas.ts';

export type ListaClickUp = 'LEADS' | 'LIGACOES' | 'AUDIOS';

/** Mapa de opção de dropdown já validado — BIDIRECIONAL (design §2.5), pra
 *  servir tanto a escrita (valor lógico -> uuid) quanto o caminho reverso
 *  futuro (Phase 19, uuid -> valor lógico). */
export interface OpcoesBidirecionais {
  porValor: Record<string, string>;
  porUuid: Record<string, string>;
}

/** Uma entrada validada do mapa — mesmo shape de `clickup_campo_mapa`
 *  (sql/escala/10_clickup_campos.sql, design §2.5). */
export interface CampoMapaEntry {
  lista: ListaClickUp;
  campo_logico: string;
  field_id: string;
  tipo: string;
  opcoes: OpcoesBidirecionais | null;
  origem: string;
}

/** Constantes de UMA lista a validar contra o ClickUp: campo_logico->field_id
 *  (CAMPOS_*) + field_id->{valorLogico:uuid} pros campos drop_down (OPCOES_*
 *  já tem exatamente esse shape — sem conversão). */
export interface ConstantesCampoLista {
  lista: ListaClickUp;
  campos: Record<string, string>;
  opcoes?: Record<string, Record<string, string>>;
}

/** Divergência GENUÍNA entre as constantes do código e o ClickUp real
 *  (field_id sumiu, opção de dropdown removida, ou opção NOVA desconhecida
 *  ao código) — falha alto no boot (MODELO-06), nunca segue silenciosa. */
export class DivergenciaCampoMapa extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DivergenciaCampoMapa';
  }
}

/**
 * PURA (sem I/O): valida as constantes de UMA lista contra as definições
 * reais do ClickUp (`getCustomFields`). Para cada campo_logico, confere que o
 * field_id existe no ClickUp — ausente lança `DivergenciaCampoMapa`. Para
 * cada campo com opções (OPCOES_*), confere BIDIRECIONALMENTE: toda opção
 * esperada existe no ClickUp (UUID sumiu -> lança) E toda opção real do
 * ClickUp é conhecida do código (UUID novo -> lança, R8 — sem isso o
 * caminho reverso futuro derrubaria esse valor silenciosamente). Em sucesso,
 * devolve o mapa validado com origem carimbada.
 */
export function validarCampoMapa(
  constantes: ConstantesCampoLista,
  camposClickUp: CampoClickUpDefinicao[],
): CampoMapaEntry[] {
  const origem = `clickup_get_custom_fields@${new Date().toISOString()}`;
  const porId = new Map(camposClickUp.map((f) => [f.id, f]));
  const entradas: CampoMapaEntry[] = [];

  for (const [campoLogico, fieldId] of Object.entries(constantes.campos)) {
    const definicao = porId.get(fieldId);
    if (!definicao) {
      throw new DivergenciaCampoMapa(
        `[campo-mapa] ${constantes.lista}.${campoLogico}: field_id ${fieldId} nao encontrado no ClickUp ` +
          `(campo removido/renomeado na lista?) — atualize CAMPOS_${constantes.lista} antes de seguir`,
      );
    }

    let opcoesValidadas: OpcoesBidirecionais | null = null;
    const opcoesEsperadas = constantes.opcoes?.[fieldId];
    if (opcoesEsperadas) {
      const opcoesClickUp = definicao.type_config?.options ?? [];
      const uuidsClickUp = new Set(opcoesClickUp.map((o) => o.id).filter((id): id is string => !!id));
      const uuidsEsperados = new Set(Object.values(opcoesEsperadas));

      for (const [valorLogico, uuid] of Object.entries(opcoesEsperadas)) {
        if (!uuidsClickUp.has(uuid)) {
          throw new DivergenciaCampoMapa(
            `[campo-mapa] ${constantes.lista}.${campoLogico}: opcao '${valorLogico}' (uuid ${uuid}) nao encontrada ` +
              `nas opcoes do ClickUp (opcao removida na UI?) — atualize OPCOES_${constantes.lista} antes de seguir`,
          );
        }
      }
      for (const uuidReal of uuidsClickUp) {
        if (!uuidsEsperados.has(uuidReal)) {
          throw new DivergenciaCampoMapa(
            `[campo-mapa] ${constantes.lista}.${campoLogico}: opcao NOVA no ClickUp (uuid ${uuidReal}) desconhecida ` +
              `ao codigo — atualize OPCOES_${constantes.lista} antes que o caminho reverso derrube esse valor (R8)`,
          );
        }
      }

      opcoesValidadas = {
        porValor: { ...opcoesEsperadas },
        porUuid: Object.fromEntries(Object.entries(opcoesEsperadas).map(([valor, uuid]) => [uuid, valor])),
      };
    }

    entradas.push({
      lista: constantes.lista,
      campo_logico: campoLogico,
      field_id: fieldId,
      tipo: definicao.type,
      opcoes: opcoesValidadas,
      origem,
    });
  }

  return entradas;
}

/** Upsert (merge por `lista,campo_logico` — PRIMARY KEY) do mapa validado em
 *  `clickup_campo_mapa`. Self-contained (não modifica supabase.ts): reusa
 *  `SUPABASE_REST_URL` + monta os headers a partir de `SUPABASE_SERVICE_KEY`,
 *  mesmo molde de `upsertLigacoesEspelho`. Sem Supabase configurado -> no-op
 *  (0). Erro de rede/HTTP LANÇA (WR-03). NUNCA loga token. */
export async function upsertCampoMapa(linhas: CampoMapaEntry[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  if (linhas.length === 0) return 0;
  let res: Response;
  try {
    res = await fetchTimeout(`${SUPABASE_REST_URL}/${SUPABASE_TABLE_CLICKUP_CAMPO_MAPA}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(linhas),
    });
  } catch (e) {
    throw new Error(
      `[campo-mapa] falha de rede ao cachear mapa em ${SUPABASE_TABLE_CLICKUP_CAMPO_MAPA}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`[campo-mapa] HTTP ${res.status} ao cachear mapa em ${SUPABASE_TABLE_CLICKUP_CAMPO_MAPA}`);
  }
  return linhas.length;
}

/** Injeção de dependências (testabilidade — smoke offline, sem rede real). */
export interface CarregarEValidarDeps {
  buscarCampos: (listId: string) => Promise<CampoClickUpDefinicao[]>;
  cachear: (linhas: CampoMapaEntry[]) => Promise<number>;
  alertar: (titulo: string, detalhe: string) => Promise<void>;
}

export interface ResultadoCarregarEValidar {
  /** true quando o ClickUp estava inalcançável e a validação foi PULADA (retry no próximo boot). */
  pulou: boolean;
  mapa: CampoMapaEntry[];
}

const LISTAS: Array<{ lista: ListaClickUp; listId: string; campos: Record<string, string>; opcoes: Record<string, Record<string, string>> }> = [
  { lista: 'LEADS', listId: CLICKUP_LIST_LEADS, campos: CAMPOS_LEADS, opcoes: OPCOES_LEADS },
  { lista: 'LIGACOES', listId: CLICKUP_LIST_LIGACOES, campos: CAMPOS_LIGACOES, opcoes: OPCOES_LIGACOES },
  { lista: 'AUDIOS', listId: CLICKUP_LIST_AUDIOS, campos: CAMPOS_AUDIOS, opcoes: OPCOES_AUDIOS },
];

/**
 * Boot (I/O): busca `get_custom_fields` das 3 listas (LEADS/LIGACOES/AUDIOS),
 * valida contra as constantes do código (`validarCampoMapa`) e, em sucesso,
 * cacheia o mapa validado em `clickup_campo_mapa`. ClickUp inalcançável
 * (erro de rede em QUALQUER lista) -> warn + PULA a validação inteira desta
 * rodada (retry no próximo boot; nunca brica o processo por dependência
 * externa fora do ar). Divergência GENUÍNA (ClickUp alcançável mas
 * discordante) -> dispara alerta best-effort e RE-LANÇA `DivergenciaCampoMapa`
 * (falha alto, MODELO-06) — o chamador (index.ts, boot) decide como reagir.
 * Falha ao CACHEAR (Supabase indisponível) é degradação best-effort: loga e
 * segue (a autoridade real são as constantes já validadas, o cache é só
 * contrato legível para o worker/reverso futuro, Phase 19).
 */
export async function carregarEValidarCampoMapa(
  deps: Partial<CarregarEValidarDeps> = {},
): Promise<ResultadoCarregarEValidar> {
  const buscarCampos = deps.buscarCampos ?? getCustomFields;
  const cachear = deps.cachear ?? upsertCampoMapa;
  const alertar = deps.alertar ?? alertarThreshold;

  let camposPorLista: Record<ListaClickUp, CampoClickUpDefinicao[]>;
  try {
    const resultados = await Promise.all(LISTAS.map((l) => buscarCampos(l.listId)));
    camposPorLista = Object.fromEntries(LISTAS.map((l, i) => [l.lista, resultados[i]])) as Record<
      ListaClickUp,
      CampoClickUpDefinicao[]
    >;
  } catch (e) {
    console.warn(
      `[campo-mapa] ClickUp inalcancavel no boot — pulando validacao do mapa de field-ids (retry no proximo boot): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { pulou: true, mapa: [] };
  }

  let mapa: CampoMapaEntry[];
  try {
    mapa = LISTAS.flatMap((l) =>
      validarCampoMapa({ lista: l.lista, campos: l.campos, opcoes: l.opcoes }, camposPorLista[l.lista]),
    );
  } catch (e) {
    if (e instanceof DivergenciaCampoMapa) {
      await alertar('🚨 Divergência no mapa de field-ids ClickUp (boot)', e.message).catch(() => {});
    }
    throw e;
  }

  try {
    await cachear(mapa);
  } catch (e) {
    console.error(
      `[campo-mapa] falha ao cachear o mapa validado em ${SUPABASE_TABLE_CLICKUP_CAMPO_MAPA} (degradando p/ so-log; a autoridade sao as constantes ja validadas): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  return { pulou: false, mapa };
}
