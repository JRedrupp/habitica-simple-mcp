// Habitica MCP: single-file Cloudflare Worker, no dependencies.
// Paste this whole file into the Cloudflare dashboard's "Edit code" editor.
//
// Secrets to add under Settings -> Variables and Secrets:
//   HABITICA_USER_ID, HABITICA_API_TOKEN, MCP_SECRET
// Your MCP endpoint is then: https://<worker>.<subdomain>.workers.dev/mcp/<MCP_SECRET>

const DEFAULT_API = "https://habitica.com/api/v3";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const enc = encodeURIComponent;

// ------------------------------------------------------------ Habitica client

async function habitica(env, method, path, body) {
  const res = await fetch((env.HABITICA_API_BASE || DEFAULT_API) + path, {
    method,
    headers: {
      "x-api-user": env.HABITICA_USER_ID,
      "x-api-key": env.HABITICA_API_TOKEN,
      // Habitica asks integrations to identify themselves: <author id>-<app name>
      "x-client": env.HABITICA_USER_ID + "-ClaudeMCP",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(
      "Habitica " + res.status + ": " + (json.message || json.error || "request failed"),
    );
  }
  return json.data;
}

const DAY_KEYS = {
  mon: "m",
  tue: "t",
  wed: "w",
  thu: "th",
  fri: "f",
  sat: "s",
  sun: "su",
};

// The raw Habitica task object is huge, so keep only what's useful.
function slimTask(t) {
  const repeatDays = t.repeat
    ? Object.keys(DAY_KEYS).filter((d) => t.repeat[DAY_KEYS[d]])
    : undefined;
  return {
    id: t.id,
    type: t.type,
    text: t.text,
    notes: t.notes || undefined,
    priority: t.priority,
    completed: t.completed,
    tags: t.tags && t.tags.length ? t.tags : undefined,
    isDue: t.isDue,
    streak: t.streak,
    schedule:
      t.type === "daily"
        ? {
            frequency: t.frequency,
            everyX: t.everyX,
            repeatDays,
            daysOfMonth: t.daysOfMonth && t.daysOfMonth.length ? t.daysOfMonth : undefined,
            startDate: t.startDate,
          }
        : undefined,
    date: t.date || undefined,
    up: t.up,
    down: t.down,
    counterUp: t.counterUp,
    counterDown: t.counterDown,
    value: t.type === "reward" ? t.value : undefined,
    checklist:
      t.checklist && t.checklist.length
        ? t.checklist.map((c) => ({
            id: c.id,
            text: c.text,
            completed: c.completed,
          }))
        : undefined,
  };
}

// Resolve a tag given either its id or its (case-insensitive) name.
async function resolveTag(env, nameOrId) {
  const tags = await habitica(env, "GET", "/tags");
  const wanted = String(nameOrId).trim().toLowerCase();
  const hit =
    tags.find((t) => t.id === nameOrId) ||
    tags.find((t) => String(t.name).toLowerCase() === wanted);
  if (!hit) {
    throw new Error(
      'No tag matching "' +
        nameOrId +
        '". Existing tags: ' +
        (tags.map((t) => t.name).join(", ") || "(none)"),
    );
  }
  return hit.id;
}

function applySchedule(body, a) {
  if (a.frequency) body.frequency = a.frequency;
  if (a.everyX !== undefined) body.everyX = a.everyX;
  if (a.startDate) body.startDate = a.startDate;
  if (a.daysOfMonth) body.daysOfMonth = a.daysOfMonth;
  if (a.repeatDays) {
    const repeat = {};
    for (const d of Object.keys(DAY_KEYS)) repeat[DAY_KEYS[d]] = a.repeatDays.includes(d);
    body.repeat = repeat;
  }
}

const round = (n, dp = 0) => (n === undefined ? undefined : Math.round(n * 10 ** dp) / 10 ** dp);

// -------------------------------------------------------------- JSON schemas

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const int = (description, extra = {}) => ({
  type: "integer",
  description,
  ...extra,
});
const bool = (description) => ({ type: "boolean", description });
const enm = (values, description) => ({
  type: typeof values[0] === "number" ? "number" : "string",
  enum: values,
  description,
});
const arr = (items, description) => ({ type: "array", items, description });
const obj = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
});

const PRIORITY = enm([0.1, 1, 1.5, 2], "Difficulty: 0.1 trivial, 1 easy, 1.5 medium, 2 hard");

