/**
 * Sincronização diária HubSpot -> Google Sheets.
 * Grava 5 abas (Aba Principal, Chamadas, Emails, Reuniões, Whatsapp) que alimentam o dashboard.
 *
 * COMO FUNCIONA
 * - O cabeçalho (linha 1) de cada aba é o contrato: o script preenche exatamente essas colunas, na mesma ordem,
 *   achando a propriedade do HubSpot pelo rótulo (ou por DEAL_COLS, para as propriedades padrão).
 *   Coluna nova = escrever o cabeçalho com o nome exato da propriedade. Não precisa mexer no código.
 *   'Date entered "Etapa (Pipeline)"' vira hs_v2_date_entered_<id da etapa>.
 * - Os filtros de cada aba ficam em CFG (e comentados em cada função sync*).
 * - A aba só é limpa depois que todos os dados foram buscados. Se algo falhar, fica o dado do dia anterior.
 * - Cada execução grava uma linha por aba em "_sync_log". Se uma aba falhar, você recebe um e-mail.
 *
 * INSTALAÇÃO (detalhes em docs/setup.md)
 * 1. Crie a planilha com as abas e os cabeçalhos (modelos em demo/csv, gerados por data-generator/generate.py --csv).
 * 2. Na planilha: Extensões > Apps Script. Copie HubspotSync.gs, HistoricoMensal.gs e appsscript.json.
 * 3. Configurações do projeto > Propriedades do script:
 *      HUBSPOT_TOKEN = token do app privado (escopos de leitura de CRM: deals, owners, calls, emails, meetings, communications)
 *      SHEET_ID      = opcional; vazio = usa a planilha onde o script está
 * 4. Ajuste CFG (nome do pipeline, filtros) e rode syncTudo() uma vez à mão para autorizar.
 *    Com TAB_SUFFIX = ' (API)' ele grava em abas de teste, para comparar com um export manual.
 * 5. Validou? TAB_SUFFIX = '' e crie um acionador diário para syncTudo (ou rode criarGatilhos()).
 */

const CFG = {
  TAB_SUFFIX: '',            // ' (API)' na fase de validação
  TABS: { main: 'Aba Principal', calls: 'Chamadas', emails: 'Emails', meet: 'Reuniões', wa: 'Whatsapp', log: '_sync_log' },

  // --- filtros (equivalentes aos filtros dos relatórios que eram exportados à mão) ---
  PIPELINE_LABEL: 'Prefeituras',                       // nome do pipeline de negócios no HubSpot
  TEST_GROUP_LABEL: '',                                // opcional: propriedade de negócio usada para marcar grupo de teste
  MAIN_EXCLUDE_TEST: [],                               // valores dessa propriedade que ficam fora (ex.: ['Piloto'])
  CALLS_SINCE: '2026-01-01',                           // atividades a partir desta data
  CALLS_EXCLUDE_OUTCOMES: ['WhatsApp - registro manual'],   // resultados de chamada que não são ligação de verdade
  EMAILS_SINCE: '2026-01-01',
  WA_SINCE: '2026-01-01',
  MEET_SINCE: '2026-01-01',                            // inclui as reuniões já agendadas para os próximos 12 meses
  EMAIL_TEAM: '',                                      // opcional: só e-mails de uma equipe do HubSpot
  EMAIL_REPLY_PROP: 'hs_email_reply_count',
  EMAIL_SENT_PROPS: ['hs_email_sent_count', 'hs_email_sent_count_v2'],   // "Número de e-mails enviados" (precisa ser conhecido)

  EMPTY_ACTIVITY: '(Nenhum valor)', // como o export nativo preenche células vazias nas abas de atividade
  ALERT_EMAIL: '',                 // vazio = e-mail de quem instalou o gatilho
  PAGE_SLEEP_MS: 250               // pausa entre chamadas (limite da busca do HubSpot)
};

/** Planilha de destino: SHEET_ID nas propriedades do script ou, se vazio, a planilha à qual o script está vinculado. */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/* Colunas padrão do HubSpot: o export usa o nome em português, a API usa o nome interno.
   Colunas que não estão aqui são achadas pelo rótulo da propriedade (ex.: "Temperatura", 'Date entered "Demo (Prefeituras)"'). */
