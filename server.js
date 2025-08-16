// server.js — Node 20+/22, package.json должен содержать "type": "module"
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import OpenAI from 'openai'

const app = express()
app.use(cors())
app.use(express.json())

// Инициализация клиента OpenAI (ключ берём из .env)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/** ------------------------------------------------------------------
 *  TOOLS, которые модель может вызывать
 *  -----------------------------------------------------------------*/
const tools = [
  {
    type: 'function',
    name: 'create_map',
    description: 'Создай игровую карту.',
    parameters: {
      type: 'object',
      properties: {
        w: { type: 'integer', minimum: 8, maximum: 48 },
        h: { type: 'integer', minimum: 8, maximum: 48 },
        legend: {
          type: 'object',
          description: 'Сопоставление символов и тайлов.',
          additionalProperties: { type: 'string' }
        },
        rows: {
          type: 'array',
          description: "Массив строк длиной h, каждая строка длиной w. Разрешённые символы '0','1','2'.",
          items: { type: 'string' }
        }
      },
      required: ['w', 'h', 'rows']
    }
  },
  {
    type: 'function',
    name: 'spawn_npc',
    description: 'Создай NPC на координатах.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        name: { type: 'string' },
        role: { type: 'string' },
        persona: { type: 'string', description: 'Стиль речи/поведения NPC.' }
      },
      required: ['x', 'y', 'name']
    }
  },
  {
    type: 'function',
    name: 'spawn_enemy',
    description: 'Создай врага.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        kind: { type: 'string' },
        stats: {
          type: 'object',
          properties: {
            hp: { type: 'integer', minimum: 1, default: 5 },
            atk: { type: 'integer', minimum: 1, default: 1 }
          }
        }
      },
      required: ['x', 'y', 'kind']
    }
  },
  {
    type: 'function',
    name: 'place_item',
    description: 'Положи предмет на тайл.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        kind: { type: 'string' }
      },
      required: ['x', 'y', 'kind']
    }
  },
  {
    type: 'function',
    name: 'set_waypoint',
    description: 'Поставь игроку ориентир на карте.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        note: { type: 'string' }
      },
      required: ['x', 'y']
    }
  },
  {
    type: 'function',
    name: 'give_quests',
    description: 'Предложи до 3 квестов.',
    parameters: {
      type: 'object',
      properties: {
        hint: { type: 'string' }
      }
    }
  },
  {
    type: 'function',
    name: 'modify_tiles',
    description: 'Измени набор тайлов на карте (мосты, двери, тропы).',
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: 'Список изменений тайлов',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer', minimum: 0 },
              y: { type: 'integer', minimum: 0 },
              tile: { type: 'integer', description: '0=трава,1=стена,2=вода' }
            },
            required: ['x', 'y', 'tile']
          }
        },
        note: { type: 'string', description: 'Короткое пояснение игроку' }
      },
      required: ['changes']
    }
  },
  {
    type: 'function',
    name: 'offer_replies',
    description: 'Предложи игроку 2–4 варианта кратких ответов.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' }
            },
            required: ['text']
          }
        }
      },
      required: ['options']
    }
  }
]

/** ------------------------------------------------------------------
 *  Вытягивание tool_calls из ответа Responses API
 *  -----------------------------------------------------------------*/
function extractToolCalls(response) {
  const blocks = (response.output ?? response.output_array ?? response.content ?? [])
  const arr = Array.isArray(blocks) ? blocks : []
  const out = []
  for (const b of arr) {
    if (b?.type === 'tool_call') out.push(b)
    if (Array.isArray(b?.content)) for (const c of b.content) if (c?.type === 'tool_call') out.push(c)
  }
  return out
}

/** ------------------------------------------------------------------
 *  /api/newgame — модель создаёт карту, NPC, врагов, предметы, waypoint
 *  -----------------------------------------------------------------*/
