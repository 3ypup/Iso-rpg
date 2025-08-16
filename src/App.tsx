// src/App.tsx — полная сборка с кликом для движения, ИИ-генерацией мира,
// ветвистым диалогом (варианты ответов) и динамическими инструментами (modify_tiles и др.)

import React, { useEffect, useRef, useState } from "react";

// ===== Типы =====
type Tile = 0 | 1 | 2; // 0=трава, 1=стена, 2=вода
type Vec2 = { x: number; y: number };

type NPC = { id: string; x: number; y: number; name: string; role?: string; persona?: string };
type Enemy = { id: string; x: number; y: number; kind: string; stats?: { hp: number; atk: number } };
type Item = { id: string; x: number; y: number; kind: string };

type DialogueTurn = { speaker: "player" | "npc" | "system"; text: string };
type ReplyOption = { id: string; text: string };

// ===== Константы/палитра =====
const TILE_W = 64;
const TILE_H = 32;

const palette = {
  grass: "linear-gradient(135deg,#7dbf73 0%,#6ab368 100%)",
  wall: "linear-gradient(135deg,#6b6b6b 0%,#4a4a4a 100%)",
  water: "linear-gradient(135deg,#7cc5ff 0%,#3aa0ee 100%)",
};

// ===== Утилиты =====
function isoToScreen(x: number, y: number): { left: number; top: number } {
  return { left: (x - y) * (TILE_W / 2), top: (x + y) * (TILE_H / 2) };
}
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function toMatrix(rows: string[]): Tile[][] {
  return rows.map((row) => Array.from(row).map((ch) => (ch === "1" ? 1 : ch === "2" ? 2 : 0) as Tile));
}
function fromMatrix(m: Tile[][]): string[] {
  return m.map((r) => r.map((t) => (t === 1 ? "1" : t === 2 ? "2" : "0")).join(""));
}
function generateMap(w = 24, h = 24): Tile[][] {
  const m: Tile[][] = [];
  for (let y = 0; y < h; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < w; x++) {
      let t: Tile = 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) t = 1;
      else if (Math.random() < 0.08) t = 1;
      else if (Math.random() < 0.03) t = 2;
      row.push(t);
    }
    m.push(row);
  }
  if (h > 13 && w > 13) {
    m[12][12] = 0;
    m[12][13] = 0;
    m[13][12] = 0;
    m[13][13] = 0;
  }
  return m;
}
function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function App() {
  // ===== Модель ИИ =====
  const [model, setModel] = useState("gpt-4o-mini");

  // ===== Мир =====
  const [map, setMap] = useState<Tile[][]>(() => generateMap());
  const MAP_H = map.length;
  const MAP_W = map[0]?.length ?? 0;

  const [player, setPlayer] = useState<Vec2>({ x: 5, y: 5 });
  const [camera, setCamera] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [npcs, setNpcs] = useState<NPC[]>([
    { id: "npc-demo", x: 13, y: 13, name: "Гридд", role: "торговец", persona: "жадный, но обаятельный" },
  ]);
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [waypoint, setWaypoint] = useState<{ x: number; y: number; note?: string } | null>(null);

  // ===== Квесты/лог/диалог =====
  const [quests, setQuests] = useState<
    Array<{ id: string; title: string; desc: string; status: "new" | "active" | "done" }>
  >([]);
  const [log, setLog] = useState<string[]>(["Вы очнулись на поляне."]);
  const [npcThinking, setNpcThinking] = useState(false);
  const [npcReply, setNpcReply] = useState<string>("");

  // ===== Маршрут движения (клик) =====
  const [path, setPath] = useState<Vec2[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);

  // ===== Диалог с вариантами =====
  const [currentNpcId, setCurrentNpcId] = useState<string | null>(null);
  const [dialogueOptions, setDialogueOptions] = useState<ReplyOption[]>([]);
  const [historyByNpc, setHistoryByNpc] = useState<Record<string, DialogueTurn[]>>({});

  // ===== Камера центрируется на игроке =====
  useEffect(() => {
    const { left, top } = isoToScreen(player.x, player.y);
    if (viewportRef.current) {
      const vw = viewportRef.current.clientWidth;
      const vh = viewportRef.current.clientHeight;
      setCamera({ x: vw / 2 - left, y: vh / 2 - top - TILE_H });
    }
  }, [player.x, player.y, map]);

  // ===== Шаг по пути (каждые 100мс) =====
  useEffect(() => {
    if (!path.length) return;
    const id = window.setInterval(() => {
      setPath((p) => {
        if (!p.length) return p;
        const [next, ...rest] = p;
        setPlayer(next);
        return rest;
      });
    }, 100);
    return () => clearInterval(id);
  }, [path.length]);

  // ===== Вспомогательные на клиенте =====
  function pushLog(s: string) {
    setLog((l) => [s, ...l].slice(0, 20));
  }
  function tileAt(p: Vec2): Tile {
    return map[p.y]?.[p.x] ?? 1;
  }
  function passable(v: Vec2) {
    return tileAt(v) === 0;
  }
  function neighbors(v: Vec2): Vec2[] {
    const out: Vec2[] = [];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dy] of dirs) {
      const nx = clamp(v.x + dx, 0, MAP_W - 1);
      const ny = clamp(v.y + dy, 0, MAP_H - 1);
      const n = { x: nx, y: ny };
      if (passable(n)) out.push(n);
    }
    return out;
  }
  function manhattan(a: Vec2, b: Vec2) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  function findPath(start: Vec2, goal: Vec2): Vec2[] {
    if (!passable(goal)) return [];
    const key = (p: Vec2) => `${p.x},${p.y}`;
    const open: Vec2[] = [start];
    const came = new Map<string, string>();
    const g = new Map<string, number>([[key(start), 0]]);
    const f = new Map<string, number>([[key(start), manhattan(start, goal)]]);
    while (open.length) {
      open.sort((a, b) => (f.get(key(a)) ?? 1e9) - (f.get(key(b)) ?? 1e9));
      const current = open.shift()!;
      if (current.x === goal.x && current.y === goal.y) {
        const path: Vec2[] = [];
        let curK = key(goal);
        while (curK !== key(start)) {
          const [x, y] = curK.split(",").map(Number);
          path.unshift({ x, y });
          curK = came.get(curK)!;
        }
        return path;
      }
      for (const nb of neighbors(current)) {
        const nk = key(nb);
        const tentative = (g.get(key(current)) ?? 1e9) + 1;
        if (tentative < (g.get(nk) ?? 1e9)) {
          came.set(nk, key(current));
          g.set(nk, tentative);
          f.set(nk, tentative + manhattan(nb, goal));
          if (!open.find((p) => p.x === nb.x && p.y === nb.y)) open.push(nb);
        }
      }
    }
    return [];
  }
  function screenToTile(px: number, py: number): Vec2 {
    if (!viewportRef.current) return { x: player.x, y: player.y };
    const rect = viewportRef.current.getBoundingClientRect();
    const L = px - rect.left - camera.x;
    const T = py - rect.top - camera.y;
    const xf = L / TILE_W + T / TILE_H;
    const yf = T / TILE_H - L / TILE_W;
    const x = clamp(Math.floor(xf), 0, MAP_W - 1);
    const y = clamp(Math.floor(yf), 0, MAP_H - 1);
    return { x, y };
  }
  function pushNpcHistory(npcId: string, turn: DialogueTurn) {
    setHistoryByNpc((h) => {
      const arr = h[npcId] ? [...h[npcId], turn] : [turn];
      return { ...h, [npcId]: arr.slice(-12) };
    });
  }

  // ===== Применение действий ИИ на клиенте =====
  function applyAction(a: any) {
    if (!a) return;

    if (a.type === "set_waypoint") setWaypoint(a.payload);

    if (a.type === "give_quests") {
      const qs = (a.payload ?? []).map((q: any) => ({
        id: String(q.id ?? crypto.randomUUID()),
        title: String(q.title ?? "Квест"),
        desc: String(q.desc ?? "Описание отсутствует"),
        status: "new" as const,
      }));
      setQuests((prev) => [...qs, ...prev].slice(0, 6));
    }

    if (a.type === "spawn_npc") setNpcs((prev) => [...prev, a.payload]);

    if (a.type === "spawn_enemy") setEnemies((prev) => [...prev, a.payload]);

    if (a.type === "place_item") setItems((prev) => [...prev, a.payload]);

    if (a.type === "create_map") setMap(toMatrix(a.payload.rows || []));

    if (a.type === "dialogue_options") {
      setDialogueOptions(a.payload ?? []);
    }

    if (a.type === "modify_tiles") {
      const changes = a.payload?.changes ?? [];
      setMap((prev) => {
        const H = prev.length,
          W = prev[0]?.length ?? 0;
        const clone = prev.map((r) => r.slice());
        for (const c of changes) {
          if (c && c.y >= 0 && c.y < H && c.x >= 0 && c.x < W) {
            const t = c.tile === 1 ? 1 : c.tile === 2 ? 2 : 0;
            clone[c.y][c.x] = t as Tile;
          }
        }
        return clone;
      });
      if (a.payload?.note) pushLog(a.payload.note);
    }
  }

  // ===== Новый мир от ИИ =====
  async function newGame() {
    try {
      const resp = await fetch("/api/newgame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, size: { w: 24, h: 24 }, themeHint: "лесная поляна у трактира" }),
      });
      const data = await resp.json();
      if (data?.world) {
        const rows: string[] = data.world.map.rows?.length ? data.world.map.rows : fromMatrix(generateMap(24, 24));
        const m = toMatrix(rows);
        setMap(m);
        setPlayer({ x: 2, y: 2 });
        setNpcs(data.world.npcs ?? []);
        setEnemies(data.world.enemies ?? []);
        setItems(data.world.items ?? []);
        setWaypoint(data.world.waypoint ?? null);
        setQuests([]);
        setNpcReply("");
        setPath([]);
        setDialogueOptions([]);
        setHistoryByNpc({});
        pushLog("Создана новая локация ИИ.");
        if (data.text) pushLog("Вступление: " + data.text);
      }
      for (const a of data.actions ?? []) applyAction(a);
    } catch {
      pushLog("Не удалось создать мир.");
    }
  }

  // ===== Диалог с NPC =====
  async function talkToNearestNPC(initialMessage?: string) {
    const near = npcs.find((n) => Math.abs(n.x - player.x) + Math.abs(n.y - player.y) <= 1);
    if (!near) {
      pushLog("Рядом нет NPC.");
      return;
    }

    setCurrentNpcId(near.id);
    setNpcThinking(true);
    setDialogueOptions([]);

    if (initialMessage) pushNpcHistory(near.id, { speaker: "player", text: initialMessage });

    try {
      const worldPayload = {
        map: { w: map[0]?.length ?? 0, h: map.length },
        npcs,
        enemies,
        items,
      };
      const resp = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world: worldPayload,
          npc: { id: near.id, name: near.name, role: near.role },
          history: historyByNpc[near.id] ?? [],
          playerMessage: initialMessage ?? "Привет! Есть работа или куда идти?",
          model,
        }),
      });
      const data = await resp.json();
      const text = data.text ?? "";
      setNpcReply(text);
      pushNpcHistory(near.id, { speaker: "npc", text });
      pushLog(`${near.name}: ${truncate(text, 140)}`);
      for (const a of data.actions ?? []) applyAction(a);
    } catch {
      pushLog("Проблема связи с ИИ.");
    } finally {
      setNpcThinking(false);
    }
  }

  async function chooseReply(opt: ReplyOption) {
    if (!currentNpcId) return;
    const npc = npcs.find((n) => n.id === currentNpcId);
    if (!npc) return;

    setDialogueOptions([]);
    pushNpcHistory(currentNpcId, { speaker: "player", text: opt.text });
    setNpcThinking(true);

    try {
      const worldPayload = { map: { w: map[0]?.length ?? 0, h: map.length }, npcs, enemies, items };
      const resp = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          world: worldPayload,
          npc: { id: npc.id, name: npc.name, role: npc.role },
          history: historyByNpc[currentNpcId] ?? [],
          playerMessage: opt.text,
          model,
        }),
      });
      const data = await resp.json();
      const text = data.text ?? "";
      setNpcReply(text);
      pushNpcHistory(currentNpcId, { speaker: "npc", text });
      pushLog(`${npc.name}: ${truncate(text, 140)}`);
      for (const a of data.actions ?? []) applyAction(a);
    } catch {
      pushLog("Проблема связи с ИИ.");
    } finally {
      setNpcThinking(false);
    }
  }

  // ===== Рендер тайлов =====
  const tiles: JSX.Element[] = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const { left, top } = isoToScreen(x, y);
      const t = map[y][x];
      const bg = t === 0 ? palette.grass : t === 1 ? palette.wall : palette.water;
      tiles.push(
        <div
          key={`t-${x}-${y}`}
          className="absolute"
          style={{ left: camera.x + left, top: camera.y + top, width: TILE_W, height: TILE_H }}
        >
          <div
            className="w-full h-full"
            style={{
              transform: "skewY(26.565deg) scaleY(0.5) rotate(45deg)",
              transformOrigin: "center",
              background: bg,
              border: "1px solid rgba(0,0,0,0.15)",
              boxShadow: "0 2px 4px rgba(0,0,0,0.25)",
              borderRadius: 4,
            }}
          />
        </div>
      );
    }
  }

  // ===== Рендер сущностей =====
  const entityDots: JSX.Element[] = [];
  for (const n of npcs) {
    const p = isoToScreen(n.x, n.y);
    entityDots.push(
      <div
        key={n.id}
        className="absolute"
        style={{ left: camera.x + p.left, top: camera.y + p.top - 28, width: TILE_W, height: TILE_H }}
      >
        <div className="absolute -translate-x-1/2 left-1/2 -top-6 text-[10px] bg-neutral-800/85 px-1.5 py-0.5 rounded">
          {n.name}
        </div>
        <div className="mx-auto w-6 h-10 rounded-b-full rounded-t-md bg-amber-500 shadow-lg border border-amber-700 flex items-center justify-center text-neutral-900 font-bold">
          $
        </div>
      </div>
    );
  }
  for (const e of enemies) {
    const p = isoToScreen(e.x, e.y);
    entityDots.push(
      <div key={e.id} className="absolute" style={{ left: camera.x + p.left, top: camera.y + p.top - 22 }}>
        <div className="w-5 h-5 rounded-full border border-red-700 bg-red-500 shadow flex items-center justify-center text-[10px]">
          !
        </div>
      </div>
    );
  }
  for (const it of items) {
    const p = isoToScreen(it.x, it.y);
    entityDots.push(
      <div key={it.id} className="absolute" style={{ left: camera.x + p.left, top: camera.y + p.top - 18 }}>
        <div className="w-3 h-3 rounded-full border border-amber-600 shadow bg-amber-300" title={it.kind} />
      </div>
    );
  }
  if (waypoint) {
    const p = isoToScreen(waypoint.x, waypoint.y);
    entityDots.push(
      <div key="wp" className="absolute" style={{ left: camera.x + p.left, top: camera.y + p.top - 34 }}>
        <div className="w-0 h-0 border-l-4 border-r-4 border-b-8 border-l-transparent border-r-transparent border-b-yellow-400 mx-auto" />
        {waypoint.note && (
          <div className="text-[10px] bg-yellow-400 text-neutral-900 px-1 rounded mt-0.5">{waypoint.note}</div>
        )}
      </div>
    );
  }

  // ===== Позиция игрока =====
  const plPos = isoToScreen(player.x, player.y);

  // ===== JSX =====
  return (
    <div className="w-full h-full bg-neutral-900 text-neutral-100">
      {/* Верхняя панель */}
      <div className="flex gap-3 p-3 items-center">
        <div className="text-xl font-semibold">Isometric RPG — AI Sandbox</div>
        <div className="text-sm opacity-80">Клик мышью — идти • Подойди к NPC и поговори</div>
        <button
          onClick={newGame}
          className="ml-2 text-sm px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500"
        >
          Новая игра (ИИ)
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs opacity-70">Модель:</span>
          <select
            className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option>gpt-4o-mini</option>
            <option>gpt-4o</option>
            <option>gpt-3.5-turbo</option>
          </select>
        </div>
      </div>

      {/* Поле игры */}
      <div
        ref={viewportRef}
        onClick={(e) => {
          const target = screenToTile(e.clientX, e.clientY);
          const npcHit = npcs.find((n) => n.x === target.x && n.y === target.y);
          if (npcHit) {
            const p = findPath(player, { x: npcHit.x, y: npcHit.y });
            if (p.length > 1) setPath(p.slice(0, -1));
            else talkToNearestNPC();
            return;
          }
          const p = findPath(player, target);
          if (p.length) setPath(p);
          else pushLog("Туда не пройти.");
        }}
        className="relative w-full h-[70vh] overflow-hidden rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-800 to-neutral-900"
      >
        {tiles}
        {entityDots}

        {/* Игрок */}
        <div
          className="absolute"
          style={{ left: camera.x + plPos.left, top: camera.y + plPos.top - 24, width: TILE_W, height: TILE_H }}
        >
          <div className="mx-auto w-6 h-10 rounded-b-full rounded-t-md bg-sky-300 shadow-lg border border-sky-600" />
        </div>
      </div>

      {/* Нижняя панель */}
      <div className="grid grid-cols-3 gap-3 p-3">
        {/* Журнал */}
        <div className="col-span-1 rounded-2xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="font-semibold mb-2">Журнал</div>
          <div className="space-y-2 max-h-56 overflow-auto pr-1">
            {quests.length === 0 && (
              <div className="text-sm opacity-70">Попросите задание у ближайшего NPC.</div>
            )}
            {quests.map((q) => (
              <div key={q.id} className="text-sm bg-neutral-800/60 rounded p-2">
                <div className="font-medium">{q.title}</div>
                <div className="opacity-80">{q.desc}</div>
                <div className="mt-1 text-xs uppercase tracking-wide opacity-60">{q.status}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Диалог */}
        <div className="col-span-2 rounded-2xl border border-neutral-800 p-3 bg-neutral-900/60">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-semibold">Диалог</div>
            {npcThinking && <div className="text-xs opacity-70 animate-pulse">думает…</div>}
            <button
              className="ml-auto text-sm px-3 py-1 rounded bg-neutral-800 border border-neutral-700 hover:bg-neutral-700"
              onClick={() => talkToNearestNPC()}
            >
              Поговорить
            </button>
          </div>

          <div className="h-40 overflow-auto text-sm whitespace-pre-wrap">
            {npcReply || <span className="opacity-70">Подойдите к NPC и нажмите «Поговорить».</span>}
          </div>

          {/* Варианты ответов */}
          {dialogueOptions.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {dialogueOptions.map((o) => (
                <button
                  key={o.id}
                  onClick={() => chooseReply(o)}
                  className="text-sm px-3 py-2 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-left"
                >
                  {o.text}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3">
            <div className="font-medium mb-1">События</div>
            <div className="space-y-1 max-h-24 overflow-auto text-xs opacity-80">
              {log.map((l, i) => (
                <div key={i}>• {l}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