const DEAL_COLS = {
  'Record ID': 'hs_object_id', 'Nome do negócio': 'dealname', 'Data de criação': 'createdate', 'Etapa do negócio': 'dealstage',
  'Pipeline': 'pipeline', 'É aberto (numérico)': 'hs_is_open_count', 'Proprietário do negócio': 'hubspot_owner_id', 'Valor': 'amount',
  'Último contato': 'notes_last_contacted', 'Data da próxima atividade': 'notes_next_activity_date',
  'Número de contatos efetuados': 'num_contacted_notes', 'Número de atividades de vendas': 'num_notes',
  'Tempo na fase atual': 'hs_v2_time_in_current_stage', 'Data que entrou na fase atual': 'hs_v2_date_entered_current_stage',
  'Data de fechamento': 'closedate', 'Data da última atividade': 'notes_last_updated',
  // lista = candidatos em ordem; usa o primeiro que existir no portal
  'Nome da próxima reunião': ['hs_next_meeting_name', 'engagements_last_meeting_booked_name']
};

/* Rótulos alternativos (a API devolve os rótulos padrão em inglês) */
const DEAL_LABEL_ALIASES = {
  'Nome da próxima reunião': ['Next meeting name', 'Next Meeting Name']
};

/* Colunas achadas pelo conteúdo quando o nome não ajuda */
const DEAL_AUTO = {
  // Exemplo: coluna cujo nome na planilha não bate com nenhum rótulo, achada pelo conteúdo da propriedade.
  // 'Frequência de contato': P => (Object.values(P.byName).find(p => p.type === 'enumeration' &&
  //    (p.options || []).some(o => norm_(o.label) === 'semanal')) || {}).name || null
};

/* Traduções dos valores padrão (a API devolve em inglês/código; o dashboard espera como no export) */
const PT = {
  meeting_outcome: { SCHEDULED: 'Programados', COMPLETED: 'Concluído', RESCHEDULED: 'Reprogramado', NO_SHOW: 'Não compareceu', CANCELED: 'Cancelado' },
  email_direction: { EMAIL: 'Saída', INCOMING_EMAIL: 'Entrada', FORWARDED_EMAIL: 'Encaminhado' },
  email_status: { SENT: 'Enviados', SENDING: 'Enviando', SCHEDULED: 'Agendados', FAILED: 'Falhou', BOUNCED: 'Devolvidos' },
  call_direction: { OUTBOUND: 'Saída', INBOUND: 'Entrada' },
  call_disposition: { // resultados padrão de chamada (os personalizados vêm pelo nome configurado no portal)
    'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Conectado', '73a0d17f-1163-4015-bdd5-ec830791da20': 'Sem resposta',
    'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Deixou mensagem de voz', 'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Deixou mensagem ao vivo',
    '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Ocupado', '17b47fee-58de-441e-a44c-c6300d46f273': 'Número errado'
  }
};

/* ======================= EXECUÇÃO ======================= */

function syncTudo() { runTabs_(['main', 'meet', 'wa', 'calls', 'emails']); fotoMensal(); }
function syncPrincipalReunioesWhatsapp() { runTabs_(['main', 'meet', 'wa']); fotoMensal(); }
function syncChamadas() { runTabs_(['calls']); }
function syncEmails() { runTabs_(['emails']); }

/** Gatilhos diários separados, para cada execução caber no limite de 6 min do Apps Script. */
function criarGatilhos() {
  ScriptApp.getProjectTriggers().filter(t => /^sync/.test(t.getHandlerFunction())).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncPrincipalReunioesWhatsapp').timeBased().everyDays(1).atHour(5).create();
  ScriptApp.newTrigger('syncChamadas').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('syncEmails').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
}

