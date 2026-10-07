# Decisões e alternativas

Registro das escolhas que mais pesaram, com o que foi descartado e por quê. A regra geral foi começar pelo mais simples que resolve e deixar caminho aberto para crescer.

## Apps Script + Sheets em vez de warehouse + BI

**Escolhido:** extração em Apps Script gravando no Google Sheets; painel servido pelo próprio Apps Script.

**Alternativas:** conector pago HubSpot → BigQuery + Looker Studio ou Power BI; Python agendado (Cloud Run/Functions) + banco.

**Por quê:** zero infraestrutura nova, zero custo, acesso controlado pelo Google Workspace que a empresa já usa, e o time de dados consegue abrir a planilha e conferir qualquer número. O volume de um funil B2G cabe com folga no Sheets.

**Quando trocar:** se o volume chegar perto do teto do Sheets ou se outras áreas precisarem consultar os mesmos dados com SQL. A extração não muda: só o destino da escrita (`writeTab_`).

## O cabeçalho da planilha como contrato

**Escolhido:** a sync lê a linha 1 e busca cada propriedade pelo rótulo.

**Alternativa:** lista fixa de propriedades no código.

**Por quê:** a planilha substituiu exports manuais; mantendo os mesmos cabeçalhos do export nativo, o painel antigo continuou funcionando no primeiro dia. Coluna nova não exige deploy. O custo é depender do rótulo exato, mitigado pelo aviso "coluna sem propriedade" no log e pela função `listarPropriedades()`.

## Extração: busca fatiada e escrita segura

**Busca fatiada por mês.** A Search API do HubSpot devolve no máximo 10 mil resultados por consulta. A sync divide a busca por mês de criação, junta as fatias e busca as associações em lote (500 por chamada na v4), com retry e espera crescente em 429 e 5xx.

**Escrita só depois de tudo chegar.** A aba só é limpa quando todos os dados já estão em memória. Se a API falhar no meio, fica o dado do dia anterior, um registro no `_sync_log` e um e-mail de alerta. Planilha pela metade é pior do que planilha de ontem.

## Dois projetos de Apps Script

Ver [arquitetura.md](arquitetura.md#por-que-dois-projetos-de-apps-script). Resumo: o Web App expõe as funções globais do projeto ao navegador.

## Painel em HTML próprio em vez de Looker Studio

**Escolhido:** um `Index.html` com JavaScript puro e Chart.js.

**Por quê:** o Looker não fazia o que o time precisava sem gambiarras: deduplicar reuniões com regras de negócio, ler o texto das conversas de WhatsApp, comparar com uma foto mensal respeitando os filtros, tooltips que listam as contas por trás de cada número. Também era lento e quebrava a conexão com frequência.

**Custo assumido:** manutenção depende de quem sabe JavaScript, e um arquivo único é difícil de testar. Mitigação: `CONFIG` e `COLS` concentram tudo que muda com frequência.

## Cálculo no navegador

**Escolhido:** o servidor entrega dados quase crus; filtros e agregações acontecem no cliente.

**Por quê:** a base é pequena (milhares de linhas), então cada filtro responde na hora sem ida ao servidor, e o cache do servidor serve igual para todo mundo. Se a base crescer uma ordem de grandeza, a agregação sobe para o servidor.

## Cache gzip no Drive

**Alternativas:** `CacheService` (limite de 100 KB por chave e 6 horas), `PropertiesService` (limite de tamanho).

**Escolhido:** arquivo `.json.gz` no Drive do dono, com ID e data nas propriedades do script. Invalidação por data de modificação da planilha, mudança de spec e `CACHE_VER`. Ver [incidentes](incidentes.md) para o motivo do `CACHE_VER`.

## Histórico em formato longo e reconstrução pelo CRM

**Alternativa:** guardar só agregados mensais (ex.: "62 contas paradas em agosto").

**Por quê:** agregado não respeita filtro. Com uma linha por negócio por mês, o comparativo funciona para qualquer recorte da tela (um proprietário, um estado, uma faixa de ICP). A reconstrução recuperou os meses anteriores ao projeto, em vez de esperar meses de fotos se acumularem.

## Comparativo mês a mês, não dia a dia

Ciclo de venda B2G é longo. Variação diária vira ruído e induz a reação errada. O comparativo existe só nos indicadores principais e usa, por padrão, a foto mais recente com pelo menos 7 dias, para não comparar com um mês que acabou de fechar e quase não mudou.

## Reuniões: cinco regras de deduplicação

O CRM gera registros duplicados (a mesma reunião associada a dois negócios, reagendamentos que criam outro registro, visita presencial registrada junto com a call de alinhamento). Regras, aplicadas com union-find:

1. mesmo ID de reunião;
2. mesmo nome e mesma hora de início;
3. mesma conta no mesmo dia;
4. reunião presencial + outra reunião da conta em até 3 dias;
5. duas reuniões concluídas da mesma conta em até 7 dias.

Do grupo fica o melhor resultado (concluída > reprogramada > falta > cancelada > programada) e, no empate, a mais recente. "Programada" com data no passado vira "Não compareceu", porque ninguém atualizou.

## WhatsApp lido do texto bruto

A integração grava o histórico da conversa no corpo da comunicação (`Remetente [20th August 2026, 13:50]: texto`). O painel separa as mensagens, decide o lado de cada remetente (time ou lead) pelos nomes da equipe e calcula: quem iniciou, se o lead respondeu, tempo de resposta do lead e do time em mediana. Registros antigos que eram resumo de IA passam por uma classificação por regras e ficam fora dos tempos de resposta.

## Abertura de e-mail não é indicador principal

A abertura é medida por um pixel por e-mail. Colega em cópia, encaminhamento, o próprio vendedor em outro dispositivo e filtros que carregam imagens contam como abertura. O painel conta e-mails com pelo menos uma abertura (não o total de aberturas) e trata **resposta** como o indicador que vale.

## Tema escuro e um acento só

O painel original seguia a marca da empresa. Esta versão usa fundo quase preto, texto branco suave e um único acento verde-limão reservado para o que é bom ou para o destaque principal. Vermelho e âmbar aparecem só como estado (fora do prazo, parado, perdido). Escalas ordinais (temperatura, mapa) são uma cor do escuro ao claro, e a paleta categórica dos motivos de perda foi validada para daltonismo contra o fundo escuro.
