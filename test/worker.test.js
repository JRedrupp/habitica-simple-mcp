// Tests run the worker in-process with globalThis.fetch stubbed out as a fake Habitica.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import worker from "../worker.js";

const SECRET = "a".repeat(24);
const env = { MCP_SECRET: SECRET, HABITICA_USER_ID: "user-1", HABITICA_API_TOKEN: "token-1" };

const realFetch = globalThis.fetch;
let calls;
let routes;

// routes: "METHOD /path" -> data (or a function returning data / a Response)
function fakeHabitica(map) {
  routes = map;
}

beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = (init.method || "GET") + " " + u.pathname.replace(/^\/api\/v3/, "") + u.search;
    calls.push({
      key,
      url: String(url),
      headers: init.headers,
      body: init.body && JSON.parse(init.body),
    });
    const hit = routes[key];
    if (hit === undefined) throw new Error("unexpected Habitica call: " + key);
    const out = typeof hit === "function" ? hit() : hit;
    if (out instanceof Response) return out;
    return Response.json({ success: true, data: out });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (body, path = "/mcp/" + SECRET, e = env) =>
  worker.fetch(
    new Request("https://example.com" + path, { method: "POST", body: JSON.stringify(body) }),
    e,
  );
const rpc = async (method, params, id = 1) =>
  await (await post({ jsonrpc: "2.0", id, method, params })).json();
const callTool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r) => r.content[0].text;
const dataOf = (r) => JSON.parse(textOf(r));

