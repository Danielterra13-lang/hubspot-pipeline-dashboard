# Instalação com um HubSpot de verdade

Tempo estimado: 30 a 60 minutos. Você precisa de acesso de admin no HubSpot (para criar um app privado) e de uma conta Google Workspace.

## 1. App privado no HubSpot

Configurações → Integrações → Apps privados → Criar. Só escopos de **leitura**: negócios e seus esquemas (propriedades e pipelines), proprietários, e as atividades (chamadas, e-mails, reuniões e comunicações). Os nomes exatos variam com a versão do portal; se faltar algum, a sync para com a resposta do HubSpot indicando o escopo que faltou.

Guarde o token. Ele vai **só** nas propriedades do script, nunca na planilha nem no código.

## 2. Planilha

Crie uma planilha com as abas `Aba Principal`, `Chamadas`, `Emails`, `Reuniões` e `Whatsapp`. A linha 1 de cada aba define o que será sincronizado. Para partir dos cabeçalhos usados no painel:

```bash
python3 data-generator/generate.py --csv   # gera demo/csv/<aba>.csv
```

Importe só a primeira linha de cada CSV, ou o arquivo inteiro se quiser testar o painel antes da sync.

Os nomes das colunas precisam ser **os rótulos das propriedades no seu HubSpot**. Os do exemplo são genéricos (`Temperatura`, `Categoria ICP`...). Se as suas propriedades se chamam diferente, ajuste o cabeçalho na planilha e o mapa `COLS` no `Index.html`.

As colunas de entrada em etapa seguem o padrão do HubSpot: `Date entered "Nome da etapa (Nome do pipeline)"`.

## 3. Projeto da sync

Na planilha: Extensões → Apps Script.

1. Crie `HubspotSync.gs` e `HistoricoMensal.gs` com o conteúdo de `apps-script/sync/`.
2. Configurações do projeto → mostrar `appsscript.json` e cole o de `apps-script/sync/appsscript.json` (fuso de São Paulo, V8).
3. Configurações do projeto → Propriedades do script: `HUBSPOT_TOKEN`.
4. Ajuste `CFG` no topo do `HubspotSync.gs`: `PIPELINE_LABEL` e os filtros opcionais.
5. Rode `listarPropriedades()` para conferir rótulos (grava a aba `_propriedades`).
6. Com `TAB_SUFFIX: ' (API)'`, rode `syncTudo()` e compare as abas de teste com um export manual.
7. Validou: `TAB_SUFFIX: ''` e crie um acionador diário para `syncTudo` (Acionadores → Adicionar, orientado por tempo, diário, de manhã). Se a execução passar de 6 minutos, use `criarGatilhos()`, que separa em três.
8. Histórico: ajuste `HIST.RECONSTRUIR_DESDE`, rode `validarReconstrucao()`, confira a aba `_validacao_historico` e só então rode `reconstruirHistorico()`.

## 4. Projeto do painel (separado)

Em script.google.com, crie um projeto novo (não vinculado à planilha).

1. Arquivos `Code.gs` e `Index.html` com o conteúdo de `apps-script/dashboard/`.
2. `appsscript.json` de `apps-script/dashboard/`.
3. Propriedades do script: `SHEET_ID` = ID da planilha (o trecho entre `/d/` e `/edit` na URL).
4. Em `Index.html`, ajuste `CONFIG` (limites de carteira, pessoas do time que aparecem no WhatsApp, data de início) e, se mudou nomes de colunas, `COLS`.
5. Implantar → Nova implantação → App da Web. Executar como: **Eu**. Quem pode acessar: **seu domínio**.
6. Rode `criarGatilhoCache()` uma vez.

Para publicar mudanças depois: Implantar → Gerenciar implantações → lápis → Versão: **Nova versão**. Nunca "Nova implantação" (gera outro link).

## 5. Versionar com clasp (opcional)

```bash
npm i -g @google/clasp
clasp login
cd apps-script/sync && cp ../.clasp.json.example .clasp.json   # cole o scriptId do projeto da sync
clasp push
```

Repita em `apps-script/dashboard`. O `.clasp.json` está no `.gitignore`.

## Checklist de segurança

- [ ] Token do HubSpot só nas propriedades do script
- [ ] Planilha restrita (não precisa compartilhar com quem só vê o painel)
- [ ] Web App com acesso limitado ao domínio
- [ ] Sync e painel em projetos separados
- [ ] Nenhum `.clasp.json` ou ID de planilha commitado