const SCHEDULE = {
  frequency: enm(["daily", "weekly", "monthly", "yearly"], "Dailies: how the repeat cycle works"),
  everyX: int("Dailies: repeat every N days/weeks/months/years (default 1)", {
    minimum: 0,
    maximum: 9999,
  }),
  repeatDays: arr(
    enm(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    "Weekly dailies: which weekdays it is due",
  ),
  daysOfMonth: arr(
    int("Day of month", { minimum: 1, maximum: 31 }),
    "Monthly dailies: which dates it is due",
  ),
  startDate: str("Dailies: ISO date the schedule starts from, e.g. 2026-11-01"),
};

// Minimal validator covering the schema features used above.
function validate(schema, v, path) {
  if (schema.enum && !schema.enum.includes(v))
    return path + " must be one of " + schema.enum.join(", ");
  if ("const" in schema && v !== schema.const) return path + " must be " + schema.const;
  switch (schema.type) {
    case "string":
      if (typeof v !== "string") return path + " must be a string";
      if (schema.minLength && v.length < schema.minLength) return path + " must not be empty";
      break;
    case "number":
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v)) return path + " must be a number";
      if (schema.type === "integer" && !Number.isInteger(v)) return path + " must be an integer";
      if (schema.minimum !== undefined && v < schema.minimum)
        return path + " must be >= " + schema.minimum;
      if (schema.maximum !== undefined && v > schema.maximum)
        return path + " must be <= " + schema.maximum;
      break;
    case "boolean":
      if (typeof v !== "boolean") return path + " must be true or false";
      break;
    case "array":
      if (!Array.isArray(v)) return path + " must be a list";
      for (let i = 0; i < v.length; i++) {
        const e = validate(schema.items, v[i], path + "[" + i + "]");
        if (e) return e;
      }
      break;
    case "object":
      if (typeof v !== "object" || v === null || Array.isArray(v))
        return path + " must be an object";
      for (const k of schema.required || []) {
        if (v[k] === undefined) return "Missing required argument: " + k;
      }
      for (const [k, s] of Object.entries(schema.properties || {})) {
        if (v[k] !== undefined) {
          const e = validate(s, v[k], k);
          if (e) return e;
        }
      }
      break;
  }
  return null;
}

// --------------------------------------------------------------------- tools

const TOOLS = [];
const tool = (name, description, inputSchema, handler) =>
  TOOLS.push({ name, description, inputSchema, handler });

tool(
  "get_stats",
  "Get the player's profile and stats: level, HP, MP, XP, gold, class, and whether damage is paused (sleeping in the inn).",
  obj(),
  async (_a, env) => {
    const u = await habitica(env, "GET", "/user");
    const s = u.stats || {};
    return {
      name: u.profile && u.profile.name,
      class: s.class,
      level: s.lvl,
      hp: Math.round(s.hp) + "/" + s.maxHealth,
      mp: Math.round(s.mp) + "/" + s.maxMP,
      xp: Math.round(s.exp) + "/" + s.toNextLevel,
      gold: round(s.gp || 0, 2),
      damagePaused: Boolean(u.preferences && u.preferences.sleep),
    };
  },
);

tool(
  "list_tasks",
  "List tasks of one type. Dailies include whether they're due today (isDue). Optionally filter by tag.",
  obj(
    {
      type: enm(["habits", "dailys", "todos", "rewards", "completedTodos"], "Which list to fetch"),
      dueOnly: bool("For dailys: only return those due today and not yet done"),
      tag: str("Tag name or id to filter by"),
    },
    ["type"],
  ),
  async ({ type, dueOnly, tag }, env) => {
    let tasks = await habitica(env, "GET", "/tasks/user?type=" + type);
    if (type === "dailys" && dueOnly) tasks = tasks.filter((t) => t.isDue && !t.completed);
    if (tag) {
      const tagId = await resolveTag(env, tag);
      tasks = tasks.filter((t) => t.tags && t.tags.includes(tagId));
    }
    return tasks.map(slimTask);
  },
);

tool(
  "get_task",
  "Fetch a single task by id.",
  obj({ taskId: str("Task id") }, ["taskId"]),
  async ({ taskId }, env) => slimTask(await habitica(env, "GET", "/tasks/" + enc(taskId))),
);

tool(
  "create_task",
  "Create a habit, daily, to-do or reward. Dailies can be given a schedule (frequency, everyX, repeatDays, daysOfMonth, startDate).",
  obj(
    {
      type: enm(["habit", "daily", "todo", "reward"]),
      text: { type: "string", minLength: 1, description: "Task title" },
      notes: str("Notes"),
      priority: PRIORITY,
      dueDate: str("To-dos only: ISO date, e.g. 2026-11-05"),
      up: bool("Habits: has a + button (default true)"),
      down: bool("Habits: has a - button"),
      checklist: arr(str("Item text"), "To-dos/dailies: checklist item texts"),
      cost: num("Rewards: gold cost"),
      tags: arr(str("Tag"), "Tag names or ids to attach (must already exist)"),
      ...SCHEDULE,
    },
    ["type", "text"],
  ),
  async (a, env) => {
    const body = { type: a.type, text: a.text };
    if (a.notes) body.notes = a.notes;
    if (a.priority) body.priority = a.priority;
    if (a.dueDate && a.type === "todo") body.date = a.dueDate;
    if (a.type === "habit") {
      if (a.up !== undefined) body.up = a.up;
      if (a.down !== undefined) body.down = a.down;
    }
    if (a.checklist && a.checklist.length) body.checklist = a.checklist.map((t) => ({ text: t }));
    if (a.type === "reward" && a.cost !== undefined) body.value = a.cost;
    if (a.type === "daily") applySchedule(body, a);
    if (a.tags && a.tags.length)
      body.tags = await Promise.all(a.tags.map((t) => resolveTag(env, t)));
    return slimTask(await habitica(env, "POST", "/tasks/user", body));
  },
);

