#!/usr/bin/env python3
"""
Gerador de dados sintéticos para o modo demonstração do dashboard.

Produz um funil B2G fictício (venda para secretarias municipais de educação) com o MESMO formato
de abas que a sincronização com o HubSpot grava na planilha:

  Aba Principal  -> negócios (uma linha por negócio, colunas de propriedades + "Date entered" por etapa)
  Chamadas       -> uma linha por chamada associada a negócio
  Emails         -> uma linha por e-mail enviado
  Whatsapp       -> uma linha por conversa (corpo = histórico bruto do chat)
  Reuniões       -> uma linha por reunião (inclui registros duplicados, como acontece no CRM)
  _historico_mensal -> fotos de fim de mês (formato longo), reconstruídas + uma foto "real"

Tudo é inventado: nomes de pessoas, valores, conversas e resultados. Os municípios são a lista pública
do IBGE (municipios_ibge.csv), usada só para dar nome às contas e posicionar no mapa.

Saída: demo/demo.json, no mesmo formato que o getData() do Apps Script devolve
({main, calls, emails, whats, meet, hist, errs}, cada aba = {cols:[{label}], rows:[{c:[{v}|{f}|null]}]}).

Uso:
  python3 data-generator/generate.py                 # gera demo/demo.json
  python3 data-generator/generate.py --csv           # também grava demo/csv/*.csv (para importar no Sheets)
  python3 data-generator/generate.py --seed 7 --deals 900 --now 2026-10-06T09:30

Só usa a biblioteca padrão do Python 3.8+.
"""
import argparse
import csv
import json
import math
import os
import random
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# --------------------------------------------------------------------------------------------
# Domínio (tudo fictício, mas com a mesma estrutura de um funil B2G real)
# --------------------------------------------------------------------------------------------
PIPELINE = 'Prefeituras'
STAGES = ['Cliente Potencial', 'Contato Iniciado', 'Contato Visto', 'Contato Identificado', 'Conexão Estabelecida',
          'Conversa Agendada', 'Conversa Realizada', 'Contato Qualificado', 'Demo', 'Proposta Solicitada',
          'Proposta Enviada', 'Ajuste Proposta/Edital', 'Formalização', 'Negócio Ganho']
LOST = 'Negócio Perdido'
IDX = {s: i for i, s in enumerate(STAGES)}
I_CONV_REAL = IDX['Conversa Realizada']
I_SDR_END = IDX['Conexão Estabelecida']            # o SDR prospecta até aqui; depois o negócio vai para um AE
I_PROPOSTA = IDX['Proposta Solicitada']

# probabilidade de avançar da etapa i para i+1 e tempo médio (dias) na etapa i
P_NEXT = [0.80, 0.86, 0.72, 0.78, 0.80, 0.92, 0.70, 0.80, 0.66, 0.92, 0.35, 0.60, 0.85]
D_MEAN = [18, 6, 8, 10, 10, 7, 12, 16, 18, 14, 28, 30, 25]
P_LOSE = [0.10, 0.50, 0.50, 0.52, 0.52, 0.50, 0.55, 0.55, 0.60, 0.60, 0.60, 0.60, 0.50]   # quem não avança: perde ou fica parado

SDR = 'Ana Ribeiro'
AES = ['Bruno Carvalho', 'Camila Nunes', 'Diego Freitas', 'Rafael Moura']
FORMER_AE = 'Elisa Prado'                         # saiu do time em junho: as contas dela foram redistribuídas
FORMER_UNTIL = datetime(2026, 6, 30, 23, 59)
WA_EXTRA = 'Fernanda Alves'                       # pré-vendas que aparece nas conversas mas não é proprietária

LEAD_FIRST = ['Patrícia', 'Marcos', 'Luciana', 'Roberto', 'Simone', 'Rogério', 'Vanessa', 'Sérgio', 'Cláudia', 'Paulo',
              'Adriana', 'Renato', 'Juliana', 'Márcio', 'Tatiane', 'Gustavo', 'Sandra', 'Fábio', 'Regina', 'Wagner']
LEAD_LAST = ['Gomes', 'Barbosa', 'Moreira', 'Teixeira', 'Pinheiro', 'Cardoso', 'Monteiro', 'Rezende', 'Castro', 'Vieira']
LEAD_ROLE = ['Secretária de Educação', 'Coordenadora pedagógica', 'Diretor de ensino', 'Assessora da secretaria',
             'Coordenador de tecnologia educacional', 'Supervisora de anos finais']

TEMPS = ['Muito quente', 'Quente', 'Morno', 'Frio', 'Desqualificada']
ICPS = ['1 - até 5 mil alunos', '2 - 5 a 20 mil alunos', '3 - 20 a 50 mil alunos', '4 - acima de 50 mil alunos']
ICP_W = [0.38, 0.36, 0.17, 0.09]
ICP_VALUE = [(25_000, 80_000), (80_000, 260_000), (260_000, 650_000), (650_000, 2_400_000)]
MKT = ['Webinar de gestores', 'Evento regional', 'Campanha de e-mail', 'Material rico', 'Visita de campo']
HIPOTESES = ['H1 - Dor com avaliação diagnóstica', 'H2 - Recomposição de aprendizagem', 'H3 - Formação de professores']
SLA_DAYS = {'Prospecção': 21, 'Qualificação': 30, 'Proposta': 45}

