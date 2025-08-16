// server.js — продовый сервер для iso-rpg (Ollama/OpenAI + статика из dist)
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

// ─────────────────────────  базовые вещи  ─────────────────────────
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3001
const PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase()

// CORS: по умолчанию открыт. Можно ограничить через CORS_ORIGINS="http://localhost:5173,https://your.app"
const ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const app = express()
app.use(express.json())
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ORIGINS.length === 0 || ORIGINS.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  }
}))

// ─────────────────────────  провайдеры LLM  ─────────────────────────
let openai = null
if (PROVIDER === 'openai') {
  const { default: OpenAI } = await import('openai')
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

const OLLAMA_URL   = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b'

// ─────────────────────────  хелперы  ─────────────────────────
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

async function ollamaChat(system, user, temperature = 0.8, model = OLLAMA_MODEL) {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role:'system', content: system },
        { role:'user',   content: user }
      ],
      options: { temperature },
      stream: false
    })
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '')
    throw new Error(`Ollama error ${resp.status}: ${txt.slice(0,200)}`)
  }
  const data = await resp.json()
  return data?.message?.content || ''
}

function applyActionToWorld(a, world, out) {
  if (!a) return
  if (a.type === 'create_map') {
    const { w,h,rows } = a.payload || {}
    if (Number.isInteger(w) && Number.isInteger(h) && Array.isArray(rows) && rows.length===h && rows.every(s=>typeof s==='string' && s.length===w)) {
      world.map = { w,h,rows, legend: world.map.legend }
      out.push({ type:'create_map', payload:{ w,h,rows } })
    }
  }
  if (a.type === 'spawn_npc') {
    const p = a.payload || {}
    const npc = { id: p.id || ('npc-'+Math.random().toString(36).slice(2,8)), x:p.x|0, y:p.y|0, name:String(p.name||'NPC'), role:p.role||'', persona:p.persona||'' }
    world.npcs.push(npc); out.push({ type:'spawn_npc', payload:npc })
  }
  if (a.type === 'spawn_enemy') {
    const p = a.payload || {}
    const en = { id: p.id || ('en-'+Math.random().toString(36).slice(2,8)), x:p.x|0, y:p.y|0, kind:String(p.kind||'rat'), stats: p.stats || { hp:5, atk:1 } }
    world.enemies.push(en); out.push({ type:'spawn_enemy', payload:en })
  }
  if (a.type === 'place_item') {
    const p = a.payload || {}
    const it = { id: p.id || ('it-'+Math.random().toString(36).slice(2,8)), x:p.x|0, y:p.y|0, kind:String(p.kind||'gold') }
    world.items.push(it); out.push({ type:'place_item', payload:it })
  }
  if (a.type === 'set_waypoint') {
    const p = a.payload || {}
    world.waypoint = { x:p.x|0, y:p.y|0, note:String(p.note||'') }
    out.push({ type:'set_waypoint', payload:world.waypoint })
  }
  if (a.type === 'give_quests') {
    const qs = Array.isArray(a.payload) ? a.payload.map(q => ({
      id:String(q.id || ('q-'+Math.random().toString(36).slice(2,8))),
      title:String(q.title||'Квест'),
      desc:String(q.desc||'')
    })) : []
    out.push({ type:'give_quests', payload:qs })
  }
  if (a.type === 'modify_tiles') {
    const changes = (a.payload?.changes||[]).map(c=>({ x:c.x|0, y:c.y|0, tile:c.tile|0 }))
    out.push({ type:'modify_tiles', payload:{ changes, note:a.payload?.note||'' } })
  }
  if (a.type === 'dialogue_options') {
    const opts = (a.payload||[]).map((o,i)=>({ id:String(o.id||`opt${i+1}`), text:String(o.text||'...') }))
    out.push({ type:'dialogue_options', payload:opts })
  }
}

