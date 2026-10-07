# Dados sintéticos

`data-generator/generate.py` cria um funil B2G fictício com o mesmo formato que a sync grava na planilha. O painel não sabe a diferença: lê o JSON pelo mesmo caminho que leria o Web App.

```bash
python3 data-generator/generate.py                      # demo/demo.json
python3 data-generator/generate.py --csv                # + demo/csv/*.csv para importar no Sheets
python3 data-generator/generate.py --seed 7 --deals 900 --now 2026-12-15T09:00
```

Só biblioteca padrão do Python. Mesma seed, mesmo arquivo (o CI confere).

## O que é simulado

**Negócios.** Secretarias municipais de educação, uma por município, sorteadas da lista pública do IBGE com peso por estado. Cada negócio nasce em Cliente Potencial e percorre 13 etapas. Em cada etapa há uma probabilidade de avançar, um tempo de permanência (log-normal) e, para quem não avança, uma chance de ser perdido. O resultado é um caminho com a data de entrada em cada etapa, que vira as colunas `Date entered`.

**Carteira.** Um SDR prospecta parte da base até Conexão Estabelecida; depois o negócio vai para um dos quatro AEs. Uma AE saiu do time em junho e as contas dela foram redistribuídas, para o histórico mensal mostrar troca de proprietário.

**Atividades.** Um processo de Poisson por negócio gera pontos de contato, mais frequentes na prospecção. Cada contato vira uma chamada, um e-mail ou uma conversa de WhatsApp. Daí saem Último contato, Contatos efetuados e Status operacional.

**WhatsApp.** O corpo é o histórico bruto no formato da integração (`Remetente [9th October 2026, 10:12]: texto`). Uma parte vem sem quebras de linha e outra como resumo em texto, para exercitar os dois caminhos do parser. Em 12% das conversas o responsável não vem preenchido e o painel precisa inferir pelo texto.

**Reuniões.** Conversa inicial, demo e apresentação de proposta nas datas em que o negócio entrou nessas etapas, mais faltas, cancelamentos, remarcações e reuniões futuras. Cerca de 8% vêm duplicadas de formas diferentes, para as regras de deduplicação terem trabalho.

**Temperatura, termômetro, SLA.** Derivados da etapa, da recência do último contato e de um ruído por negócio e por mês. O termômetro compara a temperatura com a de 30 dias antes.

**Perdas e objeções.** Motivo depende da etapa em que o negócio caiu (no começo do funil, "Sem resposta"; perto da proposta, "Sem orçamento" e "Escolheu concorrente"). Há viés regional proposital (Norte com mais "Conectividade das escolas", Sul com mais concorrente) para a análise por região mostrar algo. 8% das perdas vêm sem motivo e 8% sem etapa registrada.

**Histórico mensal.** Cada mês desde janeiro é calculado com a mesma função que monta a Aba Principal, aplicada no último minuto do mês. Os meses antigos saem como "reconstruído" e o último como "foto", como na produção.

## O relógio da demonstração

A base tem uma data de referência (`--now`). Na demonstração, o painel congela o relógio nela, para "últimos 7 dias" e "este mês" continuarem coerentes mesmo meses depois. O relógio anda a partir dali (as animações dependem disso), e um aviso no topo da tela diz que é demonstração.

## O que não é real

Tudo, exceto a lista de municípios e as siglas dos estados. Nomes de pessoas, valores, conversas, motivos e resultados são inventados.