MOTIVOS = ['Sem orçamento', 'Escolheu concorrente', 'Sem resposta', 'Timing: próximo ano', 'Mudança de gestão',
           'Não é prioridade', 'Produto não atende']
OBJECOES = ['Preço acima do orçamento', 'Orçamento contingenciado', 'Já usa outra solução', 'Rede sem tempo para formação',
            'Conectividade das escolas', 'Processo de compra (licitação)']
REGIAO = {'N': 'AC AM AP PA RO RR TO', 'NE': 'AL BA CE MA PB PE PI RN SE', 'CO': 'DF GO MS MT', 'SE': 'ES MG RJ SP', 'S': 'PR RS SC'}
UF_REG = {uf: r for r, s in REGIAO.items() for uf in s.split()}
# viés regional (para a análise por região ter o que mostrar)
MOT_BIAS = {'NE': {'Sem orçamento': 2.2}, 'S': {'Escolheu concorrente': 2.4}, 'N': {'Mudança de gestão': 1.8}}
OBJ_BIAS = {'N': {'Conectividade das escolas': 3.0}, 'NE': {'Orçamento contingenciado': 1.8}, 'S': {'Já usa outra solução': 2.0}}
NOTAS = {
    'Sem orçamento': ['Secretaria confirmou que o orçamento do ano já está comprometido.', 'Pediu para retomar depois da LOA.'],
    'Escolheu concorrente': ['Fecharam com uma plataforma que já atendia o estado.', 'Optaram pela solução que veio junto com o material didático.'],
    'Sem resposta': ['Sete tentativas em canais diferentes sem retorno.', 'Contato saiu da secretaria e ninguém assumiu.'],
    'Timing: próximo ano': ['Querem rever no planejamento do ano que vem.', 'Calendário de formação já fechado.'],
    'Mudança de gestão': ['Troca de secretário no meio da negociação.', 'Nova gestão pediu para pausar todos os projetos.'],
    'Não é prioridade': ['Foco da rede está em infraestrutura neste ano.', 'Priorizaram alfabetização nos anos iniciais.'],
    'Produto não atende': ['Precisam de uma solução para educação infantil.', 'Exigem integração com sistema próprio.'],
}
UF_W = {'SP': 14, 'MG': 12, 'BA': 9, 'PR': 7, 'RS': 7, 'PE': 6, 'CE': 6, 'GO': 5, 'MA': 4, 'PA': 4, 'SC': 4, 'PB': 3,
        'PI': 3, 'RN': 3, 'AL': 3, 'ES': 3, 'RJ': 3, 'MT': 3, 'MS': 2, 'TO': 2, 'SE': 2, 'AM': 2, 'RO': 1, 'AC': 1, 'AP': 1, 'RR': 1}

CALL_RESULTS = [('Conectado', 0.30), ('Sem resposta', 0.40), ('Deixou mensagem de voz', 0.12), ('Ocupado', 0.10), ('Número errado', 0.08)]
MEET_OUT = {'done': 'Concluído', 'sched': 'Programados', 'resched': 'Reprogramado', 'noshow': 'Não compareceu', 'cancel': 'Cancelado'}

MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

# --------------------------------------------------------------------------------------------
# utilitários
# --------------------------------------------------------------------------------------------
R = random.Random()


def block_of(i):
    if i <= 0:
        return 'Prospecção'
    if i < I_CONV_REAL:
        return 'Prospecção'
    if i < I_PROPOSTA:
        return 'Qualificação'
    return 'Proposta'


def lognorm_days(mean):
    sigma = 0.6
    mu = math.log(mean) - sigma * sigma / 2
    return max(0.3, R.lognormvariate(mu, sigma))


def business_time(d):
    """Empurra um instante para horário comercial em dia útil."""
    d = d.replace(second=0, microsecond=0)
    if d.hour >= 19:
        d = (d + timedelta(days=1)).replace(hour=R.randint(8, 11), minute=R.randint(0, 59))
    elif d.hour < 8:
        d = d.replace(hour=R.randint(8, 11), minute=R.randint(0, 59))
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def ts(d):
    return d.strftime('%Y-%m-%d %H:%M') if d else None