function runTabs_(tabs) {
  const t0 = Date.now(), ctx = baseContext_();
  const fns = { main: syncMain_, calls: syncCalls_, emails: syncEmails_, meet: syncMeetings_, wa: syncWhatsapp_ };
  const errors = [];
  tabs.forEach(k => {
    const t1 = Date.now();
    try {
      const n = fns[k](ctx);
      log_(CFG.TABS[k], n, 'ok', ctx.warn.splice(0).join(' | '), (Date.now() - t1) / 1000);
    } catch (e) {
      errors.push(CFG.TABS[k] + ': ' + e.message);
      log_(CFG.TABS[k], 0, 'ERRO', e.message, (Date.now() - t1) / 1000);
    }
  });
  if (errors.length) {
    const to = CFG.ALERT_EMAIL || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, '[Pipeline dashboard] Falha na sincronização com o HubSpot',
      'As abas abaixo não foram atualizadas (os dados anteriores foram mantidos):\n\n' + errors.join('\n') +
      '\n\nDetalhes na aba ' + CFG.TABS.log + '.');
  }
  console.log('Tempo total: ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
}

/* ======================= CONTEXTO (proprietários, pipeline, negócios) ======================= */

function baseContext_() {
  const ctx = { warn: [] };
  // proprietários (inclui arquivados, para quem saiu do time continuar aparecendo pelo nome)
  ctx.owners = {}; ctx.users = {}; ctx.teams = {};
  [false, true].forEach(arch => {
    let after;
    do {
      const r = hs_('get', '/crm/v3/owners?limit=500&archived=' + arch + (after ? '&after=' + after : ''));
      (r.results || []).forEach(o => {
        const nm = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email;
        ctx.owners[o.id] = nm; if (o.userId) ctx.users[o.userId] = nm;
        (o.teams || []).forEach(t => { ctx.teams[t.name] = t.id; });
      });
      after = r.paging && r.paging.next && r.paging.next.after;
    } while (after);
  });
  // pipeline e etapas
  const pipes = hs_('get', '/crm/v3/pipelines/deals').results || [];
  const pipe = pipes.find(p => p.label === CFG.PIPELINE_LABEL);
  if (!pipe) throw new Error('Pipeline "' + CFG.PIPELINE_LABEL + '" não encontrado');
  ctx.pipelineId = pipe.id; ctx.pipelineLabels = {}; ctx.stages = {}; ctx.stageByLabel = {};
  pipes.forEach(p => { ctx.pipelineLabels[p.id] = p.label; p.stages.forEach(s => { ctx.stages[s.id] = s.label.indexOf(p.label) >= 0 ? s.label : s.label + ' (' + p.label + ')'; }); });
  pipe.stages.forEach(s => { ctx.stageByLabel[norm_(s.label)] = s.id; });
  // propriedades de negócio
  ctx.dealProps = propsIndex_('deals');
  // grupo de teste (opcional): negócios marcados ficam fora das abas
  const tg = CFG.TEST_GROUP_LABEL ? ctx.dealProps.byLabel[norm_(CFG.TEST_GROUP_LABEL)] : null;
  if (CFG.TEST_GROUP_LABEL && !tg) throw new Error('Propriedade "' + CFG.TEST_GROUP_LABEL + '" não encontrada em negócios');
  ctx.testProp = tg ? tg.name : null;
  // todos os negócios do pipeline (só o essencial; a Aba Principal busca as colunas completas)
  const deals = searchAll_('deals', [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: ctx.pipelineId }] }],
    ['dealname'].concat(ctx.testProp ? [ctx.testProp] : []));
  ctx.deals = {};
  deals.forEach(d => { ctx.deals[d.id] = { id: d.id, name: d.properties.dealname || '', test: tg ? optLabel_(tg, d.properties[ctx.testProp]) : '' }; });
  return ctx;
}

/* ======================= ABAS ======================= */

