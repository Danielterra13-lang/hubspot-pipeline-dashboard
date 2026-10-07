# Incidentes e lições

Problemas que apareceram com o projeto em uso, o que causou e o que mudou no código ou no processo.

| Sintoma | Causa | Correção |
|---|---|---|
| Média de dias na etapa aparecendo como 0,3 | Duração acima de 1 ano vira data de 1901 no Sheets e não era reconhecida como duração | Regra: data antes de 1970 é duração, lida pelo texto formatado |
| Dado antigo continuava na tela depois de uma correção no código | O cache só era invalidado quando a planilha mudava | `CACHE_VER` no código e `remontarCache()` |
| Link do painel servindo a versão velha | Publicado com "Nova implantação", que cria outro link | Sempre "Gerenciar implantações → Nova versão" na mesma implantação |
| Linha de limite de carteira de um proprietário não aparecia | O eixo Y parava antes do maior limite (e `suggestedMax` no `beforeLayout` não tinha efeito) | `suggestedMax` = maior limite + 5, direto nas opções do gráfico |
| Foto mensal não ia rodar no dia 1 | O acionador chamava `syncTudo`, mas `fotoMensal()` tinha sido adicionada em outra função | `fotoMensal()` no fim de `syncTudo()` |

## Em detalhe

### Duração que virou data

O HubSpot exporta "Tempo na fase atual" como `h:mm:ss`. O Sheets converte isso numa data contada a partir de 30/12/1899. Até 24 horas parece uma hora; acima de um ano a data cai em 1900, 1901. O código antigo só tratava como duração datas de 1899, então negócios parados há mais de um ano viravam "0,3 dias" e puxavam a média para baixo.

Lição: tipo de dado do Sheets não é confiável para durações. O `toTable_` agora lê o texto formatado (`getDisplayValues`) de qualquer coluna em que apareça uma data antes de 1970.

### Cache que não sabia que o código mudou

O cache era invalidado pela data de modificação da planilha. Uma correção na forma de montar os dados não mexe na planilha, então o cache antigo continuava sendo servido até a sync do dia seguinte.

Lição: todo cache precisa de uma chave de versão do código que o gera. `CACHE_VER` resolve; `remontarCache()` existe para forçar na hora.

### "Nova implantação" x "Nova versão"

No Apps Script, cada implantação tem seu link. "Nova implantação" cria outro link, e o antigo, que estava nos favoritos de todo mundo, continua preso à versão anterior.

Lição: um link, uma implantação. Publicar mudança é editar a implantação existente e escolher "Nova versão". Implantações antigas são arquivadas.

### Foto mensal que dependia do gatilho certo

A função de foto foi adicionada a uma função de sync parcial, mas o acionador configurado no editor chamava `syncTudo`. Teria passado o dia 1 sem foto, e o comparativo do mês ficaria sem base.

Lição: conferir qual função o acionador chama, não qual função parece certa. Hoje `syncTudo()` termina chamando `fotoMensal()`, e a foto tem janela de 5 dias com nova tentativa diária e e-mail de alerta.

## Hábitos que ficaram

- Toda execução deixa rastro no `_sync_log`, inclusive avisos de colunas sem propriedade.
- Toda mudança de cálculo é conferida contra uma fonte independente (export manual, estudo anterior) antes de ir para a reunião.
- Mudança de layout de dados = subir `CACHE_VER`.