tool(
  "update_task",
  "Edit an existing task: title, notes, difficulty, due date, or (for dailies) its schedule.",
  obj(
    {
      taskId: str("Task id"),
      text: str("New title"),
      notes: str("New notes"),
      priority: PRIORITY,
      dueDate: str("To-dos only: ISO date"),
      ...SCHEDULE,
    },
    ["taskId"],
  ),
  async (a, env) => {
    const body = {};
    if (a.text !== undefined) body.text = a.text;
    if (a.notes !== undefined) body.notes = a.notes;
    if (a.priority !== undefined) body.priority = a.priority;
    if (a.dueDate !== undefined) body.date = a.dueDate;
    applySchedule(body, a);
    if (!Object.keys(body).length) throw new Error("Nothing to update");
    return slimTask(await habitica(env, "PUT", "/tasks/" + enc(a.taskId), body));
  },
);

tool(
  "score_task",
  "Score a task. For habits use direction up/down; for dailies and to-dos 'up' completes and 'down' un-completes; for rewards 'up' buys it.",
  obj(
    {
      taskId: str("Task id from list_tasks"),
      direction: enm(["up", "down"], "Default: up"),
    },
    ["taskId"],
  ),
  async ({ taskId, direction = "up" }, env) => {
    const r = await habitica(env, "POST", "/tasks/" + enc(taskId) + "/score/" + direction);
    return {
      hp: round(r.hp),
      mp: round(r.mp),
      exp: round(r.exp),
      gold: round(r.gp, 2),
      level: r.lvl,
      drop: r._tmp && r._tmp.drop && r._tmp.drop.dialog,
    };
  },
);
tool(
  "move_task",
  "Move a task within its list. Position 0 is the top; -1 is the bottom.",
  obj(
    {
      taskId: str("Task id"),
      position: int("0 = top, -1 = bottom, or a zero-based index"),
    },
    ["taskId", "position"],
  ),
  async ({ taskId, position }, env) => ({
    moved: true,
    newOrder: await habitica(env, "POST", "/tasks/" + enc(taskId) + "/move/to/" + position),
  }),
);

tool(
  "delete_task",
  "Permanently delete a task. This cannot be undone: ALWAYS ask the user to confirm the specific task first, and only then call with confirm=true.",
  obj(
    {
      taskId: str("Task id"),
      confirm: {
        type: "boolean",
        const: true,
        description: "Must be true; set only after the user has confirmed",
      },
    },
    ["taskId", "confirm"],
  ),
  async ({ taskId, confirm }, env) => {
    if (confirm !== true) throw new Error("Refusing to delete without confirm=true");
    await habitica(env, "DELETE", "/tasks/" + enc(taskId));
    return { deleted: taskId };
  },
);

tool(
  "score_checklist_item",
  "Tick or untick a checklist item on a to-do or daily.",
  obj({ taskId: str("Task id"), itemId: str("Checklist item id") }, ["taskId", "itemId"]),
  async ({ taskId, itemId }, env) =>
    slimTask(
      await habitica(env, "POST", "/tasks/" + enc(taskId) + "/checklist/" + enc(itemId) + "/score"),
    ),
);

tool(
  "checklist_item",
  "Add, rename or delete a checklist item on a to-do or daily. add needs text; update needs itemId and text; delete needs itemId.",
  obj(
    {
      taskId: str("Task id"),
      action: enm(["add", "update", "delete"]),
      itemId: str("Required for update and delete"),
      text: str("Required for add and update"),
    },
    ["taskId", "action"],
  ),
  async ({ taskId, action, itemId, text }, env) => {
    const base = "/tasks/" + enc(taskId) + "/checklist";
    if (action === "add") {
      if (!text) throw new Error("text is required for add");
      return slimTask(await habitica(env, "POST", base, { text }));
    }
    if (action === "update") {
      if (!itemId || !text) throw new Error("itemId and text are required for update");
      return slimTask(await habitica(env, "PUT", base + "/" + enc(itemId), { text }));
    }
    if (!itemId) throw new Error("itemId is required for delete");
    return slimTask(await habitica(env, "DELETE", base + "/" + enc(itemId)));
  },
);