// ── OpenAI helpers (Responses API) ──
const openaiTools = [
  { type:'function', name:'create_map', description:'Создай карту',
    parameters:{ type:'object', properties:{
      w:{type:'integer',minimum:8,maximum:48},
      h:{type:'integer',minimum:8,maximum:48},
      legend:{type:'object',additionalProperties:{type:'string'}},
      rows:{type:'array',items:{type:'string'}}
    }, required:['w','h','rows'] } },
  { type:'function', name:'spawn_npc', description:'Создай NPC',
    parameters:{ type:'object', properties:{
      x:{type:'integer',minimum:0}, y:{type:'integer',minimum:0},
      name:{type:'string'}, role:{type:'string'}, persona:{type:'string'}
    }, required:['x','y','name'] } },
  { type:'function', name:'spawn_enemy', description:'Создай врага',
    parameters:{ type:'object', properties:{
      x:{type:'integer',minimum:0}, y:{type:'integer',minimum:0},
      kind:{type:'string'},
      stats:{type:'object',properties:{hp:{type:'integer',minimum:1}, atk:{type:'integer',minimum:1}}}
    }, required:['x','y','kind'] } },
  { type:'function', name:'place_item', description:'Положи предмет',
    parameters:{ type:'object', properties:{ x:{type:'integer'}, y:{type:'integer'}, kind:{type:'string'} },
    required:['x','y','kind'] } },
  { type:'function', name:'set_waypoint', description:'Поставь метку',
    parameters:{ type:'object', properties:{ x:{type:'integer'}, y:{type:'integer'}, note:{type:'string'} },
    required:['x','y'] } },
  { type:'function', name:'give_quests', description:'Предложи до 3 квестов',
    parameters:{ type:'object', properties:{ hint:{type:'string'} } } },
  { type:'function', name:'modify_tiles', description:'Измени тайлы (мост/дверь/тропа)',
    parameters:{ type:'object', properties:{
      changes:{ type:'array', items:{ type:'object', properties:{ x:{type:'integer'}, y:{type:'integer'}, tile:{type:'integer'} },
      required:['x','y','tile'] } },
      note:{type:'string'}
    }, required:['changes'] } },
  { type:'function', name:'offer_replies', description:'2–4 варианта ответа',
    parameters:{ type:'object', properties:{
      options:{ type:'array', items:{ type:'object', properties:{ id:{type:'string'}, text:{type:'string'} }, required:['text'] } }
    }, required:['options'] } }
]

function extractToolCallsFromOpenAI(resp) {
  const blocks = (resp.output ?? resp.output_array ?? resp.content ?? [])
  const arr = Array.isArray(blocks) ? blocks : []
  const out = []
  for (const b of arr) {
    if (b?.type === 'tool_call') out.push(b)
    if (Array.isArray(b?.content)) for (const c of b.content) if (c?.type === 'tool_call') out.push(c)
  }
  return out
}

// ─────────────────────────  API  ─────────────────────────

// Health-check (помогает диагностировать провайдера)
app.get('/api/llm-health', async (req, res) => {
  try {
    if (PROVIDER === 'openai') {
      const r = await openai.responses.create({ model: 'gpt-4o-mini', input:[{ role:'user', content:'ping' }], max_output_tokens: 5 })
      return res.json({ provider:'openai', ok:true, text:r.output_text?.slice(0,50)||'' })
    } else {
      const r = await fetch(`${OLLAMA_URL}/api/tags`)
      return res.json({ provider:'ollama', ok:r.ok })
    }
  } catch (e) {
    return res.status(500).json({ provider: PROVIDER, ok:false, error: String(e).slice(0,200) })
  }
})

