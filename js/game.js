(() => {
  "use strict";

  const MAP_W = 1800;
  const MAP_H = 1200;
  const WALL = 36;
  const PLAYER_R = 22;
  const SPEED = 250;
  const MAX_HP = 100;
  const GUN_DMG = 10;
  const GUN_CD = 1;
  const SWORD_DMG = 20;
  const SWORD_CD = 1;
  const SWORD_RANGE = 78;
  const SWORD_ARC = Math.PI * 0.7;
  const BULLET_SPEED = 760;
  const BULLET_R = 5;
  const RESPAWN = 3;
  const NET_HZ = 12;
  const TOPIC = "circlearena-v1";
  const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];

  const COLORS = ["#ff4d4d", "#3ecbff", "#3dff8a", "#ffb020", "#c084fc", "#fb7185"];

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const $ = (id) => document.getElementById(id);

  const ui = {
    menu: $("menu"),
    waiting: $("waiting"),
    hud: $("hud"),
    touch: $("touch"),
    hpFill: $("hpFill"),
    hpText: $("hpText"),
    roomTag: $("roomTag"),
    killStat: $("killStat"),
    killFeed: $("killFeed"),
    centerMsg: $("centerMsg"),
    gunCd: $("gunCd"),
    swordCd: $("swordCd"),
    nameInput: $("nameInput"),
    roomInput: $("roomInput"),
    menuError: $("menuError"),
    roomCode: $("roomCode"),
    waitStatus: $("waitStatus"),
    moveKnob: $("moveKnob"),
    aimKnob: $("aimKnob"),
    btnGun: $("btnGun"),
    btnSword: $("btnSword"),
    btnLeave: $("btnLeave"),
  };

  const input = {
    mx: 0,
    my: 0,
    aimX: 0,
    aimY: 0,
    gun: false,
    sword: false,
    mouseAim: true,
    keys: { w: false, a: false, s: false, d: false },
  };

  let dpr = 1;
  let viewW = 0;
  let viewH = 0;
  let lastT = 0;
  let camX = MAP_W / 2;
  let camY = MAP_H / 2;
  let shake = 0;
  let mode = "menu";
  let meId = uid();
  let myName = "플레이어";
  let myColor = COLORS[0];
  let roomId = "";
  let isHost = false;
  let mqttClient = null;
  let netAcc = 0;
  let nextBullet = 1;
  let nextFx = 1;
  let netEvents = [];

  const world = {
    players: {},
    bullets: [],
    fx: [],
    floats: [],
    feed: [],
  };

  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function len(x, y) {
    return Math.hypot(x, y) || 1;
  }

  function ang(x, y) {
    return Math.atan2(y, x);
  }

  function spawnPos(i) {
    const pads = [
      { x: 160, y: 160 },
      { x: MAP_W - 160, y: MAP_H - 160 },
      { x: MAP_W - 160, y: 160 },
      { x: 160, y: MAP_H - 160 },
      { x: MAP_W / 2, y: 160 },
      { x: MAP_W / 2, y: MAP_H - 160 },
    ];
    return pads[i % pads.length];
  }

  function makePlayer(id, name, color, slot) {
    const p = spawnPos(slot);
    return {
      id,
      name: name || "플레이어",
      color,
      x: p.x,
      y: p.y,
      a: 0,
      hp: MAX_HP,
      gunCd: 0,
      swordCd: 0,
      kills: 0,
      deaths: 0,
      alive: true,
      respawn: 0,
      bot: false,
      lastSeen: performance.now(),
    };
  }

  function localPlayer() {
    return world.players[meId];
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(viewH * dpr);
    canvas.style.width = viewW + "px";
    canvas.style.height = viewH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function showTouch() {
    const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
    ui.touch.classList.toggle("hidden", !coarse);
  }

  function setError(msg) {
    ui.menuError.textContent = msg || "";
  }

  function showMenu() {
    mode = "menu";
    ui.menu.classList.remove("hidden");
    ui.waiting.classList.add("hidden");
    ui.hud.classList.add("hidden");
    ui.touch.classList.add("hidden");
    disconnect();
  }

  function enterGame(label) {
    mode = "play";
    ui.menu.classList.add("hidden");
    ui.waiting.classList.add("hidden");
    ui.hud.classList.remove("hidden");
    ui.roomTag.textContent = label;
    showTouch();
  }

  function startPractice() {
    resetWorld();
    myName = (ui.nameInput.value || "플레이어").slice(0, 12);
    myColor = COLORS[0];
    world.players[meId] = makePlayer(meId, myName, myColor, 0);
    world.players.bot1 = Object.assign(makePlayer("bot1", "봇 알파", COLORS[1], 1), { bot: true });
    world.players.bot2 = Object.assign(makePlayer("bot2", "봇 베타", COLORS[2], 2), { bot: true });
    isHost = true;
    roomId = "";
    enterGame("연습 모드");
  }

  function resetWorld() {
    world.players = {};
    world.bullets = [];
    world.fx = [];
    world.floats = [];
    world.feed = [];
    nextBullet = 1;
  }

  function randomRoom() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function connectMqtt(onReady) {
    disconnect();
    let idx = 0;
    const tryNext = () => {
      if (idx >= BROKERS.length) {
        onReady(new Error("온라인 서버에 연결하지 못했습니다."));
        return;
      }
      const url = BROKERS[idx++];
      const client = mqtt.connect(url, {
        clientId: "ca-" + meId + "-" + uid(),
        reconnectPeriod: 0,
        connectTimeout: 6000,
        clean: true,
      });
      const fail = () => {
        try { client.end(true); } catch (_) {}
        tryNext();
      };
      const timer = setTimeout(fail, 7000);
      client.on("connect", () => {
        clearTimeout(timer);
        mqttClient = client;
        client.subscribe(`${TOPIC}/${roomId}/#`, (err) => onReady(err));
      });
      client.on("error", () => {});
      client.on("close", () => {
        if (mqttClient === client && mode === "play") {
          pushFeed("연결이 끊겼습니다");
        }
      });
      client.on("message", onMessage);
    };
    tryNext();
  }

  function disconnect() {
    if (mqttClient) {
      try { mqttClient.end(true); } catch (_) {}
      mqttClient = null;
    }
  }

  function pub(kind, data) {
    if (!mqttClient || !mqttClient.connected) return;
    mqttClient.publish(`${TOPIC}/${roomId}/${kind}`, JSON.stringify(data), { qos: 0, retain: false });
  }

  function onMessage(topic, buf) {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
    const kind = topic.split("/").pop();
    if (kind === "hello" && msg.id !== meId && isHost) {
      if (!world.players[msg.id]) {
        const slot = Object.keys(world.players).length;
        world.players[msg.id] = makePlayer(msg.id, msg.name, msg.color, slot);
        pushFeed(`${msg.name} 참가`);
      } else {
        world.players[msg.id].name = msg.name;
        world.players[msg.id].color = msg.color;
        world.players[msg.id].lastSeen = performance.now();
      }
    }
    if (kind === "input" && msg.id !== meId && isHost) {
      const p = world.players[msg.id];
      if (!p) return;
      p._in = msg;
      p.lastSeen = performance.now();
    }
    if (kind === "bye" && msg.id !== meId) {
      const p = world.players[msg.id];
      if (p) {
        pushFeed(`${p.name} 나감`);
        delete world.players[msg.id];
      }
    }
    if (kind === "state" && !isHost && msg.host !== meId) {
      applyRemoteState(msg);
      for (const ev of msg.events || []) applyEvent(ev);
    }
    if (kind === "host?" && isHost) {
      pub("hello-ack", { host: meId });
    }
    if (kind === "hello-ack" && mode === "wait") {
      isHost = false;
      enterGame("방 " + roomId);
      pub("hello", { id: meId, name: myName, color: myColor });
    }
  }

  function applyRemoteState(msg) {
    const seen = {};
    for (const rp of msg.players || []) {
      seen[rp.id] = true;
      let p = world.players[rp.id];
      if (!p) {
        p = makePlayer(rp.id, rp.name, rp.color, 0);
        world.players[rp.id] = p;
      }
      if (rp.id === meId) {
        p.hp = rp.hp;
        p.alive = rp.alive;
        p.respawn = rp.respawn;
        p.kills = rp.kills;
        p.deaths = rp.deaths;
        p.gunCd = rp.gunCd;
        p.swordCd = rp.swordCd;
        if (!p.alive || Math.hypot(p.x - rp.x, p.y - rp.y) > 80) {
          p.x = rp.x;
          p.y = rp.y;
          p.a = rp.a;
        }
      } else {
        p.tx = rp.x;
        p.ty = rp.y;
        p.ta = rp.a;
        p.hp = rp.hp;
        p.alive = rp.alive;
        p.respawn = rp.respawn;
        p.name = rp.name;
        p.color = rp.color;
        p.kills = rp.kills;
        p.deaths = rp.deaths;
      }
    }
    for (const id of Object.keys(world.players)) {
      if (!seen[id] && id !== meId) delete world.players[id];
    }
    world.bullets = (msg.bullets || []).map((b) => ({ ...b }));
  }

  function applyEvent(ev) {
    if (ev.k === "slash" && ev.from !== meId) addFx(ev.x, ev.y, ev.a, "slash", ev.c);
    if (ev.k === "muzzle" && ev.from !== meId) addFx(ev.x, ev.y, ev.a, "muzzle");
    if (ev.k === "boom") addFx(ev.x, ev.y, 0, "boom", ev.c);
    if (ev.k === "spark") addFx(ev.x, ev.y, 0, "spark");
    if (ev.k === "dmg") addFloat(ev.x, ev.y, ev.t);
    if (ev.k === "feed") pushFeed(ev.t, true);
  }

  function snapshot() {
    return {
      host: meId,
      players: Object.values(world.players)
        .filter((p) => !p.bot)
        .map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          a: Math.round(p.a * 100) / 100,
          hp: Math.round(p.hp),
          gunCd: Math.round(p.gunCd * 100) / 100,
          swordCd: Math.round(p.swordCd * 100) / 100,
          kills: p.kills,
          deaths: p.deaths,
          alive: p.alive,
          respawn: Math.round(p.respawn * 10) / 10,
        })),
      bullets: world.bullets.map((b) => ({
        id: b.id,
        x: Math.round(b.x),
        y: Math.round(b.y),
        a: b.a,
        owner: b.owner,
      })),
      events: netEvents.splice(0, netEvents.length),
    };
  }

  function createRoom() {
    if (typeof mqtt === "undefined") {
      setError("네트워크 라이브러리를 불러오지 못했습니다. 연습 모드를 이용하세요.");
      return;
    }
    myName = (ui.nameInput.value || "플레이어").slice(0, 12);
    myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    roomId = randomRoom();
    isHost = true;
    resetWorld();
    world.players[meId] = makePlayer(meId, myName, myColor, 0);
    ui.roomCode.textContent = roomId;
    ui.waitStatus.textContent = "상대를 기다리는 중…";
    ui.menu.classList.add("hidden");
    ui.waiting.classList.remove("hidden");
    mode = "wait";
    setError("");
    connectMqtt((err) => {
      if (err) {
        setError(err.message || String(err));
        showMenu();
        return;
      }
      enterGame("방 " + roomId);
      ui.waitStatus.textContent = "연결됨";
    });
  }

  function joinRoom() {
    if (typeof mqtt === "undefined") {
      setError("네트워크 라이브러리를 불러오지 못했습니다. 연습 모드를 이용하세요.");
      return;
    }
    myName = (ui.nameInput.value || "플레이어").slice(0, 12);
    myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    roomId = (ui.roomInput.value || "").trim().toUpperCase();
    if (roomId.length < 4) {
      setError("방 코드를 입력하세요.");
      return;
    }
    isHost = false;
    resetWorld();
    world.players[meId] = makePlayer(meId, myName, myColor, 1);
    setError("연결 중…");
    connectMqtt((err) => {
      if (err) {
        setError(err.message || String(err));
        return;
      }
      mode = "wait";
      ui.menu.classList.add("hidden");
      ui.waiting.classList.remove("hidden");
      ui.roomCode.textContent = roomId;
      ui.waitStatus.textContent = "호스트를 찾는 중…";
      pub("host?", { id: meId });
      pub("hello", { id: meId, name: myName, color: myColor });
      setTimeout(() => {
        if (mode !== "wait") return;
        isHost = true;
        ui.waitStatus.textContent = "이 방의 호스트가 되었습니다.";
        enterGame("방 " + roomId);
      }, 2500);
    });
  }

  function moveVector(p) {
    if (p.id === meId) {
      let x = 0;
      let y = 0;
      if (input.keys.w) y -= 1;
      if (input.keys.s) y += 1;
      if (input.keys.a) x -= 1;
      if (input.keys.d) x += 1;
      x += input.mx;
      y += input.my;
      const l = Math.hypot(x, y);
      if (l > 1) {
        x /= l;
        y /= l;
      }
      return { x, y };
    }
    if (p._in) return { x: p._in.mx || 0, y: p._in.my || 0 };
    return { x: 0, y: 0 };
  }

  function aimAngle(p) {
    if (p.id === meId) {
      if (input.mouseAim) {
        const w = screenToWorld(lastMouse.x, lastMouse.y);
        return ang(w.x - p.x, w.y - p.y);
      }
      if (Math.hypot(input.aimX, input.aimY) > 0.2) return ang(input.aimX, input.aimY);
      const mv = moveVector(p);
      if (Math.hypot(mv.x, mv.y) > 0.2) return ang(mv.x, mv.y);
      return p.a;
    }
    if (p._in && typeof p._in.a === "number") return p._in.a;
    return p.a;
  }

  function wantsGun(p) {
    if (p.id === meId) return input.gun;
    return !!(p._in && p._in.gun);
  }

  function wantsSword(p) {
    if (p.id === meId) return input.sword;
    return !!(p._in && p._in.sword);
  }

  const lastMouse = { x: 0, y: 0 };

  function screenToWorld(sx, sy) {
    const zoom = zoomLevel();
    return {
      x: camX + (sx - viewW / 2) / zoom,
      y: camY + (sy - viewH / 2) / zoom,
    };
  }

  function zoomLevel() {
    return Math.max(viewW / 1100, viewH / 780) * 0.92;
  }

  function collideWalls(ent, r) {
    ent.x = clamp(ent.x, WALL + r, MAP_W - WALL - r);
    ent.y = clamp(ent.y, WALL + r, MAP_H - WALL - r);
  }

  function inArena(x, y, r) {
    return x > WALL + r && x < MAP_W - WALL - r && y > WALL + r && y < MAP_H - WALL - r;
  }

  function fireGun(p) {
    if (!p.alive || p.gunCd > 0) return;
    p.gunCd = GUN_CD;
    const bx = p.x + Math.cos(p.a) * (PLAYER_R + 8);
    const by = p.y + Math.sin(p.a) * (PLAYER_R + 8);
    world.bullets.push({
      id: nextBullet++,
      x: bx,
      y: by,
      a: p.a,
      vx: Math.cos(p.a) * BULLET_SPEED,
      vy: Math.sin(p.a) * BULLET_SPEED,
      owner: p.id,
      life: 1.6,
    });
    addFx(bx, by, p.a, "muzzle");
    if (isHost) netEvents.push({ k: "muzzle", x: bx, y: by, a: p.a, from: p.id });
    beep(880, 0.05, 0.04);
  }

  function swingSword(p) {
    if (!p.alive || p.swordCd > 0) return;
    p.swordCd = SWORD_CD;
    addFx(p.x, p.y, p.a, "slash", p.color);
    if (isHost) netEvents.push({ k: "slash", x: p.x, y: p.y, a: p.a, c: p.color, from: p.id });
    beep(220, 0.08, 0.06);
    if (!isHost && roomId) return;
    for (const o of Object.values(world.players)) {
      if (o.id === p.id || !o.alive) continue;
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > SWORD_RANGE + PLAYER_R) continue;
      const diff = Math.abs(Math.atan2(Math.sin(ang(dx, dy) - p.a), Math.cos(ang(dx, dy) - p.a)));
      if (diff <= SWORD_ARC / 2) hit(o, p, SWORD_DMG, "검");
    }
  }

  function hit(target, attacker, dmg, weapon) {
    if (!target.alive) return;
    target.hp -= dmg;
    addFloat(target.x, target.y - 28, "-" + dmg);
    if (isHost) netEvents.push({ k: "dmg", x: target.x, y: target.y - 28, t: "-" + dmg });
    shake = Math.max(shake, 8);
    if (target.id === meId) vibrate(30);
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.respawn = RESPAWN;
      target.deaths += 1;
      attacker.kills += 1;
      addFx(target.x, target.y, 0, "boom", target.color);
      const line = `${attacker.name} 가 ${target.name} 를 ${weapon}으로 처치`;
      pushFeed(line);
      if (isHost) {
        netEvents.push({ k: "boom", x: target.x, y: target.y, c: target.color });
        netEvents.push({ k: "feed", t: line });
      }
      beep(90, 0.2, 0.08);
    }
  }

  function addFx(x, y, a, kind, color) {
    world.fx.push({ id: nextFx++, x, y, a, kind, color, t: 0, life: kind === "boom" ? 0.45 : 0.18 });
  }

  function addFloat(x, y, text) {
    world.floats.push({ x, y, text, t: 0 });
  }

  function pushFeed(text, remote) {
    if (world.feed[0] === text) return;
    world.feed.unshift(text);
    world.feed = world.feed.slice(0, 4);
    ui.killFeed.innerHTML = world.feed.map((t) => `<div>${escapeHtml(t)}</div>`).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function updateBots(dt) {
    const humans = Object.values(world.players).filter((p) => p.alive && !p.bot);
    for (const b of Object.values(world.players)) {
      if (!b.bot) continue;
      if (!b.alive) continue;
      const target = humans[0];
      if (!target) continue;
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      b.a = ang(dx, dy);
      const want = d > 160 ? 1 : d < 70 ? -0.4 : 0.15;
      b.x += (dx / d) * SPEED * 0.72 * want * dt;
      b.y += (dy / d) * SPEED * 0.72 * want * dt;
      b.x += Math.cos(b.a + Math.PI / 2) * 40 * dt;
      collideWalls(b, PLAYER_R);
      if (d < SWORD_RANGE + 10) b._in = { gun: false, sword: true, mx: 0, my: 0, a: b.a };
      else b._in = { gun: d < 520, sword: false, mx: 0, my: 0, a: b.a };
    }
  }

  function update(dt) {
    if (mode !== "play") return;
    const hostSim = isHost || !roomId;

    if (!isHost && roomId) {
      for (const p of Object.values(world.players)) {
        if (p.id === meId && p.alive) {
          const mv = moveVector(p);
          p.x += mv.x * SPEED * dt;
          p.y += mv.y * SPEED * dt;
          collideWalls(p, PLAYER_R);
          p.a = aimAngle(p);
          p.gunCd = Math.max(0, p.gunCd - dt);
          p.swordCd = Math.max(0, p.swordCd - dt);
          if (wantsGun(p)) fireGun(p);
          if (wantsSword(p)) swingSword(p);
        } else if (p.tx != null) {
          p.x += (p.tx - p.x) * Math.min(1, dt * 12);
          p.y += (p.ty - p.y) * Math.min(1, dt * 12);
          p.a = p.ta;
        }
      }
      for (const b of world.bullets) {
        b.x += Math.cos(b.a) * BULLET_SPEED * dt;
        b.y += Math.sin(b.a) * BULLET_SPEED * dt;
      }
    }

    if (hostSim) {
      if (!roomId) updateBots(dt);
      const now = performance.now();
      for (const p of Object.values(world.players)) {
        if (roomId && !p.bot && p.id !== meId && now - p.lastSeen > 8000) {
          pushFeed(`${p.name} 연결 끊김`);
          delete world.players[p.id];
          continue;
        }
        p.gunCd = Math.max(0, p.gunCd - dt);
        p.swordCd = Math.max(0, p.swordCd - dt);
        if (!p.alive) {
          p.respawn -= dt;
          if (p.respawn <= 0) {
            const s = spawnPos(Math.floor(Math.random() * 6));
            p.x = s.x;
            p.y = s.y;
            p.hp = MAX_HP;
            p.alive = true;
          }
          continue;
        }
        const mv = moveVector(p);
        p.x += mv.x * SPEED * dt;
        p.y += mv.y * SPEED * dt;
        collideWalls(p, PLAYER_R);
        p.a = aimAngle(p);
        if (wantsGun(p)) fireGun(p);
        if (wantsSword(p)) swingSword(p);
      }

      const list = Object.values(world.players);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a.alive || !b.alive) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          const min = PLAYER_R * 2;
          if (d > 0 && d < min) {
            const push = (min - d) / 2;
            const nx = dx / d;
            const ny = dy / d;
            a.x -= nx * push;
            a.y -= ny * push;
            b.x += nx * push;
            b.y += ny * push;
            collideWalls(a, PLAYER_R);
            collideWalls(b, PLAYER_R);
          }
        }
      }

      for (const b of world.bullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (!inArena(b.x, b.y, BULLET_R)) b.life = 0;
        for (const p of Object.values(world.players)) {
          if (!p.alive || p.id === b.owner) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_R + BULLET_R) {
            const atk = world.players[b.owner];
            if (atk) hit(p, atk, GUN_DMG, "총");
            b.life = 0;
            addFx(b.x, b.y, 0, "spark");
            if (isHost) netEvents.push({ k: "spark", x: b.x, y: b.y });
          }
        }
      }
      world.bullets = world.bullets.filter((b) => b.life > 0);
    }

    for (const f of world.fx) f.t += dt;
    world.fx = world.fx.filter((f) => f.t < f.life);
    for (const f of world.floats) {
      f.t += dt;
      f.y -= 28 * dt;
    }
    world.floats = world.floats.filter((f) => f.t < 0.7);
    shake *= Math.pow(0.04, dt);

    const me = localPlayer();
    if (me) {
      camX += (me.x - camX) * Math.min(1, dt * 6);
      camY += (me.y - camY) * Math.min(1, dt * 6);
    }

    if (roomId && mqttClient && mqttClient.connected) {
      netAcc += dt;
      if (netAcc >= 1 / NET_HZ) {
        netAcc = 0;
        if (isHost) pub("state", snapshot());
        else {
          const mep = localPlayer();
          pub("input", {
            id: meId,
            mx: Math.round(moveVector(mep).x * 100) / 100,
            my: Math.round(moveVector(mep).y * 100) / 100,
            a: mep ? Math.round(mep.a * 100) / 100 : 0,
            gun: input.gun,
            sword: input.sword,
          });
        }
      }
    }

    updateHud();
  }

  function updateHud() {
    const me = localPlayer();
    if (!me) return;
    const hp = me.alive ? me.hp : 0;
    ui.hpFill.style.transform = `scaleX(${hp / MAX_HP})`;
    ui.hpText.textContent = String(Math.max(0, Math.ceil(hp)));
    ui.killStat.textContent = `처치 ${me.kills}  ·  사망 ${me.deaths}`;
    ui.gunCd.style.transform = `scaleX(${1 - me.gunCd / GUN_CD})`;
    ui.swordCd.style.transform = `scaleX(${1 - me.swordCd / SWORD_CD})`;
    if (!me.alive) {
      ui.centerMsg.classList.remove("hidden");
      ui.centerMsg.textContent = `쓰러짐  ·  ${Math.ceil(me.respawn)}초 후 부활`;
    } else {
      ui.centerMsg.classList.add("hidden");
    }
  }

  function render() {
    ctx.clearRect(0, 0, viewW, viewH);
    const zoom = zoomLevel();
    const sx = shake ? (Math.random() - 0.5) * shake : 0;
    const sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.save();
    ctx.translate(viewW / 2 + sx, viewH / 2 + sy);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);

    ctx.fillStyle = "#0c1018";
    ctx.fillRect(-200, -200, MAP_W + 400, MAP_H + 400);

    ctx.fillStyle = "#151b27";
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    ctx.strokeStyle = "rgba(80, 96, 128, 0.18)";
    ctx.lineWidth = 2;
    for (let x = WALL; x < MAP_W; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, WALL);
      ctx.lineTo(x, MAP_H - WALL);
      ctx.stroke();
    }
    for (let y = WALL; y < MAP_H; y += 80) {
      ctx.beginPath();
      ctx.moveTo(WALL, y);
      ctx.lineTo(MAP_W - WALL, y);
      ctx.stroke();
    }

    ctx.fillStyle = "#2a3344";
    ctx.fillRect(0, 0, MAP_W, WALL);
    ctx.fillRect(0, MAP_H - WALL, MAP_W, WALL);
    ctx.fillRect(0, 0, WALL, MAP_H);
    ctx.fillRect(MAP_W - WALL, 0, WALL, MAP_H);
    ctx.strokeStyle = "rgba(62, 203, 255, 0.35)";
    ctx.lineWidth = 4;
    ctx.strokeRect(WALL - 2, WALL - 2, MAP_W - WALL * 2 + 4, MAP_H - WALL * 2 + 4);

    for (const f of world.fx) {
      const k = 1 - f.t / f.life;
      if (f.kind === "slash") {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.a);
        ctx.beginPath();
        ctx.arc(0, 0, SWORD_RANGE, -SWORD_ARC / 2, SWORD_ARC / 2);
        ctx.strokeStyle = `rgba(255, 176, 32, ${0.75 * k})`;
        ctx.lineWidth = 10;
        ctx.stroke();
        ctx.restore();
      } else if (f.kind === "muzzle") {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.a);
        ctx.fillStyle = `rgba(180, 240, 255, ${k})`;
        ctx.beginPath();
        ctx.ellipse(8, 0, 16, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (f.kind === "boom") {
        ctx.beginPath();
        ctx.arc(f.x, f.y, 18 + (1 - k) * 40, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 80, 80, ${k})`;
        ctx.lineWidth = 5;
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(255,255,255,${k})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const b of world.bullets) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = "#dff6ff";
      ctx.beginPath();
      ctx.ellipse(0, 0, 9, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(62, 203, 255, 0.35)";
      ctx.fillRect(-18, -2, 16, 4);
      ctx.restore();
    }

    for (const p of Object.values(world.players)) {
      drawPlayer(p);
    }

    for (const f of world.floats) {
      ctx.globalAlpha = 1 - f.t / 0.7;
      ctx.fillStyle = "#ffe08a";
      ctx.font = "700 16px Rajdhani, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(f.text, f.x, f.y);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function drawPlayer(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 10, PLAYER_R * 0.9, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    if (!p.alive) ctx.globalAlpha = 0.35;
    ctx.rotate(p.a);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.arc(-4, -5, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b0e14";
    ctx.beginPath();
    ctx.moveTo(PLAYER_R - 2, 0);
    ctx.lineTo(PLAYER_R + 14, -7);
    ctx.lineTo(PLAYER_R + 14, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#9ad8ff";
    ctx.fillRect(PLAYER_R + 6, -3, 16, 6);
    ctx.restore();

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(-24, -PLAYER_R - 16, 48, 6);
    ctx.fillStyle = p.hp > 40 ? "#3dff8a" : "#ff4d4d";
    ctx.fillRect(-24, -PLAYER_R - 16, 48 * (p.hp / MAX_HP), 6);
    ctx.fillStyle = "#e8edf7";
    ctx.font = "600 12px 'Noto Sans KR', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, 0, -PLAYER_R - 22);
    ctx.restore();
  }

  let audioCtx = null;
  function beep(freq, dur, vol) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      o.type = "square";
      g.gain.value = vol;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }

  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {}
  }

  function loop(t) {
    const dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
    lastT = t;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }

  function bindInput() {
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (k in input.keys) input.keys[k] = true;
      if (k === " " || k === "shift") {
        input.sword = true;
        e.preventDefault();
      }
      if (k === "escape" && mode === "play") {
        pub("bye", { id: meId });
        showMenu();
      }
    });
    window.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      if (k in input.keys) input.keys[k] = false;
      if (k === " " || k === "shift") input.sword = false;
    });
    window.addEventListener("mousemove", (e) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
      input.mouseAim = true;
    });
    window.addEventListener("mousedown", (e) => {
      if (mode !== "play") return;
      if (e.button === 0) input.gun = true;
      if (e.button === 2) input.sword = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) input.gun = false;
      if (e.button === 2) input.sword = false;
    });
    window.addEventListener("contextmenu", (e) => e.preventDefault());

    bindStick("moveStick", ui.moveKnob, (x, y) => {
      input.mx = x;
      input.my = y;
    });
    bindStick("aimStick", ui.aimKnob, (x, y) => {
      input.aimX = x;
      input.aimY = y;
      if (Math.hypot(x, y) > 0.2) input.mouseAim = false;
    });

    const hold = (el, setter) => {
      const on = (e) => {
        e.preventDefault();
        setter(true);
        el.classList.add("held");
      };
      const off = (e) => {
        e.preventDefault();
        setter(false);
        el.classList.remove("held");
      };
      el.addEventListener("pointerdown", on);
      el.addEventListener("pointerup", off);
      el.addEventListener("pointercancel", off);
      el.addEventListener("pointerleave", off);
    };
    hold(ui.btnGun, (v) => { input.gun = v; });
    hold(ui.btnSword, (v) => { input.sword = v; });
  }

  function bindStick(id, knob, setter) {
    const el = $(id);
    let pid = null;
    const radius = 50;
    const apply = (e) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const l = Math.hypot(dx, dy);
      if (l > radius) {
        dx = (dx / l) * radius;
        dy = (dy / l) * radius;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      setter(dx / radius, dy / radius);
    };
    el.addEventListener("pointerdown", (e) => {
      pid = e.pointerId;
      el.setPointerCapture(pid);
      apply(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (pid === e.pointerId) apply(e);
    });
    const end = (e) => {
      if (pid !== e.pointerId) return;
      pid = null;
      knob.style.transform = "translate(0,0)";
      setter(0, 0);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  ui.roomTag.onclick = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => pushFeed("방 코드 복사됨: " + roomId));
  };

  ui.btnLeave.onclick = () => {
    pub("bye", { id: meId });
    showMenu();
  };

  $("btnPractice").onclick = startPractice;
  $("btnCreate").onclick = createRoom;
  $("btnJoin").onclick = joinRoom;
  $("btnCancelWait").onclick = () => {
    pub("bye", { id: meId });
    showMenu();
  };
  ui.roomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });

  window.addEventListener("beforeunload", () => pub("bye", { id: meId }));
  window.addEventListener("resize", resize);
  window.addEventListener("pointerdown", () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });

  ui.nameInput.value = "플레이어" + Math.floor(10 + Math.random() * 89);
  resize();
  bindInput();
  requestAnimationFrame(loop);
})();
