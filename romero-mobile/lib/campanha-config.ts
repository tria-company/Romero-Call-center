/* ══════════════════════════════════════════════════════════════════════════
   CENTRAL DE CAMPANHA — o que NÃO é telemetria.

   Tudo neste arquivo é decisão de campanha, não medição: meta de votos,
   calendário eleitoral e tamanho da equipe. Nenhum desses números existe no
   ClickUp, e nenhum poderia ser derivado das ligações — são escolhas de quem
   comanda a operação.

   O resto da tela (ligações, contatos, tempo médio, ranking, cobertura, SLA)
   é telemetria contada da operação. Hoje ela NÃO existe mais aqui: a extração
   periódica em arquivo foi desacoplada e a Central de Campanha mostra "sem
   dados ainda" para tudo que não seja meta/calendário/equipe (ver `campanha.ts`,
   const `VAZIO`). Voltará quando existir uma rota de agregação ao vivo.

   Editar aqui é o jeito certo de ajustar meta e datas — são decisão de campanha,
   não medição.
   ══════════════════════════════════════════════════════════════════════════ */

export const CONFIG_CAMPANHA = {
  /** Metas de votos por urna. Sem fonte: definidas pela campanha. */
  metas: {
    romero: 40000,
    andreza: 30000,
  },

  /** Calendário. Rótulos em DD/MM — são exibição, não cálculo. */
  calendario: {
    inicio: "28/07",
    eleicao: "27/08",
    totalDias: 30,
  },

  /**
   * Telefonistas na operação inteira. O ranking mostra só quem tem ligação
   * registrada no ClickUp; este número é o efetivo contratado.
   * 0 = desconhecido, e a tela omite em vez de inventar.
   */
  equipeTotal: 0,
} as const;
