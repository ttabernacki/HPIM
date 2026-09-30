/* Echo Snake audio: everything is synthesized with WebAudio, no asset files.
 * Call unlock() from a user gesture. All methods are safe no-ops if audio is unavailable. */
(function (root) {
  "use strict";
  const A_MINOR_PENT = [0, 3, 5, 7, 10];               // semitones
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);

  function EchoAudio() {
    let ctx = null, master, sfxBus, musicBus, noiseBuf;
    let sfxOn = true, musicOn = true, musicLevel = 0, timer = null, step = 0, nextT = 0, bpm = 112;

    function unlock() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      try {
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
        sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
        musicBus = ctx.createGain(); musicBus.gain.value = 0.0; musicBus.connect(master);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        applyMusic();
        startMusic();
      } catch (e) { ctx = null; }
    }

    function tone(freq, dur, { type = "square", vol = 0.2, slideTo = null, delay = 0, attack = 0.005, bus = sfxBus } = {}) {
      if (!ctx || !sfxOn && bus === sfxBus) return;
      const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(bus || sfxBus);
      o.start(t); o.stop(t + dur + 0.02);
    }

    function noise(dur, { vol = 0.15, from = 800, to = 800, q = 1, type = "bandpass", delay = 0, bus = sfxBus } = {}) {
      if (!ctx || !sfxOn && bus === sfxBus) return;
      const t = ctx.currentTime + delay, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(bus || sfxBus);
      s.start(t); s.stop(t + dur + 0.02);
    }

    const sfx = {
      eat(combo) {
        const n = 57 + A_MINOR_PENT[combo % 5] + 12 * Math.min(2, Math.floor(combo / 5));
        tone(midi(n), 0.11, { type: "triangle", vol: 0.28, slideTo: midi(n) * 1.5 });
        tone(midi(n + 12), 0.07, { type: "sine", vol: 0.12, delay: 0.03 });
      },
      graze(mult) { noise(0.05, { vol: 0.05 + 0.01 * mult, from: 5200 + mult * 400, to: 3000, q: 4, type: "bandpass" }); },
      phase() {
        noise(0.35, { vol: 0.2, from: 300, to: 5000, q: 2 });
        tone(880, 0.3, { type: "sine", vol: 0.14, slideTo: 220 });
      },
      phaseThrough() { [0, 4, 7, 12].forEach((s, i) => tone(midi(81 + s), 0.09, { type: "sine", vol: 0.13, delay: i * 0.03 })); },
      phaseEnd() { tone(330, 0.12, { type: "sine", vol: 0.1, slideTo: 200 }); },
      charge() { tone(midi(76), 0.1, { type: "sine", vol: 0.2 }); tone(midi(83), 0.16, { type: "sine", vol: 0.2, delay: 0.09 }); },
      goldenSpawn() { [0, 7, 12, 19].forEach((s, i) => tone(midi(88 + s), 0.12, { type: "sine", vol: 0.08, delay: i * 0.05 })); },
      golden() { [0, 4, 7, 12, 16].forEach((s, i) => tone(midi(72 + s), 0.16, { type: "triangle", vol: 0.2, delay: i * 0.05 })); },
      goldenGone() { tone(midi(70), 0.25, { type: "sine", vol: 0.1, slideTo: midi(58) }); },
      newEcho() {
        tone(midi(45), 0.7, { type: "sawtooth", vol: 0.16, slideTo: midi(38) });
        tone(midi(46), 0.7, { type: "sawtooth", vol: 0.1, slideTo: midi(39) });
        noise(0.6, { vol: 0.1, from: 2000, to: 200, q: 1 });
      },
      comboLost() { tone(midi(52), 0.14, { type: "triangle", vol: 0.12, slideTo: midi(45) }); },
      die() {
        tone(midi(50), 0.9, { type: "sawtooth", vol: 0.26, slideTo: midi(26) });
        tone(midi(38), 0.9, { type: "square", vol: 0.14, slideTo: midi(21) });
        noise(0.7, { vol: 0.3, from: 3000, to: 80, q: 0.7, type: "lowpass" });
      },
      click() { tone(760, 0.05, { type: "square", vol: 0.08 }); },
      start() { [0, 5, 9, 12].forEach((s, i) => tone(midi(60 + s), 0.12, { type: "triangle", vol: 0.16, delay: i * 0.06 })); },
    };

    // ---- music: a 16-step loop in A minor; layers unlock as more echoes appear ----
    const BASS = [33, 0, 33, 0, 36, 0, 33, 0, 31, 0, 31, 0, 38, 0, 36, 0];   // 0 = rest
    const ARP = [57, 60, 64, 60, 57, 60, 65, 60, 55, 59, 62, 59, 57, 60, 64, 67];
    const LEAD = [81, 0, 0, 79, 0, 0, 76, 0, 0, 74, 0, 76, 0, 0, 0, 0];

    function scheduleStep(t, s) {
      const dur = 60 / bpm / 4;
      const at = (f, d, o) => {
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = o.type; osc.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(o.vol, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        osc.connect(g); g.connect(musicBus); osc.start(t); osc.stop(t + d + 0.02);
      };
      if (BASS[s]) at(midi(BASS[s]), dur * 1.8, { type: "triangle", vol: 0.5 });
      if (s % 2 === 0 && ctx) {                                     // hat
        const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = noiseBuf; f.type = "highpass"; f.frequency.value = 7000;
        g.gain.setValueAtTime(s % 4 === 0 ? 0.09 : 0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        src.connect(f); f.connect(g); g.connect(musicBus); src.start(t); src.stop(t + 0.06);
      }
      if (s % 4 === 0) at(midi(33 - 12 + 12), dur * 0.9, { type: "sine", vol: 0.45 });   // kick-ish thump
      if (musicLevel >= 2) at(midi(ARP[s]), dur * 0.8, { type: "square", vol: 0.07 });
      if (musicLevel >= 3 && LEAD[s]) at(midi(LEAD[s]), dur * 2.5, { type: "sine", vol: 0.16 });
    }

    function pump() {
      if (!ctx) return;
      const stepLen = 60 / bpm / 4;
      if (!(stepLen > 0)) return;                                   // never loop on a bad tempo
      if (nextT < ctx.currentTime - 1) nextT = ctx.currentTime;     // tab was throttled: don't replay a backlog
      for (let n = 0; n < 16 && nextT < ctx.currentTime + 0.25; n++) {
        if (musicOn && musicLevel > 0) scheduleStep(Math.max(nextT, ctx.currentTime), step % 16);
        nextT += stepLen; step++;
      }
    }
    function startMusic() {
      if (!ctx || timer) return;
      nextT = ctx.currentTime + 0.05; step = 0;
      timer = setInterval(pump, 80);
    }
    function applyMusic() {
      if (!ctx) return;
      const target = musicOn && musicLevel > 0 ? 0.22 : 0;
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.4);
    }

    return {
      unlock, sfx,
      setSfx(v) { sfxOn = !!v; },
      setMusic(v) { musicOn = !!v; applyMusic(); },
      // level: 0 silent, 1 bass+hat, 2 +arp, 3 +lead. Tempo follows game speed (tickMs).
      setIntensity(level, tickMs) {
        musicLevel = level;
        if (tickMs > 0) bpm = Math.max(90, Math.min(150, Math.round(100 + (125 - tickMs) * 0.6)));
        applyMusic();
      },
      get ready() { return !!ctx; },
      // Test hook: an analyser on the master bus, to verify that sound is really produced.
      tap() { if (!ctx) return null; const an = ctx.createAnalyser(); an.fftSize = 1024; master.connect(an); return an; },
    };
  }

  root.EchoAudio = EchoAudio;
  if (typeof module === "object" && module.exports) module.exports = EchoAudio;
})(typeof self !== "undefined" ? self : this);
