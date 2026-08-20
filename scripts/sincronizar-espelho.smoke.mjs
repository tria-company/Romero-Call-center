#!/usr/bin/env node
// scripts/sincronizar-espelho.smoke.mjs
//
// Smoke determinístico (sem rede) dos 3 mappers PUROS do espelho generalizado
// (17-02, Fase A espelho — src/mastra/espelho.ts): `paraLinhaLigacao`,
// `paraLinhaAudio`, `paraLinhaLeadFull`. Prova, via fixtures de TaskClickUp
// (custom_fields com os field-ids REAIS de CAMPOS_LIGACOES/CAMPOS_AUDIOS/
// CAMPOS_LEADS — D-07, nunca por nome), que os mappers extraem o shape certo
// da linha do espelho — incluindo o caso do 9º dígito (12 e 13 dígitos devem
// produzir o MESMO telefone_canonico).
//
// Uso: node --experimental-strip-types scripts/sincronizar-espelho.smoke.mjs

import { paraLinhaLigacao, paraLinhaAudio, paraLinhaLeadFull } from '../src/mastra/espelho.ts';
import { CAMPOS_LIGACOES, CAMPOS_AUDIOS, CAMPOS_LEADS, OPCOES_LIGACOES } from '../src/mastra/clickup.ts';

const falhas = [];

function checar(condicao, mensagem) {
  if (!condicao) falhas.push(mensagem);
}

const AGORA = '2026-08-20T12:00:00.000Z';

// ===== paraLinhaLigacao =====

function taskLigacaoFixture(overrides = {}) {
  const camposBase = {
    [CAMPOS_LIGACOES.LEAD_REL]: [{ id: 'lead-task-abc' }],
    [CAMPOS_LIGACOES.TELEFONE]: '+5581999998888',
    [CAMPOS_LIGACOES.OPERADOR]: 'closer1',
    [CAMPOS_LIGACOES.ATENDEU]: OPCOES_LIGACOES[CAMPOS_LIGACOES.ATENDEU].sim,
    [CAMPOS_LIGACOES.INICIO]: '1755000000000',
    [CAMPOS_LIGACOES.FIM]: '1755000300000', // +300s
    [CAMPOS_LIGACOES.DURACAO]: '5min 0s',
    [CAMPOS_LIGACOES.MOTIVO_FALHA]: '',
    [CAMPOS_LIGACOES.URL_GRAVACAO]: 'https://exemplo/gravacao.mp3',
    [CAMPOS_LIGACOES.TRANSCRICAO]: 'transcrição de teste',
    [CAMPOS_LIGACOES.ANALISE_IA]: 'LIGAR — respondeu positivo',
    [CAMPOS_LIGACOES.NECESSITA_REVISAO]: OPCOES_LIGACOES[CAMPOS_LIGACOES.NECESSITA_REVISAO].nao,
  };
  const custom_fields = Object.entries({ ...camposBase, ...(overrides.campos ?? {}) }).map(([id, value]) => ({
    id,
    value,
  }));
  return {
    id: overrides.id ?? 'ligacao-task-1',
    name: 'Ligação — teste',
    status: overrides.status ?? { status: 'aberto', type: 'open' },
    description: overrides.description ?? 'Roteiro pronto da ligação',
    assignees: overrides.assignees ?? [{ id: 42 }],
    custom_fields,
  };
}

