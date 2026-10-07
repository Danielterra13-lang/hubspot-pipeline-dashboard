/**
 * Histórico mensal da Aba Principal, para o comparativo mês a mês do dashboard.
 * Fica no mesmo projeto do HubspotSync.gs e reaproveita as funções dele (hs_, baseContext_, dealValue_ etc.).
 *
 * ABA "_historico_mensal": uma linha por negócio por mês, com as colunas que os indicadores comparados usam.
 *   Mês de referência | Data da foto | Origem ("foto" ou "reconstruído") | colunas de HIST.COLS
 *
 * FOTO AUTOMÁTICA
 *   A sync diária da Aba Principal chama fotoMensal(). Nos primeiros dias do mês (HIST.JANELA_DIAS), se ainda
 *   não existe foto do mês anterior, ele copia a Aba Principal recém-atualizada como fechamento desse mês.
 *   Se a execução do dia 1 falhar, a do dia 2 grava. Fora dessa janela, não faz nada.
 *
 * RECONSTRUÇÃO (roda uma vez)
 *   reconstruirHistorico() monta os meses de HIST.RECONSTRUIR_DESDE até o mês anterior ao atual a partir do
 *   histórico de propriedades do HubSpot (como cada negócio estava no último minuto de cada mês).
 *   Nunca sobrescreve um mês que já tem foto real.
 *
 * VALIDAÇÃO
 *   validarReconstrucao() reconstrói a base "de agora" pelo mesmo método e compara com a Aba Principal.
 *   Se bater, o método é confiável para os meses passados. Resultado na aba "_validacao_historico".
 */

const HIST = {
  TAB: '_historico_mensal',
  VALID_TAB: '_validacao_historico',
  RECONSTRUIR_DESDE: '2026-01',
  JANELA_DIAS: 5,              // a foto do mês anterior pode ser gravada até o dia 5
  META: ['Mês de referência', 'Data da foto', 'Origem'],
  COLS: ['Record ID', 'Nome do negócio', 'Etapa do negócio', 'É aberto (numérico)', 'Proprietário do negócio', 'Valor',
    'Último contato', 'Número de contatos efetuados', 'Tempo na fase atual', 'Data que entrou na fase atual',
    'Estado (UF)', 'Temperatura', 'Termômetro', 'Status operacional', 'Status do funil',
    'Categoria SLA', 'Categoria ICP', 'Ações de marketing'],
  // colunas comparadas na validação
  VALIDAR: ['Etapa do negócio', 'Proprietário do negócio', 'Valor', 'Último contato', 'Número de contatos efetuados',
    'Temperatura', 'Termômetro', 'Status operacional', 'Status do funil', 'Categoria SLA']
};

/* ======================= FOTO MENSAL ======================= */

/** Chamada pela sync diária. Grava o fechamento do mês anterior nos primeiros dias do mês. */
function fotoMensal() {
  const now = new Date();
  if (now.getDate() > HIST.JANELA_DIAS) return;
  const mes = mesDe_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  try {
    if (origemDoMes_(mes) === 'foto') return;
    if (principalFalhouHoje_()) { log_(HIST.TAB, 0, 'adiado', 'Aba Principal não atualizou hoje; a foto de ' + mes + ' fica para amanhã', 0); return; }
    const n = gravarFotoDaPrincipal_(mes, now);
    log_(HIST.TAB, n, 'ok', 'foto de ' + mes, 0);
  } catch (e) {
    log_(HIST.TAB, 0, 'ERRO', 'foto de ' + mes + ': ' + e.message, 0);
    MailApp.sendEmail(CFG.ALERT_EMAIL || Session.getEffectiveUser().getEmail(), '[Pipeline dashboard] Falha na foto mensal',
      'A foto de ' + mes + ' não foi gravada: ' + e.message + '\nA próxima execução diária tenta de novo (até o dia ' + HIST.JANELA_DIAS + ').');
  }
}

