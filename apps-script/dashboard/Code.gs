/**
 * Web App do dashboard: serve o Index.html e entrega os dados da planilha (que pode ficar privada).
 * Fica num projeto de Apps Script SEPARADO da sync: um Web App deixa o navegador chamar qualquer função
 * pública do projeto, então aqui só existem doGet, getData e as funções de cache.
 *
 * Publicar mudanças: Implantar > Gerenciar implantações > lápis > Versão: Nova versão
 *   (nunca "Nova implantação": gera outro link e o antigo continua servindo a versão velha)
 *   Executar como: Eu | Quem pode acessar: só o seu domínio
 *
 * Propriedades do script: SHEET_ID = ID da planilha gravada pela sync.
 *
 * CACHE
 *   Os dados só mudam quando a sync roda. O getData monta o pacote uma vez, guarda compactado (gzip) num arquivo
 *   do seu Drive e entrega esse arquivo para todo mundo até a planilha mudar. Três sinais invalidam o cache:
 *   data de modificação da planilha, mudança nas colunas pedidas pelo painel (spec) e CACHE_VER no código.
 *   criarGatilhoCache() (uma vez) remonta o cache de hora em hora, antes de alguém abrir.
 */
const SHEET_ID = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
const CACHE_FILE = 'pipeline-dashboard-cache.json';
const SHEETS = { main: 'Aba Principal', calls: 'Chamadas', emails: 'Emails', whats: 'Whatsapp', meet: 'Reuniões' };
const HIST_SHEET = '_historico_mensal';                          // opcional: sem ela, o dashboard só não mostra o comparativo
const CACHE_VER = '3';                                          // mude este número ao alterar a forma de montar os dados: o cache antigo é descartado
const SKIP_COLS = /^(corpo do email|assunto do email)$/i;        // textos longos que o dashboard não usa

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Pipeline B2G · Report semanal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * spec (enviado pelo dashboard) = colunas que cada aba precisa: { main: {names, prefixes, rx}, calls: {names}, ... }.
 * Sem spec, devolve todas as colunas (compatível com versões antigas do Index).
 */
function getData(spec) {
  const p = PropertiesService.getScriptProperties();
  if (spec) {                                          // guarda as colunas pedidas pelo dashboard (usadas pelo gatilho)
    const s = JSON.stringify(spec);
    if (p.getProperty('SPEC') !== s) { p.setProperty('SPEC', s); p.deleteProperty('CACHE_AT'); }
  }
  return lerCache_() || montarCache_();
}

/** Força a remontagem do cache agora (use depois de mexer no código ou se algo parecer desatualizado). */
function remontarCache() { montarCache_(); }

/** Gatilho de hora em hora: remonta o cache se a planilha mudou. */
function aquecerCache() { if (!lerCache_()) montarCache_(); }

/** Rode uma vez à mão. */
function criarGatilhoCache() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'aquecerCache').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('aquecerCache').timeBased().everyHours(1).create();
  aquecerCache();
}

function lerCache_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('CACHE_ID'), at = Number(p.getProperty('CACHE_AT') || 0);
  if (!id || !at || p.getProperty('CACHE_VER') !== CACHE_VER) return null;
  if (DriveApp.getFileById(SHEET_ID).getLastUpdated().getTime() > at) return null;   // planilha mudou depois do cache
  try { return Utilities.ungzip(DriveApp.getFileById(id).getBlob().setContentType('application/x-gzip')).getDataAsString('UTF-8'); }
  catch (e) { return null; }
}

function montarCache_() {
  const p = PropertiesService.getScriptProperties();
  const t0 = Date.now();                               // antes da leitura: se a planilha mudar durante a montagem, remonta depois
  const json = montarDados_(JSON.parse(p.getProperty('SPEC') || 'null'));
  const gz = Utilities.gzip(Utilities.newBlob(json, 'application/json', CACHE_FILE), CACHE_FILE + '.gz');
  const novo = DriveApp.createFile(gz);
  const velho = p.getProperty('CACHE_ID');
  p.setProperty('CACHE_ID', novo.getId()); p.setProperty('CACHE_AT', String(t0)); p.setProperty('CACHE_VER', CACHE_VER);
  if (velho) { try { DriveApp.getFileById(velho).setTrashed(true); } catch (e) {} }
  return json;
}

function montarDados_(spec) {
  spec = spec || {};
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const errs = [];
  const main = ss.getSheetByName(SHEETS.main) || ss.getSheets()[0];
  const read = (k) => {
    const sh = ss.getSheetByName(SHEETS[k]);
    if (!sh) { errs.push('Aba "' + SHEETS[k] + '" não encontrada'); return null; }
    return toTable_(sh, spec[k]);
  };
  const hist = ss.getSheetByName(HIST_SHEET);
  return JSON.stringify({
    main: toTable_(main, spec.main), calls: read('calls'), emails: read('emails'), whats: read('whats'), meet: read('meet'),
    hist: hist ? toTable_(hist, null) : null,
    errs: errs
  });
}

/* Converte a aba no formato que o dashboard entende (cols + rows.c[].v), só com as colunas pedidas */
function toTable_(sh, want) {
  const range = sh.getDataRange();
  const vals = range.getValues();
  const tz = Session.getScriptTimeZone();
  const head = vals.shift();
  const keep = head.map((h, j) => (!SKIP_COLS.test(String(h).trim()) && wanted_(h, want)) ? j : -1).filter(j => j >= 0);
  const rows = vals.filter(r => r.some(v => v !== '' && v !== null));
  // durações (ex.: "Tempo na fase atual") chegam como data antiga (1899 + a duração; acima de 1 ano já cai em 1900, 1901...): só essas colunas são lidas também como texto formatado
  const disp = {};
  keep.forEach(j => {
    if (rows.some(r => r[j] instanceof Date && r[j].getFullYear() < 1970)) {
      const d = sh.getRange(2, j + 1, vals.length, 1).getDisplayValues();
      disp[j] = vals.map((r, i) => d[i][0]).filter((x, i) => vals[i].some(v => v !== '' && v !== null));
    }
  });
  const out = rows.map((r, i) => ({ c: keep.map(j => {
    const v = r[j];
    if (v === '' || v === null) return null;
    if (v instanceof Date) {
      if (v.getFullYear() < 1970) return { f: disp[j] ? disp[j][i] : '' };
      return { v: Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm') };
    }
    return { v: v };
  }) }));
  return { cols: keep.map(j => ({ label: String(head[j]) })), rows: out };
}

function wanted_(h, want) {
  if (!want) return true;
  const k = colKey_(h);
  if ((want.names || []).some(n => colKey_(n) === k)) return true;
  if ((want.prefixes || []).some(p => k.indexOf(colKey_(p)) === 0)) return true;
  if ((want.rx || []).some(src => { try { return new RegExp(src).test(k); } catch (e) { return false; } })) return true;
  return false;
}
function colKey_(s) {
  return String(s || '').replace(/\s*-\s*(di[aá]rio|diariamente|semanal|semanalmente|mensal|mensalmente|trimestral|trimestralmente|anual|anualmente)\s*$/i, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}