describe("routing and auth", () => {
  it("404s on a wrong secret, wrong root, or too-short secret", async () => {
    assert.equal((await post({}, "/mcp/wrong")).status, 404);
    assert.equal((await post({}, "/other/" + SECRET)).status, 404);
    assert.equal((await post({}, "/mcp/short", { MCP_SECRET: "short" })).status, 404);
    assert.equal((await post({}, "/mcp/" + SECRET, {})).status, 404);
  });

  it("405s on non-POST", async () => {
    const res = await worker.fetch(new Request("https://example.com/mcp/" + SECRET), env);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  it("400s on malformed JSON", async () => {
    const res = await worker.fetch(
      new Request("https://example.com/mcp/" + SECRET, { method: "POST", body: "{nope" }),
      env,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  it("202s on notifications and handles batches", async () => {
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    const batch = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const replies = await batch.json();
    assert.deepEqual(
      replies.map((r) => r.id),
      [1, 2],
    );
  });

  it("rejects non-JSON-RPC payloads", async () => {
    const res = await (await post({ hello: "world" })).json();
    assert.equal(res.error.code, -32600);
  });
});

describe("MCP protocol", () => {
  it("negotiates the protocol version", async () => {
    const ok = await rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(ok.result.protocolVersion, "2024-11-05");
    const fallback = await rpc("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(fallback.result.protocolVersion, "2025-06-18");
    assert.equal(fallback.result.serverInfo.name, "habitica");
  });

  it("answers ping and rejects unknown methods", async () => {
    assert.deepEqual((await rpc("ping")).result, {});
    assert.equal((await rpc("nope")).error.code, -32601);
  });

  it("lists well-formed tools without leaking handlers", async () => {
    const { tools } = (await rpc("tools/list")).result;
    assert.equal(tools.length, 17);
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    for (const t of tools) {
      assert.ok(t.description, t.name);
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(t.handler, undefined, t.name);
    }
  });

  it("errors on unknown tools", async () => {
    assert.equal((await rpc("tools/call", { name: "nope" })).error.code, -32602);
  });
});

describe("argument validation", () => {
  const cases = [
    ["get_task", {}, /Missing required argument: taskId/],
    ["get_task", { taskId: 5 }, /taskId must be a string/],
    ["get_task_history", {}, /Missing required argument: taskId/],
    ["get_task_history", { taskId: "x", limit: 0 }, /limit must be >= 1/],
    ["list_tasks", { type: "bogus" }, /type must be one of/],
    ["create_task", { type: "todo", text: "" }, /must not be empty/],
    ["move_task", { taskId: "x", position: 1.5 }, /position must be an integer/],
    ["delete_task", { taskId: "x", confirm: false }, /confirm must be true/],
    ["set_sleep", { sleeping: "yes" }, /sleeping must be true or false/],
    ["create_task", { type: "todo", text: "t", tags: "a" }, /tags must be a list/],
  ];
  for (const [name, args, pattern] of cases) {
    it(name + " " + JSON.stringify(args), async () => {
      const r = await callTool(name, args);
      assert.equal(r.isError, true);
      assert.match(textOf(r), pattern);
      assert.equal(calls.length, 0, "must not reach Habitica");
    });
  }
});

describe("Habitica client", () => {
  it("sends credentials and honors HABITICA_API_BASE", async () => {
    fakeHabitica({ "GET /user": { stats: {}, profile: {} } });
    await callTool("get_stats", {});
    assert.match(calls[0].url, /^https:\/\/habitica\.com\/api\/v3\/user$/);
    assert.equal(calls[0].headers["x-api-user"], "user-1");
    assert.equal(calls[0].headers["x-api-key"], "token-1");
    assert.equal(calls[0].headers["x-client"], "user-1-ClaudeMCP");

    await post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_stats", arguments: {} } },
      "/mcp/" + SECRET,
      { ...env, HABITICA_API_BASE: "https://habitica.test/api/v3" },
    );
    assert.match(calls[1].url, /^https:\/\/habitica\.test\/api\/v3\/user$/);
  });

  it("surfaces Habitica errors as tool errors", async () => {
    fakeHabitica({
      "GET /tasks/missing": () =>
        Response.json({ success: false, message: "Task not found." }, { status: 404 }),
    });
    const r = await callTool("get_task", { taskId: "missing" });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), "Habitica 404: Task not found.");
  });

  it("copes with non-JSON error bodies", async () => {
    fakeHabitica({ "GET /tags": () => new Response("<html>", { status: 502 }) });
    const r = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tags", arguments: {} } },
      "/mcp/" + SECRET,
      { ...env, HABITICA_RETRY_BASE_MS: "0" },
    ).then(async (x) => (await x.json()).result);
    assert.equal(textOf(r), "Habitica 502: request failed");
    assert.equal(calls.length, 4);
  });

  describe("retries", () => {
    const fast = { ...env, HABITICA_RETRY_BASE_MS: "0" };
    const call = (name, args, e = fast) =>
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        "/mcp/" + SECRET,
        e,
      ).then(async (r) => (await r.json()).result);
    const flaky = (status, headers) => {
      let n = 0;
      return () =>
        n++ === 0
          ? new Response("{}", { status, headers })
          : Response.json({ success: true, data: [] });
    };

    it("retries a 429 then succeeds", async () => {
      fakeHabitica({ "GET /tags": flaky(429) });
      const r = await call("list_tags", {});
      assert.notEqual(r.isError, true);
      assert.equal(calls.length, 2);
    });

    it("retries a 5xx on GET", async () => {
      fakeHabitica({ "GET /tags": flaky(503) });
      await call("list_tags", {});
      assert.equal(calls.length, 2);
    });

    it("retries a network error on GET", async () => {
      let n = 0;
      fakeHabitica({
        "GET /tags": () => {
          if (n++ === 0) throw new TypeError("network down");
          return [];
        },
      });
      const r = await call("list_tags", {});
      assert.notEqual(r.isError, true);
      assert.equal(calls.length, 2);
    });

    it("gives up after 4 attempts", async () => {
      fakeHabitica({ "GET /tags": () => new Response("{}", { status: 429 }) });
      const r = await call("list_tags", {});
      assert.equal(r.isError, true);
      assert.match(textOf(r), /^Habitica 429/);
      assert.equal(calls.length, 4);
    });

    it("does not retry a POST on 5xx but does on 429", async () => {
      fakeHabitica({ "POST /tasks/user": () => new Response("{}", { status: 502 }) });
      const args = { type: "todo", text: "x" };
      await call("create_task", args);
      assert.equal(calls.length, 1);

      calls.length = 0;
      fakeHabitica({ "POST /tasks/user": flaky(429) });
      await call("create_task", args);
      assert.equal(calls.length, 2);
    });

    it("honors Retry-After and fails fast when it exceeds the cap", async () => {
      fakeHabitica({ "GET /tags": flaky(429, { "retry-after": "0.001" }) });
      await call("list_tags", {});
      assert.equal(calls.length, 2);

      calls.length = 0;
      fakeHabitica({ "GET /tags": flaky(429, { "retry-after": "60" }) });
      const r = await call("list_tags", {});
      assert.equal(r.isError, true);
      assert.equal(calls.length, 1);
    });
  });
});

const TAGS = [
  { id: "t1", name: "Work" },
  { id: "t2", name: "Home" },
];

describe("tools", () => {
  it("get_task_history returns recent ISO-dated entries", async () => {
    const history = [1, 2, 3].map((n) => ({
      date: Date.UTC(2026, 10, n),
      value: n + 0.123,
      completed: true,
    }));
    fakeHabitica({ "GET /tasks/t1": { id: "t1", text: "Run", type: "daily", history } });
    const d = dataOf(await callTool("get_task_history", { taskId: "t1", limit: 2 }));
    assert.equal(d.totalEntries, 3);
    assert.equal(d.entries.length, 2);
    assert.equal(d.entries[0].date, "2026-11-02T00:00:00.000Z");
    assert.equal(d.entries[1].value, 3.12);
    assert.ok(!("scoredUp" in d.entries[0]));
  });

  it("get_task_history handles tasks without history", async () => {
    fakeHabitica({ "GET /tasks/t2": { id: "t2", text: "Prize", type: "reward" } });
    const d = dataOf(await callTool("get_task_history", { taskId: "t2" }));
    assert.deepEqual(d.entries, []);
  });

  it("list_tasks includes dateCompleted for completed todos", async () => {
    fakeHabitica({
      "GET /tasks/user?type=completedTodos": [
        {
          id: "a",
          type: "todo",
          text: "x",
          completed: true,
          dateCompleted: "2026-11-01T10:00:00.000Z",
        },
      ],
    });
    const d = dataOf(await callTool("list_tasks", { type: "completedTodos" }));
    assert.equal(d[0].dateCompleted, "2026-11-01T10:00:00.000Z");
  });

  it("get_stats shapes the profile", async () => {
    fakeHabitica({
      "GET /user": {
        profile: { name: "Jake" },
        preferences: { sleep: true },
        stats: {
          class: "rogue",
          lvl: 12,
          hp: 41.6,
          maxHealth: 50,
          mp: 9.2,
          maxMP: 30,
          exp: 100.4,
          toNextLevel: 200,
          gp: 12.3456,
        },
      },
    });
    assert.deepEqual(dataOf(await callTool("get_stats", {})), {
      name: "Jake",
      class: "rogue",
      level: 12,
      hp: "42/50",
      mp: "9/30",
      xp: "100/200",
      gold: 12.35,
      damagePaused: true,
    });
  });

  it("list_tasks filters dueOnly and slims tasks", async () => {
    fakeHabitica({
      "GET /tasks/user?type=dailys": [
        {
          id: "a",
          type: "daily",
          text: "Run",
          isDue: true,
          completed: false,
          frequency: "weekly",
          repeat: { m: true, w: true, th: false },
        },
        { id: "b", type: "daily", text: "Read", isDue: true, completed: true },
        { id: "c", type: "daily", text: "Swim", isDue: false, completed: false },
      ],
    });
    const out = dataOf(await callTool("list_tasks", { type: "dailys", dueOnly: true }));
    assert.deepEqual(
      out.map((t) => t.id),
      ["a"],
    );
    assert.deepEqual(out[0].schedule.repeatDays, ["mon", "wed"]);
    assert.equal(out[0].notes, undefined);
  });

  it("list_tasks filters by tag name, and by id", async () => {
    fakeHabitica({
      "GET /tasks/user?type=todos": [
        { id: "a", type: "todo", text: "A", tags: ["t1"] },
        { id: "b", type: "todo", text: "B", tags: ["t2"] },
        { id: "c", type: "todo", text: "C" },
      ],
      "GET /tags": TAGS,
    });
    const byName = dataOf(await callTool("list_tasks", { type: "todos", tag: "work" }));
    assert.deepEqual(
      byName.map((t) => t.id),
      ["a"],
    );
    const byId = dataOf(await callTool("list_tasks", { type: "todos", tag: "t2" }));
    assert.deepEqual(
      byId.map((t) => t.id),
      ["b"],
    );
  });

  it("reports unknown tags with the existing ones", async () => {
    fakeHabitica({ "GET /tasks/user?type=todos": [], "GET /tags": TAGS });
    const r = await callTool("list_tasks", { type: "todos", tag: "nope" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /No tag matching "nope"\. Existing tags: Work, Home/);
  });

  it("create_task maps a daily schedule and resolves tags", async () => {
    fakeHabitica({
      "GET /tags": TAGS,
      "POST /tasks/user": { id: "new", type: "daily", text: "Stretch" },
    });
    await callTool("create_task", {
      type: "daily",
      text: "Stretch",
      priority: 1.5,
      frequency: "weekly",
      everyX: 1,
      repeatDays: ["mon", "sun"],
      startDate: "2026-11-01",
      checklist: ["warm up"],
      tags: ["Work"],
    });
    const body = calls.find((c) => c.key === "POST /tasks/user").body;
    assert.deepEqual(body, {
      type: "daily",
      text: "Stretch",
      priority: 1.5,
      frequency: "weekly",
      everyX: 1,
      startDate: "2026-11-01",
      repeat: { m: true, t: false, w: false, th: false, f: false, s: false, su: true },
      checklist: [{ text: "warm up" }],
      tags: ["t1"],
    });
  });

  it("create_task maps todo dates, habit buttons and reward cost", async () => {
    fakeHabitica({ "POST /tasks/user": { id: "x" } });
    await callTool("create_task", { type: "todo", text: "T", dueDate: "2026-12-01" });
    await callTool("create_task", { type: "habit", text: "H", up: false, down: true });
    await callTool("create_task", { type: "reward", text: "R", cost: 30 });
    assert.deepEqual(
      calls.map((c) => c.body),
      [
        { type: "todo", text: "T", date: "2026-12-01" },
        { type: "habit", text: "H", up: false, down: true },
        { type: "reward", text: "R", value: 30 },
      ],
    );
  });

  it("update_task sends only changed fields and refuses empty updates", async () => {
    fakeHabitica({ "PUT /tasks/abc": { id: "abc", type: "todo", text: "New" } });
    assert.ok(!(await callTool("update_task", { taskId: "abc", text: "New" })).isError);
    assert.deepEqual(calls[0].body, { text: "New" });
    const r = await callTool("update_task", { taskId: "abc" });
    assert.equal(textOf(r), "Nothing to update");
  });

  it("update_task replaces the checklist from strings and objects, and [] clears", async () => {
    fakeHabitica({ "PUT /tasks/abc": { id: "abc", type: "todo", text: "T" } });
    await callTool("update_task", {
      taskId: "abc",
      checklist: ["a", { id: "i1", completed: true }],
    });
    await callTool("update_task", { taskId: "abc", checklist: [] });
    assert.deepEqual(calls[0].body, { checklist: [{ text: "a" }, { id: "i1", completed: true }] });
    assert.deepEqual(calls[1].body, { checklist: [] });
  });

  it("update_task checklistOrder reorders existing items and appends unlisted ones", async () => {
    const items = [
      { id: "i1", text: "one", completed: false },
      { id: "i2", text: "two", completed: true },
      { id: "i3", text: "three", completed: false },
    ];
    fakeHabitica({
      "GET /tasks/abc": { id: "abc", checklist: items },
      "PUT /tasks/abc": { id: "abc", type: "todo", text: "T" },
    });
    await callTool("update_task", { taskId: "abc", checklistOrder: ["i3", "i2"] });
    assert.deepEqual(calls[1].body.checklist, [
      { id: "i3", text: "three", completed: false },
      { id: "i2", text: "two", completed: true },
      { id: "i1", text: "one", completed: false },
    ]);
  });

  it("update_task checklistOrder rejects unknown ids, and checklist plus checklistOrder", async () => {
    fakeHabitica({ "GET /tasks/abc": { id: "abc", checklist: [{ id: "i1", text: "one" }] } });
    const bad = await callTool("update_task", { taskId: "abc", checklistOrder: ["zz"] });
    assert.match(textOf(bad), /Unknown checklist item id\(s\): zz\. Valid ids: i1/);
    const both = await callTool("update_task", {
      taskId: "abc",
      checklist: [],
      checklistOrder: [],
    });
    assert.match(textOf(both), /either checklist or checklistOrder/);
  });

  it("score_task defaults to up and rounds results", async () => {
    fakeHabitica({
      "POST /tasks/abc/score/up": {
        hp: 49.6,
        mp: 3.2,
        exp: 10.5,
        gp: 5.678,
        lvl: 3,
        _tmp: { drop: { dialog: "Found an egg" } },
      },
      "POST /tasks/abc/score/down": { hp: 40, mp: 0, exp: 0, gp: 0, lvl: 3 },
    });
    assert.deepEqual(dataOf(await callTool("score_task", { taskId: "abc" })), {
      hp: 50,
      mp: 3,
      exp: 11,
      gold: 5.68,
      level: 3,
      drop: "Found an egg",
    });
    assert.equal(dataOf(await callTool("score_task", { taskId: "abc", direction: "down" })).hp, 40);
  });

  it("move_task, delete_task and url-encodes ids", async () => {
    fakeHabitica({
      "POST /tasks/a%2Fb/move/to/-1": ["a/b"],
      "DELETE /tasks/abc": {},
    });
    assert.deepEqual(dataOf(await callTool("move_task", { taskId: "a/b", position: -1 })), {
      moved: true,
      newOrder: ["a/b"],
    });
    assert.deepEqual(dataOf(await callTool("delete_task", { taskId: "abc", confirm: true })), {
      deleted: "abc",
    });
  });

  it("url-encodes task ids in every task endpoint", async () => {
    const id = "a/b?c";
    const enc = "a%2Fb%3Fc";
    const task = { id, type: "todo", text: "t" };
    fakeHabitica({
      ["GET /tasks/" + enc]: task,
      ["PUT /tasks/" + enc]: task,
      ["POST /tasks/" + enc + "/score/up"]: {},
      ["POST /tasks/" + enc + "/checklist/i%2F1/score"]: task,
      ["POST /tasks/" + enc + "/checklist"]: task,
      ["GET /tags"]: [{ id: "t1", name: "x" }],
      ["POST /tasks/" + enc + "/tags/t1"]: task,
    });
    assert.ok(!(await callTool("get_task", { taskId: id })).isError);
    await callTool("update_task", { taskId: id, text: "n" });
    assert.ok(!(await callTool("score_task", { taskId: id })).isError);
    assert.ok(!(await callTool("score_checklist_item", { taskId: id, itemId: "i/1" })).isError);
    assert.ok(
      !(await callTool("checklist_item", { taskId: id, action: "add", text: "x" })).isError,
    );
    assert.ok(!(await callTool("tag_task", { taskId: id, tag: "x" })).isError);
  });

  it("checklist_item covers add, update, delete and argument checks", async () => {
    const task = { id: "abc", type: "todo", text: "T" };
    fakeHabitica({
      "POST /tasks/abc/checklist": task,
      "PUT /tasks/abc/checklist/i1": task,
      "DELETE /tasks/abc/checklist/i1": task,
      "POST /tasks/abc/checklist/i1/score": task,
    });
    await callTool("checklist_item", { taskId: "abc", action: "add", text: "x" });
    await callTool("checklist_item", { taskId: "abc", action: "update", itemId: "i1", text: "y" });
    await callTool("checklist_item", { taskId: "abc", action: "delete", itemId: "i1" });
    await callTool("score_checklist_item", { taskId: "abc", itemId: "i1" });
    assert.deepEqual(
      calls.map((c) => c.key),
      [
        "POST /tasks/abc/checklist",
        "PUT /tasks/abc/checklist/i1",
        "DELETE /tasks/abc/checklist/i1",
        "POST /tasks/abc/checklist/i1/score",
      ],
    );
    assert.match(
      textOf(await callTool("checklist_item", { taskId: "abc", action: "add" })),
      /text is required/,
    );
    assert.match(
      textOf(await callTool("checklist_item", { taskId: "abc", action: "delete" })),
      /itemId is required/,
    );
  });

  it("list_tags, create_tag and tag_task", async () => {
    fakeHabitica({
      "GET /tags": TAGS,
      "POST /tags": { id: "t3", name: "New", extra: 1 },
      "POST /tasks/abc/tags/t1": { id: "abc", type: "todo", text: "T" },
      "DELETE /tasks/abc/tags/t2": { id: "abc", type: "todo", text: "T" },
    });
    assert.deepEqual(dataOf(await callTool("list_tags", {})), TAGS);
    assert.deepEqual(dataOf(await callTool("create_tag", { name: "New" })), {
      id: "t3",
      name: "New",
    });
    await callTool("tag_task", { taskId: "abc", tag: "work" });
    await callTool("tag_task", { taskId: "abc", tag: "Home", action: "remove" });
    assert.deepEqual(calls.slice(-1)[0].key, "DELETE /tasks/abc/tags/t2");
  });

  it("set_sleep only toggles when the state differs", async () => {
    fakeHabitica({ "GET /user": { preferences: { sleep: false } }, "POST /user/sleep": true });
    assert.deepEqual(dataOf(await callTool("set_sleep", { sleeping: false })), {
      damagePaused: false,
      changed: false,
    });
    assert.deepEqual(dataOf(await callTool("set_sleep", { sleeping: true })), {
      damagePaused: true,
      changed: true,
    });
    assert.equal(calls.filter((c) => c.key === "POST /user/sleep").length, 1);
  });

  it("buy_health_potion and cast_spell", async () => {
    fakeHabitica({
      "POST /user/buy-health-potion": { hp: 35.4, gp: 10.126 },
      "POST /user/class/cast/fireball?targetId=abc": { user: { stats: { mp: 12.4, hp: 30 } } },
      "POST /user/class/cast/healAll": { user: { stats: { mp: 5, hp: 50 } } },
    });
    assert.deepEqual(dataOf(await callTool("buy_health_potion", {})), { hp: 35, gold: 10.13 });
    assert.deepEqual(
      dataOf(await callTool("cast_spell", { spellId: "fireball", targetId: "abc" })),
      { cast: "fireball", mp: 12, hp: 30 },
    );
    assert.equal(dataOf(await callTool("cast_spell", { spellId: "healAll" })).mp, 5);
  });
});
