// Proximity voice over the same peer connections as the game data. Each remote voice is placed in
// the world on the listener's side: distance fades it, and walls muffle it with a low-pass filter.
//
//   voice off until the player opts in · push-to-talk by default · mute per player and mute all ·
//   an age question first (under-13s get no voice) · nothing is ever recorded
//
//   const voice = createVoice({ room, transport, storagePrefix })
//   await voice.enable()                         // from a click: asks for the mic (listen-only if refused)
//   voice.setTalking(true|false)                 // push-to-talk
//   voice.setCanTalk(false)                      // a role with no voice (a ghost)
//   voice.update(listener, peers)                // every frame while in the world:
//       listener: { x, y, z, fx, fy, fz }        //   position and facing
//       peers: { [pid]: { x, y, z, muffle, gain } }   muffle 0 (clear) … 1 (through walls); gain 0 … 1
//   voice.setSpatial(false)                      // lobby: everyone at full volume, no position
//
// Chrome does not cancel echo for sound played through Web Audio, so speakers plus an open mic
// echo. Push-to-talk avoids it. `aec: 'loop'` (?aec=loop) also routes the mix through a loopback
// peer connection into an <audio> element, which Chrome does cancel; it is there to be tested.

export function createVoice({ room, transport, storagePrefix = 'mp', range = 14, refDistance = 1.6, aec = null, onChange = () => {}, track = () => {} }) {
  const peers = new Map();          // peerId -> { stream, el, src, lp, gain, pan, an, buf, level }
  const muted = new Set();          // pids
  let ctx = null, bus = null, mic = null, micTrack = null, micAn = null, micBuf = null;
  let enabled = false, talking = false, canTalk = true, canHear = true, spatial = false, muteAll = false, open = false;
  let loop = null;
  const store = {
    get(k) { try { return localStorage.getItem(storagePrefix + '.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(storagePrefix + '.' + k, v); } catch {} },
  };

  const voice = {
    get enabled() { return enabled; },
    get hasMic() { return !!micTrack; },
    get talking() { return talking && canTalk && !!micTrack; },
    get canTalk() { return canTalk; },
    get muteAll() { return muteAll; },
    get openMic() { return open; },
    get age() { return store.get('voiceAge'); },            // null (not asked) | 'ok' | 'under'
    setAge(over13) { store.set('voiceAge', over13 ? 'ok' : 'under'); onChange(); },
    isMuted: pid => muted.has(pid),
    get context() { return ctx; },

    async enable() {
      if (enabled) return true;
      if (voice.age !== 'ok') return false;
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume().catch(() => {});
      bus = ctx.createGain();
      routeOut();
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        micTrack = mic.getAudioTracks()[0];
        micTrack.enabled = false;
        micAn = ctx.createAnalyser(); micAn.fftSize = 256; micBuf = new Uint8Array(micAn.fftSize);
        ctx.createMediaStreamSource(mic).connect(micAn);
        transport.addStream(mic);
      } catch { mic = null; micTrack = null; }             // refused: listen only
      enabled = true;
      for (const [id, p] of peers) wire(id, p);
      track('mp_voice_on', { mic: micTrack ? 1 : 0 });
      applyGains(); onChange();
      return true;
    },
    disable() {
      if (!enabled) return;
      if (mic) { transport.removeStream(mic); mic.getTracks().forEach(t => t.stop()); }
      mic = micTrack = micAn = null;
      for (const p of peers.values()) unwire(p);
      enabled = talking = false;
      onChange();
    },
    setTalking(on) {
      talking = !!on;
      if (micTrack) micTrack.enabled = (talking || open) && canTalk;
      onChange();
    },
    setOpenMic(on) { open = !!on; voice.setTalking(talking); },      // headphones on: no need to hold a key
    setCanTalk(on) { canTalk = !!on; voice.setTalking(talking); },
    setCanHear(on) { canHear = !!on; applyGains(); },
    setSpatial(on) { spatial = !!on; if (!spatial) for (const p of peers.values()) flat(p); applyGains(); },
    mute(pid, on = !muted.has(pid)) { on ? muted.add(pid) : muted.delete(pid); applyGains(); onChange(); },
    setMuteAll(on) { muteAll = !!on; applyGains(); onChange(); },

    // 0 … 1, for "is talking" rings. Mine is the mic; theirs is what arrived.
    myLevel() { return micAn && voice.talking ? rms(micAn, micBuf) : 0; },
    level(pid) { const p = peers.get(room.peerOf(pid)); return p?.an ? rms(p.an, p.buf) : 0; },

    update(listener, world) {
      if (!enabled || !spatial) return;
      const L = ctx.listener, t = ctx.currentTime;
      if (L.positionX) {
        L.positionX.setTargetAtTime(listener.x, t, 0.03); L.positionY.setTargetAtTime(listener.y, t, 0.03); L.positionZ.setTargetAtTime(listener.z, t, 0.03);
        L.forwardX.setTargetAtTime(listener.fx, t, 0.03); L.forwardY.setTargetAtTime(listener.fy || 0, t, 0.03); L.forwardZ.setTargetAtTime(listener.fz, t, 0.03);
      } else { L.setPosition(listener.x, listener.y, listener.z); L.setOrientation(listener.fx, listener.fy || 0, listener.fz, 0, 1, 0); }
      for (const r of room.roster) {
        const p = r.peer && peers.get(r.peer);
        if (!p?.pan) continue;
        const w = world[r.pid];
        p.world = w ? (w.gain ?? 1) : 0;
        if (w) {
          p.pan.positionX.setTargetAtTime(w.x, t, 0.04); p.pan.positionY.setTargetAtTime(w.y, t, 0.04); p.pan.positionZ.setTargetAtTime(w.z, t, 0.04);
          // Smooth the cutoff so a wall coming between two players doesn't click.
          const cut = 18000 * Math.pow(700 / 18000, Math.min(1, Math.max(0, w.muffle || 0)));
          p.lp.frequency.setTargetAtTime(cut, t, 0.08);
        }
      }
      applyGains();
    },

    // A report is the player, the room and the reason. It never includes audio.
    report(pid, reason) {
      muted.add(pid); applyGains(); onChange();
      track('mp_report', { reason: String(reason).slice(0, 40) });
    },
    _peers: peers,
  };

  function rms(an, buf) {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / buf.length) * 4);
  }

  function routeOut() {
    if (aec !== 'loop' || !window.RTCPeerConnection) { bus.connect(ctx.destination); return; }
    // mix → loopback peer connection → <audio>, so Chrome's echo canceller sees what the speakers play
    const dest = ctx.createMediaStreamDestination();
    bus.connect(dest);
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const el = new Audio(); el.autoplay = true;
    b.ontrack = e => { el.srcObject = e.streams[0] || new MediaStream([e.track]); el.play().catch(() => {}); };
    dest.stream.getTracks().forEach(tr => a.addTrack(tr, dest.stream));
    (async () => {
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
    })().catch(() => bus.connect(ctx.destination));
    loop = { a, b, el };
  }

  function wire(id, p) {
    if (!ctx || p.src) return;
    // Chrome only feeds a remote WebRTC stream into Web Audio while a media element is also playing it.
    p.el = new Audio(); p.el.muted = true; p.el.srcObject = p.stream; p.el.play().catch(() => {});
    p.src = ctx.createMediaStreamSource(p.stream);
    p.lp = ctx.createBiquadFilter(); p.lp.type = 'lowpass'; p.lp.frequency.value = 18000; p.lp.Q.value = 0.5;
    p.gain = ctx.createGain(); p.gain.gain.value = 0;
    p.pan = ctx.createPanner();
    p.pan.panningModel = matchMedia('(pointer: coarse)').matches ? 'equalpower' : 'HRTF';
    p.pan.distanceModel = 'linear'; p.pan.refDistance = refDistance; p.pan.maxDistance = range; p.pan.rolloffFactor = 1;
    p.an = ctx.createAnalyser(); p.an.fftSize = 256; p.buf = new Uint8Array(p.an.fftSize);
    p.src.connect(p.an);
    p.src.connect(p.lp).connect(p.gain).connect(p.pan).connect(bus);
    p.world = 1;
    if (!spatial) flat(p);
  }
  function unwire(p) {
    try { p.src?.disconnect(); p.pan?.disconnect(); } catch {}
    if (p.el) { p.el.srcObject = null; }
    p.src = p.lp = p.gain = p.pan = p.an = p.el = null;
  }
  // No position: sit the voice on the listener, unmuffled.
  function flat(p) {
    if (!p.pan) return;
    const L = ctx.listener, t = ctx.currentTime;
    const lx = L.positionX ? L.positionX.value : 0, ly = L.positionY ? L.positionY.value : 0, lz = L.positionZ ? L.positionZ.value : 0;
    p.pan.positionX.setValueAtTime(lx, t); p.pan.positionY.setValueAtTime(ly, t); p.pan.positionZ.setValueAtTime(lz, t);
    p.lp.frequency.setTargetAtTime(18000, t, 0.05);
    p.world = 1;
  }
  function applyGains() {
    if (!ctx) return;
    for (const [id, p] of peers) {
      if (!p.gain) continue;
      const pid = room.pidOf(id);          // only players on the roster are heard (a kicked peer is not)
      const g = !pid || !canHear || muteAll || muted.has(pid) ? 0 : (spatial ? p.world ?? 0 : 1);
      p.gain.gain.setTargetAtTime(g, ctx.currentTime, 0.05);
    }
  }

  transport.onPeerStream((stream, id) => {
    const old = peers.get(id);
    if (old) unwire(old);
    const p = { stream };
    peers.set(id, p);
    if (enabled) { wire(id, p); applyGains(); }
    onChange();
  });
  room.on('peer', (id, joined) => {
    if (joined) { if (mic) transport.addStream(mic, id); }
    else { const p = peers.get(id); if (p) { unwire(p); peers.delete(id); } }
  });
  room.on('roster', applyGains);

  return voice;
}