// Новая игра: карта + сущности + вступление
app.post('/api/newgame', async (req, res) => {
  try {
    const { model = 'gpt-4o-mini', size = { w:24, h:24 }, themeHint = 'лесная поляна у трактира' } = req.body
    const world = { map:{ w:size.w, h:size.h, legend:{'0':'grass','1':'wall','2':'water'}, rows:[] }, npcs:[], enemies:[], items:[], waypoint:null }
    const actions = []
    let intro = 'Вы пришли на поляну…'

    if (PROVIDER === 'openai') {
      let response = await openai.responses.create({
        model, tools: openaiTools, temperature: 0.8,
        input: [
          { role:'system', content: 'Ты — режиссёр стартовой локации RPG. Создай карту 24x24, 1–2 дружественных NPC, 1–3 врагов, 1–3 предмета и waypoint. Используй функции. Не ставь сущности на непроходимые тайлы.' },
          { role:'user', content: `Тема: ${themeHint}. Размер: ${size.w}x${size.h}.` }
        ]
      })

      for (let round=0; round<4; round++) {
        const calls = extractToolCallsFromOpenAI(response)
        if (!calls.length) break

        const tool_outputs = []
        for (const call of calls) {
          const name = call.name
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {})
          if (name === 'create_map')   applyActionToWorld({ type:'create_map',   payload: args }, world, actions)
          if (name === 'spawn_npc')    applyActionToWorld({ type:'spawn_npc',    payload: args }, world, actions)
          if (name === 'spawn_enemy')  applyActionToWorld({ type:'spawn_enemy',  payload: args }, world, actions)
          if (name === 'place_item')   applyActionToWorld({ type:'place_item',   payload: args }, world, actions)
          if (name === 'set_waypoint') applyActionToWorld({ type:'set_waypoint', payload: args }, world, actions)
          if (name === 'give_quests')  applyActionToWorld({ type:'give_quests',  payload: args.quests || [] }, world, actions)
          if (name === 'modify_tiles') applyActionToWorld({ type:'modify_tiles', payload:{ changes: args.changes||[], note: args.note||'' } }, world, actions)
          if (name === 'offer_replies')applyActionToWorld({ type:'dialogue_options', payload:(args.options||[]).map((o,i)=>({id:o.id||`opt${i+1}`, text:o.text})) }, world, actions)
          tool_outputs.push({ tool_call_id: call.id, output: JSON.stringify({ ok:true }) })
        }

        response = await openai.responses.create({
          model, input:[{ role:'system', content:'Короткая вводная для игрока.' }], tool_outputs
        })
      }
      intro = response.output_text || intro
    } else {
      const sys = [
        'You are an RPG worldbuilder. Return ONLY MINIFIED JSON:',
        '{"intro": string, "actions":[{"type":string,"payload":object}]}',
        'Allowed actions: "create_map","spawn_npc","spawn_enemy","place_item","set_waypoint","give_quests","modify_tiles","dialogue_options".',
        'For create_map: payload {"w":24,"h":24,"rows":[string x24 ...] length 24}, chars only "0","1","2".',
        'For modify_tiles: payload {"changes":[{"x":int,"y":int,"tile":0|1|2}],"note":string}.'
      ].join(' ')
      const usr = `Theme: ${themeHint}. Size: ${size.w}x${size.h}. Generate map + 1–2 friendly NPC + 1–3 enemies + 1–3 items + waypoint. No entities on walls/water.`
      const raw = await ollamaChat(sys, usr, 0.8, model)
      const json = extractJSON(raw)
      if (json?.actions) for (const a of json.actions) applyActionToWorld(a, world, actions)
      if (json?.intro) intro = String(json.intro)
    }

    res.json({ text:intro, world, actions })
  } catch (e) {
    console.error(e); res.status(500).json({ error:'newgame failed' })
  }
})

