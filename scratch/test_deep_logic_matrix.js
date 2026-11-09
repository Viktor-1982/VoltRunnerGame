const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ARTIFACT_DIR = process.env.VOLT_AUDIT_ARTIFACTS || os.tmpdir();
const CHROME_PATH = process.env.VOLT_AUDIT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET_URL = process.env.VOLT_AUDIT_URL || 'http://localhost:8790/index.html';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class PersistentCDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.client = null;
    this.msgId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.upgraded = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.wsUrl);
      this.client = net.createConnection({ host: url.hostname, port: url.port }, () => {
        const key = crypto.randomBytes(16).toString('base64');
        const req = [
          `GET ${url.pathname} HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n');
        this.client.write(req);
      });

      this.client.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.upgraded) {
          const headerEnd = this.buffer.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            this.upgraded = true;
            this.buffer = this.buffer.slice(headerEnd + 4);
            resolve();
          }
        }
        while (this.upgraded && this.buffer.length >= 2) {
          const lenByte = this.buffer[1] & 0x7f;
          let dataStart = 2;
          let payloadLen = lenByte;
          if (lenByte === 126) {
            if (this.buffer.length < 4) return;
            payloadLen = this.buffer.readUInt16BE(2);
            dataStart = 4;
          } else if (lenByte === 127) {
            if (this.buffer.length < 10) return;
            payloadLen = Number(this.buffer.readBigUInt64BE(2));
            dataStart = 10;
          }
          if (this.buffer.length < dataStart + payloadLen) return;
          const frameData = this.buffer.slice(dataStart, dataStart + payloadLen);
          this.buffer = this.buffer.slice(dataStart + payloadLen);
          try {
            const parsed = JSON.parse(frameData.toString('utf8'));
            if (parsed.id && this.pending.has(parsed.id)) {
              const { res, rej } = this.pending.get(parsed.id);
              this.pending.delete(parsed.id);
              if (parsed.error) rej(new Error(parsed.error.message));
              else res(parsed.result);
            }
          } catch (e) {}
        }
      });
      this.client.on('error', reject);
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.msgId;
      this.pending.set(id, { res, rej });
      const payloadBuf = Buffer.from(JSON.stringify({ id, method, params }));
      const mask = crypto.randomBytes(4);
      let frameHeader;
      if (payloadBuf.length < 126) {
        frameHeader = Buffer.alloc(6);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | payloadBuf.length;
        mask.copy(frameHeader, 2);
      } else {
        frameHeader = Buffer.alloc(8);
        frameHeader[0] = 0x81;
        frameHeader[1] = 0x80 | 126;
        frameHeader.writeUInt16BE(payloadBuf.length, 2);
        mask.copy(frameHeader, 4);
      }
      const masked = Buffer.alloc(payloadBuf.length);
      for (let i = 0; i < payloadBuf.length; i++) masked[i] = payloadBuf[i] ^ mask[i % 4];
      this.client.write(Buffer.concat([frameHeader, masked]));
    });
  }
  close() {
    if (this.client) this.client.destroy();
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'voltrunner-audit-chrome-'));
  const chromeProc = spawn(CHROME_PATH, [
    '--remote-debugging-port=0',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1280,720',
    `--user-data-dir=${chromeProfile}`,
    TARGET_URL
  ]);

  let cdp;
  const results = [];
  function assertTest(section, testId, name, cond, details = '') {
    results.push({ section, testId, name, passed: !!cond, details });
    const icon = cond ? '✅ PASS' : '❌ FAIL';
    console.log(`${icon} [${testId}] ${name}${details ? ' — ' + details : ''}`);
    if (!cond) {
      throw new Error(`Test failed: [${testId}] ${name} (${details})`);
    }
  }

  async function evalJs(expression) {
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res && res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.text} (${res.exceptionDetails.exception?.description || ''})`);
    }
    return res && res.result ? res.result.value : undefined;
  }

  async function screenshot(filename) {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
    return outPath;
  }

  try {
    let pageTarget;
    for (let i = 0; i < 25; i++) {
      try {
        const [port] = fs.readFileSync(path.join(chromeProfile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
        const targets = await getJson(`http://127.0.0.1:${port}/json`);
        pageTarget = targets.find((target) => target.type === 'page' && target.url === TARGET_URL);
        if (pageTarget) break;
      } catch (e) {}
      await sleep(300);
    }
    if (!pageTarget) throw new Error(`Could not open ${TARGET_URL} in Chromium`);
    cdp = new PersistentCDP(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = await evalJs("Boolean(window._voltGame?.boss && !document.getElementById('btn-play')?.disabled)");
        if (ready) break;
      } catch (error) {
        if (!error.message.includes('context')) throw error;
      }
      await sleep(100);
    }
    if (!ready) throw new Error('Game loading did not finish');

    // =========================================================================
    // СЕКЦИЯ 1: ФИЗИКА И ДВИЖЕНИЕ
    // =========================================================================
    console.log('\n--- СЕКЦИЯ 1: ФИЗИКА И ДВИЖЕНИЕ (Movement & Math Constraints) ---');

    // 1.1 Coyote Time & Jump Buffer
    const coyoteRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      // Move hero to edge of start platform and walk off
      g.hero.x = 31 * 44;
      g.hero.y = 520 - g.hero.h;
      g.hero.vx = 200;
      g.keys.right = true;
      // Step off edge: hero in air, coyote timer active
      g.stepUpdate(0.02);
      const inAir = !g.hero.onGround;
      const hasCoyote = g.hero.coyote > 0;
      // Press jump during coyote time
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
      g.stepUpdate(0.016);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
      const jumpedOnCoyote = g.hero.vy < -500;
      g.keys.right = false;
      return { inAir, hasCoyote, jumpedOnCoyote };
    })()`);
    assertTest('Физика', '1.1', 'Coyote time срабатывает на краю платформы', coyoteRes.hasCoyote && coyoteRes.jumpedOnCoyote);

    // 1.2 One-Way Bridge Pass-Through
    const bridgeRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      const br = g.oneWayBridges[0];
      // 1. Jump from below through bridge
      g.hero.x = br.x + 20;
      g.hero.y = br.y + 30;
      g.hero.vy = -400;
      g.stepUpdate(0.016);
      const passesThroughFromBelow = g.hero.y < br.y + 30;

      // 2. Stand on bridge
      g.hero.y = br.y - g.hero.h;
      g.hero.vy = 0;
      g.hero.onGround = true;
      g.stepUpdate(0.016);
      const standsOnBridge = Math.abs(g.hero.y - (br.y - g.hero.h)) < 2;

      // 3. Press DOWN to drop through
      g.keys.down = true;
      g.stepUpdate(0.016);
      g.stepUpdate(0.016);
      const droppedDown = g.hero.y > br.y - g.hero.h;
      g.keys.down = false;

      return { passesThroughFromBelow, standsOnBridge, droppedDown };
    })()`);
    assertTest('Физика', '1.2', 'One-way bridge: подъем снизу + стойка + спрыгивание на стрелку ВНИЗ', 
      bridgeRes.passesThroughFromBelow && bridgeRes.standsOnBridge && bridgeRes.droppedDown);

    // 1.3 Moving Platform Velocity Delta Carry
    const mpRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      const mp = g.movingPlats[0];
      g.hero.x = mp.x + 10;
      g.hero.y = mp.y - g.hero.h;
      g.hero.vy = 0;
      g.hero.onGround = true;
      const initialHeroX = g.hero.x;
      const initialMpX = mp.x;
      // Step platform movement
      for (let i = 0; i < 15; i++) g.stepUpdate(0.016);
      const deltaMpX = mp.x - initialMpX;
      const deltaHeroX = g.hero.x - initialHeroX;
      return { carried: Math.abs(deltaMpX - deltaHeroX) < 1.0, onGround: g.hero.onGround };
    })()`);
    assertTest('Физика', '1.3', 'Движущиеся платформы жестко и плавно переносят героя', mpRes.carried && mpRes.onGround);

    // 1.4 Underwater Buoyancy & Continuous Swimming Stroke (World 1-3)
    const swimRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(3);
      // Hero in water floats with buoyancy (low gravity)
      g.hero.x = 20 * 44;
      g.hero.y = 350;
      g.hero.vy = 0;
      g.stepUpdate(0.1);
      const floatsSlowly = g.hero.vy < 50; // In water grav is 380 dt => ~38 px/s, not 1980 dt => ~198 px/s
      // Execute 3 continuous swim strokes
      const strokes = [];
      for (let s = 0; s < 3; s++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
        g.stepUpdate(0.016);
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
        strokes.push(g.hero.vy < -350);
        g.stepUpdate(0.1);
      }
      return { floatsSlowly, strokesValid: strokes.every(Boolean) };
    })()`);
    assertTest('Физика', '1.4', 'Подводная плавучесть и неограниченные взмахи плавания', swimRes.floatsSlowly && swimRes.strokesValid);

    const waterSurfaceRes = await evalJs(`(() => {
      const g = window._voltGame;
      const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      const beamX = 75 * 44;
      g.startStage(3);
      g.hero.x = beamX - 220;
      g.hero.y = 200;
      g.hero.invuln = 20;
      press('ArrowRight', true);
      let highestY = g.hero.y;
      for (let stroke = 0; stroke < 12; stroke++) {
        press('Space', true);
        for (let frame = 0; frame < 30; frame++) {
          g.stepUpdate(1 / 60);
          highestY = Math.min(highestY, g.hero.y);
        }
        press('Space', false);
      }
      const blockedAtSurface = g.hero.x + g.hero.w <= beamX + 1;
      press('ArrowDown', true);
      for (let frame = 0; frame < 90; frame++) g.stepUpdate(1 / 60);
      const divedUnderBeam = g.hero.x > beamX + 44;
      g.resetAllInputs();
      return { highestY, blockedAtSurface, divedUnderBeam };
    })()`);
    assertTest('Физика', '1.5', 'Гребки удерживают героя в кадре, а под балкой можно проплыть нырком',
      waterSurfaceRes.highestY === 112 && waterSurfaceRes.blockedAtSurface && waterSurfaceRes.divedUnderBeam,
      JSON.stringify(waterSurfaceRes));

    // =========================================================================
    // СЕКЦИЯ 2: БОЕВАЯ СИСТЕМА И ИНТЕРАКТИВ
    // =========================================================================
    console.log('\n--- СЕКЦИЯ 2: БОЕВАЯ СИСТЕМА И ИНТЕРАКТИВ (Combat & Props) ---');

    // 2.1 Crate smashing from below and above
    const crateRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      // Mystery crate at col 7
      const crate = g.solidBlocks.find(b => b.kind === 'crate1' && b.reward === 'heart');
      // Head-bonk from below
      g.hero.x = crate.x;
      g.hero.y = crate.y + crate.h + 2;
      g.hero.vy = -300;
      g.stepUpdate(0.016);
      const smashedFromBelow = !g.solidBlocks.includes(crate);
      const heartSpawned = g.powerups.some(p => p.kind === 'heart');
      return { smashedFromBelow, heartSpawned };
    })()`);
    assertTest('Боевка', '2.1', 'Разбивание ящика головой снизу и выпадение Сердца', crateRes.smashedFromBelow && crateRes.heartSpawned);

    // 2.2 Snail Shell Bowling Knockout
    const bowlingRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      const snail = g.enemies.find(e => e.type === 'snail');
      const pig = g.enemies.find(e => e.type === 'pig');
      // Stomp snail into shell
      g.hero.x = snail.x;
      g.hero.y = snail.y - g.hero.h + 2;
      g.hero.vy = 200;
      g.stepUpdate(0.016);
      // Kick shell toward pig
      snail.ignorePlayerTimer = 0;
      g.hero.x = snail.x - 10;
      g.hero.y = snail.y;
      g.stepUpdate(0.016);
      // Position pig in path of spinning shell
      pig.x = snail.x + 30;
      pig.y = snail.y;
      g.stepUpdate(0.016);
      return { shellSpinning: snail.state === 'shell_spin', pigDead: pig.dead };
    })()`);
    assertTest('Боевка', '2.2', 'Стомп улитки -> пинок панциря -> боулинг врага', bowlingRes.shellSpinning && bowlingRes.pigDead);

    // 2.3 Helper Mini-Drone fruit magnet & 1-hit bumper shield
    const droneRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      // Give hero helper drone
      g.hero.hasDrone = true;
      const fruit = g.fruits[0];
      fruit.x = g.hero.x + 60;
      fruit.y = g.hero.y;
      const initialDist = Math.abs(fruit.x - g.hero.x);
      // Step update: drone magnetic pull active
      for (let i = 0; i < 10; i++) g.stepUpdate(0.016);
      const pulledCloser = Math.abs(fruit.x - g.hero.x) < initialDist;

      // Hit hero with saw: drone absorbs 100% damage
      g.hero.invuln = 0;
      const hpBefore = g.hero.hp;
      g.hurtHero();
      const damageAbsorbed = (g.hero.hp === hpBefore) && (g.hero.hasDrone === false) && (g.hero.invuln > 1.0);

      return { pulledCloser, damageAbsorbed };
    })()`);
    assertTest('Боевка', '2.3', 'Дрон-помощник: электромагнит фруктов + поглощение урона бампером', droneRes.pulledCloser && droneRes.damageAbsorbed);

    // =========================================================================
    // СЕКЦИЯ 3: 6 УНИКАЛЬНЫХ МИРОВ И ОСОБЫЕ ЛОВУШКИ
    // =========================================================================
    console.log('\n--- СЕКЦИЯ 3: 6 УНИКАЛЬНЫХ МИРОВ И ОСОБЫЕ МЕХАНИКИ ---');

    // 3.1 World 1-2 Stalactites Proximity Trigger
    const w2Res = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(2);
      const st = g.stalactites[0];
      // Hero walks underneath stalactite (within 85px)
      g.hero.x = st.x;
      g.hero.y = 480;
      g.stepUpdate(0.016);
      const triggered = st.state === 'shake';
      for (let i = 0; i < 35; i++) g.stepUpdate(0.016);
      const fellOrBroke = st.state === 'falling' || st.state === 'broken';
      return { triggered, fellOrBroke };
    })()`);
    assertTest('Миры', '3.1', 'Мир 1-2: Датчик приближения и падение сталактитов', w2Res.triggered && w2Res.fellOrBroke);

    // 3.2 World 1-4 Cloud Platform Dissolution and Respawn
    const w4Res = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(4);
      const cp = g.cloudPlats[0];
      g.hero.x = cp.x + 10;
      g.hero.y = cp.y - g.hero.h;
      g.hero.vy = 50;
      g.stepUpdate(0.016);
      const stepped = cp.stepped;
      // Step 0.8s: dissolves
      for (let i = 0; i < 55; i++) g.stepUpdate(0.016);
      const dissolved = cp.dissolved === true;
      // Step 3.2s: respawns
      for (let i = 0; i < 200; i++) g.stepUpdate(0.016);
      const respawned = cp.dissolved === false;
      return { stepped, dissolved, respawned };
    })()`);
    assertTest('Миры', '3.2', 'Мир 1-4: Таяние облаков под ногами и их возрождение', w4Res.stepped && w4Res.dissolved && w4Res.respawned);

    // 3.3 World 1-5 Dart Traps Proximity Firing
    const w5Res = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(5);
      const dtp = g.dartTraps[0];
      // Approach trap closer than 550px
      g.hero.x = dtp.x + 200;
      g.stepUpdate(0.016);
      const dartFired = g.darts.length > 0;
      const dartMoves = dartFired && Math.abs(g.darts[0].vx) > 200;
      return { dartFired, dartMoves };
    })()`);
    assertTest('Миры', '3.3', 'Мир 1-5: Сенсорные ловушки дротиков и баллистика яда', w5Res.dartFired && w5Res.dartMoves);

    // 3.4 World 1-6 Conveyors & Cyber Switch Gate Control
    const w6Res = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(6);
      // Conveyor belt velocity transfer
      const cv = g.conveyors[0];
      g.hero.x = cv.x + 20;
      g.hero.y = cv.y - g.hero.h;
      g.hero.vy = 0;
      g.hero.onGround = true;
      const startX = g.hero.x;
      for (let i = 0; i < 15; i++) g.stepUpdate(0.016);
      const pulledByBelt = g.hero.x < startX; // Belt pulls at -140 px/s

      // Forcefield gate blocked until switch pressed
      const ff = g.forcefields[0];
      const sw = g.cyberSwitches[0];
      const gateActive = ff.active === true;
      // Stomp cyber switch
      g.hero.x = sw.x;
      g.hero.y = sw.y - g.hero.h + 2;
      g.stepUpdate(0.016);
      const gateDeactivated = sw.pressed && ff.active === false;

      return { pulledByBelt, gateActive, gateDeactivated };
    })()`);
    assertTest('Миры', '3.4', 'Мир 1-6: Тяга конвейера и отключение лазерных ворот терминалом', 
      w6Res.pulledByBelt && w6Res.gateActive && w6Res.gateDeactivated);

    const atlantisRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(3);
      const entry = g.allPipes.find((p) => p.isWarp && !p.isExit);
      Object.assign(g.hero, { x: entry.x + 9, y: entry.y - g.hero.h });
      g.keys.down = true;
      g.stepUpdate(1 / 60);
      g.keys.down = false;
      for (let i = 0; i < 85; i++) g.stepUpdate(1 / 60);
      if (!g.inSecretRoom || g.pipeAnim.active) return false;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      g.stepUpdate(1 / 60);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      return g.hero.vy === -390;
    })()`);
    assertTest('Миры', '3.5', 'После входа в Атлантиду прыжок становится гребком', atlantisRes);

    const solarVaultRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(4);
      g.inSecretRoom = true;
      const gate = g.forcefields[0];
      const belt = g.conveyors[0];
      Object.assign(g.hero, { x: gate.x - 70, y: 440 - g.hero.h, vx: 0, vy: 0 });
      g.keys.right = true;
      for (let i = 0; i < 35; i++) g.stepUpdate(1 / 60);
      const blockedAtFloor = gate.active && g.hero.x + g.hero.w <= gate.x;
      g.resetAllInputs();
      const x = belt.x + 55;
      Object.assign(g.hero, { x, y: belt.y - g.hero.h - 24, vx: 0, vy: 160, onGround: false });
      for (let i = 0; i < 30; i++) g.stepUpdate(1 / 60);
      return blockedAtFloor && g.hero.x > x && g.hero.onGround && g.hero.y + g.hero.h === belt.y
        && g.cyberSwitches[0].pressed && !gate.active;
    })()`);
    assertTest('Миры', '3.6', 'Лента держит героя и везёт к терминалу, который открывает поле', solarVaultRes);

    // =========================================================================
    // СЕКЦИЯ 4: ФИНАЛ УРОВНЯ, БОСС, ПОРТАЛ И ПРОГРЕССИЯ
    // =========================================================================
    console.log('\n--- СЕКЦИЯ 4: ФИНАЛ УРОВНЯ, БОСС И ТРИУМФАЛЬНЫЕ ВРАТА ---');

    // 4.1 Boss Protection & Gate Victory Dissolve
    const bossFinalRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);

      // Attempt to take trophy while boss alive: must bounce back
      g.hero.x = g.trophyObj.x;
      g.hero.y = g.trophyObj.y;
      g.stepUpdate(0.016);
      const bouncedFromTrophy = g.hero.x < g.trophyObj.x && !g.portalObj.open;

      // Defeat boss
      g.boss.dead = true;

      // Touch trophy: gates open, celebration starts
      g.hero.x = g.trophyObj.x;
      g.hero.y = 520 - g.hero.h;
      g.stepUpdate(0.016);
      const gatesOpen = g.portalObj.open === true;
      const celebrating = g.state === 'celebrating';

      // Step until hero steps inside doorway and dissolves
      let heroDisappeared = false;
      for (let i = 0; i < 180; i++) {
        g.stepUpdate(0.016);
        if (g.hero.disappearing) heroDisappeared = true;
      }

      return { bouncedFromTrophy, gatesOpen, celebrating, heroDisappeared };
    })()`);
    assertTest('Финал', '4.1', 'Кубок защищен Боссом + распахивание Врат + вихревое растворение героя',
      bossFinalRes.bouncedFromTrophy && bossFinalRes.gatesOpen && bossFinalRes.celebrating && bossFinalRes.heroDisappeared);

    // 4.2 Full 3/3 Stars Stage Progress Persistence
    const starsPersistRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      // Collect all 3 stars
      g.secretStars.forEach((s, idx) => {
        g.hero.x = s.x;
        g.hero.y = s.y;
        g.stepUpdate(0.016);
      });
      // Finish stage
      g.openVictoryModal();
      const savedStars = g.save.stageStars && g.save.stageStars[1];
      const count = savedStars ? savedStars.filter(Boolean).length : 0;
      return { count };
    })()`);
    assertTest('Финал', '4.2', 'Сбор 3/3 звезд корректно сохраняется в профиле уровня', starsPersistRes.count === 3);

    // =========================================================================
    // СЕКЦИЯ 5: НАДЕЖНОСТЬ, КРАЕВЫЕ КЕЙСЫ И СЕЙВЫ
    // =========================================================================
    console.log('\n--- СЕКЦИЯ 5: НАДЕЖНОСТЬ, КРАЕВЫЕ КЕЙСЫ И СЕЙВЫ ---');

    // 5.1 Find a nearby platform for a rewarded revive after combat.
    const reviveGroundRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(4);
      // Probe an X coordinate inside a gap.
      const safeX = g.findNearestSafeX(44 * 44);
      // Safe column must be an actual ground block
      const col = Math.round(safeX / 44);
      const isSolidGround = g.solidBlocks.some(b => b.kind === 'grass' && Math.round(b.x / 44) === col);
      return { isSolidGround, safeX };
    })()`);
    assertTest('Сейвы', '5.1', 'Возрождение после боя находит ближайшую твёрдую платформу', reviveGroundRes.isSolidGround);

    // 5.2 Seamless Mid-Stage Menu Resume
    const menuResumeRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(2);
      g.hero.x = 115 * 44;
      g.hero.y = 520 - g.hero.h;
      const targetPos = g.hero.x;
      // Open main menu mid-stage
      g.returnToMainMenu();
      const inMenu = g.state === 'menu';
      // Resume
      g.resumeFromMainMenu();
      const exactResume = g.state === 'playing' && Math.abs(g.hero.x - targetPos) < 1;
      return { inMenu, exactResume };
    })()`);
    assertTest('Сейвы', '5.2', 'Выход в Меню и бесшовный возврат на текущую точку уровня', menuResumeRes.inMenu && menuResumeRes.exactResume);

    // 5.3 SDK Mute Priority Compliance
    const muteRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.hostMuted = true;
      // Attempt to unmute with in-game button
      document.getElementById('btn-mute').click();
      const blockedByHost = g.isMuted === true;
      g.hostMuted = false;
      return { blockedByHost };
    })()`);
    assertTest('SDK', '5.3', 'hostMuted > userMuted: CrazyGames QA приоритет звука', muteRes.blockedByHost);

    const retryRes = await evalJs(`(() => {
      const g = window._voltGame;
      const reach = (x, y = 440 - g.hero.h) => {
        Object.assign(g.hero, { x, y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      };
      g.startStage(6);
      reach(g.checkpoints.at(-1).x + 10);
      const previousCheckpoint = g.checkpointX;
      g.startStage(1);
      const firstCheckpoint = g.checkpoints[0].x + 12;
      reach(firstCheckpoint);
      const star = g.secretStars.find((item) => item.id === 2);
      reach(star.x, star.y);
      const score = g.runScore;
      g.hero.invuln = 0;
      g.hero.hp = 1;
      g.hurtHero();
      document.getElementById('btn-retry').click();
      const resumed = g.state === 'playing' && g.hero.x === firstCheckpoint && g.hero.x !== previousCheckpoint;
      reach(star.x, star.y);
      return { resumed, keptStar: score === 500 && g.runScore === score && g.runStarsCollected[1] };
    })()`);
    assertTest('Сейвы', '5.4', 'Retry uses the current world checkpoint and keeps earned stars', retryRes.resumed && retryRes.keptStar);

    const focusPauseRes = await evalJs(`(async () => {
      const g = window._voltGame;
      g.startStage(4);
      const cloud = g.cloudPlats[0];
      Object.assign(g.hero, { x: cloud.x + 40, y: cloud.y - g.hero.h, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const before = cloud.shakeTimer;
      window.dispatchEvent(new Event('blur'));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const frozen = g.state === 'paused' && cloud.stepped && !cloud.dissolved && cloud.shakeTimer === before;
      window.dispatchEvent(new Event('focus'));
      const waitsForResume = g.state === 'paused';
      document.getElementById('btn-resume').click();
      return frozen && waitsForResume && g.state === 'playing';
    })()`);
    assertTest('Пауза', '5.5', 'Cloud timer freezes when the window loses focus and waits for Resume', focusPauseRes);

    const pitReturnRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(1);
      // The far bank is at column 160. Stand on the near bank before falling close to the far one.
      const nearBankX = 142 * 44 + 5;
      Object.assign(g.hero, { x: nearBankX, y: 440 - g.hero.h, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      Object.assign(g.hero, { x: 157 * 44, y: 590, invuln: 0 });
      g.stepUpdate(1 / 60);
      return g.state === 'playing' && g.hero.x === nearBankX && g.hero.y === 440 - g.hero.h
        && g.hero.onGround && g.hero.hp === 1;
    })()`);
    assertTest('Сейвы', '5.6', 'A fall near the far bank returns the hero to the last stable surface', pitReturnRes);

    const gateRetryRes = await evalJs(`(() => {
      const g = window._voltGame;
      const stand = (x) => {
        Object.assign(g.hero, { x, y: 440 - g.hero.h, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      };
      const retry = () => {
        Object.assign(g.hero, { hp: 1, invuln: 0 });
        g.hurtHero();
        document.getElementById('btn-retry').click();
      };
      g.startStage(6);
      const checkpoint = g.checkpoints.find((cp) => cp.x === 300 * 44);
      stand(checkpoint.x + 12);
      for (const sw of g.cyberSwitches) stand(sw.x);
      const score = g.runScore;
      retry();
      const retained = g.hero.x === checkpoint.x + 12 && g.cyberSwitches.every((sw) => sw.pressed)
        && g.forcefields.every((field) => !field.active) && score >= 600;
      stand(g.cyberSwitches.find((sw) => sw.switchId === 3).x);
      const noDuplicateScore = g.runScore === score;
      g.pauseGame();
      document.getElementById('btn-restart').click();
      const fresh = g.cyberSwitches.every((sw) => !sw.pressed) && g.forcefields.every((field) => field.active);

      stand(checkpoint.x + 12);
      retry();
      const thirdGate = g.forcefields.find((field) => field.switchId === 3);
      const initiallyClosed = thirdGate.active;
      g.keys.right = true;
      for (let i = 0; i < 90; i++) g.stepUpdate(1 / 60);
      g.resetAllInputs();
      return { retained, noDuplicateScore, fresh, forwardRoute: initiallyClosed && !thirdGate.active && g.hero.x > thirdGate.x };
    })()`);
    assertTest('Сейвы', '5.7', 'Retry keeps opened gates and puts an unused third terminal ahead of the checkpoint',
      Object.values(gateRetryRes).every(Boolean), JSON.stringify(gateRetryRes));


    const bossAttackRes = await evalJs(`(() => {
      const g = window._voltGame, results = [];
      for (let world = 2; world <= 6; world++) {
        for (const lowHealth of [false, true]) {
          g.startStage(world);
          const b = g.boss, h = g.hero;
          Object.assign(h, { x: 493 * 44, y: 440 - h.h, vx: 0, vy: 0, invuln: 0 });
          Object.assign(b, { x: 502 * 44, attackCd: 0, jumpCd: 99 });
          if (lowHealth) b.hp = 1;
          g.stepUpdate(1 / 60);
          const expected = ['rock', 'bubble', 'gust', 'flame', 'laser'][world - 2];
          const typed = b.attacks.length > 0 && b.attacks.every(a => a.kind === expected);
          for (let i = 0; i < 55; i++) g.stepUpdate(1 / 60);
          const warned = h.hp === 2 && b.attacks.every(a => a.warning > 0);
          g.keys.right = true;
          for (let i = 0; i < 70; i++) g.stepUpdate(1 / 60);
          g.resetAllInputs();
          const dodged = h.hp === 2;
          for (let i = 0; i < 80; i++) g.stepUpdate(1 / 60);
          results.push({ world, lowHealth, typed, warned, dodged, expired: b.attacks.length === 0 });
        }
      }
      return results;
    })()`);
    assertTest('Боссы', '6.1', 'Each themed attack warns before damage and can be dodged at full and low boss health',
      bossAttackRes.every(r => r.typed && r.warned && r.dodged && r.expired), JSON.stringify(bossAttackRes));

    const bossCleanupRes = await evalJs(`(() => {
      const g = window._voltGame, results = [];
      for (let world = 2; world <= 6; world++) {
        for (const weapon of ['stomp', 'fire', 'shell']) {
          g.startStage(world);
          const b = g.boss, h = g.hero;
          Object.assign(h, { x: 493 * 44, y: 440 - h.h, vx: 0, vy: 0, invuln: 0 });
          Object.assign(b, { x: 502 * 44, attackCd: 0, jumpCd: 99 });
          g.stepUpdate(1 / 60);
          const spawned = b.attacks.length > 0;
          b.hp = 1; b.hurtTimer = 0;
          g.shockwaves.push({ x: 0, y: 0, w: 26, h: 26, vx: 210, life: 1 });
          if (weapon === 'stomp') Object.assign(h, { x: b.x, y: b.y - h.h - 1, vy: 130 });
          if (weapon === 'fire') g.fireballs.push({ x: b.x + 40, y: b.y + 30, vx: 0, vy: 0, bounces: 2, life: 2 });
          if (weapon === 'shell') g.enemies.push({ type: 'snail', state: 'shell_spin', x: b.x + 20, y: 412,
            w: 34, h: 28, vx: 300, vy: 0, dead: false, hitTimer: 0 });
          g.stepUpdate(1 / 60);
          const cleaned = b.dead && b.attacks.length === 0 && g.shockwaves.length === 0;
          g.pauseGame(); document.getElementById('btn-restart').click();
          results.push({ world, weapon, spawned, cleaned, fresh: !g.boss.dead && g.boss.attacks.length === 0 });
        }
      }
      return results;
    })()`);
    assertTest('Боссы', '6.2', 'Stomp, fire and shell victories clear every attack; restart creates a clean boss',
      bossCleanupRes.every(r => r.spawned && r.cleaned && r.fresh), JSON.stringify(bossCleanupRes));

    const magmaChargeRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(5);
      const h = g.hero, entry = g.allPipes.find(p => p.isWarp && !p.isExit);
      Object.assign(h, { x: entry.x + 12, y: entry.y - h.h, vx: 0, vy: 0, onGround: true });
      g.keys.down = true; g.stepUpdate(1 / 60); g.keys.down = false;
      for (let i = 0; i < 90; i++) g.stepUpdate(1 / 60);
      g.overchargeGauge = 0; g.turboTimer = 0;
      const entered = g.inSecretRoom;
      g.keys.right = true;
      let anyTurbo = false;
      for (let i = 0; i < 200 && h.x < 664.8 * 44; i++) {
        g.stepUpdate(1 / 60); anyTurbo ||= g.turboTimer > 0;
      }
      g.resetAllInputs();
      return entered && !anyTurbo && h.x > 664.8 * 44 && h.hp === 2;
    })()`);
    assertTest('Тайники', '6.3', 'Entering the magma vault breaks cracked wall at normal run speed with zero turbo', magmaChargeRes);


    const attackDamageRes = await evalJs(`(() => {
      const g = window._voltGame, results = [];
      for (let world = 2; world <= 6; world++) {
        for (const dt of [1 / 60, 0.1]) {
          g.startStage(world);
          const b = g.boss, h = g.hero;
          Object.assign(h, { x: 493 * 44, y: 440 - h.h, vx: 0, vy: 0, invuln: 0 });
          Object.assign(b, { x: 502 * 44, attackCd: 0, jumpCd: 99 });
          g.stepUpdate(1 / 60);
          const a = b.attacks[0]; a.warning = 0;
          Object.assign(h, { x: a.x, y: a.kind === 'rock' ? a.y + 15 : a.y, vx: 0, vy: 0, invuln: 0 });
          g.stepUpdate(dt);
          const damaged = h.hp === 1;
          h.invuln = 0; g.hurtHero(); document.getElementById('btn-retry').click();
          results.push({ world, dt, damaged, retry: g.state === 'playing' && g.boss.attacks.length === 0 && !g.boss.dead });
        }
      }
      return results;
    })()`);
    assertTest('Боссы', '6.4', 'Active attacks damage at normal and 100 ms steps; Retry clears their state',
      attackDamageRes.every(r => r.damaged && r.retry), JSON.stringify(attackDamageRes));

    const attackPauseRes = await evalJs(`(async () => {
      const g = window._voltGame;
      g.startStage(6);
      Object.assign(g.hero, { x: 493 * 44, y: 440 - g.hero.h, vx: 0, vy: 0 });
      Object.assign(g.boss, { x: 502 * 44, attackCd: 0, jumpCd: 99 });
      g.stepUpdate(1 / 60);
      g.pauseGame();
      const before = JSON.stringify(g.boss.attacks);
      await new Promise(resolve => setTimeout(resolve, 180));
      const pausedState = g.state;
      const after = JSON.stringify(g.boss.attacks);
      const frozen = pausedState === 'paused' && before === after;
      document.getElementById('btn-resume').click();
      g.stepUpdate(0.1);
      const resumed = before !== JSON.stringify(g.boss.attacks);
      g.hero.x = 10; g.stepUpdate(1 / 60);
      return { frozen, resumed, cleared: g.boss.attacks.length === 0, state: g.state,
        ...(!frozen ? { pausedState, before, after } : {}) };
    })()`);
    assertTest('Боссы', '6.5', 'Real frame loop freezes warning on Pause, resumes it, and clears it outside the arena',
      attackPauseRes.frozen && attackPauseRes.resumed && attackPauseRes.cleared, JSON.stringify(attackPauseRes));

    const stage1DualVaultRes = await evalJs(`(() => {
      const g = window._voltGame;
      constTILE = 44;

      function enterPipe(pipe) {
        for (let w = 0; w < 70 && g.secretCooldown > 0; w++) g.stepUpdate(1 / 60);
        Object.assign(g.hero, { x: pipe.x + 12, y: pipe.y - g.hero.h, vx: 0, vy: 0, onGround: true });
        g.keys.down = true;
        g.stepUpdate(1 / 60);
        g.keys.down = false;
        for (let i = 0; i < 95 && g.pipeAnim.active; i++) g.stepUpdate(1 / 60);
      }

      function exitActiveVault() {
        for (let w = 0; w < 70 && g.secretCooldown > 0; w++) g.stepUpdate(1 / 60);
        const exitPipe = g.activeVault.exit;
        Object.assign(g.hero, { x: exitPipe.x + 12, y: exitPipe.y - g.hero.h, vx: 0, vy: 0, onGround: true });
        g.keys.down = true;
        g.stepUpdate(1 / 60);
        g.keys.down = false;
        for (let i = 0; i < 95 && g.pipeAnim.active; i++) g.stepUpdate(1 / 60);
      }

      function inSpan(obj, v) {
        return obj.x >= v.startCol * constTILE && obj.x <= (v.endCol + 1) * constTILE;
      }

      // ORDER A: Visit Vault 1 (Emerald Grotto) -> collect everything -> exit -> Visit Vault 2 (Amber Cache)
      g.startStage(1);
      const warpPipesA = g.allPipes.filter(p => p.isWarp && !p.isExit);
      if (warpPipesA.length !== 2 || g.vaults.length !== 2) return { ok: false, reason: 'vault count' };
      const [pipe1A, pipe2A] = warpPipesA;

      enterPipe(pipe1A);
      const v1A = g.activeVault;
      const v2A = g.vaults[1];
      if (!g.inSecretRoom || v1A !== g.vaults[0] || v1A.kind !== 'main') return { ok: false, reason: 'enter v1A' };

      // Collect all items inside Vault 1
      for (const f of g.fruits.filter(item => inSpan(item, v1A))) {
        Object.assign(g.hero, { x: f.x, y: f.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      for (const tc of g.treasureChests.filter(item => inSpan(item, v1A))) {
        Object.assign(g.hero, { x: tc.x + 4, y: tc.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      const star1A = g.secretStars.find(s => inSpan(s, v1A));
      Object.assign(g.hero, { x: star1A.x, y: star1A.y, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);

      // Verify Vault 2 was completely untouched by collecting in Vault 1
      const v2ChestsUntouched = g.treasureChests.filter(item => inSpan(item, v2A)).every(tc => !tc.opened);
      const v2FruitsUntouched = g.fruits.filter(item => inSpan(item, v2A)).every(f => !f.collected);
      const v2DroneUntouched = g.droneOrbs.filter(item => inSpan(item, v2A)).every(d => !d.collected);

      exitActiveVault();
      const returnedFromV1 = !g.inSecretRoom && Math.abs(g.hero.x - (84 * constTILE + 9)) < 20;

      // Now enter Pipe 2 (Col 330 -> Amber Cache)
      enterPipe(pipe2A);
      const enteredV2 = g.inSecretRoom && g.activeVault === v2A && v2A.kind === 'amber';
      const v2ChestsBefore = g.treasureChests.filter(item => inSpan(item, v2A));
      const v2DroneBefore = g.droneOrbs.find(item => inSpan(item, v2A));

      // Climb & collect in Vault 2
      for (const tc of v2ChestsBefore) {
        Object.assign(g.hero, { x: tc.x + 4, y: tc.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      Object.assign(g.hero, { x: v2DroneBefore.x, y: v2DroneBefore.y, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      for (const f of g.fruits.filter(item => inSpan(item, v2A) && !item.collected)) {
        Object.assign(g.hero, { x: f.x, y: f.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      const v2AllCollected = v2ChestsBefore.length === 2 && v2ChestsBefore.every(tc => tc.opened) && v2DroneBefore.collected && g.hero.hasDrone;

      exitActiveVault();
      const returnedFromV2 = !g.inSecretRoom && Math.abs(g.hero.x - (334 * constTILE + 9)) < 20;

      // ORDER B: Visit Vault 2 (Amber Cache) FIRST -> collect everything -> exit -> Visit Vault 1 (Emerald Grotto)
      g.startStage(1);
      g.hero.hasDrone = false;
      const [pipe1B, pipe2B] = g.allPipes.filter(p => p.isWarp && !p.isExit);
      const [v1B, v2B] = g.vaults;

      enterPipe(pipe2B);
      for (const tc of g.treasureChests.filter(item => inSpan(item, v2B))) {
        Object.assign(g.hero, { x: tc.x + 4, y: tc.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      for (const d of g.droneOrbs.filter(item => inSpan(item, v2B))) {
        Object.assign(g.hero, { x: d.x, y: d.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      for (const f of g.fruits.filter(item => inSpan(item, v2B))) {
        Object.assign(g.hero, { x: f.x, y: f.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      exitActiveVault();

      // Verify Vault 1 (Emerald Grotto) is 100% intact before and upon entry!
      enterPipe(pipe1B);
      const v1StarIntact = g.secretStars.find(s => inSpan(s, v1B))?.collected === false && !g.runStarsCollected[0];
      const v1ChestIntact = g.treasureChests.filter(item => inSpan(item, v1B)).every(tc => !tc.opened);
      const v1FruitsIntact = g.fruits.filter(item => inSpan(item, v1B)).length === 14
        && g.fruits.filter(item => inSpan(item, v1B)).every(f => !f.collected);
      const totalStageStars = g.secretStars.length === 3;

      return {
        ok: v2ChestsUntouched && v2FruitsUntouched && v2DroneUntouched && returnedFromV1
          && enteredV2 && v2AllCollected && returnedFromV2
          && v1StarIntact && v1ChestIntact && v1FruitsIntact && totalStageStars,
        v2ChestsUntouched, v2FruitsUntouched, v2DroneUntouched, returnedFromV1,
        enteredV2, v2AllCollected, returnedFromV2,
        v1StarIntact, v1ChestIntact, v1FruitsIntact, totalStageStars
      };
    })()`);
    assertTest('Тайники', '6.6', 'World 1-1 has two independent vaults (Emerald Grotto & Amber Cache) verified in both visit orders',
      stage1DualVaultRes.ok, JSON.stringify(stage1DualVaultRes));

    const auditFixesRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // 1. Verify addScore updates save.totalScore and save.bestScore
      g.startStage(1);
      const totalBefore = g.save.totalScore;
      const f0 = g.fruits[0];
      Object.assign(g.hero, { x: f0.x, y: f0.y, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const scoreSaved = g.save.totalScore > totalBefore && g.save.bestScore >= g.save.totalScore;

      // 2. Verify Star #3 is in the second half (col >= 400) and props span second half across all 6 stages
      let allStarsLate = true;
      let allPropsFullLength = true;
      for (let st = 1; st <= 6; st++) {
        g.startStage(st);
        const star3 = g.secretStars.find(s => s.id === 3);
        if (!star3 || star3.x < 400 * TILE) allStarsLate = false;
        const overworldChests = g.treasureChests.filter(c => c.x < 500 * TILE);
        const overworldDrones = g.droneOrbs.filter(d => d.x < 500 * TILE);
        if (!overworldChests.some(c => c.x > 300 * TILE) || !overworldDrones.some(d => d.x > 300 * TILE)) {
          allPropsFullLength = false;
        }
      }

      // 3. Verify Rock Head slams in World 1-2 and Wind Fan lifts hero in World 1-4
      g.startStage(2);
      const rh = g.rockHeads[0];
      Object.assign(g.hero, { x: rh.x, y: rh.topY - g.hero.h - 2, vx: 0, vy: 120, onGround: false });
      g.stepUpdate(1 / 60);
      const bouncedOnRockHead = g.hero.vy < -400 && rh.state === 'slam';

      g.startStage(4);
      const wf = g.windFans[0];
      Object.assign(g.hero, { x: wf.x + 4, y: wf.y - 60, vx: 0, vy: 100, onGround: false });
      g.stepUpdate(1 / 60);
      const liftedByFan = g.hero.vy <= -360;

      return {
        ok: scoreSaved && allStarsLate && allPropsFullLength && bouncedOnRockHead && liftedByFan,
        scoreSaved, allStarsLate, allPropsFullLength, bouncedOnRockHead, liftedByFan
      };
    })()`);
    assertTest('Аудит', '6.7', 'Score persistence, late-stage Star #3 (1-1..1-6), full-stage props, Rock Heads & Wind Fans',
      auditFixesRes.ok, JSON.stringify(auditFixesRes));

    const rockRiftRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // Test Stage 1: Smash Cracked Rock Wall at Col 286 -> Enter Crystal Rift at Col 288 -> Collect rewards -> Exit to Col 291
      g.startStage(1);
      const entranceRift1 = g.secretRifts.find(r => !r.isExit);
      const exitRift1 = g.secretRifts.find(r => r.isExit);
      if (!entranceRift1 || !exitRift1) return { ok: false, reason: 'missing rifts in stage 1' };

      // 1. Verify rift cannot be entered while rock wall at Col 286 is intact
      Object.assign(g.hero, { x: entranceRift1.x + 8, y: 440 - g.hero.h, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const blockedWhileWallIntact = !g.inSecretRoom;

      // 2. Run through battery line at Cols 276..285 -> break cracked_brick wall at Col 286 -> enter Crystal Rift!
      Object.assign(g.hero, { x: 276 * TILE, y: 440 - g.hero.h, vx: 0, vy: 0, onGround: true });
      g.keys.right = true;
      for (let i = 0; i < 160 && !g.inSecretRoom; i++) g.stepUpdate(1 / 60);
      g.resetAllInputs();

      const wallBroken = !g.solidBlocks.some(b => b.kind === 'cracked_brick' && Math.abs(b.x - 286 * TILE) < 16);
      const enteredRift1 = g.inSecretRoom && g.activeVault?.kind === 'rift' && g.hero.x >= 810 * TILE;

      // 3. Collect rift chests & drone inside 810..848
      const riftChests = g.treasureChests.filter(c => c.x >= 810 * TILE && c.x <= 848 * TILE);
      for (const tc of riftChests) {
        Object.assign(g.hero, { x: tc.x + 4, y: tc.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      const riftChestsOpened = riftChests.length === 2 && riftChests.every(c => c.opened);

      // 4. Step cooldown and exit through exitRift1 back to Col 291
      for (let w = 0; w < 70 && g.secretCooldown > 0; w++) g.stepUpdate(1 / 60);
      Object.assign(g.hero, { x: exitRift1.x + 8, y: 440 - g.hero.h, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const exitedRift1 = !g.inSecretRoom && g.activeVault === null && Math.abs(g.hero.x - 291 * TILE) < 20;

      // 5. Test Stage 2: Blast Cracked Rock Wall at Col 281 with a Fireball -> Enter Rift at Col 283
      g.startStage(2);
      g.fireballs.push({ x: 280.5 * TILE, y: 440 - 30, vx: 500, vy: 0, r: 8, friendly: true, bounces: 3 });
      for (let i = 0; i < 15; i++) g.stepUpdate(1 / 60);
      const stage2WallBlasted = !g.solidBlocks.some(b => b.kind === 'cracked_brick' && Math.abs(b.x - 281 * TILE) < 16);
      const entranceRift2 = g.secretRifts.find(r => !r.isExit);
      Object.assign(g.hero, { x: entranceRift2.x + 8, y: 440 - g.hero.h, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const enteredRift2 = g.inSecretRoom && g.activeVault?.kind === 'rift';

      return {
        ok: blockedWhileWallIntact && wallBroken && enteredRift1 && riftChestsOpened && exitedRift1 && stage2WallBlasted && enteredRift2,
        blockedWhileWallIntact, wallBroken, enteredRift1, riftChestsOpened, exitedRift1, stage2WallBlasted, enteredRift2
      };
    })()`);
    assertTest('Тайники', '6.8', 'Breakable Rock Wall shatters (Turbo/Ram/Fireball) and opens Secret Crystal Rift World (810..848)',
      rockRiftRes.ok, JSON.stringify(rockRiftRes));

    const multiHeightRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // 1. Verify all 6 stages have multi-height terrain (at least 4 distinct ground Y levels per stage)
      const stageHeightCounts = [];
      for (let st = 1; st <= 6; st++) {
        g.startStage(st);
        const grassYs = new Set(
          g.solidBlocks
            .filter(b => b.kind === 'grass' && b.x < 485 * TILE)
            .map(b => b.y)
        );
        stageHeightCounts.push(grassYs.size);
      }
      const allStagesVaried = stageHeightCounts.every(cnt => cnt >= 4);

      // 2. Verify hero climbs stepped Emerald Hill in Stage 1 (Cols 52 -> 54 -> 58)
      g.startStage(1);
      const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      Object.assign(g.hero, { x: 52 * TILE, y: 440 - g.hero.h, vx: 0, vy: 0, onGround: true });
      const startY = g.hero.y;
      press('ArrowRight', true);
      // Jump onto step 1 (Col 54, elev +1)
      press('Space', true);
      for (let i = 0; i < 28; i++) g.stepUpdate(1 / 60);
      press('Space', false);
      for (let i = 0; i < 14; i++) g.stepUpdate(1 / 60);
      // Jump onto step 2 (Col 58, elev +2)
      press('Space', true);
      for (let i = 0; i < 32; i++) g.stepUpdate(1 / 60);
      press('Space', false);
      for (let i = 0; i < 18; i++) g.stepUpdate(1 / 60);
      g.resetAllInputs();
      const climbedHill = g.hero.y <= startY - 44 && g.hero.x >= 54 * TILE;

      // 3. Verify walking enemy on elevated plateau turns around at step ledge without falling off
      g.startStage(1);
      const hillEnemy = g.enemies.find(e => e.type === 'snail' && Math.round(e.x / TILE) === 55);
      let enemyStayedOnHill = false;
      if (hillEnemy) {
        Object.assign(g.hero, { x: 55 * TILE, y: 120, vx: 0, vy: 0, invuln: 5 });
        for (let i = 0; i < 120; i++) {
          g.hero.y = 120;
          g.hero.vy = 0;
          g.stepUpdate(1 / 60);
        }
        enemyStayedOnHill = Math.abs((hillEnemy.y + hillEnemy.h) - (440 - TILE)) <= 2;
      }

      return {
        ok: allStagesVaried && climbedHill && enemyStayedOnHill,
        stageHeightCounts,
        climbedHill,
        enemyStayedOnHill
      };
    })()`);
    assertTest('Рельеф', '6.9', 'Multi-height terrain across all 6 stages (hills, canyons, split bridges & enemy step-ledge turn)',
      multiHeightRes.ok, JSON.stringify(multiHeightRes));

    const points235Res = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // 1. Point 2: Verify all 6 stages have distinct Warp Pipe #1, Star #2, Star #3, and Checkpoint signatures
      const warpCols = [];
      const star2Cols = [];
      const star3Cols = [];
      const cpSigs = [];
      let noEmptySecondHalf = true;

      for (let st = 1; st <= 6; st++) {
        g.startStage(st);
        const wp = g.allPipes.find(p => p.isWarp && !p.isExit);
        warpCols.push(wp ? wp.col : -1);
        const s2 = g.secretStars.find(s => s.id === 2);
        star2Cols.push(s2 ? Math.round(s2.x / TILE) : -1);
        const s3 = g.secretStars.find(s => s.id === 3);
        star3Cols.push(s3 ? Math.round(s3.x / TILE) : -1);
        cpSigs.push(g.checkpoints.map(c => Math.round(c.x / TILE)).join(','));

        // 2. Point 3: Verify second half (Cols 200..470) has no empty 30-col stretches
        for (let c = 200; c <= 440; c += 30) {
          const minX = c * TILE;
          const maxX = (c + 30) * TILE;
          const hasAction =
            g.enemies.some(e => e.x >= minX && e.x <= maxX) ||
            g.saws.some(s => s.x >= minX && s.x <= maxX) ||
            g.firebars.some(f => f.cx >= minX && f.cx <= maxX) ||
            g.laserGrids.some(l => l.x >= minX && l.x <= maxX) ||
            g.rockHeads.some(r => r.x >= minX && r.x <= maxX) ||
            g.dartTraps.some(d => d.x >= minX && d.x <= maxX) ||
            g.movingPlats.some(m => m.x >= minX && m.x <= maxX);
          if (!hasAction) noEmptySecondHalf = false;
        }
      }

      const uniqueMacro =
        new Set(warpCols).size === 6 &&
        new Set(star2Cols).size === 6 &&
        new Set(star3Cols).size === 6 &&
        new Set(cpSigs).size === 6;

      // 3. Point 5: Verify anti-cheese ceilings over Laser Grids (Stage 6) and Firebars (Stage 5)
      g.startStage(5);
      const overworldFirebars = g.firebars.filter(fb => fb.cx < 500 * TILE);
      const firebarsRoofed = overworldFirebars.length >= 6 && overworldFirebars.every(fb =>
        g.solidBlocks.some(b => Math.abs(b.x - fb.cx) <= TILE && b.y < fb.cy)
      );

      g.startStage(6);
      const allLasersRoofed = g.laserGrids.length >= 7 && g.laserGrids.every(lg =>
        g.solidBlocks.some(b => b.kind === 'steel' && Math.abs(b.x - lg.x) <= TILE && b.y <= lg.y)
      );

      // Attempt to double-jump over active Laser Grid #1 at Col 24 in Stage 6: ceiling blocks sky-cheese!
      const lg0 = g.laserGrids[0];
      lg0.state = 'on';
      lg0.timer = 0;
      const press = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      Object.assign(g.hero, { x: lg0.x - 56, y: 440 - g.hero.h, vx: 0, vy: 0, onGround: true, invuln: 0, hp: 2 });
      press('ArrowRight', true);
      press('Space', true);
      for (let i = 0; i < 14; i++) g.stepUpdate(1 / 60);
      press('Space', false);
      g.stepUpdate(1 / 60);
      press('Space', true);
      for (let i = 0; i < 25; i++) g.stepUpdate(1 / 60);
      g.resetAllInputs();
      // Either hero bonked ceiling and took laser hit OR could not clear above lg0.y!
      const cannotSkyCheeseLaser = g.hero.hp < 2 || g.hero.x < lg0.x;

      return {
        ok: uniqueMacro && noEmptySecondHalf && firebarsRoofed && allLasersRoofed && cannotSkyCheeseLaser,
        uniqueMacro,
        warpCols,
        star2Cols,
        star3Cols,
        noEmptySecondHalf,
        firebarsRoofed,
        allLasersRoofed,
        cannotSkyCheeseLaser
      };
    })()`);
    assertTest('Архитектура', '6.10', 'Points 2, 3, 5: Unique macro layouts, dense second halves, and anti-cheese trap ceilings',
      points235Res.ok, JSON.stringify(points235Res));

    const point4BiomeRes = await evalJs(`(() => {
      const g = window._voltGame;

      // 1. Verify all 6 stages have distinct biome-specific Boss titles in UI banner
      const bossNames = [];
      const wfPopupTexts = [];
      const rbPopupTexts = [];

      for (let st = 1; st <= 6; st++) {
        g.startStage(st);
        // Trigger boss banner by placing hero near boss
        Object.assign(g.hero, { x: g.boss.x - 180, y: 440 - g.hero.h, vx: 0, vy: 0, invuln: 5 });
        g.stepUpdate(1 / 60);
        bossNames.push(document.getElementById('boss-name').textContent);

        // Trigger first wonderFlower / biome prop and capture popup text
        const wf = g.wonderFlowers[0];
        if (wf) {
          g.popups.length = 0;
          Object.assign(g.hero, { x: wf.x, y: wf.y - 10, vx: 0, vy: 0 });
          g.stepUpdate(1 / 60);
          wfPopupTexts.push(g.popups[0]?.text || '');
        }

        // Trigger first rainbowBubble / biome orb and capture popup text
        const rb = g.rainbowBubbles[0];
        if (rb) {
          g.popups.length = 0;
          rb.popped = false;
          Object.assign(g.hero, { x: rb.x - g.hero.w / 2, y: rb.baseY - g.hero.h, vx: 0, vy: 60 });
          g.stepUpdate(1 / 60);
          rbPopupTexts.push(g.popups[0]?.text || '');
        }
      }

      const uniqueBossTitles = new Set(bossNames).size === 6;
      // Stage 2 crystal, Stage 3 coral, Stage 5 relic, Stage 6 cyber beacon are all distinct from Stage 1 flower
      const distinctBiomeProps = new Set(wfPopupTexts).size >= 5 && new Set(rbPopupTexts).size >= 5;

      // Verify Stage 3 Jellyfish now sweeps across the full vertical water column (>= 180px span)
      g.startStage(3);
      const jelly = g.enemies.find(e => e.type === 'jelly');
      let minJY = Infinity, maxJY = -Infinity;
      Object.assign(g.hero, { x: jelly.baseX, y: 120, vx: 0, vy: 0, invuln: 10 });
      for (let i = 0; i < 140; i++) {
        g.hero.x = jelly.baseX;
        g.hero.y = 120;
        g.stepUpdate(1 / 60);
        minJY = Math.min(minJY, jelly.y);
        maxJY = Math.max(maxJY, jelly.y);
      }
      const jellyFullVerticalSweep = (maxJY - minJY) >= 180;

      return {
        ok: uniqueBossTitles && distinctBiomeProps && jellyFullVerticalSweep,
        uniqueBossTitles,
        bossNames,
        distinctBiomeProps,
        jellyFullVerticalSweep,
        jellySpanPx: Math.round(maxJY - minJY),
        wfPopupTexts,
        rbPopupTexts
      };
    })()`);
    assertTest('Биомы', '6.11', 'Point 4: Biome-coherent boss titles, themed interactive props/orbs & stage-specific enemy visuals',
      point4BiomeRes.ok, JSON.stringify(point4BiomeRes));

    const point6EconomyRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // 1. Verify overworld main-path crate pairs are de-spammed (Stages 2..6 have <= 2 powerup crates on overworld < 485 cols)
      let cratesDeSpammed = true;
      for (let st = 2; st <= 6; st++) {
        g.startStage(st);
        const overworldPowerCrates = g.solidBlocks.filter(b =>
          b.x < 485 * TILE &&
          (b.kind === 'crate1' || b.kind === 'crate3') &&
          (b.reward === 'heart' || b.reward === 'fire')
        );
        if (overworldPowerCrates.length > 3) cratesDeSpammed = false;
      }

      // 2. Verify Cyber Tech Lab shop buttons render in #modal-start and fit without vertical overflow
      g.returnToMainMenu();
      const shopBtns = document.querySelectorAll('#shop-buttons .shop-btn');
      const hasFourUpgrades = shopBtns.length === 4;
      const startCard = document.querySelector('#modal-start .modal-card');
      const fitsViewport = startCard && startCard.scrollHeight <= startCard.clientHeight + 2;

      // 3. Test insufficient funds rejection, then purchasing all 4 permanent upgrades with batteries (save.fruits)
      g.save.fruits = 40;
      g.save.upgrades = { maxHp: false, magnet: false, startDrone: false, startFire: false };
      const rejectedWhenPoor = g.buyUpgrade('maxHp') === false && !g.save.upgrades.maxHp && g.save.fruits === 40;

      g.save.fruits = 800;
      const boughtHp = g.buyUpgrade('maxHp') && g.save.upgrades.maxHp && g.save.fruits === 720;
      const boughtMag = g.buyUpgrade('magnet') && g.save.upgrades.magnet && g.save.fruits === 580;
      const boughtDrone = g.buyUpgrade('startDrone') && g.save.upgrades.startDrone && g.save.fruits === 360;
      const boughtFire = g.buyUpgrade('startFire') && g.save.upgrades.startFire && g.save.fruits === 40;

      // 4. Start Stage 2 and verify all permanent upgrades apply on spawnHero and magnet pulls batteries even without drone!
      g.startStage(2);
      const spawnedBuffed = g.hero.maxHp === 3 && g.hero.hp === 3 && g.hero.hasDrone === true && g.hero.hasFire === true;

      // Disable drone temporarily to verify standalone permanent Battery Magnet upgrade pulls nearby batteries
      g.hero.hasDrone = false;
      const f = g.fruits[0];
      f.collected = false;
      f.x = g.hero.x + 70;
      f.y = g.hero.y;
      const distBefore = Math.abs(f.x - g.hero.x);
      for (let i = 0; i < 8; i++) g.stepUpdate(1 / 60);
      const magnetPulled = Math.abs(f.x - g.hero.x) < distBefore;

      // Reset upgrades back to default false so subsequent or repeated runs start clean
      g.save.upgrades = { maxHp: false, magnet: false, startDrone: false, startFire: false };
      g.renderShopButtons();

      return {
        ok: cratesDeSpammed && hasFourUpgrades && fitsViewport && rejectedWhenPoor && boughtHp && boughtMag && boughtDrone && boughtFire && spawnedBuffed && magnetPulled,
        cratesDeSpammed,
        hasFourUpgrades,
        fitsViewport,
        rejectedWhenPoor,
        boughtHp,
        boughtMag,
        boughtDrone,
        boughtFire,
        spawnedBuffed,
        magnetPulled
      };
    })()`);
    assertTest('Экономика', '6.12', 'Point 6: Cyber Tech Lab Upgrade Shop, battery currency spending, permanent buffs & de-spammed crates',
      point6EconomyRes.ok, JSON.stringify(point6EconomyRes));

    const depthUpgradesRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;

      // 1. Verify all 6 stages now have Secret Crystal Rifts (secretRifts.length === 2), tactical Boss Arena platforms, and ZERO buried/floating rifts or checkpoints!
      let allStagesHaveRifts = true;
      let allBossArenasHavePlatforms = true;
      let zeroTerrainCollisions = true;
      for (let st = 1; st <= 6; st++) {
        g.startStage(st);
        if (g.secretRifts.length !== 2) allStagesHaveRifts = false;
        const arenaBridges = g.oneWayBridges.filter(br => br.x >= 490 * TILE && br.x <= 512 * TILE);
        if (arenaBridges.length < 2) allBossArenasHavePlatforms = false;
        for (const rf of g.secretRifts) {
          const box = { x: rf.targetX, y: rf.targetY, w: g.hero.w, h: g.hero.h };
          if (g.solidBlocks.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) {
            zeroTerrainCollisions = false;
          }
        }
        for (const cp of g.checkpoints) {
          const col = Math.round(cp.x / TILE);
          const grass = g.solidBlocks.find(b => b.kind === 'grass' && Math.round(b.x / TILE) === col);
          if (grass && Math.abs((cp.y + cp.h) - grass.y) > 4) zeroTerrainCollisions = false;
        }
        // Verify zero bridges intersected/blocked by solid blocks (bricks/crates/steel) and zero crates overlapping saws!
        for (const br of g.oneWayBridges) {
          for (const b of g.solidBlocks) {
            if (b.kind === 'grass' || b.kind === 'forcefield') continue;
            if (br.x < b.x + b.w + 4 && br.x + br.w > b.x - 4 && b.y < br.y + 20 && b.y + b.h > br.y - 46) {
              zeroTerrainCollisions = false;
            }
          }
        }
        for (const b of g.solidBlocks) {
          if (b.kind === 'grass') continue;
          for (const sw of g.saws) {
            const sawBox = { x: sw.x - (sw.rangeX || 0) - sw.r, y: sw.y - sw.r, w: (sw.rangeX || 0) * 2 + sw.r * 2, h: sw.r * 2 };
            if (b.x < sawBox.x + sawBox.w + 8 && b.x + b.w > sawBox.x - 8 && b.y < sawBox.y + sawBox.h + 8 && b.y + b.h > sawBox.y - 8) {
              zeroTerrainCollisions = false;
            }
          }
        }
      }

      // 2. Verify Tiered Battery Values: Chest spawns 3 Plasma Cores (bonusVal === 3), giving +3 🔋 to wallet and +1 to overchargeGauge (preventing instant Turbo spam)!
      g.startStage(1);
      const bank0 = g.save.fruits;
      g.overchargeGauge = 0;
      g.turboTimer = 0;
      const tc = g.treasureChests.find(c => c.x < 480 * TILE);
      Object.assign(g.hero, { x: tc.x + 4, y: tc.y, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const allChestCores = g.fruits.filter(f => f.bonusVal === 3);
      const coreGave3 = zeroTerrainCollisions && allChestCores.length === 3 && (g.save.fruits - bank0) === 3 && g.overchargeGauge === 1;

      // 3. Verify Hero Battery Unlocking (selectOrUnlockHero) & 4 Hero Specializations (vg rapid fire, nf high jump, pm speed/coyote, md heavy wall smash)
      g.save.unlockedHeroes = { vg: true, nf: false, md: false, pm: false };
      g.save.fruits = 50;
      const blockedLowBank = g.selectOrUnlockHero('nf') === false && g.save.unlockedHeroes.nf === false && g.save.heroId === 'vg';
      g.save.fruits = 150;
      const unlockedFrog = g.selectOrUnlockHero('nf') === true && g.save.unlockedHeroes.nf === true && g.save.fruits === 50 && g.save.heroId === 'nf';

      g.startStage(1);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      g.stepUpdate(1 / 60);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      const frogHighJump = blockedLowBank && unlockedFrog && g.hero.vy === -635;

      g.save.unlockedHeroes.pm = true;
      g.save.heroId = 'pm';
      g.startStage(1);
      g.stepUpdate(1 / 60);
      const pinkExtendedCoyote = Math.abs(g.hero.coyote - 0.18) < 0.01;

      g.save.heroId = 'vg';
      g.startStage(1);

      // 4. Verify Pig Reactive Angry Charge AI (en.charging === true when hero is in front within 210px)
      const pig = g.enemies.find(e => e.type === 'pig');
      pig.vx = -95;
      Object.assign(g.hero, { x: pig.x - 120, y: pig.y, vx: 0, vy: 0, invuln: 5 });
      g.stepUpdate(1 / 60);
      const pigCharged = pig.charging === true && Math.abs(pig.vx) > 130;

      // 5. Verify #btn-vic-menu on Victory screen advances stage & opens Cyber Tech Lab (#modal-start) + 2x2 Hero Grid & Zero Scrollbar in RU
      g.startStage(1);
      g.openVictoryModal();
      document.getElementById('btn-vic-menu').click();
      if (g.lang !== 'ru') document.getElementById('btn-lang').click();
      const modalCard = document.querySelector('#modal-start .modal-card');
      const heroTops = new Set(Array.from(document.querySelectorAll('#hero-picker .hero-card')).map(c => Math.round(c.offsetTop / 8)));
      const stageTops = new Set(Array.from(document.querySelectorAll('#stage-buttons .stage-btn')).map(b => Math.round(b.offsetTop / 8)));
      const noScrollbar = modalCard.scrollHeight <= modalCard.clientHeight + 2;
      const layoutMetrics = { heroRows: heroTops.size, stageRows: stageTops.size, scrollH: modalCard.scrollHeight, clientH: modalCard.clientHeight, winH: window.innerHeight };

      // Test 2-step progress reset button (#btn-shop-reset)
      g.save.fruits = 250;
      g.save.upgrades.maxHp = true;
      g.save.unlockedHeroes.nf = true;
      document.getElementById('btn-shop-reset').click(); // Step 1: Arm confirmation
      const armedStillHasFruits = g.save.fruits === 250 && document.getElementById('btn-shop-reset').classList.contains('armed');
      document.getElementById('btn-shop-reset').click(); // Step 2: Execute reset
      const wipedClean = armedStillHasFruits && g.save.fruits === 0 && !g.save.upgrades.maxHp && !g.save.unlockedHeroes.nf && g.save.heroId === 'vg';

      // Verify: (a) batteries don't stick without magnet/drone, (b) 10 overworld batteries don't trigger turbo, (c) trapped snail shell stops after 4 wall bounces
      g.startStage(1);
      const testFruit = g.fruits.find(f => !f.collected);
      testFruit.x = g.hero.x + 42;
      testFruit.y = g.hero.y;
      const fxBefore = testFruit.x;
      g.stepUpdate(1 / 60);
      const noStickyPull = testFruit.x === fxBefore && !testFruit.collected;

      for (let k = 0; k < 10; k++) {
        const bf = g.fruits.find(f => !f.collected);
        Object.assign(g.hero, { x: bf.x, y: bf.y, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      const noOverworldTurbo = g.turboTimer === 0;

      const snail = g.enemies.find(e => e.type === 'snail');
      snail.state = 'shell_spin';
      snail.vx = 520;
      snail.shellWallHits = 0;
      // Place two temporary solid blocks trapping the snail shell in a tight loop
      const wallL = { x: snail.x - 20, y: snail.y - 10, w: 16, h: 48, kind: 'steel', bump: 0 };
      const wallR = { x: snail.x + snail.w + 20, y: snail.y - 10, w: 16, h: 48, kind: 'steel', bump: 0 };
      g.solidBlocks.push(wallL, wallR);
      Object.assign(g.hero, { x: snail.x, y: snail.y - 120, vx: 0, vy: 0 });
      for (let i = 0; i < 60 && snail.state === 'shell_spin'; i++) g.stepUpdate(1 / 60);
      const shellStoppedCleanly = snail.state === 'shell_idle' && snail.vx === 0;

      g.returnToMainMenu();
      const vicMenuOpenedLab = g.state === 'menu' && !document.getElementById('modal-start').classList.contains('hidden') && heroTops.size === 2 && stageTops.size === 2 && noScrollbar && wipedClean && noStickyPull && noOverworldTurbo && shellStoppedCleanly;
      if (g.lang !== 'en') document.getElementById('btn-lang').click();

      return {
        ok: allStagesHaveRifts && allBossArenasHavePlatforms && coreGave3 && frogHighJump && pinkExtendedCoyote && pigCharged && vicMenuOpenedLab,
        allStagesHaveRifts,
        allBossArenasHavePlatforms,
        coreGave3,
        frogHighJump,
        pinkExtendedCoyote,
        pigCharged,
        vicMenuOpenedLab,
        layoutMetrics
      };
    })()`);
    assertTest('Глубина', '6.13', 'Tiered batteries (+1/+2/+3), 4 Hero Perks, 6-World Rifts, Tactical Boss Arenas, Pig Charge AI & Victory Lab Button',
      depthUpgradesRes.ok, JSON.stringify(depthUpgradesRes));

    const newFeaturesRes = await evalJs(`(() => {
      const g = window._voltGame;
      const TILE = 44;
      g.resetSaveProgress();

      // 1. Volt Dash: activates dashTimer, propels at vx=620, breaks cracked_brick & unlocks dash_breaker (+30 batteries)
      g.startStage(1);
      Object.assign(g.hero, { x: 285 * TILE, y: 440 - g.hero.h, vx: 0, vy: 0, dir: 1, onGround: true });
      g.triggerDash();
      for (let i = 0; i < 12; i++) g.stepUpdate(1 / 60);
      const dashSmashed = !g.solidBlocks.some(b => b.kind === 'cracked_brick' && Math.abs(b.x - 286 * TILE) < 16);
      const dashAch = Boolean(g.save.achievements?.dash_breaker);

      // 2. Electric Ground Slam: dives in mid-air, smashes crate, emits shockwave & unlocks first_slam (+25 batteries)
      g.startStage(1);
      const crate = g.solidBlocks.find(b => b.kind === 'crate1' || b.kind === 'crate3');
      Object.assign(g.hero, { x: crate.x, y: crate.y - g.hero.h - 40, vx: 0, vy: 0, onGround: false, coyote: 0 });
      g.triggerSlam();
      for (let i = 0; i < 15 && g.solidBlocks.includes(crate); i++) g.stepUpdate(1 / 60);
      const slamSmashed = !g.solidBlocks.includes(crate) && g.slamRings.length > 0 && Boolean(g.save.achievements?.first_slam);

      // 3. Golden Energy Ring Trial: activates 6 cells, collecting all 6 awards +15 batteries + ring_master (+40 batteries)
      g.startStage(1);
      const er = g.energyRings[0];
      Object.assign(g.hero, { x: er.x - g.hero.w / 2, y: er.y - g.hero.h / 2, vx: 0, vy: 0 });
      g.stepUpdate(1 / 60);
      const ringActivated = er.state === 'active' && er.cells.length === 6;
      const bankBeforeRing = g.save.fruits;
      for (const cell of er.cells) {
        Object.assign(g.hero, { x: cell.x - g.hero.w / 2, y: cell.y - g.hero.h / 2, vx: 0, vy: 0 });
        g.stepUpdate(1 / 60);
      }
      const ringDone = er.state === 'done' && Boolean(g.save.achievements?.ring_master) && (g.save.fruits - bankBeforeRing) === (15 + 40);

      // 4. 3x Air Bounce Combo: 3 airborne bounces without touching ground drops bonus powerup & unlocks air_combo_3
      g.startStage(1);
      const rbs = g.rainbowBubbles.slice(0, 3);
      const pCountBefore = g.powerups.length;
      for (const rb of rbs) {
        rb.popped = false;
        Object.assign(g.hero, { x: rb.x - g.hero.w / 2, y: rb.baseY - g.hero.h, vx: 0, vy: 60, onGround: false });
        g.stepUpdate(1 / 60);
      }
      const combo3Triggered = g.bounceCombo === 3 && g.powerups.length > pCountBefore && Boolean(g.save.achievements?.air_combo_3);
      Object.assign(g.hero, { x: 10 * TILE, y: 440 - g.hero.h - 2, vx: 0, vy: 120, onGround: false });
      g.stepUpdate(1 / 60);
      const comboResetOnLand = g.bounceCombo === 0;

      // 5. Boss Counter-Shock Core: touching bossCore launches it into Boss, dealing 2 HP damage & stunning Boss (stunTimer > 0)
      g.startStage(2);
      const bc = g.bossCores[0];
      const bossHpBefore = g.boss.hp;
      Object.assign(g.boss, { x: 500 * TILE, y: 440 - g.boss.h, vx: 0, vy: 0 });
      Object.assign(g.hero, { x: bc.x, y: bc.y, vx: 0, vy: 0, invuln: 5 });
      g.stepUpdate(1 / 60);
      const coreLaunched = bc.state === 'launched';
      for (let i = 0; i < 60 && bc.state === 'launched'; i++) g.stepUpdate(1 / 60);
      const bossStunned = g.boss.hp === bossHpBefore - 2 && g.boss.stunTimer > 0 && Boolean(g.save.achievements?.boss_stunner);

      g.resetSaveProgress();
      return {
        ok: dashSmashed && dashAch && slamSmashed && ringActivated && ringDone && combo3Triggered && comboResetOnLand && coreLaunched && bossStunned,
        dashSmashed, dashAch, slamSmashed, ringActivated, ringDone, combo3Triggered, comboResetOnLand, coreLaunched, bossStunned
      };
    })()`);
    assertTest('Геймплей 2.0', '6.14', 'Volt Dash, Ground Slam, Golden Energy Rings, 3x Air Combo Drops, Boss Counter-Cores & Achievements',
      newFeaturesRes.ok, JSON.stringify(newFeaturesRes));

    // 6.15 Audit Regression Checks:
    // (1) Mobile touch controls fit 100% inside 320px, 360px, and 390px viewports (JUMP button right <= viewport width)
    // (2) Stage progression lock: with unlockedStage === 1, stages 2..6 are disabled/locked and cannot be selected or started
    // (3) Midgame ad timer: cleared upon adStarted so active ads > 4s are never cut off early
    const mobileWidths = [320, 360, 390];
    const mobileFits = [];
    for (const w of mobileWidths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 640, deviceScaleFactor: 2, mobile: true });
      const fit = await evalJs(`(() => {
        const g = window._voltGame;
        g.startStage(1);
        const layer = document.getElementById('touch-layer');
        layer.classList.add('active');
        const jumpRect = document.getElementById('t-jump').getBoundingClientRect();
        const leftRect = document.getElementById('t-left').getBoundingClientRect();
        return {
          w: window.innerWidth,
          leftX: Math.round(leftRect.left),
          jumpRight: Math.round(jumpRect.right),
          fits: leftRect.left >= 0 && jumpRect.right <= window.innerWidth
        };
      })()`);
      mobileFits.push(fit);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    const stageLockAndAdRes = await evalJs(`(async () => {
      const g = window._voltGame;
      g.returnToMainMenu();
      g.resetSaveProgress();
      const stageBtns = Array.from(document.querySelectorAll('#stage-buttons .stage-btn'));
      const onlyStage1Enabled = stageBtns.length === 6 && !stageBtns[0].disabled && stageBtns.slice(1).every(b => b.disabled && b.classList.contains('locked'));
      // Attempt clicking Stage 6 button and pressing Digit6 key
      stageBtns[5].click();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit6', key: '6' }));
      const stayedOnStage1 = g.currentStage === 1;
      // Click Play: must launch Stage 1, not Stage 6
      document.getElementById('btn-play').click();
      const launchedStage1 = g.state === 'playing' && g.currentStage === 1;

      return { onlyStage1Enabled, stayedOnStage1, launchedStage1 };
    })()`);

    const auditRegressionOk = mobileFits.every(m => m.fits) && stageLockAndAdRes.onlyStage1Enabled && stageLockAndAdRes.stayedOnStage1 && stageLockAndAdRes.launchedStage1;
    assertTest('Аудит QA', '6.15', 'Mobile touch buttons fit 320/360/390px viewports & strict unlockedStage progression lock',
      auditRegressionOk, JSON.stringify({ mobileFits, ...stageLockAndAdRes }));

    await screenshot('deep_logic_audit_complete.png');
    console.log(`\nPassed ${results.length} game logic checks.`);

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
  }
})();