/** Para emergências: grava agora a foto do mês anterior, mesmo fora da janela (substitui o que houver). */
function forcarFotoMesAnterior() {
  const now = new Date();
  const mes = mesDe_(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const n = gravarFotoDaPrincipal_(mes, now);
  log_(HIST.TAB, n, 'ok', 'foto de ' + mes + ' (forçada)', 0);
}

function gravarFotoDaPrincipal_(mes, quando) {
  const ss = ss_(), src = ss.getSheetByName(CFG.TABS.main + CFG.TAB_SUFFIX);
  if (!src) throw new Error('Aba "' + CFG.TABS.main + CFG.TAB_SUFFIX + '" não encontrada');
  const range = src.getDataRange(), vals = range.getValues(), disp = range.getDisplayValues();
  const head = vals.shift().map(h => norm_(h)); disp.shift();
  const idx = HIST.COLS.map(h => head.indexOf(norm_(h)));
  const faltam = HIST.COLS.filter((h, i) => idx[i] < 0);
  if (faltam.indexOf('Record ID') >= 0) throw new Error('coluna Record ID não encontrada na Aba Principal');
  const rows = [];
  vals.forEach((r, i) => {
    if (!r.some(v => v !== '' && v !== null)) return;
    const o = {};
    HIST.COLS.forEach((h, k) => {
      const j = idx[k]; if (j < 0) { o[h] = ''; return; }
      const v = r[j];
      // durações ("Tempo na fase atual") chegam como data de 1899: guarda o texto
      o[h] = (v instanceof Date && v.getFullYear() < 1970) ? disp[i][j] : v;
    });
    rows.push(o);
  });
  substituirMeses_([{ mes: mes, quando: quando, origem: 'foto', rows: rows }]);
  return rows.length;
}

function principalFalhouHoje_() {
  const sh = ss_().getSheetByName(CFG.TABS.log);
  if (!sh || sh.getLastRow() < 2) return false;
  const n = Math.min(40, sh.getLastRow() - 1);
  const rows = sh.getRange(sh.getLastRow() - n + 1, 1, n, 4).getValues().reverse();
  const hoje = mesDe_(new Date()) + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), '-dd');
  const last = rows.find(r => r[1] === CFG.TABS.main);
  if (!last) return false;
  const dia = Utilities.formatDate(new Date(last[0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return dia === hoje && last[3] !== 'ok';
}

/* ======================= RECONSTRUÇÃO ======================= */

/** Monta os meses de HIST.RECONSTRUIR_DESDE até o mês anterior. Não mexe em meses com foto real. */
function reconstruirHistorico() {
  const now = new Date(), meses = [];
  const p = HIST.RECONSTRUIR_DESDE.split('-');
  for (let d = new Date(+p[0], +p[1] - 1, 1); d < new Date(now.getFullYear(), now.getMonth(), 1); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) meses.push(mesDe_(d));
  const t0 = Date.now(), R = carregarHistoricoHubspot_();
  const avisos = [], lotes = [];
  meses.forEach(mes => {
    if (origemDoMes_(mes) === 'foto') { avisos.push(mes + ' já tem foto real (mantida)'); return; }
    const T = fimDoMes_(mes), rows = linhasEm_(R, T);
    lotes.push({ mes: mes, quando: T, origem: 'reconstruído', rows: rows });
    avisos.push(mes + ': ' + rows.length + ' negócios');
  });
  if (lotes.length) substituirMeses_(lotes);
  log_(HIST.TAB, 0, 'ok', 'reconstrução: ' + avisos.join(' | ') + (R.semHistorico.length ? ' | sem histórico no HubSpot (usado o valor atual): ' + R.semHistorico.join(', ') : ''), (Date.now() - t0) / 1000);
}

/** Reconstrói a base de agora e compara com a Aba Principal, coluna a coluna. */
function validarReconstrucao() {
  const R = carregarHistoricoHubspot_(), rec = linhasEm_(R, new Date());
  const ss = ss_(), src = ss.getSheetByName(CFG.TABS.main + CFG.TAB_SUFFIX);
  const vals = src.getDataRange().getValues(), head = vals.shift().map(h => norm_(h)), iId = head.indexOf(norm_('Record ID'));
  const atual = {};
  vals.forEach(r => { if (r[iId] !== '') atual[String(r[iId])] = r; });
  const res = {}, dif = [];
  HIST.VALIDAR.forEach(c => { res[c] = { n: 0, ok: 0 }; });
  const soNaRec = [], idsRec = {};
  rec.forEach(o => {
    const id = String(o['Record ID']); idsRec[id] = 1;
    const r = atual[id]; if (!r) { soNaRec.push(o['Nome do negócio']); return; }
    HIST.VALIDAR.forEach(c => {
      const j = head.indexOf(norm_(c)); if (j < 0) return;
      const a = cmpVal_(r[j]), b = cmpVal_(o[c]);
      res[c].n++;
      if (a === b) res[c].ok++; else if (dif.length < 300) dif.push([id, o['Nome do negócio'], c, String(o[c]), String(r[j] instanceof Date ? cmpVal_(r[j]) : r[j])]);
    });
  });
  const soNaPrincipal = Object.keys(atual).filter(id => !idsRec[id]).length;
  let sh = ss.getSheetByName(HIST.VALID_TAB) || ss.insertSheet(HIST.VALID_TAB);
  sh.clearContents();
  const out = [['Coluna', 'Comparados', 'Iguais', '% iguais', ''],
    ...HIST.VALIDAR.map(c => [c, res[c].n, res[c].ok, res[c].n ? res[c].ok / res[c].n : '', '']),
    ['', '', '', '', ''],
    ['Negócios só na reconstrução', soNaRec.length, '', '', ''],
    ['Negócios só na Aba Principal', soNaPrincipal, '', '', ''],
    ['Sem histórico no HubSpot (usado o valor atual)', R.semHistorico.join(', ') || '—', '', '', ''],
    ['', '', '', '', ''],
    ['Record ID', 'Negócio', 'Coluna', 'Reconstruído', 'Aba Principal'], ...dif];
  sh.getRange(1, 1, out.length, 5).setValues(out);
  sh.getRange(2, 4, HIST.VALIDAR.length, 1).setNumberFormat('0.0%');
}

/** Busca os negócios do pipeline com o histórico de cada propriedade usada no histórico mensal. */
function carregarHistoricoHubspot_() {
  const ctx = baseContext_(), P = ctx.dealProps;
  const pipes = hs_('get', '/crm/v3/pipelines/deals').results || [];
  const closed = {};
  pipes.forEach(p => p.stages.forEach(s => { closed[s.id] = String((s.metadata || {}).isClosed) === 'true'; }));
  const derivadas = ['Record ID', 'Etapa do negócio', 'É aberto (numérico)', 'Tempo na fase atual', 'Data que entrou na fase atual'];
  const cols = HIST.COLS.map(h => {
    if (derivadas.indexOf(h) >= 0) return { h: h, name: null };
    const name = resolveDealCol_(P, h);
    if (!name) throw new Error('coluna "' + h + '" sem propriedade no HubSpot');
    return { h: h, name: name, def: P.byName[name] };
  });
  const props = uniq_(cols.filter(c => c.name).map(c => c.name).concat(['dealstage', 'pipeline', 'createdate', 'dealname', ctx.testProp]).filter(Boolean));
  const exclude = CFG.MAIN_EXCLUDE_TEST.map(norm_);
  const ids = Object.keys(ctx.deals).filter(id => exclude.indexOf(norm_(ctx.deals[id].test)) < 0);
  const deals = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = hs_('post', '/crm/v3/objects/deals/batch/read',
      { inputs: ids.slice(i, i + 50).map(id => ({ id: id })), properties: props, propertiesWithHistory: props });
    Array.prototype.push.apply(deals, r.results || []);
    Utilities.sleep(CFG.PAGE_SLEEP_MS);
  }
  // propriedades que não trazem histórico para ninguém (ficam com o valor atual)
  const semHistorico = cols.filter(c => c.name && c.name !== 'dealname' && !deals.some(d => ((d.propertiesWithHistory || {})[c.name] || []).length)).map(c => c.h);
  return { ctx: ctx, cols: cols, deals: deals, closed: closed, semHistorico: semHistorico };
}

/** Como cada negócio estava no instante T. */
function linhasEm_(R, T) {
  const t = T.getTime(), ctx = R.ctx, out = [];
  R.deals.forEach(d => {
    const H = d.propertiesWithHistory || {}, cur = d.properties || {};
    const created = parseTs_(cur.createdate);
    if (created && created > t) return;                                   // ainda não existia
    if (String(valorEm_(H.pipeline, cur.pipeline, t)) !== String(ctx.pipelineId)) return;
    const st = estagioEm_(H.dealstage, cur.dealstage, t);
    if (!st.v) return;
    const o = {
      'Record ID': d.id, 'Etapa do negócio': ctx.stages[st.v] || st.v, 'É aberto (numérico)': R.closed[st.v] ? 0 : 1,
      'Data que entrou na fase atual': st.desde ? dt_(st.desde) : '', 'Tempo na fase atual': st.desde ? dur_(t - st.desde) : ''
    };
    R.cols.forEach(c => {
      if (!c.name) return;
      const v = c.name === 'dealname' ? cur.dealname : valorEm_(H[c.name], cur[c.name], t);
      o[c.h] = dealValue_(ctx, c, v);
    });
    out.push(o);
  });
  return out;
}

/** Valor da propriedade em t. Sem histórico nenhum: usa o valor atual. */
function valorEm_(hist, atual, t) {
  if (!hist || !hist.length) return atual;
  const e = hist.map(x => ({ v: x.value, ts: parseTs_(x.timestamp) })).sort((a, b) => b.ts - a.ts).find(x => x.ts <= t);
  return e ? e.v : '';
}

/** Etapa em t e desde quando o negócio estava nela (sem contar regravações da mesma etapa). */
function estagioEm_(hist, atual, t) {
  if (!hist || !hist.length) return { v: atual, desde: null };
  const h = hist.map(x => ({ v: x.value, ts: parseTs_(x.timestamp) })).sort((a, b) => b.ts - a.ts);
  let i = h.findIndex(x => x.ts <= t);
  if (i < 0) return { v: '', desde: null };
  const v = h[i].v;
  while (i + 1 < h.length && h[i + 1].v === v) i++;
  return { v: v, desde: h[i].ts };
}

/* ======================= ABA DE HISTÓRICO ======================= */

/** Troca as linhas dos meses informados (as dos outros meses ficam como estão). */
function substituirMeses_(lotes) {
  const meses = lotes.map(l => l.mes);
  const ss = ss_();
  let sh = ss.getSheetByName(HIST.TAB);
  const header = HIST.META.concat(HIST.COLS);
  let manter = [];
  if (sh && sh.getLastRow() > 1) {
    const vals = sh.getDataRange().getValues(), disp = sh.getDataRange().getDisplayValues();
    const old = vals.shift().map(String); disp.shift();
    const map = header.map(h => old.indexOf(h));
    vals.forEach((r, i) => {
      if (meses.indexOf(mesTxt_(r[0], disp[i][0])) >= 0) return;
      manter.push(map.map(j => {
        if (j < 0) return '';
        const v = r[j];
        return (v instanceof Date && v.getFullYear() < 1970) ? disp[i][j] : v;
      }));
    });
  }
  if (!sh) sh = ss.insertSheet(HIST.TAB);
  const novas = [];
  lotes.forEach(l => l.rows.forEach(o => novas.push([l.mes, l.quando, l.origem].concat(HIST.COLS.map(h => (o[h] === undefined || o[h] === null) ? '' : o[h])))));
  const all = manter.concat(novas).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (all.length) {
    sh.getRange(2, 1, all.length, 1).setNumberFormat('@');           // "2026-08" fica como texto, não vira data
    sh.getRange(2, 1, all.length, header.length).setValues(all);
  }
  sh.setFrozenRows(1);
  SpreadsheetApp.flush();
}

function origemDoMes_(mes) {
  const sh = ss_().getSheetByName(HIST.TAB);
  if (!sh || sh.getLastRow() < 2) return '';
  const r = sh.getRange(2, 1, sh.getLastRow() - 1, 3), v = r.getValues(), d = r.getDisplayValues();
  let achou = '';
  v.forEach((x, i) => { if (mesTxt_(x[0], d[i][0]) === mes) achou = achou === 'foto' ? 'foto' : String(x[2]); });
  return achou;
}

/* ======================= APOIO ======================= */

function mesDe_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM'); }
function fimDoMes_(mes) { const p = mes.split('-'); return new Date(new Date(+p[0], +p[1], 1).getTime() - 60000); } // 23:59 do último dia
function mesTxt_(v, disp) { return v instanceof Date ? mesDe_(v) : String(disp || v).slice(0, 7); }
function parseTs_(v) { if (v === null || v === undefined || v === '') return null; const n = /^\d+$/.test(String(v)) ? Number(v) : new Date(v).getTime(); return isNaN(n) ? null : n; }
function cmpVal_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v))) return String(Number(v));
  return norm_(v);
}