// Диалог с NPC + действия/варианты ответов
app.post('/api/agent', async (req, res) => {
  try {
    const { world, npc, history = [], playerMessage, model = 'gpt-4o-mini' } = req.body
    const actions = []
    let text = '...'

    if (PROVIDER === 'openai') {
      const hist = history.slice(-6).map(h => `${h.speaker === 'player' ? 'Player':'NPC'}: ${h.text}`).join('\n')
      let response = await openai.responses.create({
        model, tools: openaiTools, temperature: 0.9,
        input: [
          { role:'system', content: 'You are an in-world NPC. Reply briefly. Use tools when helpful. Almost always suggest 2–4 short reply options (offer_replies) after your line.' },
          { role:'user', content: `NPC: ${JSON.stringify({ name: npc?.name, role: npc?.role })}` },
          { role:'user', content: `World: ${JSON.stringify({
            map:{w:world?.map?.w,h:world?.map?.h},
            npcs:(world?.npcs||[]).map(n=>({name:n.name,x:n.x,y:n.y})).slice(0,6),
            enemies:(world?.enemies||[]).map(e=>({kind:e.kind,x:e.x,y:e.y})).slice(0,6),
            items:(world?.items||[]).slice(0,6)
          })}` },
          { role:'user', content: `Context:\n${hist || '—'}` },
          { role:'user', content: `Player: ${playerMessage}` }
        ]
      })

      const outs = []
      for (const call of extractToolCallsFromOpenAI(response)) {
        const name = call.name
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {})
        if (name === 'create_map')   actions.push({ type:'create_map',   payload: args })
        if (name === 'spawn_npc')    actions.push({ type:'spawn_npc',    payload: args })
        if (name === 'spawn_enemy')  actions.push({ type:'spawn_enemy',  payload: args })
        if (name === 'place_item')   actions.push({ type:'place_item',   payload: args })
        if (name === 'set_waypoint') actions.push({ type:'set_waypoint', payload: args })
        if (name === 'give_quests')  actions.push({ type:'give_quests',  payload: args.quests || [] })
        if (name === 'modify_tiles') actions.push({ type:'modify_tiles', payload:{ changes: args.changes||[], note: args.note||'' } })
        if (name === 'offer_replies')actions.push({ type:'dialogue_options', payload:(args.options||[]).map((o,i)=>({id:o.id||`opt${i+1}`, text:o.text})) })
        outs.push({ tool_call_id: call.id, output: JSON.stringify({ ok:true }) })
      }

      if (outs.length) {
        response = await openai.responses.create({
          model, input:[{ role:'system', content:'Short line after tools.' }], tool_outputs: outs
        })
      }
      text = response.output_text || text
    } else {
      const hist = history.slice(-6).map(h => `${h.speaker}: ${h.text}`).join('\n')
      const sys = [
        'You are an in-world NPC. Return ONLY MINIFIED JSON:',
        '{"assistant_text": string, "actions":[{"type":string,"payload":object}]}',
        'Allowed: "give_quests","set_waypoint","spawn_item","spawn_enemy","spawn_npc","modify_tiles","dialogue_options".',
        'Always include "dialogue_options" with 2–4 short replies.'
      ].join(' ')
      const usr = `NPC: ${npc?.name||'NPC'} (${npc?.role||''}). World: ${JSON.stringify({
        map:{w:world?.map?.w,h:world?.map?.h},
        npcs:(world?.npcs||[]).map(n=>({name:n.name,x:n.x,y:n.y})).slice(0,6),
        enemies:(world?.enemies||[]).map(e=>({kind:e.kind,x:e.x,y:e.y})).slice(0,6),
        items:(world?.items||[]).slice(0,6)
      })}\nContext:\n${hist || '—'}\nPlayer: ${playerMessage}`

      const raw = await ollamaChat(sys, usr, 0.9)
      const json = extractJSON(raw)
      text = String(json?.assistant_text || '...')
      for (const a of (json?.actions || [])) actions.push(a)
    }

    res.json({ text, actions })
  } catch (e) {
    console.error(e); res.status(500).json({ error:'agent failed' })
  }
})

// ─────────────────────────  статика из dist  ─────────────────────────
// (ставим ПОСЛЕ /api, чтобы не перехватывать их)
app.use(express.static(path.join(__dirname, 'dist')))
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')))

// ─────────────────────────  старт  ─────────────────────────
app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT} (provider: ${PROVIDER})`)
})

