const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARTIFACT_DIR = 'C:/Users/Viktor/.gemini/antigravity/brain/5795fe41-64dc-42c4-a9da-32b424262e45';
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TARGET_URL = 'http://localhost:8790/index.html';

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
  const chromeProc = spawn(CHROME_PATH, [
    '--remote-debugging-port=9226',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1280,720',
    '--user-data-dir=C:/temp/chrome_deep_logic_test',
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
    let targets = null;
    for (let i = 0; i < 25; i++) {
      try {
        targets = await getJson('http://127.0.0.1:9226/json');
        if (targets && targets.length > 0) break;
      } catch (e) {}
      await sleep(300);
    }
    const pageTarget = targets.find((t) => t.type === 'page');
    cdp = new PersistentCDP(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await sleep(1500);

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

    // 5.1 Pit Recovery Nearest Safe Island Range
    const pitSafeRes = await evalJs(`(() => {
      const g = window._voltGame;
      g.startStage(4);
      // Fall at far edge of gap
      const safeX = g.findNearestSafeX(44 * 44);
      // Safe column must be an actual ground block
      const col = Math.round(safeX / 44);
      const isSolidGround = g.solidBlocks.some(b => b.kind === 'grass' && Math.round(b.x / 44) === col);
      return { isSolidGround, safeX };
    })()`);
    assertTest('Сейвы', '5.1', 'Спасение из ям всегда находит твердую платформу острова', pitSafeRes.isSolidGround);

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

    await screenshot('deep_logic_audit_complete.png');
    console.log(`\n🎉 ВСЕ ТЕСТЫ ИГРОВОЙ ЛОГИКИ (${results.length}/${results.length}) УСПЕШНО ПРОЙДЕНЫ! 100% ПРОВЕРКА ЗАВЕРШЕНА.`);

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
  }
})();