/** Aba Principal — negócios do pipeline CFG.PIPELINE_LABEL, fora do grupo de teste. Desde sempre. */
function syncMain_(ctx) {
  const header = header_(CFG.TABS.main), P = ctx.dealProps, cols = [];
  header.forEach(h => {
    let name = resolveDealCol_(P, h);
    const de = !name && h.match(/^Date entered "(.+?)"$/);                     // 'Date entered "Etapa"' -> hs_v2_date_entered_<id>
    if (de && ctx.stageByLabel[norm_(de[1])]) name = 'hs_v2_date_entered_' + ctx.stageByLabel[norm_(de[1])];
    if (!name) ctx.warn.push('coluna sem propriedade: ' + h + ' (rode listarPropriedades e adicione em DEAL_COLS)');
    cols.push({ h: h, name: name, def: name ? P.byName[name] : null });
  });
  const props = uniq_(cols.filter(c => c.name).map(c => c.name).concat([ctx.testProp, 'hs_v2_date_entered_current_stage']).filter(Boolean));
  const now = Date.now();
  const deals = searchAll_('deals', [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: ctx.pipelineId }] }], props);
  const exclude = CFG.MAIN_EXCLUDE_TEST.map(norm_);
  const rows = deals
    .filter(d => exclude.indexOf(norm_(ctx.deals[d.id] ? ctx.deals[d.id].test : '')) < 0)
    .map(d => {
      const o = {}; cols.forEach(c => { o[c.h] = c.name ? dealValue_(ctx, c, d.properties[c.name]) : ''; });
      // o HubSpot calcula "Tempo na fase atual" na hora do export; pela API ele vem vazio, então calculamos igual
      const ent = d.properties.hs_v2_date_entered_current_stage;
      if (o['Tempo na fase atual'] === '' && ent) o['Tempo na fase atual'] = dur_(now - new Date(/^\d+$/.test(ent) ? Number(ent) : ent).getTime());
      return o;
    });
  return writeTab_(CFG.TABS.main, header, rows);
}

/** Chamadas — desde CFG.CALLS_SINCE; resultado fora de CFG.CALLS_EXCLUDE_OUTCOMES; negócio do pipeline e fora do grupo de teste. */
function syncCalls_(ctx) {
  const header = header_(CFG.TABS.calls), P = propsIndex_('calls');
  const ex = extraCols_(P, header, ['Data da atividade', 'Atividade atribuída a', 'Resultado da chamada', 'Direção da chamada', 'Contagem de conectados', 'Duração da chamada', 'Negócio ID', 'Nome do negócio', 'Chamada ID']);
  const acts = searchByMonth_('calls', 'hs_timestamp', new Date(CFG.CALLS_SINCE + 'T00:00:00-03:00'), [],
    uniq_(['hs_timestamp', 'hubspot_owner_id', 'hs_call_disposition', 'hs_call_direction', 'hs_call_duration'].concat(ex.map(c => c.name))));
  const disp = callDispositions_(ctx);
  const outcome = v => PT.call_disposition[v] || disp[v] || optLabel_(P.byName.hs_call_disposition, v) || v || '';
  const excl = CFG.CALLS_EXCLUDE_OUTCOMES.map(norm_);
  const kept = acts.filter(a => { const o = outcome(a.properties.hs_call_disposition); return o && excl.indexOf(norm_(o)) < 0; });
  const rows = pairWithDeals_(ctx, 'calls', kept, d => !d.test).map(x => {
    const p = x.a.properties, res = outcome(p.hs_call_disposition);
    return fillExtras_(ctx, {
      'Data da atividade': dt_(p.hs_timestamp), 'Atividade atribuída a': ctx.owners[p.hubspot_owner_id] || '',
      'Resultado da chamada': res, 'Direção da chamada': PT.call_direction[p.hs_call_direction] || p.hs_call_direction || '',
      'Contagem de conectados': norm_(res) === 'conectado' ? 1 : 0, 'Duração da chamada': dur_(p.hs_call_duration),
      'Negócio ID': x.d.id, 'Nome do negócio': x.d.name, 'Chamada ID': x.a.id
    }, ex, p);
  });
  return writeTab_(CFG.TABS.calls, header, rows, CFG.EMPTY_ACTIVITY);
}