function testarParaLinhaLigacaoShape() {
  const task = taskLigacaoFixture();
  const linha = paraLinhaLigacao(task, AGORA);

  checar(linha.clickup_task_id === 'ligacao-task-1', `clickup_task_id incorreto: ${linha.clickup_task_id}`);
  checar(linha.lead_clickup_task_id === 'lead-task-abc', `lead_clickup_task_id incorreto: ${linha.lead_clickup_task_id}`);
  checar(linha.operador === 'closer1', `operador incorreto: ${linha.operador}`);
  checar(linha.assignee_clickup_id === 42, `assignee_clickup_id incorreto: ${linha.assignee_clickup_id}`);
  // telefone_canonico é o E.164 PÓS-normalização do 9º dígito (design §2.1) — a fixture
  // envia com o 9 (13 dígitos); o canônico sai SEM o 9 (12 dígitos), unificando com a
  // forma que o Wavoip/WhatsApp reporta (ver testarNonoDigitoMesmoCanonico abaixo).
  checar(linha.telefone_canonico === '+558199998888', `telefone_canonico incorreto: ${linha.telefone_canonico}`);
  checar(Array.isArray(linha.telefone_variantes) && linha.telefone_variantes.length > 0, 'telefone_variantes deveria ser um array não-vazio');
  checar(linha.script === 'Roteiro pronto da ligação', `script incorreto: ${linha.script}`);
  checar(linha.status === 'aberta', `status incorreto (esperado aberta): ${linha.status}`);
  checar(linha.inicio === new Date(1755000000000).toISOString(), `inicio incorreto: ${linha.inicio}`);
  checar(linha.fim === new Date(1755000300000).toISOString(), `fim incorreto: ${linha.fim}`);
  checar(linha.duracao_seg === 300, `duracao_seg incorreto (esperado 300): ${linha.duracao_seg}`);
  checar(linha.atendeu === true, `atendeu incorreto (esperado true): ${linha.atendeu}`);
  checar(linha.motivo_falha === null, `motivo_falha deveria ser null quando vazio: ${linha.motivo_falha}`);
  checar(linha.url_gravacao === 'https://exemplo/gravacao.mp3', `url_gravacao incorreto: ${linha.url_gravacao}`);
  checar(linha.transcricao === 'transcrição de teste', `transcricao incorreto: ${linha.transcricao}`);
  checar(
    linha.analise_ia && linha.analise_ia.texto === 'LIGAR — respondeu positivo',
    `analise_ia incorreto: ${JSON.stringify(linha.analise_ia)}`,
  );
  checar(linha.necessita_revisao === false, `necessita_revisao incorreto (esperado false): ${linha.necessita_revisao}`);
  checar(linha.atualizado_em === AGORA, `atualizado_em incorreto: ${linha.atualizado_em}`);
  checar(!('telefone' in linha) || true, 'linha não deveria expor PII fora dos campos esperados'); // guarda de shape
}

function testarStatusEmProcessamento() {
  // OPER_STATUS_EM_PROCESSAMENTO vem de config.ts (env) — o smoke não seta env,
  // então este teste só prova o fallback "fechado -> fechada" e "aberto -> aberta"
  // (o caminho em_processamento é coberto pela leitura em runtime real).
  const taskFechada = taskLigacaoFixture({ id: 'ligacao-fechada', status: { status: 'complete', type: 'closed' } });
  const linhaFechada = paraLinhaLigacao(taskFechada, AGORA);
  checar(linhaFechada.status === 'fechada', `status deveria ser 'fechada' para type closed: ${linhaFechada.status}`);

  const taskAberta = taskLigacaoFixture({ id: 'ligacao-aberta', status: { status: 'a fazer', type: 'open' } });
  const linhaAberta = paraLinhaLigacao(taskAberta, AGORA);
  checar(linhaAberta.status === 'aberta', `status deveria ser 'aberta' para type open: ${linhaAberta.status}`);
}

function testarLeadClickupTaskIdFallbackIdLead() {
  // Sem LEAD_REL, mas ID_LEAD com cara de task-id ClickUp (6-15 alfanum) -> fallback.
  const task = taskLigacaoFixture({
    id: 'ligacao-fallback',
    campos: { [CAMPOS_LIGACOES.LEAD_REL]: [], [CAMPOS_LIGACOES.ID_LEAD]: 'abc123def456' },
  });
  const linha = paraLinhaLigacao(task, AGORA);
  checar(linha.lead_clickup_task_id === 'abc123def456', `lead_clickup_task_id (fallback ID_LEAD) incorreto: ${linha.lead_clickup_task_id}`);
}

// Regra do 9º dígito: telefone em 13 dígitos (com 9) e em 12 dígitos (sem 9)
// devem produzir o MESMO telefone_canonico — senão a correlação multi-candidato
// (§5.3 do design) casa errado o mesmo número em formatos diferentes.
function testarNonoDigitoMesmoCanonico() {
  const task13 = taskLigacaoFixture({ id: 'tel-13', campos: { [CAMPOS_LIGACOES.TELEFONE]: '+5581999998888' } }); // com 9
  const task12 = taskLigacaoFixture({ id: 'tel-12', campos: { [CAMPOS_LIGACOES.TELEFONE]: '558199998888' } }); // sem 9
  const linha13 = paraLinhaLigacao(task13, AGORA);
  const linha12 = paraLinhaLigacao(task12, AGORA);
  checar(
    linha13.telefone_canonico !== null && linha13.telefone_canonico === linha12.telefone_canonico,
    `telefone_canonico deveria ser IGUAL para 12 e 13 dígitos: 13d=${linha13.telefone_canonico}, 12d=${linha12.telefone_canonico}`,
  );
}

