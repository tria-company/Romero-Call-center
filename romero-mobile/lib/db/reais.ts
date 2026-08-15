/* ══════════════════════════════════════════════════════════════════════════
   BASE REAL — ClickUp (Gabinete 509 · Telemarketing 2.0)

   `reais.json` é gerado por `npm run puxar:clickup` e NÃO está no repositório
   (contém nome, telefone e CPF de eleitores). Quando ele vem vazio — clone
   novo, script ainda não rodado — `temBaseReal()` devolve false e a semente
   fictícia assume, exatamente como antes.

   O QUE É REAL e o que não é, para ninguém ler número inventado como número
   apurado:

     REAL   cadastros, nomes, telefones, bairro/cidade, confirmação de voto,
            militante, observação consolidada, último contato, próximo contato,
            fila do dia (derivada de "Próximo contato") e as ligações.

     SEM FONTE no ClickUp, mantido do mockup e marcado aqui: seguidores de
     Instagram, meta de cada candidato e apoioHoje. Pets, aniversário, idade,
     indicações e atendimentos ficam VAZIOS em vez de inventados — é por isso
     que a ficha mostra menos coisa do que mostrava com a base fictícia.
   ══════════════════════════════════════════════════════════════════════════ */

import bruto from "./reais.json";
import { VERSAO_BANCO } from "./seed";
import type { Banco, Candidato, Interacao, ItemFila, Lead } from "./schema";

type BaseReal = {
  geradoEm: string;
  origem: { workspace: string; space: string; folder: string };
  totais: {
    cadastros: number;
    confirmadosRomero: number;
    confirmadosAndreza: number;
    militantes: number;
    comContato: number;
    semContato: number;
    contatadosHoje: number;
    ligacoes: number;
  };
  leads: Lead[];
  fila: ItemFila[];
  interacoes: Interacao[];
};

const base = bruto as unknown as BaseReal;

export function temBaseReal(): boolean {
  return Array.isArray(base?.leads) && base.leads.length > 0;
}

export const origemReal = base?.origem;
export const geradoEmReal = base?.geradoEm;
export const totaisReais = base?.totais;

function candidatosReais(): Candidato[] {
  const t = base.totais;
  return [
    {
      id: "romero",
      nome: "Romero",
      cargo: "Deputado Estadual",
      numero: "40000",
      emoji: "🐶",
      instagram: "@romeroalbuquerque40000",
      seguidores: 84312, // sem fonte no ClickUp
      seguidoresHoje: 218, // sem fonte
      apoio: t.confirmadosRomero, // REAL
      meta: 21500, // sem fonte
      apoioHoje: 0, // sem fonte: o ClickUp não datou a confirmação
    },
    {
      id: "andreza",
      nome: "Andreza",
      cargo: "Deputada Federal",
      numero: "4020",
      emoji: "🐱",
      instagram: "@andrezaromero",
      seguidores: 61847, // sem fonte
      seguidoresHoje: 174, // sem fonte
      apoio: t.confirmadosAndreza, // REAL
      meta: 21500, // sem fonte
      apoioHoje: 0, // sem fonte
    },
  ];
}

export function criarBancoReal(): Banco {
  const t = base.totais;
  return {
    versao: VERSAO_BANCO,
    painel: {
      cadastros: t.cadastros, // REAL — total da lista Leads
      apoiadoresAtivos: t.comContato, // REAL — pessoas já alcançadas pela operação
      apoiadoresHoje: t.contatadosHoje, // REAL — contatadas hoje
      equipeTamanho: 0, // a tela de Equipe foi removida; sem fonte
      equipeOnline: 0,
    },
    candidatos: candidatosReais(),
    leads: base.leads,
    atendimentos: [], // sem fonte: o ClickUp guarda a CONTAGEM, não os eventos
    fila: base.fila,
    interacoes: base.interacoes,
    solicitacoes: [], // a CENTRAL DE DEMANDAS do ClickUp está zerada
    ultimoCodigo: 0,
  };
}