/** Emails — desde CFG.EMAILS_SINCE; status "Enviados"; equipe CFG.EMAIL_TEAM (se definida); negócio do pipeline e fora do grupo de teste. */
function syncEmails_(ctx) {
  const header = header_(CFG.TABS.emails);
  const teamId = CFG.EMAIL_TEAM ? ctx.teams[CFG.EMAIL_TEAM] : null;
  if (CFG.EMAIL_TEAM && !teamId) ctx.warn.push('equipe "' + CFG.EMAIL_TEAM + '" não encontrada; e-mails sem filtro de equipe');
  const P = propsIndex_('emails');
  const sentDef = CFG.EMAIL_SENT_PROPS.map(n => P.byName[n]).find(Boolean)
    || ['Número de e-mails enviados', 'Number of emails sent', 'Number of Emails Sent', 'Emails sent'].map(l => P.byLabel[norm_(l)]).find(Boolean);
  if (!sentDef) ctx.warn.push('propriedade "Número de e-mails enviados" não encontrada; filtro "é conhecido" não aplicado (rode listarPropriedades)');
  const want = ['hs_timestamp', 'hubspot_owner_id', 'hubspot_team_id', 'hs_email_direction', 'hs_email_status', 'hs_email_open_count',
    CFG.EMAIL_REPLY_PROP, 'hs_email_subject'].concat(sentDef ? [sentDef.name] : []);
  want.filter(n => !P.byName[n]).forEach(n => ctx.warn.push('propriedade de e-mail inexistente no portal: ' + n));
  const ex = extraCols_(P, header, ['Data da atividade', 'Atividade atribuída a', 'Direção de e-mail', 'Status de envio de e-mail', 'Número de e-mails enviados',
    'Number of Email Opens', 'Email Open Rate', 'Número de respostas de e-mail', 'Assunto do email', 'Corpo do email', 'Negócio ID', 'Nome do negócio']);
  ex.forEach(c => want.push(c.name));
  const acts = searchByMonth_('emails', 'hs_timestamp', new Date(CFG.EMAILS_SINCE + 'T00:00:00-03:00'),
    [{ propertyName: 'hs_email_status', operator: 'EQ', value: 'SENT' }], want.filter(n => P.byName[n]));
  const kept = acts.filter(a => (!teamId || String(a.properties.hubspot_team_id || '') === String(teamId))
    && (!sentDef || (a.properties[sentDef.name] !== null && a.properties[sentDef.name] !== undefined && a.properties[sentDef.name] !== '')));
  const rows = pairWithDeals_(ctx, 'emails', kept, d => !d.test).map(x => {
    const p = x.a.properties, rawOpens = p.hs_email_open_count, opens = Number(rawOpens || 0);
    return fillExtras_(ctx, {
      'Data da atividade': dt_(p.hs_timestamp), 'Atividade atribuída a': ctx.owners[p.hubspot_owner_id] || '',
      'Direção de e-mail': PT.email_direction[p.hs_email_direction] || p.hs_email_direction || '',
      'Status de envio de e-mail': PT.email_status[p.hs_email_status] || p.hs_email_status || '',
      'Número de e-mails enviados': sentDef ? Number(p[sentDef.name]) : 1, 'Number of Email Opens': (rawOpens === null || rawOpens === undefined || rawOpens === '') ? '' : opens, 'Email Open Rate': opens > 0 ? 1 : 0,
      'Número de respostas de e-mail': p[CFG.EMAIL_REPLY_PROP] ? Number(p[CFG.EMAIL_REPLY_PROP]) : '',
      'Assunto do email': p.hs_email_subject || '', 'Corpo do email': '',   // corpo não é usado no dashboard
      'Negócio ID': x.d.id, 'Nome do negócio': x.d.name
    }, ex, p);
  });
  return writeTab_(CFG.TABS.emails, header, rows, CFG.EMPTY_ACTIVITY);
}