app.post('/api/newgame', async (req, res) => {
  try {
    const { model = 'gpt-4o-mini', size = { w: 24, h: 24 }, themeHint = 'лесная поляна у трактира' } = req.body

    const world = {
      map: { w: size.w, h: size.h, legend: { '0':'grass','1':'wall','2':'water' }, rows: [] },
      npcs: [],
      enemies: [],
      items: [],
      waypoint: null
    }

    let response = await openai.responses.create({
      model,
      tools,
      temperature: 0.8,
      input: [
        { role: 'system', content:
          'Ты — режиссёр стартовой локации RPG. ' +
          'Сгенерируй карту (24x24), 1–2 дружелюбных NPC, 1–3 врагов, 1–3 предмета и waypoint. ' +
          'Используй функции. Не ставь сущности на непроходимые тайлы.' },
        { role: 'user', content: `Тема: ${themeHint}. Размер: ${size.w}x${size.h}.` }
      ]
    })

    const actions = []

    for (let round = 0; round < 4; round++) {
      const calls = extractToolCalls(response)
      if (!calls.length) break

      const tool_outputs = []
      for (const call of calls) {
        const name = call.name
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {})
        let result = null

        if (name === 'create_map') {
          const { w, h, rows, legend } = args
          if (Array.isArray(rows) && rows.length === h && rows.every(s => typeof s === 'string' && s.length === w)) {
            world.map = { w, h, rows, legend: legend ?? world.map.legend }
            result = { ok: true, w, h }
            actions.push({ type: 'create_map', payload: { w, h, rows } })
          } else {
            result = { ok: false, error: 'invalid map' }
          }
        }

        if (name === 'spawn_npc') {
          const npc = {
            id: 'npc-' + Math.random().toString(36).slice(2, 8),
            x: args.x | 0, y: args.y | 0,
            name: String(args.name || 'NPC'),
            role: args.role || '', persona: args.persona || ''
          }
          world.npcs.push(npc)
          result = { ok: true, npc }
          actions.push({ type: 'spawn_npc', payload: npc })
        }

        if (name === 'spawn_enemy') {
          const enemy = {
            id: 'en-' + Math.random().toString(36).slice(2, 8),
            x: args.x | 0, y: args.y | 0,
            kind: String(args.kind || 'rat'),
            stats: { hp: args?.stats?.hp ?? 5, atk: args?.stats?.atk ?? 1 }
          }
          world.enemies.push(enemy)
          result = { ok: true, enemy }
          actions.push({ type: 'spawn_enemy', payload: enemy })
        }

        if (name === 'place_item') {
          const item = {
            id: 'it-' + Math.random().toString(36).slice(2, 8),
            x: args.x | 0, y: args.y | 0,
            kind: String(args.kind || 'gold')
          }
          world.items.push(item)
          result = { ok: true, item }
          actions.push({ type: 'place_item', payload: item })
        }

        if (name === 'set_waypoint') {
          world.waypoint = { x: args.x | 0, y: args.y | 0, note: String(args.note || '') }
          result = { ok: true, waypoint: world.waypoint }
          actions.push({ type: 'set_waypoint', payload: world.waypoint })
        }

        if (name === 'give_quests') {
          const qs = [{ id: 'start-1', title: 'Осмотреть окрестности', desc: 'Пройдись по поляне и поговори с торговцем.' }]
          result = { ok: true, quests: qs }
          actions.push({ type: 'give_quests', payload: qs })
        }

        if (name === 'modify_tiles') {
          const changes = Array.isArray(args.changes) ? args.changes.map(c => ({ x: c.x|0, y: c.y|0, tile: c.tile|0 })) : []
          result = { ok: true, applied: changes.length, note: args.note || '' }
          actions.push({ type: 'modify_tiles', payload: { changes, note: args.note || '' } })
        }

        if (name === 'offer_replies') {
          const options = (args.options || []).map((o, i) => ({ id: String(o.id || `opt${i+1}`), text: String(o.text || '...') }))
          result = { ok: true, options }
          actions.push({ type: 'dialogue_options', payload: options })
        }

        if (result) tool_outputs.push({ tool_call_id: call.id, output: JSON.stringify(result) })
      }

      if (!tool_outputs.length) break

      response = await openai.responses.create({
        model,
        input: [{ role: 'system', content: 'Короткая вводная реплика после создания локации.' }],
        tool_outputs
      })
    }

    const intro = response.output_text || 'Вы пришли на поляну…'
    res.json({ text: intro, world, actions })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'newgame failed' })
  }
})

/** ------------------------------------------------------------------
 *  /api/agent — диалог с NPC + действия (квесты, метки, спавн, модификация тайлов)
 *  -----------------------------------------------------------------*/