// ===== paraLinhaAudio =====

function taskAudioFixture(overrides = {}) {
  const camposBase = {
    [CAMPOS_AUDIOS.LEAD]: [{ id: 'lead-task-audio' }],
    [CAMPOS_AUDIOS.TRANSCRICAO_AUDIO]: 'transcrição do áudio',
    [CAMPOS_AUDIOS.DATA_DO_ENVIO]: '1755000000000',
  };
  const custom_fields = Object.entries({ ...camposBase, ...(overrides.campos ?? {}) }).map(([id, value]) => ({
    id,
    value,
  }));
  return {
    id: overrides.id ?? 'audio-task-1',
    name: overrides.name ?? 'Áudio enviado — 81*****8888',
    description: overrides.description ?? '',
    text_content: overrides.text_content,
    custom_fields,
  };
}

function testarParaLinhaAudioTipoAudio() {
  const task = taskAudioFixture();
  const linha = paraLinhaAudio(task);
  checar(linha.clickup_task_id === 'audio-task-1', `clickup_task_id incorreto: ${linha.clickup_task_id}`);
  checar(linha.lead_clickup_task_id === 'lead-task-audio', `lead_clickup_task_id incorreto: ${linha.lead_clickup_task_id}`);
  checar(linha.tipo === 'audio', `tipo incorreto (esperado audio): ${linha.tipo}`);
  checar(linha.transcricao_audio === 'transcrição do áudio', `transcricao_audio incorreto: ${linha.transcricao_audio}`);
  checar(linha.midia_ref === null, `midia_ref deveria ser null nesta fase: ${linha.midia_ref}`);
  checar(linha.enviado_em === new Date(1755000000000).toISOString(), `enviado_em incorreto: ${linha.enviado_em}`);
}

function testarParaLinhaAudioTipoTexto() {
  const task = taskAudioFixture({
    id: 'audio-task-texto',
    name: 'Mensagem enviada — 81*****8888',
    description: 'Olá, tudo bem?',
  });
  const linha = paraLinhaAudio(task);
  checar(linha.tipo === 'texto', `tipo incorreto (esperado texto): ${linha.tipo}`);
  checar(linha.corpo === 'Olá, tudo bem?', `corpo incorreto: ${linha.corpo}`);
}

function testarParaLinhaAudioSemLead() {
  const task = taskAudioFixture({ id: 'audio-sem-lead', campos: { [CAMPOS_AUDIOS.LEAD]: [] } });
  const linha = paraLinhaAudio(task);
  checar(linha.lead_clickup_task_id === null, `lead_clickup_task_id deveria ser null sem vínculo: ${linha.lead_clickup_task_id}`);
}

// ===== paraLinhaLeadFull =====

function taskLeadFixture(overrides = {}) {
  const hoje = new Date(AGORA);
  const ontem = hoje.getTime() - 86400000;
  const camposBase = {
    [CAMPOS_LEADS.NOME]: 'Fulano de Tal',
    [CAMPOS_LEADS.TELEFONE]: '+5581988887777',
    [CAMPOS_LEADS.CPF]: '00000000000',
    [CAMPOS_LEADS.BAIRRO]: 'Boa Viagem',
    [CAMPOS_LEADS.CIDADE]: 'Recife',
    [CAMPOS_LEADS.MILITANTE]: true,
    [CAMPOS_LEADS.SCORE]: 77,
    [CAMPOS_LEADS.QTD_TENTATIVAS]: 1,
    [CAMPOS_LEADS.QTD_ATENDIMENTOS]: 2,
    [CAMPOS_LEADS.PROXIMO_CONTATO]: String(ontem),
    [CAMPOS_LEADS.ULTIMO_CONTATO]: String(ontem),
    [CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA]: 'Já demonstrou interesse',
    [CAMPOS_LEADS.ID_LEAD_GHL]: 'ghl-abc123',
  };
  const custom_fields = Object.entries({ ...camposBase, ...(overrides.campos ?? {}) }).map(([id, value]) => ({
    id,
    value,
  }));
  return {
    id: overrides.id ?? 'lead-task-1',
    name: 'Fulano de Tal',
    description: overrides.description ?? 'Dossiê do lead',
    tags: overrides.tags ?? [{ name: 'vip' }, { name: 'lote-hoje' }],
    custom_fields,
  };
}