/** Reuniões — negócio do pipeline; início desde CFG.MEET_SINCE, incluindo as agendadas para os próximos 12 meses. */
function syncMeetings_(ctx) {
  const header = header_(CFG.TABS.meet), P = propsIndex_('meetings');
  const future = new Date(); future.setFullYear(future.getFullYear() + 1);
  const ex = extraCols_(P, header, ['Nome da reunião', 'Hora de início da reunião', 'Hora de término da reunião', 'ID do registro', 'Reunião ID', 'Resultado da reunião', 'Negócio ID']);
  const acts = searchByMonth_('meetings', 'hs_meeting_start_time', new Date(CFG.MEET_SINCE + 'T00:00:00-03:00'), [],
    uniq_(['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome'].concat(ex.map(c => c.name))), future);
  const rows = pairWithDeals_(ctx, 'meetings', acts, () => true).map(x => {
    const p = x.a.properties;
    return fillExtras_(ctx, {
      'Nome da reunião': p.hs_meeting_title || '', 'Hora de início da reunião': dt_(p.hs_meeting_start_time),
      'Hora de término da reunião': dt_(p.hs_meeting_end_time), 'ID do registro': x.a.id, 'Reunião ID': x.a.id,
      'Resultado da reunião': PT.meeting_outcome[p.hs_meeting_outcome] || optLabel_(P.byName.hs_meeting_outcome, p.hs_meeting_outcome) || '',
      'Negócio ID': x.d.id
    }, ex, p);
  });
  return writeTab_(CFG.TABS.meet, header, rows, CFG.EMPTY_ACTIVITY);
}

/** Whatsapp — comunicações do canal WhatsApp; negócio do pipeline; desde CFG.WA_SINCE. */
function syncWhatsapp_(ctx) {
  const header = header_(CFG.TABS.wa), P = propsIndex_('communications');
  const ex = extraCols_(P, header, ['Corpo da comunicação', 'Nome do negócio', 'Negócio ID', 'Atividade atribuída a', 'Data da atividade', 'Engagement ID']);
  const acts = searchByMonth_('communications', 'hs_timestamp', new Date(CFG.WA_SINCE + 'T00:00:00-03:00'),
    [{ propertyName: 'hs_communication_channel_type', operator: 'EQ', value: 'WHATS_APP' }],
    uniq_(['hs_timestamp', 'hubspot_owner_id', 'hs_communication_body'].concat(ex.map(c => c.name))));
  const rows = pairWithDeals_(ctx, 'communications', acts, () => true).map(x => {
    const p = x.a.properties;
    return fillExtras_(ctx, {
      'Corpo da comunicação': htmlToText_(p.hs_communication_body), 'Nome do negócio': x.d.name, 'Negócio ID': x.d.id,
      'Atividade atribuída a': ctx.owners[p.hubspot_owner_id] || '', 'Data da atividade': dt_(p.hs_timestamp), 'Engagement ID': x.a.id
    }, ex, p);
  });
  return writeTab_(CFG.TABS.wa, header, rows, CFG.EMPTY_ACTIVITY);
}

/* Colunas extras das abas de atividade (ex.: "Modelo de e-mail utilizado") são achadas pelo rótulo da propriedade */
const ACT_ALIASES = { 'Fonte do registro': ['hs_object_source_label'] };
const SOURCE_PT = { COMMUNICATOR: 'Fluxo para fazer e receber chamadas', CRM_UI: 'UI DE CRM' }; // tradução do export
function extraCols_(P, header, known) {
  return uniq_(header.map(keyOf)).filter(h => known.indexOf(h) < 0).map(h => {
    const name = (ACT_ALIASES[h] || []).find(n => P.byName[n]) || (P.byLabel[norm_(h)] || {}).name || null;
    return { h: h, name: name, def: name ? P.byName[name] : null };
  }).filter(c => c.name);
}
function fillExtras_(ctx, o, extras, props) { extras.forEach(c => { const v = dealValue_(ctx, c, props[c.name]); o[c.h] = SOURCE_PT[v] || v; }); return o; }

/* ======================= HUBSPOT ======================= */

function hs_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!token) throw new Error('Defina HUBSPOT_TOKEN nas propriedades do script');
  const opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  for (let i = 0; i < 6; i++) {
    const r = UrlFetchApp.fetch('https://api.hubapi.com' + path, opt), code = r.getResponseCode(), txt = r.getContentText();
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (i + 1)); continue; }
    if (code === 403 && /MISSING_SCOPES/.test(txt)) throw new Error('Falta escopo no app privado. Resposta do HubSpot: ' + txt.slice(0, 500));
    if (code >= 400) throw new Error('HubSpot ' + code + ' em ' + path + ': ' + txt.slice(0, 400));
    return txt ? JSON.parse(txt) : {};
  }
  throw new Error('HubSpot sem resposta após várias tentativas: ' + path);
}