def dur_hms(td):
    s = int(td.total_seconds())
    return '%d:%02d:%02d' % (s // 3600, (s % 3600) // 60, s % 60)


def ordinal(n):
    if 11 <= n % 100 <= 13:
        return '%dth' % n
    return '%d%s' % (n, {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th'))


def wa_stamp(d):
    return '[%s %s %d, %02d:%02d]' % (ordinal(d.day), MONTHS_EN[d.month - 1], d.year, d.hour, d.minute)


def weighted(pairs):
    tot = sum(w for _, w in pairs)
    x = R.random() * tot
    for v, w in pairs:
        x -= w
        if x <= 0:
            return v
    return pairs[-1][0]


def poisson(lam):
    if lam <= 0:
        return 0
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= R.random()
        if p <= L:
            return k
        k += 1


def month_end(y, m):
    nxt = datetime(y + (m == 12), m % 12 + 1, 1)
    return nxt - timedelta(minutes=1)


# --------------------------------------------------------------------------------------------
# simulação
# --------------------------------------------------------------------------------------------
class Deal:
    pass


def load_municipios():
    by_uf = {}
    with open(os.path.join(HERE, 'municipios_ibge.csv'), encoding='utf-8') as f:
        for row in csv.DictReader(f):
            by_uf.setdefault(row['uf'], []).append((row['codigo_ibge'], row['nome']))
    return by_uf


def simulate_path(created, now):
    """Caminho do negócio no funil: lista de (índice da etapa, data de entrada) e, se for o caso, a perda."""
    path = [(0, created)]
    t, i = created, 0
    lost_at = None
    while i < len(STAGES) - 1:
        stay = timedelta(days=lognorm_days(D_MEAN[i]))
        if R.random() < P_NEXT[i]:
            t = business_time(t + stay)
            if t > now:
                break
            i += 1
            path.append((i, t))
        else:
            if R.random() < P_LOSE[i]:
                lt = business_time(t + timedelta(days=lognorm_days(D_MEAN[i] * 2.2)))
                if lt <= now:
                    lost_at = lt
            break
    return path, lost_at


def build_deals(n, now, since):
    by_uf = load_municipios()
    used = set()
    deals = []
    uf_pairs = list(UF_W.items())
    ids = set()
    for k in range(n):
        uf = weighted(uf_pairs)
        while True:
            code, name = R.choice(by_uf[uf])
            if code not in used:
                used.add(code)
                break
        d = Deal()
        while True:
            rid = R.randint(10_000_000_000, 49_999_999_999)
            if rid not in ids:
                ids.add(rid)
                break
        d.id, d.uf, d.ibge, d.city = rid, uf, code, name
        d.reg = UF_REG[uf]
        d.nome = 'Secretaria Municipal de Educação de %s - %s' % (name, uf)
        # criação: base antiga (2025) + entrada crescente ao longo de 2026
        if R.random() < 0.16:
            created = datetime(2025, 7, 1) + timedelta(days=R.uniform(0, 183))
        else:
            span = (now - timedelta(days=4) - since).days
            created = since + timedelta(days=span * (R.random() ** 0.8))
        d.created = business_time(created.replace(hour=R.randint(8, 18), minute=R.randint(0, 59)))
        d.icp_i = weighted(list(enumerate(ICP_W)))
        d.icp = ICPS[d.icp_i]
        lo, hi = ICP_VALUE[d.icp_i]
        d.valor = round(R.uniform(lo, hi) / 500) * 500
        d.ae = R.choice(AES)
        d.sdr = R.random() < 0.38          # parte da base é prospectada pelo SDR
        d.former = R.random() < 0.18          # foi da Elisa antes de junho
        d.path, d.lost_at = simulate_path(d.created, now)
        d.noise = R.uniform(-0.5, 0.5)
        d.mkt = []
        if R.random() < 0.32:
            for a in R.sample(MKT, R.choice([1, 1, 2])):
                d.mkt.append((a, d.created + timedelta(days=R.uniform(0, max(1, (now - d.created).days)))))
        d.hip = R.choice(HIPOTESES) if R.random() < 0.4 else ''
        deals.append(d)
    return deals


def stage_at(d, t):
    """(índice da etapa, data de entrada, perdido?) no instante t."""
    if d.lost_at and d.lost_at <= t:
        last = [p for p in d.path if p[1] <= d.lost_at][-1]
        return None, d.lost_at, last[0]
    cur = None
    for p in d.path:
        if p[1] <= t:
            cur = p
    return cur[0], cur[1], None


def owner_at(d, t):
    st, _, lost_from = stage_at(d, t)
    idx = st if st is not None else lost_from
    if d.sdr and (idx is None or idx < I_SDR_END):
        return SDR
    if d.former and t <= FORMER_UNTIL:
        return FORMER_AE
    return d.ae


def end_of_activity(d, now):
    if d.lost_at:
        return d.lost_at
    last_stage, last_t = d.path[-1]
    if last_stage == IDX['Negócio Ganho']:
        return min(now, last_t + timedelta(days=12))
    if last_stage == 0 and len(d.path) == 1:
        return None                          # nunca foi abordado
    # negócio aberto: recência do último contato
    r = R.random()
    rec = R.uniform(0, 7) if r < 0.55 else R.uniform(8, 15) if r < 0.75 else R.uniform(16, 75)
    return max(d.path[1][1] if len(d.path) > 1 else d.created, now - timedelta(days=rec))


def build_touches(d, now):
    """Pontos de contato (chamada, e-mail, WhatsApp) ao longo da vida do negócio."""
    end = end_of_activity(d, now)
    d.touches, d.channels = [], []
    if not end:
        return
    start = d.path[1][1] if len(d.path) > 1 else d.created
    # um contato em cada mudança de etapa
    for i, t in d.path[1:]:
        if t <= end:
            d.touches.append(t)
    # contatos de cadência entre as mudanças
    t = start
    while t < end:
        st, _, _ = stage_at(d, t)
        rate = {'Prospecção': 0.16, 'Qualificação': 0.12, 'Proposta': 0.09}[block_of(st or 0)]
        step = R.expovariate(rate)
        t = t + timedelta(days=step)
        if t < end:
            d.touches.append(business_time(t))
    d.touches.append(business_time(end) if business_time(end) <= now else end)
    d.touches = sorted(x for x in d.touches if x <= now)
    d.channels = [weighted([('call', 0.34), ('email', 0.36), ('wa', 0.30)]) for _ in d.touches]


# --------------------------------------------------------------------------------------------
# atributos "de opinião" (temperatura, termômetro...) numa data
# --------------------------------------------------------------------------------------------
def last_touch(d, t):
    xs = [x for x in d.touches if x <= t]
    return (xs[-1], len(xs)) if xs else (None, 0)


def temp_score(d, t):
    st, _, lost_from = stage_at(d, t)
    if st is None:
        return None
    lt, _ = last_touch(d, t)
    rec = (t - lt).days if lt else 999
    base = [0, 1.2, 1.4, 1.8, 2.3, 2.8, 3.1, 3.4, 3.8, 4, 4.2, 4.2, 4.4, 4.6][st]
    adj = 1 if rec <= 7 else 0 if rec <= 15 else -1 if rec <= 30 else -2
    month_noise = random.Random('%s-%s' % (d.id, t.strftime('%Y%m'))).uniform(-0.7, 0.7)
    return base + adj + d.noise + month_noise


def temp_label(d, t):
    if d.created > t:
        return ''
    st, _, _ = stage_at(d, t)
    if st is None:
        return 'Desqualificada'
    if st == 0 and len([p for p in d.path if p[1] <= t]) == 1:
        return ''                              # cliente potencial sem abordagem: sem temperatura
    lt, _ = last_touch(d, t)
    rec = (t - lt).days if lt else 999
    if rec > 60 and random.Random('dq%s%s' % (d.id, t.month)).random() < 0.35:
        return 'Desqualificada'
    s = temp_score(d, t)
    return 'Muito quente' if s >= 4.2 else 'Quente' if s >= 2.9 else 'Morno' if s >= 1.6 else 'Frio'


def termo_label(d, t):
    cur = temp_label(d, t)
    if not cur:
        return ''
    if cur == 'Desqualificada':
        return 'Desqualificação'
    prev = temp_label(d, t - timedelta(days=30))
    order = {'Muito quente': 0, 'Quente': 1, 'Morno': 2, 'Frio': 3, 'Desqualificada': 4, '': 2}
    a, b = order[cur], order[prev]
    return 'Aquecimento' if a < b else 'Resfriamento' if a > b else 'Estável'


def status_op(d, t):
    lt, _ = last_touch(d, t)
    if not lt:
        return 'Sem atualização'
    rec = (t - lt).days
    return 'Saudável' if rec <= 7 else 'Em risco' if rec <= 15 else 'Parado'


def qualidade(d, t):
    lt, n = last_touch(d, t)
    if not lt:
        return ''
    rr = random.Random('q%s%s' % (d.id, n)).random()
    st, _, _ = stage_at(d, t)
    if st is None:
        return 'Negativo' if rr < 0.6 else 'Tentativa de contato'
    p_pos = 0.25 + 0.04 * st
    return 'Positivo' if rr < p_pos else 'Tentativa de contato' if rr < p_pos + 0.45 else 'Contexto insuficiente' if rr < p_pos + 0.6 else 'Negativo'


def snapshot(d, t):
    """Linha da Aba Principal do negócio no instante t (None se ainda não existia)."""
    if d.created > t:
        return None
    st, entered, lost_from = stage_at(d, t)
    lost = st is None
    stage_name = LOST if lost else STAGES[st]
    won = (not lost) and st == IDX['Negócio Ganho']
    lt, n = last_touch(d, t)
    blk = block_of(st if st is not None else 0)
    status = 'Perdido' if lost else 'Ganho' if won else blk
    tempo = t - entered
    sla = '' if (lost or won or st == 0) else ('Dentro do SLA' if tempo.days <= SLA_DAYS[blk] else 'Fora do SLA')
    temp = temp_label(d, t)
    prio = ''
    if not lost and not won:
        prio = 'Alta' if (d.icp_i >= 2 or temp in ('Muito quente', 'Quente')) else 'Baixa' if (temp == 'Frio' and d.icp_i == 0) else 'Média'
    return {
        'Record ID': d.id, 'Nome do negócio': d.nome, 'Etapa do negócio': stage_name,
        'É aberto (numérico)': 0 if (lost or won) else 1, 'Proprietário do negócio': owner_at(d, t), 'Valor': d.valor,
        'Data de criação': ts(d.created), 'Último contato': ts(lt), 'Número de contatos efetuados': n,
        'Tempo na fase atual': {'f': dur_hms(tempo)}, 'Data que entrou na fase atual': ts(entered),
        'Estado (UF)': d.uf, 'Temperatura': temp, 'Termômetro': termo_label(d, t), 'Status operacional': '' if lost else status_op(d, t),
        'Qualidade do último contato': qualidade(d, t), 'Status do funil': status, 'Prioridade de contato': prio,
        'Categoria SLA': sla, 'Categoria ICP': d.icp, 'Ações de marketing': '; '.join(a for a, at in d.mkt if at <= t),
    }


# --------------------------------------------------------------------------------------------
# perdas e objeções
# --------------------------------------------------------------------------------------------
def pick_biased(options, bias, k=1):
    w = [(o, bias.get(o, 1.0)) for o in options]
    out = []
    for _ in range(k):
        v = weighted([x for x in w if x[0] not in out])
        out.append(v)
    return out


def loss_fields(d):
    d.motivo = d.nota = d.etapa_perda = ''
    d.objs = []
    reached = d.path[-1][0]
    if reached >= I_SDR_END and R.random() < 0.5:
        d.objs = pick_biased(OBJECOES, OBJ_BIAS.get(d.reg, {}), R.choice([1, 1, 2]))
    if not d.lost_at:
        return
    if d.lost_at and reached >= I_SDR_END and not d.objs and R.random() < 0.45:
        d.objs = pick_biased(OBJECOES, OBJ_BIAS.get(d.reg, {}), 1)
    d.etapa_perda = STAGES[reached] if R.random() > 0.08 else ''      # às vezes a etapa da perda não é registrada
    if R.random() < 0.08:
        return                                                         # perda sem motivo registrado
    if reached < IDX['Conexão Estabelecida']:
        base = {'Sem resposta': 4, 'Não é prioridade': 2, 'Mudança de gestão': 1}
    elif reached < I_PROPOSTA:
        base = {'Não é prioridade': 2, 'Sem orçamento': 2, 'Timing: próximo ano': 1.5, 'Mudança de gestão': 1, 'Produto não atende': 1, 'Sem resposta': 1}
    else:
        base = {'Sem orçamento': 2.5, 'Escolheu concorrente': 2.5, 'Timing: próximo ano': 1.5, 'Mudança de gestão': 1, 'Produto não atende': 1}
    bias = MOT_BIAS.get(d.reg, {})
    m = weighted([(k, w * bias.get(k, 1.0)) for k, w in base.items()])
    d.motivo = m
    if R.random() < 0.55:
        d.nota = R.choice(NOTAS[m])


# --------------------------------------------------------------------------------------------
# abas de atividade
# --------------------------------------------------------------------------------------------
def lead_person():
    return '%s %s' % (R.choice(LEAD_FIRST), R.choice(LEAD_LAST))


WA_TEAM_OPEN = ['Bom dia! Tudo bem? Sou %s e falo sobre o programa de escrita para a rede de %s.',
                'Olá, aqui é %s. Conseguiu ver o material que enviei sobre a rede de %s?',
                'Boa tarde! %s por aqui. Podemos marcar 30 minutos para falar da rede de %s?']
WA_TEAM_FOLLOW = ['Combinado, envio o convite agora.', 'Perfeito, obrigado pelo retorno!', 'Fico no aguardo então.',
                  'Mandei a proposta por e-mail, qualquer dúvida me chama.', 'Consegue confirmar o melhor horário?']
WA_LEAD = ['Oi, tudo bem sim. Pode ser na quinta à tarde.', 'Recebi sim, vou ver com a equipe e retorno.',
           'Agora não conseguimos, estamos fechando o calendário.', 'Pode mandar mais detalhes por e-mail?',
           'Bom dia! Vamos conversar sim, qual horário?', 'Obrigada, vou encaminhar para a secretária.']


def wa_body(d, t, sender, lead, initiator, replied):
    lines, cur = [], t
    if initiator == 'lead':
        lines.append((lead, cur, 'Bom dia, recebi o contato de vocês sobre a plataforma. Podemos conversar?'))
        cur += timedelta(minutes=R.lognormvariate(math.log(35), 0.8))
        lines.append((sender, cur, R.choice(WA_TEAM_FOLLOW)))
    else:
        lines.append((sender, cur, R.choice(WA_TEAM_OPEN) % (sender.split()[0], d.city)))
        if R.random() < 0.35:
            cur += timedelta(minutes=R.uniform(1, 4))
            lines.append((sender, cur, 'Segue o link com um resumo do programa.'))
        if replied:
            cur += timedelta(minutes=R.lognormvariate(math.log(180), 1.1))
            lines.append((lead, cur, R.choice(WA_LEAD)))
            if R.random() < 0.7:
                cur += timedelta(minutes=R.lognormvariate(math.log(40), 0.9))
                lines.append((sender, cur, R.choice(WA_TEAM_FOLLOW)))
    return '\n'.join('%s %s: %s' % (who, wa_stamp(when), txt) for who, when, txt in lines)


def wa_summary(sender, lead, replied):
    first = sender.split()[0]
    s = '- %s iniciou a conversa apresentando o programa para a rede. ' % first
    s += ('- %s respondeu e confirmou interesse em uma reunião na próxima semana.' % lead.split()[0]) if replied \
        else '- O contato não respondeu às mensagens enviadas.'
    return s


def build_activities(deals, now, since):
    calls, emails, whats, meets = [], [], [], []
    eng_id = 9_000_000_000
    for d in deals:
        lead = lead_person()
        for t, ch in zip(d.touches, d.channels):
            if t < since:
                continue
            who = owner_at(d, t)
            st, _, _ = stage_at(d, t)
            if ch == 'call':
                res = weighted(CALL_RESULTS)
                calls.append({'Data da atividade': ts(t), 'Atividade atribuída a': who, 'Resultado da chamada': res,
                              'Contagem de conectados': 1 if res == 'Conectado' else 0,
                              'Duração da chamada': dur_hms(timedelta(seconds=R.randint(90, 900))) if res == 'Conectado' else '0:00:00',
                              'Negócio ID': d.id, 'Nome do negócio': d.nome})
            elif ch == 'email':
                opened = R.random() < 0.55
                rep = 1 if (opened and R.random() < 0.10 + 0.02 * (st or 0)) else 0
                emails.append({'Data da atividade': ts(t), 'Atividade atribuída a': who, 'Direção de e-mail': 'Saída',
                               'Status de envio de e-mail': 'Enviados', 'Número de e-mails enviados': 1,
                               'Number of Email Opens': R.randint(1, 4) if opened else 0, 'Email Open Rate': 1 if opened else 0,
                               'Número de respostas de e-mail': rep, 'Negócio ID': d.id, 'Nome do negócio': d.nome})
            else:
                eng_id += R.randint(1, 50)
                sender = WA_EXTRA if R.random() < 0.08 else who
                initiator = 'lead' if R.random() < 0.08 else 'team'
                replied = R.random() < (0.45 + 0.04 * (st or 0))
                if R.random() < 0.05:
                    body = wa_summary(sender, lead, replied)               # registros antigos: resumo em vez do chat
                else:
                    body = wa_body(d, t, sender, lead, initiator, replied)
                    if R.random() < 0.04:
                        body = body.replace('\n', ' ')                      # export que perde as quebras de linha
                whats.append({'Corpo da comunicação': body, 'Nome do negócio': d.nome, 'Negócio ID': d.id,
                              'Atividade atribuída a': '' if R.random() < 0.12 else who, 'Data da atividade': ts(t),
                              'Engagement ID': eng_id})
        meets.extend(deal_meetings(d, now, since))
    # atividades de negócios que não estão na Aba Principal (outro pipeline): o painel conta e ignora
    for _ in range(40):
        t = since + timedelta(days=R.uniform(0, (now - since).days))
        calls.append({'Data da atividade': ts(business_time(t)), 'Atividade atribuída a': R.choice(AES), 'Resultado da chamada': 'Sem resposta',
                      'Contagem de conectados': 0, 'Duração da chamada': '0:00:00', 'Negócio ID': R.randint(50_000_000_000, 59_999_999_999),
                      'Nome do negócio': 'Conta de outro pipeline'})
    calls.sort(key=lambda r: r['Data da atividade'])
    emails.sort(key=lambda r: r['Data da atividade'])
    whats.sort(key=lambda r: r['Data da atividade'])
    meets.sort(key=lambda r: r['Hora de início da reunião'])
    return calls, emails, whats, meets


REG_ID = [70_000_000_000]


def meeting_row(d, start, minutes, name, outcome, mid=None):
    REG_ID[0] += R.randint(1, 900)
    return {'Nome da reunião': name, 'Hora de início da reunião': ts(start),
            'Hora de término da reunião': ts(start + timedelta(minutes=minutes)), 'ID do registro': REG_ID[0],
            'Resultado da reunião': outcome, 'Reunião ID': mid or REG_ID[0], 'Negócio ID': d.id}


def meeting_slot(t):
    t = business_time(t)
    return t.replace(hour=R.choice([8, 9, 9, 10, 10, 11, 14, 14, 15, 15, 16, 17]), minute=R.choice([0, 0, 30]))


def deal_meetings(d, now, since):
    out = []
    marks = {i: t for i, t in d.path}
    plan = []
    if IDX['Conversa Realizada'] in marks:
        plan.append((marks[IDX['Conversa Realizada']], 'Conversa inicial', 'done'))
    if IDX['Demo'] in marks:
        plan.append((marks[IDX['Demo']], 'Demo da plataforma', 'done'))
    if IDX['Proposta Enviada'] in marks and R.random() < 0.5:
        plan.append((marks[IDX['Proposta Enviada']] + timedelta(days=3), 'Apresentação da proposta', 'done'))
    cur = d.path[-1][0]
    if not d.lost_at and cur == IDX['Conversa Agendada']:
        plan.append((max(now + timedelta(days=R.uniform(1, 18)), marks[cur] + timedelta(days=2)), 'Conversa inicial', 'sched'))
        if R.random() < 0.3:
            plan.append((marks[cur] + timedelta(days=R.uniform(1, 6)), 'Conversa inicial', R.choice(['noshow', 'resched', 'cancel'])))
        if R.random() < 0.12:
            plan.append((marks[cur] + timedelta(days=1), 'Conversa inicial', 'sched'))     # ficou como programada no passado
    if not d.lost_at and IDX['Demo'] <= cur <= IDX['Formalização'] and R.random() < 0.35:
        plan.append((now + timedelta(days=R.uniform(1, 25)), 'Reunião de acompanhamento', 'sched'))
    if d.lost_at and cur >= IDX['Conversa Agendada'] and R.random() < 0.3:
        plan.append((d.lost_at - timedelta(days=R.uniform(3, 12)), 'Conversa inicial', R.choice(['noshow', 'cancel'])))
    # parte das reuniões que aconteceram teve antes uma falta, um cancelamento ou uma remarcação
    for t, kind, oc in list(plan):
        if oc == 'done' and R.random() < 0.16:
            plan.append((t - timedelta(days=R.uniform(4, 10)), kind, weighted([('noshow', 0.5), ('resched', 0.3), ('cancel', 0.2)])))
    for t, kind, oc in plan:
        start = meeting_slot(t)
        if start < since:
            continue
        pres = cur >= IDX['Contato Qualificado'] and kind != 'Conversa inicial' and R.random() < 0.28
        if pres:
            name = 'Visita presencial - %s - %s [%s]' % (d.city, d.uf, d.ibge)
            mins = R.choice([90, 120, 150])
        else:
            name = '%s - %s/%s' % (kind, d.city, d.uf)
            mins = R.choice([30, 45, 60])
        outcome = MEET_OUT[oc]
        if oc == 'done' and start > now:
            outcome = MEET_OUT['sched']
        row = meeting_row(d, start, mins, name, outcome)
        out.append(row)
        # duplicados que aparecem no CRM
        r = R.random()
        if r < 0.05:
            dup = dict(row)
            REG_ID[0] += 3
            dup['ID do registro'] = REG_ID[0]
            dup['Reunião ID'] = REG_ID[0]
            out.append(dup)                                       # mesmo nome e horário, outro registro
        elif r < 0.08 and outcome == 'Concluído':
            out.append(meeting_row(d, start + timedelta(hours=2), mins, '%s (retomada)' % name.split(' [')[0], 'Concluído'))
        elif pres and r < 0.2:
            out.append(meeting_row(d, start - timedelta(days=1), 30, 'Alinhamento da visita - %s' % d.city, 'Concluído'))
    return out


# --------------------------------------------------------------------------------------------
# montagem das abas
# --------------------------------------------------------------------------------------------
MAIN_COLS = ['Record ID', 'Nome do negócio', 'Etapa do negócio', 'É aberto (numérico)', 'Proprietário do negócio', 'Valor',
             'Data de criação', 'Último contato', 'Data da próxima atividade', 'Tempo na fase atual', 'Data que entrou na fase atual',
             'Número de contatos efetuados', 'Estado (UF)', 'Temperatura', 'Termômetro', 'Status operacional',
             'Qualidade do último contato', 'Status do funil', 'Prioridade de contato', 'Categoria SLA', 'Categoria ICP',
             'Ações de marketing', 'Hipótese utilizada', 'Motivo de perda', 'Nota de complemento ao motivo de perda', 'Objeções',
             'Etapa de negócio perdido'] + ['Date entered "%s (%s)"' % (s, PIPELINE) for s in STAGES + [LOST]]
HIST_META = ['Mês de referência', 'Data da foto', 'Origem']
HIST_COLS = ['Record ID', 'Nome do negócio', 'Etapa do negócio', 'É aberto (numérico)', 'Proprietário do negócio', 'Valor',
             'Último contato', 'Número de contatos efetuados', 'Tempo na fase atual', 'Data que entrou na fase atual',
             'Estado (UF)', 'Temperatura', 'Termômetro', 'Status operacional', 'Status do funil', 'Categoria SLA',
             'Categoria ICP', 'Ações de marketing']
CALL_COLS = ['Data da atividade', 'Atividade atribuída a', 'Resultado da chamada', 'Contagem de conectados', 'Duração da chamada', 'Negócio ID', 'Nome do negócio']
MAIL_COLS = ['Data da atividade', 'Atividade atribuída a', 'Direção de e-mail', 'Status de envio de e-mail', 'Número de e-mails enviados',
             'Number of Email Opens', 'Email Open Rate', 'Número de respostas de e-mail', 'Negócio ID', 'Nome do negócio']
WA_COLS = ['Corpo da comunicação', 'Nome do negócio', 'Negócio ID', 'Atividade atribuída a', 'Data da atividade', 'Engagement ID']
MEET_COLS = ['Nome da reunião', 'Hora de início da reunião', 'Hora de término da reunião', 'ID do registro', 'Resultado da reunião', 'Reunião ID', 'Negócio ID']


def main_row(d, now):
    row = snapshot(d, now)
    marks = {i: t for i, t in d.path}
    for i, s in enumerate(STAGES):
        row['Date entered "%s (%s)"' % (s, PIPELINE)] = ts(marks.get(i)) if (not d.lost_at or marks.get(i, now) <= d.lost_at) else None
    row['Date entered "%s (%s)"' % (LOST, PIPELINE)] = ts(d.lost_at)
    lt, _ = last_touch(d, now)
    if row['É aberto (numérico)'] and lt and (now - lt).days <= 15 and R.random() < 0.6:
        row['Data da próxima atividade'] = ts(business_time(now + timedelta(days=R.uniform(1, 14))))
    row['Hipótese utilizada'] = d.hip
    row['Motivo de perda'] = d.motivo
    row['Nota de complemento ao motivo de perda'] = d.nota
    row['Objeções'] = '; '.join(d.objs)
    row['Etapa de negócio perdido'] = d.etapa_perda
    return row


def cell(v):
    if v is None or v == '':
        return None
    if isinstance(v, dict):
        return v
    return {'v': v}


def table(cols, rows):
    return {'cols': [{'label': c} for c in cols], 'rows': [{'c': [cell(r.get(c)) for c in cols]} for r in rows]}


def history(deals, now, since):
    rows = []
    y, m = since.year, since.month
    while True:
        end = month_end(y, m)
        if end >= now:
            break
        is_photo = (y, m) == ((now.year, now.month - 1) if now.month > 1 else (now.year - 1, 12))
        foto = end + timedelta(hours=7, minutes=12) if is_photo else end
        origem = 'foto' if is_photo else 'reconstruído'
        for d in deals:
            snap = snapshot(d, end)
            if not snap:
                continue
            r = {'Mês de referência': '%04d-%02d' % (y, m), 'Data da foto': ts(foto), 'Origem': origem}
            r.update({c: snap.get(c) for c in HIST_COLS})
            rows.append(r)
        y, m = (y + (m == 12), m % 12 + 1)
    return table(HIST_META + HIST_COLS, rows)


def display(v):
    if v is None:
        return ''
    if isinstance(v, dict):
        return v.get('f', v.get('v', ''))
    return v


def write_csv(path, t):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow([c['label'] for c in t['cols']])
        for r in t['rows']:
            w.writerow([display(c) for c in r['c']])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--deals', type=int, default=560)
    ap.add_argument('--now', default='2026-10-09T09:30', help='data de referência da base (o painel congela o relógio nela)')
    ap.add_argument('--since', default='2026-01-01', help='início das atividades (como o filtro da sync)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'demo', 'demo.json'))
    ap.add_argument('--csv', action='store_true', help='grava também demo/csv/*.csv')
    a = ap.parse_args()

    R.seed(a.seed)
    now = datetime.fromisoformat(a.now)
    since = datetime.fromisoformat(a.since)

    deals = build_deals(a.deals, now, since)
    for d in deals:
        build_touches(d, now)
        loss_fields(d)
    calls, emails, whats, meets = build_activities(deals, now, since)

    out = {
        'demo': True,
        'generatedAt': now.strftime('%Y-%m-%dT%H:%M:00'),
        'main': table(MAIN_COLS, [main_row(d, now) for d in deals]),
        'calls': table(CALL_COLS, calls),
        'emails': table(MAIL_COLS, emails),
        'whats': table(WA_COLS, whats),
        'meet': table(MEET_COLS, meets),
        'hist': history(deals, now, since),
        'errs': [],
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    if a.csv:
        names = {'main': 'Aba Principal', 'calls': 'Chamadas', 'emails': 'Emails', 'whats': 'Whatsapp', 'meet': 'Reuniões', 'hist': '_historico_mensal'}
        for k, n in names.items():
            write_csv(os.path.join(os.path.dirname(a.out), 'csv', n + '.csv'), out[k])

    lost = sum(1 for d in deals if d.lost_at)
    print('negócios: %d (perdidos %d) | chamadas %d | e-mails %d | whatsapp %d | reuniões %d | histórico %d linhas | %.1f MB'
          % (len(deals), lost, len(calls), len(emails), len(whats), len(meets), len(out['hist']['rows']),
             os.path.getsize(a.out) / 1e6))


if __name__ == '__main__':
    main()
