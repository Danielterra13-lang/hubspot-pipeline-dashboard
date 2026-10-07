# Histórico mensal: foto, reconstrução e validação

O comparativo "este mês x mês passado" precisa saber como o funil estava no fechamento de cada mês. O CRM não guarda isso pronto: cada negócio tem só o valor atual de cada propriedade.

A analogia que uso para explicar é um **extrato bancário**. O HubSpot mostra o saldo de hoje, mas guarda o extrato, ou seja, cada alteração de cada propriedade com data e hora. Dá para calcular o saldo de 31 de agosto a partir do extrato.

## Formato da aba `_historico_mensal`

Formato longo: uma linha por negócio por mês.

| Mês de referência | Data da foto | Origem | Record ID | Etapa do negócio | Proprietário | ... |
|---|---|---|---|---|---|---|
| 2026-08 | 2026-08-31 23:59 | reconstruído | 1234 | Demo | Camila Nunes | ... |
| 2026-09 | 2026-10-01 07:12 | foto | 1234 | Proposta Solicitada | Camila Nunes | ... |

Formato longo foi escolhido porque o painel lê um mês como se fosse a Aba Principal daquela data: filtra as linhas do mês e passa pelo mesmo `parse()`, com os "dias desde" contados até a data da foto. Os filtros da tela valem para os dois lados da comparação, e a foto guarda o proprietário da época.

## 1. Foto automática (`fotoMensal`)

Chamada no fim da sync diária. Do dia 1 ao dia 5, se ainda não existe foto do mês anterior, copia a Aba Principal recém-atualizada como fechamento do mês.

- Se a Aba Principal falhou naquele dia, adia para o dia seguinte (não fotografa dado velho).
- Nunca roda fora da janela. Para emergências existe `forcarFotoMesAnterior()`.
- Na analogia: é tirar um print do saldo todo dia 1.

## 2. Reconstrução (`reconstruirHistorico`)

Roda uma vez, para os meses anteriores à primeira foto.

1. Busca os negócios do pipeline em lotes de 50 com `propertiesWithHistory` (`batch/read`).
2. Para cada mês, define T = 23:59 do último dia.
3. Descarta negócios criados depois de T ou que estavam em outro pipeline em T.
4. Para cada propriedade, `valorEm_` pega o último valor gravado até T.
5. Para a etapa, `estagioEm_` acha a etapa em T e desde quando o negócio estava nela, ignorando regravações da mesma etapa. Daí sai "Tempo na fase atual" na data da foto.
6. "É aberto" vem do metadado da etapa (`isClosed`), não do valor atual.
7. Grava os meses com Origem = "reconstruído". Um mês que já tem foto real nunca é sobrescrito.

## 3. Validação (`validarReconstrucao`)

Reconstruir o passado só vale se o método estiver certo, e o passado não tem gabarito. O truque é reconstruir **o presente** pelo mesmo método e comparar com a Aba Principal, que é o dado real de hoje, coluna a coluna. O resultado vai para a aba `_validacao_historico`, com a taxa de igualdade por coluna e até 300 diferenças de exemplo.

Na versão em produção:

- Etapa, proprietário, valor, temperatura, termômetro, SLA e status do funil bateram 100%.
- Último contato e contatos efetuados ficaram entre 98% e 99%. As diferenças eram atividades registradas no mesmo dia, depois da sync.
- Prova externa: um mês reconstruído bateu com um estudo do funil feito antes, a partir de um export manual do mesmo dia.

Na analogia: o autoteste é calcular o saldo de hoje pelo extrato e conferir com o app do banco; a prova externa é comparar com um extrato impresso guardado na gaveta.

## Limitações

- Negócio excluído ou mesclado some do histórico (conta encerrada leva o extrato junto).
- O filtro de grupo de teste usa o valor atual da propriedade, não o da época.
- Propriedade sem histórico para nenhum negócio usa o valor atual; isso é registrado no log.
- Próxima prova sugerida: reconstruir um mês que já tem foto real numa aba separada e comparar as duas.