function searchAll_(type, filterGroups, properties) {
  const out = []; let after;
  do {
    const body = { filterGroups: filterGroups, properties: properties, limit: 100, sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }] };
    if (after) body.after = after;
    const r = hs_('post', '/crm/v3/objects/' + type + '/search', body);
    Array.prototype.push.apply(out, r.results || []);
    after = r.paging && r.paging.next && r.paging.next.after;
    Utilities.sleep(CFG.PAGE_SLEEP_MS);
  } while (after);
  return out;
}

/** A busca do HubSpot devolve no máximo 10 mil resultados por consulta: fatia por mês. */
function searchByMonth_(type, dateProp, from, extraFilters, properties, until) {
  const out = [], end = until || new Date();
  for (let a = new Date(from.getFullYear(), from.getMonth(), 1); a <= end; a = new Date(a.getFullYear(), a.getMonth() + 1, 1)) {
    const b = new Date(a.getFullYear(), a.getMonth() + 1, 1), lo = Math.max(a.getTime(), from.getTime());
    const filters = [{ propertyName: dateProp, operator: 'GTE', value: String(lo) }, { propertyName: dateProp, operator: 'LT', value: String(b.getTime()) }]
      .concat(extraFilters || []);
    Array.prototype.push.apply(out, searchAll_(type, [{ filters: filters }], properties));
  }
  return out;
}

/** Liga cada atividade aos negócios do pipeline (uma linha por par atividade x negócio, como no relatório). */
function pairWithDeals_(ctx, type, acts, dealOk) {
  const pairs = [];
  for (let i = 0; i < acts.length; i += 500) {
    const chunk = acts.slice(i, i + 500), byId = {};
    chunk.forEach(a => { byId[a.id] = a; });
    const r = hs_('post', '/crm/v4/associations/' + type + '/deals/batch/read', { inputs: chunk.map(a => ({ id: a.id })) });
    (r.results || []).forEach(res => {
      (res.to || []).forEach(t => {
        const d = ctx.deals[String(t.toObjectId)];
        if (d && dealOk(d)) pairs.push({ a: byId[res.from.id], d: d });
      });
    });
    Utilities.sleep(CFG.PAGE_SLEEP_MS);
  }
  return pairs;
}

/** Resultados de chamada configurados no portal (os personalizados, como "WhatsApp - registro manual", ficam aqui e não nas opções da propriedade). */
function callDispositions_(ctx) {
  const map = {};
  try {
    const r = hs_('get', '/calling/v1/dispositions');
    (Array.isArray(r) ? r : (r.results || [])).forEach(d => { map[d.id] = d.label; });
  } catch (e) { ctx.warn.push('não consegui ler os resultados de chamada: ' + e.message.slice(0, 120)); }
  return map;
}

function propsIndex_(type) {
  const r = hs_('get', '/crm/v3/properties/' + type), idx = { byName: {}, byLabel: {} };
  (r.results || []).forEach(p => { idx.byName[p.name] = p; if (!idx.byLabel[norm_(p.label)]) idx.byLabel[norm_(p.label)] = p; });
  return idx;
}

/* ======================= FORMATAÇÃO ======================= */

function resolveDealCol_(P, h) {
  const m = DEAL_COLS[h];
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) { const hit = m.find(n => P.byName[n]); if (hit) return hit; }
  const labels = [h].concat(DEAL_LABEL_ALIASES[h] || []);
  for (let i = 0; i < labels.length; i++) { const p = P.byLabel[norm_(labels[i])]; if (p) return p.name; }
  if (DEAL_AUTO[h]) { const auto = DEAL_AUTO[h](P); if (auto) return auto; }
  return null;
}

