(() => {
  "use strict";

  const MAP_W = 800;
  const MAP_H = 560;
  const WALL = 18;
  const PLAYER_R = 14;
  const SPEED = 170;
  const MAX_HP = 100;
  const GUN_DMG = 10;
  const GUN_CD = 1;
  const SWORD_DMG = 20;
  const SWORD_CD = 1;
  const SWORD_RANGE = 52;
  const SWORD_ARC = Math.PI * 0.7;
  const BULLET_SPEED = 420;
  const BULLET_R = 3;
  const RESPAWN = 3;
  const NET_HZ = 12;
  const ACCESS = "QPDFJWOFNIBP";
  const TOPIC = "sector-arena-v3";
  const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];
  const COLORS = ["#111111", "#444444", "#777777", "#999999", "#555555", "#222222"];

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const $ = (id) => document.getElementById(id);

  const ui = {
    menu: $("menu"),
    hpFill: $("hpFill"),
    hpText: $("hpText"),
    killStat: $("killStat"),
    deathStat: $("deathStat"),
    meName: $("meName"),
    centerMsg: $("centerMsg"),
    atkCd: $("atkCd"),
    nameInput: $("nameInput"),
    codeInput: $("codeInput"),
    menuError: $("menuError"),
    moveKnob: $("moveKnob"),
    btnAtk: $("btnAtk"),
    btnLeave: $("btnLeave"),
    wepGun: $("wepGun"),
    wepSword: $("wepSword"),
    touch: $("touch"),
    connLabel: $("connLabel"),
    plist: $("plist"),
    chatlog: $("chatlog"),
    chatInput: $("chatInput"),
    chatform: $("chatform"),
  };

  const input = {
    mx: 0,
    my: 0,
    aimX: 0,
    aimY: 0,
    atk: false,
    mouseAim: false, // 기본값을 false로 지정하여 모바일 오류 방지
    keys: { w: false, a: false, s: false, d: false },
  };

  let dpr = 1;
  let viewW = 0;
  let viewH = 0;
  let lastT = 0;
  let shake = 0;
  let mode = "menu";
  let meId = uid();
  let myName = "user";
  let myColor = COLORS[0];
  let myWeapon = "gun";
  let roomId = "";
  let isHost = false;
  let mqttClient = null;
  let netAcc = 0;
  let nextBullet = 1;
  let nextFx = 1;
  let netEvents = [];
  let chatting = false;
  const lastMouse = { x: 0, y: 0 };

  const world = {
    players: {},
    bullets: [],
    fx: [],
    floats: [],
  };

  function uid() {
    return Math.random().toString(36).slice(2, 8);
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function ang(x, y) {
    return Math.atan2(y, x);
  }

  function normCode(s) {
    return String(s || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  }

  function spawnPos(i) {
    const pads = [
      { x: 70, y: 70 },
      { x: MAP_W - 70, y: MAP_H - 70 },
      { x: MAP_W - 70, y: 70 },
      { x: 70, y: MAP_H - 70 },
      { x: MAP_W / 2, y: 70 },
      { x: MAP_W / 2, y: MAP_H - 70 },
    ];
    return pads[i % pads.length];
  }

  function makePlayer(id, name, color, slot) {
    const p = spawnPos(slot);
    return {
      id,
      name: name || "user",
      color,
      x: p.x,
      y: p.y,
      a: 0,
      hp: MAX_HP,
      cd: 0,
      weapon: "gun",
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

  function weaponCd(w) {
    return w === "sword" ? SWORD_CD : GUN_CD;
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = Math.max(1, rect.width);
    viewH = Math.max(1, rect.height);
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(viewH * dpr);
    canvas.style.width = viewW + "px";
    canvas.style.height = viewH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function mapView() {
    const zoom = Math.min(viewW / MAP_W, viewH / MAP_H);
    return {
      zoom,
      ox: (viewW - MAP_W * zoom) / 2,
      oy: (viewH - MAP_H * zoom) / 2,
    };
  }

  function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    const { zoom, ox, oy } = mapView();
    return {
      x: (sx - rect.left - ox) / zoom,
      y: (sy - rect.top - oy) / zoom,
    };
  }

  function showTouch() {
    const coarse = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window || window.innerWidth <= 768;
    ui.touch.classList.toggle("hidden", !coarse);
  }

  function setError(msg) {
    ui.menuError.textContent = msg || "";
  }

  function showMenu() {
    mode = "menu";
    ui.menu.classList.remove("hidden");
    ui.connLabel.textContent = "대기";
    disconnect();
  }

  function enterGame(label) {
    mode = "play";
    ui.menu.classList.add("hidden");
    ui.connLabel.textContent = label;
    ui.meName.textContent = myName;
    showTouch();
    resize();
  }

  function resetWorld() {
    world.players = {};
    world.bullets = [];
    world.fx = [];
    world.floats = [];
    nextBullet = 1;
    netEvents = [];
    ui.chatlog.innerHTML = "";
  }

  function joinWorld() {
    if (typeof mqtt === "undefined") {
      setError("접속 모듈을 못 불러왔습니다.");
      return;
    }
    const code = normCode(ui.codeInput.value);
    if (code !== ACCESS) {
      setError("접근코드가 틀립니다.");
      return;
    }
    myName = (ui.nameInput.value || "user").slice(0, 10);
    myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    myWeapon = "gun";
    setWeaponUi("gun");
    roomId = ACCESS;
    isHost = false;
    resetWorld();
    world.players[meId] = Object.assign(makePlayer(meId, myName, myColor, 1), { weapon: myWeapon });
    setError("접속중...");
    connectMqtt((err) => {
      if (err) {
        setError(err.message || String(err));
        return;
      }
      mode = "wait";
      ui.connLabel.textContent = "접속중";
      pub("host?", { id: meId });
      pub("hello", { id: meId, name: myName, color: myColor, weapon: myWeapon });
      setTimeout(() => {
        if (mode !== "wait") return;
        isHost = true;
        enterGame("접속");
        addChat("", "접속되었습니다. 다른 접속자를 기다리는 중입니다.", true);
      }, 2200);
    });
  }

  function connectMqtt(onReady) {
    disconnect();
    let idx = 0;
    const tryNext = () => {
      if (idx >= BROKERS.length) {
        onReady(new Error("서버에 연결하지 못했습니다."));
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
        if (mqttClient === client && mode === "play") addChat("", "연결이 끊겼습니다.", true);
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
        world.players[msg.id] = Object.assign(makePlayer(msg.id, msg.name, msg.color, slot), {
          weapon: msg.weapon || "gun",
        });
        addChat("", msg.name + " 님이 들어왔습니다.", true);
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
      if (msg.weapon) p.weapon = msg.weapon;
      p.lastSeen = performance.now();
    }
    if (kind === "bye" && msg.id !== meId) {
      const p = world.players[msg.id];
      if (p) {
        addChat("", p.name + " 님이 나갔습니다.", true);
        delete world.players[msg.id];
      }
    }
    if (kind === "state" && !isHost && msg.host !== meId) {
      applyRemoteState(msg);
      for (const ev of msg.events || []) applyEvent(ev);
    }
    if (kind === "host?" && isHost) pub("hello-ack", { host: meId });
    if (kind === "hello-ack" && mode === "wait") {
      isHost = false;
      enterGame("접속");
      pub("hello", { id: meId, name: myName, color: myColor, weapon: myWeapon });
      addChat("", "접속했습니다.", true);
    }
    if (kind === "chat" && msg.id !== meId) {
      addChat(msg.name, msg.t, false);
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
        p.cd = rp.cd;
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
        p.weapon = rp.weapon || p.weapon;
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
    if (ev.k === "feed") addChat("", ev.t, true);
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
          cd: Math.round(p.cd * 100) / 100,
          weapon: p.weapon,
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

  function setWeapon(w) {
    myWeapon = w;
    setWeaponUi(w);
    const me = localPlayer();
    if (me) me.weapon = w;
  }

  function setWeaponUi(w) {
    ui.wepGun.classList.toggle("on", w === "gun");
    ui.wepSword.classList.toggle("on", w === "sword");
  }

  function equipped(p) {
    if (p.id === meId) return myWeapon;
    if (p._in && p._in.weapon) return p._in.weapon;
    return p.weapon || "gun";
  }

  function moveVector(p) {
    if (p.id === meId) {
      if (chatting) return { x: 0, y: 0 };
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
      if (Math.hypot(mv.x, mv.y) > 0.1) return ang(mv.x, mv.y); // 터치 이동 시 자동 조준 보정
      return p.a;
    }
    if (p._in && typeof p._in.a === "number") return p._in.a;
    return p.a;
  }

  function wantsAtk(p) {
    if (p.id === meId) return input.atk && !chatting;
    return !!(p._in && p._in.atk);
  }

  function collideWalls(ent, r) {
    ent.x = clamp(ent.x, WALL + r, MAP_W - WALL - r);
    ent.y = clamp(ent.y, WALL + r, MAP_H - WALL - r);
  }

  function inArena(x, y, r) {
    return x > WALL + r && x < MAP_W - WALL - r && y > WALL + r && y < MAP_H - WALL - r;
  }

  function attack(p) {
    const w = equipped(p);
    if (w === "sword") swingSword(p);
    else fireGun(p);
  }

  function fireGun(p) {
    if (!p.alive || p.cd > 0) return;
    p.cd = GUN_CD;
    const bx = p.x + Math.cos(p.a) * (PLAYER_R + 6);
    const by = p.y + Math.sin(p.a) * (PLAYER_R + 6);
    world.bullets.push({
      id: nextBullet++,
      x: bx,
      y: by,
      a: p.a,
      vx: Math.cos(p.a) * BULLET_SPEED,
      vy: Math.sin(p.a) * BULLET_SPEED,
      owner: p.id,
      life: 1.8,
    });
    addFx(bx, by, p.a, "muzzle");
    if (isHost) netEvents.push({ k: "muzzle", x: bx, y: by, a: p.a, from: p.id });
    beep(780, 0.04, 0.04);
  }

  function swingSword(p) {
    if (!p.alive || p.cd > 0) return;
    p.cd = SWORD_CD;
    addFx(p.x, p.y, p.a, "slash", p.color);
    if (isHost) netEvents.push({ k: "slash", x: p.x, y: p.y, a: p.a, c: p.color, from: p.id });
    beep(200, 0.07, 0.05);
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
    addFloat(target.x, target.y - 20, "-" + dmg);
    if (isHost) netEvents.push({ k: "dmg", x: target.x, y: target.y - 20, t: "-" + dmg });
    shake = Math.max(shake, 3);
    if (target.id === meId) vibrate(20);
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.respawn = RESPAWN;
      target.deaths += 1;
      attacker.kills += 1;
      addFx(target.x, target.y, 0, "boom", target.color);
      const line = attacker.name + " 님이 " + target.name + " 님을 " + weapon + "으로 쓰러뜨렸습니다.";
      addChat("", line, true);
      if (isHost) {
        netEvents.push({ k: "boom", x: target.x, y: target.y, c: target.color });
        netEvents.push({ k: "feed", t: line });
      }
      beep(90, 0.18, 0.07);
    }
  }

  function addFx(x, y, a, kind, color) {
    world.fx.push({ id: nextFx++, x, y, a, kind, color, t: 0, life: kind === "boom" ? 0.4 : 0.16 });
  }

  function addFloat(x, y, text) {
    world.floats.push({ x, y, text, t: 0 });
  }

  function addChat(name, text, sys) {
    const line = document.createElement("div");
    if (sys) {
      line.className = "sys";
      line.textContent = "* " + text;
    } else {
      const who = document.createElement("span");
      who.className = name === myName ? "me" : "nm";
      who.textContent = name;
      line.appendChild(who);
      line.appendChild(document.createTextNode(" : " + text));
    }
    ui.chatlog.appendChild(line);
    while (ui.chatlog.childNodes.length > 80) ui.chatlog.removeChild(ui.chatlog.firstChild);
    ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
  }

  function sendChat() {
    const t = ui.chatInput.value.trim().slice(0, 60);
    if (!t) return;
    addChat(myName, t, false);
    pub("chat", { id: meId, name: myName, t });
    ui.chatInput.value = "";
  }

  function updateBots(dt) {
    const humans = Object.values(world.players).filter((p) => p.alive && !p.bot);
    for (const b of Object.values(world.players)) {
      if (!b.bot || !b.alive) continue;
      const target = humans[0];
      if (!target) continue;
      const dx = target.x - b.x;
      const dy = target.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      b.a = ang(dx, dy);
      const want = d > 140 ? 1 : d < 50 ? -0.4 : 0.1;
      b.x += (dx / d) * SPEED * 0.7 * want * dt;
      b.y += (dy / d) * SPEED * 0.7 * want * dt;
      collideWalls(b, PLAYER_R);
      if (d < SWORD_RANGE + 8) {
        b.weapon = "sword";
        b._in = { atk: true, mx: 0, my: 0, a: b.a, weapon: "sword" };
      } else {
        b.weapon = "gun";
        b._in = { atk: d < 360, mx: 0, my: 0, a: b.a, weapon: "gun" };
      }
    }
  }

  function update(dt) {
    if (mode !== "play") return;
    const hostSim = isHost || !roomId;
    const me = localPlayer();
    if (me) me.weapon = myWeapon;

    if (!isHost && roomId) {
      for (const p of Object.values(world.players)) {
        if (p.id === meId && p.alive) {
          const mv = moveVector(p);
          p.x += mv.x * SPEED * dt;
          p.y += mv.y * SPEED * dt;
          collideWalls(p, PLAYER_R);
          p.a = aimAngle(p);
          p.cd = Math.max(0, p.cd - dt);
          if (wantsAtk(p)) attack(p);
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
          addChat("", p.name + " 님 연결 끊김", true);
          delete world.players[p.id];
          continue;
        }
        p.cd = Math.max(0, p.cd - dt);
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
        if (wantsAtk(p)) attack(p);
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
            a.x -= (dx / d) * push;
            a.y -= (dy / d) * push;
            b.x += (dx / d) * push;
            b.y += (dy / d) * push;
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
      f.y -= 22 * dt;
    }
    world.floats = world.floats.filter((f) => f.t < 0.7);
    shake *= Math.pow(0.02, dt);

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
            atk: input.atk && !chatting,
            weapon: myWeapon,
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
    ui.hpFill.style.transform = "scaleX(" + hp / MAX_HP + ")";
    ui.hpText.textContent = Math.max(0, Math.ceil(hp)) + "/" + MAX_HP;
    ui.killStat.textContent = String(me.kills);
    ui.deathStat.textContent = String(me.deaths);
    const maxCd = weaponCd(equipped(me));
    ui.atkCd.style.transform = "scaleX(" + (1 - me.cd / maxCd) + ")";
    if (!me.alive) {
      ui.centerMsg.classList.remove("hidden");
      ui.centerMsg.textContent = "쓰러짐  " + Math.ceil(me.respawn) + "초 후 부활";
    } else ui.centerMsg.classList.add("hidden");

    const rows = Object.values(world.players)
      .map((p) => p.name + "  " + (p.alive ? p.hp : "DOWN") + "  K" + p.kills)
      .join("<br>");
    ui.plist.innerHTML = rows || "-";
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, viewW, viewH);
    const { zoom, ox, oy } = mapView();
    const sx = shake ? (Math.random() - 0.5) * shake : 0;
    const sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.save();
    ctx.translate(ox + sx, oy + sy);
    ctx.scale(zoom, zoom);

    ctx.fillStyle = "#e9e9e9";
    ctx.fillRect(0, 0, MAP_W, MAP_H);
    ctx.strokeStyle = "#d2d2d2";
    ctx.lineWidth = 1;
    for (let x = WALL; x < MAP_W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, WALL);
      ctx.lineTo(x, MAP_H - WALL);
      ctx.stroke();
    }
    for (let y = WALL; y < MAP_H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(WALL, y);
      ctx.lineTo(MAP_W - WALL, y);
      ctx.stroke();
    }

    const blocks = [
      [118, 106, 126, 48], [555, 100, 122, 48], [312, 250, 178, 62],
      [108, 398, 148, 44], [544, 402, 150, 44], [365, 86, 72, 74],
    ];
    for (const [x, y, w, h] of blocks) {
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(x + 4, y + 4, w - 8, 3);
      ctx.fillStyle = "#d5d5d5";
    }
    ctx.strokeStyle = "#777";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(MAP_W / 2, WALL + 8);
    ctx.lineTo(MAP_W / 2, MAP_H - WALL - 8);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, MAP_W, WALL);
    ctx.fillRect(0, MAP_H - WALL, MAP_W, WALL);
    ctx.fillRect(0, 0, WALL, MAP_H);
    ctx.fillRect(MAP_W - WALL, 0, WALL, MAP_H);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.strokeRect(0.5, 0.5, MAP_W - 1, MAP_H - 1);

    for (const f of world.fx) {
      const k = 1 - f.t / f.life;
      ctx.globalAlpha = k;
      if (f.kind === "slash") {
        ctx.beginPath();
        ctx.arc(f.x, f.y, SWORD_RANGE, f.a - SWORD_ARC / 2, f.a + SWORD_ARC / 2);
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (f.kind === "muzzle") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(f.x - 2, f.y - 2, 5, 5);
      } else if (f.kind === "boom") {
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(f.x, f.y, 10 + (1 - k) * 16, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(f.x - 1, f.y - 1, 3, 3);
      }
      ctx.globalAlpha = 1;
    }

    for (const b of world.bullets) {
      ctx.fillStyle = "#222";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath();
      ctx.arc(b.x, b.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of Object.values(world.players)) drawPlayer(p);

    ctx.font = "12px Gulim, Dotum, Tahoma, sans-serif";
    ctx.textAlign = "center";
    for (const f of world.floats) {
      ctx.globalAlpha = 1 - f.t / 0.7;
      ctx.fillStyle = "#ff0";
      ctx.fillText(f.text, f.x, f.y);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawPlayer(p) {
    ctx.save();
    if (!p.alive) ctx.globalAlpha = 0.35;
    ctx.translate(p.x, p.y);
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(1, 1, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.rotate(p.a);
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(PLAYER_R - 1, 0);
    ctx.lineTo(PLAYER_R + 8, -5);
    ctx.lineTo(PLAYER_R + 8, 5);
    ctx.closePath();
    ctx.fill();
    if (equipped(p) === "gun") {
      ctx.fillStyle = "#222";
      ctx.fillRect(PLAYER_R - 2, -2, 12, 4);
    } else {
      ctx.strokeStyle = "#ccc";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(PLAYER_R + 10, 0);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = "#000";
    ctx.fillRect(p.x - 16, p.y - PLAYER_R - 12, 32, 5);
    ctx.fillStyle = "#111";
    ctx.fillRect(p.x - 16, p.y - PLAYER_R - 12, 32 * (p.hp / MAX_HP), 5);
    ctx.strokeStyle = "#000";
    ctx.strokeRect(p.x - 16, p.y - PLAYER_R - 12, 32, 5);
    ctx.fillStyle = "#fff";
    ctx.font = "11px Gulim, Dotum, Tahoma, sans-serif";
    ctx.textAlign = "center";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, p.x, p.y - PLAYER_R - 16);
    ctx.fillText(p.name, p.x, p.y - PLAYER_R - 16);
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
      if (chatting) {
        if (e.key === "Escape") {
          ui.chatInput.blur();
          e.preventDefault();
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k in input.keys) input.keys[k] = true;
      if (k === " ") {
        input.atk = true;
        e.preventDefault();
      }
      if (k === "1") setWeapon("gun");
      if (k === "2") setWeapon("sword");
      if (k === "enter") {
        ui.chatInput.focus();
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
      if (k === " ") input.atk = false;
    });

    // 마우스 조작인 경우에만 mouseAim 활성화
    window.addEventListener("mousemove", (e) => {
      if (e.pointerType === "mouse" || !e.pointerType) {
        lastMouse.x = e.clientX;
        lastMouse.y = e.clientY;
        input.mouseAim = true;
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      if (mode !== "play" || chatting) return;
      if (e.button === 0) {
        input.mouseAim = true;
        input.atk = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) input.atk = false;
    });

    bindStick("moveStick", ui.moveKnob, (x, y) => {
      input.mx = x;
      input.my = y;
      if (x !== 0 || y !== 0) input.mouseAim = false; // 조이스틱 조작 시 마우스 조준 해제
    });

    const on = (e) => {
      e.preventDefault();
      input.mouseAim = false;
      input.atk = true;
      ui.btnAtk.classList.add("held");
    };
    const off = (e) => {
      e.preventDefault();
      input.atk = false;
      ui.btnAtk.classList.remove("held");
    };
    ui.btnAtk.addEventListener("pointerdown", on);
    ui.btnAtk.addEventListener("pointerup", off);
    ui.btnAtk.addEventListener("pointercancel", off);
    ui.btnAtk.addEventListener("pointerleave", off);
  }

  function bindStick(id, knob, setter) {
    const el = $(id);
    let pid = null;
    const radius = 42;
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
      knob.style.transform = "translate(" + dx + "px," + dy + "px)";
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

  ui.wepGun.onclick = () => setWeapon("gun");
  ui.wepSword.onclick = () => setWeapon("sword");
  ui.btnLeave.onclick = () => {
    pub("bye", { id: meId });
    showMenu();
  };
  $("btnJoin").onclick = joinWorld;
  ui.codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinWorld();
  });
  ui.chatform.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChat();
  });
  ui.chatInput.addEventListener("focus", () => { chatting = true; });
  ui.chatInput.addEventListener("blur", () => { chatting = false; });

  window.addEventListener("beforeunload", () => pub("bye", { id: meId }));
  window.addEventListener("resize", () => {
    resize();
    showTouch();
  });
  window.addEventListener("pointerdown", () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });

  ui.nameInput.value = "user" + Math.floor(10 + Math.random() * 89);
  ui.codeInput.value = "";
  resize();
  bindInput();
  requestAnimationFrame(loop);
})();