app.post('/api/agent', async (req, res) => {
  try {
    const { world, npc, history = [], playerMessage, model = 'gpt-4o-mini' } = req.body

    const histText = history.slice(-6).map(h =>
      `${h.speaker === 'player' ? 'Игрок' : (h.speaker === 'npc' ? (npc?.name || 'NPC') : 'Система')}: ${h.text}`
    ).join('\n')

    let response = await openai.responses.create({
      model,
      tools,
      temperature: 0.9,
      input: [
        { role: 'system', content:
          'Ты — NPC (обычно торговец Гридд) в изометрической RPG. ' +
          'Отвечай кратко и по делу. Если уместно — используй функции: give_quests, set_waypoint, spawn_item, spawn_enemy, spawn_npc, modify_tiles. ' +
          'Почти всегда после реплики предложи игроку 2–4 варианта ответа (offer_replies).' },
        { role: 'user', content: `NPC: ${JSON.stringify({ name: npc?.name, role: npc?.role })}` },
        { role: 'user', content: `Состояние мира (кратко): ${JSON.stringify({
          map: { w: world?.map?.w, h: world?.map?.h },
          npcs: (world?.npcs || []).map(n => ({ name: n.name, x: n.x, y: n.y })).slice(0, 6),
          enemies: (world?.enemies || []).map(e => ({ kind: e.kind, x: e.x, y: e.y })).slice(0, 6),
          items: (world?.items || []).slice(0, 6)
        })}` },
        { role: 'user', content: `Контекст диалога:\n${histText || '—'}` },
        { role: 'user', content: `Игрок: ${playerMessage}` }
      ]
    })

    const actions = []
    const tool_outputs = []

    for (const call of extractToolCalls(response)) {
      const name = call.name
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {})
      let result = null

      if (name === 'give_quests') {
        const qs = [
          { id: 'quest-rats', title: 'Крысиные дела', desc: 'Помоги трактирщику в погребе.' },
          { id: 'quest-ring', title: 'Потерянное кольцо', desc: 'Найди кольцо на восточной тропе.' }
        ]
        result = { ok: true, quests: qs }
        actions.push({ type: 'give_quests', payload: qs })
      }

      if (name === 'set_waypoint') {
        const wp = { x: args.x | 0, y: args.y | 0, note: String(args.note || '') }
        result = { ok: true, waypoint: wp }
        actions.push({ type: 'set_waypoint', payload: wp })
      }

      if (name === 'spawn_item') {
        const it = { id: 'it-' + Math.random().toString(36).slice(2, 8), x: args.x | 0, y: args.y | 0, kind: String(args.kind || 'gold') }
        result = { ok: true, item: it }
        actions.push({ type: 'place_item', payload: it })
      }

      if (name === 'spawn_enemy') {
        const en = { id: 'en-' + Math.random().toString(36).slice(2, 8), x: args.x | 0, y: args.y | 0, kind: String(args.kind || 'rat'), stats: { hp: args?.stats?.hp ?? 5, atk: args?.stats?.atk ?? 1 } }
        result = { ok: true, enemy: en }
        actions.push({ type: 'spawn_enemy', payload: en })
      }

      if (name === 'spawn_npc') {
        const nnpc = { id: 'npc-' + Math.random().toString(36).slice(2, 8), x: args.x | 0, y: args.y | 0, name: String(args.name || 'NPC'), role: args.role || '', persona: args.persona || '' }
        result = { ok: true, npc: nnpc }
        actions.push({ type: 'spawn_npc', payload: nnpc })
      }

      if (name === 'modify_tiles') {
        const changes = Array.isArray(args.changes) ? args.changes.map(c => ({ x: c.x|0, y: c.y|0, tile: c.tile|0 })) : []
        result = { ok: true, applied: changes.length, note: args.note || '' }
        actions.push({ type: 'modify_tiles', payload: { changes, note: args.note || '' } })
      }

      if (name === 'offer_replies') {
        const options = (args.options || []).map((o, i) => ({ id: String(o.id || `opt${i+1}`), text: String(o.text || '...') }))
        result = { ok: true, options }
        actions.push({ type: 'dialogue_options', payload: options })
      }

      if (name === 'create_map') {
        result = { ok: false, error: 'map change disabled in dialog' }
      }

      if (result) tool_outputs.push({ tool_call_id: call.id, output: JSON.stringify(result) })
    }

    if (tool_outputs.length) {
      response = await openai.responses.create({
        model,
        input: [{ role: 'system', content: 'Реплика NPC после применения инструментов. Коротко.' }],
        tool_outputs
      })
    }

    const text = response.output_text || (npc?.name || 'NPC') + ' молча кивает.'
    res.json({ text, actions })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'agent failed' })
  }
})

/** ------------------------------------------------------------------*/
app.listen(3001, () => console.log('API on http://localhost:3001'))