function dealValue_(ctx, col, v) {
  if (v === null || v === undefined || v === '') return '';
  const n = col.name, def = col.def || {};
  if (n === 'hubspot_owner_id') return ctx.owners[v] || v;
  if (n === 'dealstage') return ctx.stages[v] || v;
  if (n === 'pipeline') return ctx.pipelineLabels[v] || v;
  if (/time_in|_cumulative_time/.test(n) || def.numberDisplayHint === 'duration') return dur_(v);
  if (def.type === 'enumeration') return String(v).split(';').map(x => optLabel_(def, x) || ctx.users[x] || ctx.owners[x] || x).join('; ');
  if (def.type === 'datetime' || /date_entered|date_exited/.test(n) || /^\d{4}-\d{2}-\d{2}T/.test(String(v))) return dt_(v);
  if (def.type === 'date') return String(v).slice(0, 10);
  if (def.type === 'bool') return String(v) === 'true' ? 'Sim' : 'Não';
  if (def.type === 'number') return isNaN(Number(v)) ? v : Number(v);
  return v;
}
function optLabel_(def, v) {
  if (!def || v === null || v === undefined || v === '') return '';
  const o = (def.options || []).find(x => String(x.value) === String(v));
  return o ? o.label : '';
}
function dt_(v) {   // como o export: arredonda para o segundo e depois corta os segundos
  if (!v) return '';
  const d = /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
  if (isNaN(d)) return '';
  return Utilities.formatDate(new Date(Math.round(d.getTime() / 1000) * 1000), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}
function dur_(ms) {                                  // milissegundos -> "h:mm:ss" (formato do export)
  const t = Number(ms); if (!isFinite(t) || ms === '' || ms === null) return '';
  const s = Math.round(t / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h + ':' + ('0' + m).slice(-2) + ':' + ('0' + r).slice(-2);
}
function htmlToText_(h) {
  return String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}
function keyOf(h) { return String(h).replace(/\s*-\s*(Di[aá]rio|Diariamente|Semanal|Semanalmente|Mensal|Mensalmente|Trimestral|Trimestralmente|Anual|Anualmente)\s*$/i, ''); }
function norm_(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function uniq_(a) { return Array.from(new Set(a)); }

/* ======================= PLANILHA ======================= */

function header_(tab) {
  const ss = ss_(), src = ss.getSheetByName(tab);
  if (!src) throw new Error('Aba "' + tab + '" não encontrada');
  return src.getRange(1, 1, 1, src.getLastColumn()).getDisplayValues()[0].map(String);
}

function writeTab_(tab, header, rows, empty) {
  const ss = ss_(), name = tab + CFG.TAB_SUFFIX;
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  const E = empty === undefined ? '' : empty;
  // "Data da atividade - Diário" (coluna agrupada no relatório) usa o valor de "Data da atividade"
  const data = rows.map(o => header.map(h => { const v = o[h] !== undefined ? o[h] : o[keyOf(h)]; return (v === undefined || v === null || v === '') ? E : v; }));
  // grava tudo de uma vez só depois que os dados estão prontos
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (data.length) sh.getRange(2, 1, data.length, header.length).setValues(data);
  SpreadsheetApp.flush();
  return data.length;
}

function log_(tab, n, status, msg, secs) {
  const ss = ss_();
  let sh = ss.getSheetByName(CFG.TABS.log);
  if (!sh) { sh = ss.insertSheet(CFG.TABS.log); sh.appendRow(['Quando', 'Aba', 'Linhas', 'Status', 'Tempo (s)', 'Observações']); }
  sh.appendRow([new Date(), tab, n, status, Math.round(secs || 0), msg || '']);
}

/* ======================= APOIO ======================= */

/** Grava a aba "_propriedades" com nome interno x rótulo de negócios, chamadas, e-mails, reuniões e comunicações.
    Útil para conferir colunas que não foram encontradas (aparecem como aviso no _sync_log). */
function listarPropriedades() {
  const ss = ss_();
  let sh = ss.getSheetByName('_propriedades') || ss.insertSheet('_propriedades');
  const rows = [['Objeto', 'Nome interno', 'Rótulo', 'Tipo']];
  ['deals', 'calls', 'emails', 'meetings', 'communications'].forEach(t => {
    (hs_('get', '/crm/v3/properties/' + t).results || []).forEach(p => rows.push([t, p.name, p.label, p.type]));
  });
  sh.clearContents(); sh.getRange(1, 1, rows.length, 4).setValues(rows);
}