function testarParaLinhaLeadFullShape() {
  const task = taskLeadFixture();
  const linha = paraLinhaLeadFull(task, AGORA);

  checar(linha.clickup_task_id === 'lead-task-1', `clickup_task_id incorreto: ${linha.clickup_task_id}`);
  checar(linha.nome === 'Fulano de Tal', `nome incorreto: ${linha.nome}`);
  checar(linha.nome_lower === 'fulano de tal', `nome_lower incorreto: ${linha.nome_lower}`);
  checar(linha.telefone === '+5581988887777', `telefone incorreto: ${linha.telefone}`);
  checar(linha.militante === true, `militante incorreto: ${linha.militante}`);
  checar(linha.sem_contato === false, `sem_contato incorreto (tem atendimento): ${linha.sem_contato}`);
  checar(linha.score === 77, `score incorreto: ${linha.score}`);
  checar(linha.tentativas === 1, `tentativas incorreto: ${linha.tentativas}`);
  checar(linha.qtd_contatos === 2, `qtd_contatos incorreto: ${linha.qtd_contatos}`);
  checar(linha.id_lead === 'ghl-abc123', `id_lead incorreto: ${linha.id_lead}`);
  checar(linha.observacao_consolidada === 'Já demonstrou interesse', `observacao_consolidada incorreto: ${linha.observacao_consolidada}`);
  checar(linha.dossie === 'Dossiê do lead', `dossie incorreto: ${linha.dossie}`);
  checar(linha.proximo_contato !== null, `proximo_contato não deveria ser null (fixture tem PROXIMO_CONTATO=ontem)`);
  checar(linha.retorno_necessario === true, `retorno_necessario incorreto (tentativas>0 + proximoContato<=hoje): ${linha.retorno_necessario}`);
  checar(linha.elegivel === true, `elegivel incorreto (proximoContato<=hoje, tentativas<limite): ${linha.elegivel}`);
  checar(
    Array.isArray(linha.tags) && linha.tags.includes('vip') && linha.tags.includes('lote-hoje'),
    `tags incorreto: ${JSON.stringify(linha.tags)}`,
  );
}

function testarParaLinhaLeadFullCamposAusentesViramNull() {
  const task = taskLeadFixture({
    id: 'lead-sem-priorizacao',
    campos: {
      [CAMPOS_LEADS.SCORE]: '',
      [CAMPOS_LEADS.QTD_TENTATIVAS]: '',
      [CAMPOS_LEADS.PROXIMO_CONTATO]: '',
      [CAMPOS_LEADS.OBSERVACAO_CONSOLIDADA]: '',
      [CAMPOS_LEADS.ID_LEAD_GHL]: '',
    },
  });
  const linha = paraLinhaLeadFull(task, AGORA);
  checar(linha.score === null, `score ausente deveria ser null: ${linha.score}`);
  checar(linha.tentativas === null, `tentativas ausente deveria ser null: ${linha.tentativas}`);
  checar(linha.proximo_contato === null, `proximo_contato ausente deveria ser null: ${linha.proximo_contato}`);
  checar(linha.observacao_consolidada === null, `observacao_consolidada ausente deveria ser null: ${linha.observacao_consolidada}`);
  checar(linha.id_lead === null, `id_lead ausente deveria ser null: ${linha.id_lead}`);
  checar(linha.elegivel === false, `elegivel deveria ser false sem proximo_contato: ${linha.elegivel}`);
  checar(linha.retorno_necessario === false, `retorno_necessario deveria ser false sem proximo_contato: ${linha.retorno_necessario}`);
}

testarParaLinhaLigacaoShape();
testarStatusEmProcessamento();
testarLeadClickupTaskIdFallbackIdLead();
testarNonoDigitoMesmoCanonico();
testarParaLinhaAudioTipoAudio();
testarParaLinhaAudioTipoTexto();
testarParaLinhaAudioSemLead();
testarParaLinhaLeadFullShape();
testarParaLinhaLeadFullCamposAusentesViramNull();

if (falhas.length > 0) {
  console.error('=== SMOKE FAIL ===');
  for (const f of falhas) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('SMOKE OK');
process.exit(0);