tool("list_tags", "List all tags with their ids.", obj(), async (_a, env) =>
  (await habitica(env, "GET", "/tags")).map((t) => ({
    id: t.id,
    name: t.name,
  })),
);

tool(
  "create_tag",
  "Create a new tag.",
  obj({ name: { type: "string", minLength: 1, description: "Tag name" } }, ["name"]),
  async ({ name }, env) => {
    const t = await habitica(env, "POST", "/tags", { name });
    return { id: t.id, name: t.name };
  },
);

tool(
  "tag_task",
  "Add a tag to a task, or remove it. The tag can be given by name or id and must already exist (use create_tag first if not).",
  obj(
    {
      taskId: str("Task id"),
      tag: str("Tag name or id"),
      action: enm(["add", "remove"], "Default: add"),
    },
    ["taskId", "tag"],
  ),
  async ({ taskId, tag, action = "add" }, env) => {
    const tagId = await resolveTag(env, tag);
    return slimTask(
      await habitica(
        env,
        action === "add" ? "POST" : "DELETE",
        "/tasks/" + enc(taskId) + "/tags/" + enc(tagId),
      ),
    );
  },
);

tool(
  "set_sleep",
  "Pause or resume damage (Habitica's 'rest in the inn'). While paused, missed dailies don't hurt and no new due dates accrue. Useful when travelling or ill.",
  obj({ sleeping: bool("true = pause damage, false = resume") }, ["sleeping"]),
  async ({ sleeping }, env) => {
    // The API only offers a toggle, so read the current state first.
    const u = await habitica(env, "GET", "/user");
    const current = Boolean(u.preferences && u.preferences.sleep);
    if (current === sleeping) return { damagePaused: current, changed: false };
    const now = await habitica(env, "POST", "/user/sleep");
    return { damagePaused: Boolean(now), changed: true };
  },
);

tool(
  "buy_health_potion",
  "Buy a health potion (costs 25 gold, restores 15 HP).",
  obj(),
  async (_a, env) => {
    const r = await habitica(env, "POST", "/user/buy-health-potion");
    return { hp: round(r.hp), gold: round(r.gp, 2) };
  },
);

tool(
  "cast_spell",
  "Cast a class skill, e.g. 'fireball', 'healAll', 'toolsOfTrade', 'valorousPresence'. Costs MP. Skills aimed at a single task need targetId set to that task's id.",
  obj(
    {
      spellId: str("Skill key, e.g. fireball, healAll, protectAura"),
      targetId: str("Task id (or party member id) for targeted skills"),
    },
    ["spellId"],
  ),
  async ({ spellId, targetId }, env) => {
    const qs = targetId ? "?targetId=" + enc(targetId) : "";
    const r = await habitica(env, "POST", "/user/class/cast/" + enc(spellId) + qs);
    const s = (r && r.user && r.user.stats) || {};
    return { cast: spellId, mp: round(s.mp), hp: round(s.hp) };
  },
);

// ------------------------------------------------- MCP over HTTP (stateless)

const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id === undefined ? null : id,
  error: { code, message },
});
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const asText = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(msg && msg.id, -32600, "Invalid request");
  }
  // Responses from the client, or notifications, need no reply.
  if (msg.method === undefined) return null;
  const isNotification = msg.id === undefined || msg.id === null;
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(params && params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "habitica", version: "0.2.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === (params && params.name));
      if (!t) return rpcError(id, -32602, "Unknown tool: " + (params && params.name));
      const args = (params && params.arguments) || {};
      const problem = validate(t.inputSchema, args, "arguments");
      if (problem) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: problem }],
        });
      }
      try {
        const out = await t.handler(args, env);
        return rpcResult(id, {
          content: [{ type: "text", text: asText(out) }],
        });
      } catch (e) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        });
      }
    }
    default:
      return isNotification ? null : rpcError(id, -32601, "Method not found: " + method);
  }
}

// Constant-time-ish comparison so the secret can't be guessed by timing.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request, env) {
    const [root, secret] = new URL(request.url).pathname.split("/").filter(Boolean);
    if (
      root !== "mcp" ||
      !env.MCP_SECRET ||
      env.MCP_SECRET.length < 24 ||
      !secret ||
      !safeEqual(secret, env.MCP_SECRET)
    ) {
      return new Response("Not found", { status: 404 });
    }
    // Stateless JSON mode: only POST is used.
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(payload)) {
      const replies = (await Promise.all(payload.map((m) => handleMessage(m, env)))).filter(
        Boolean,
      );
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }
    const reply = await handleMessage(payload, env);
    return reply ? json(reply) : new Response(null, { status: 202 });
  },
};
