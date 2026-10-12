// Snapshot interpolation: draw other players slightly in the past, blending between the two
// snapshots either side of that moment, so 15 snapshots a second look smooth at 60 fps.
//
//   const interp = createInterp({ delayMs: 120 })
//   room.on('snapshot', s => interp.push(s.t, s.players, performance.now()))   // players: { id: { x, z, yaw, … } }
//   const p = interp.sample(id, performance.now())                             // null until it has one
//
// Number fields are blended. Fields named in `angles` take the short way round. Anything else
// (flags, strings) comes from the newer snapshot.

export function createInterp({ delayMs = 120, angles = ['yaw', 'pitch'], keep = 40 } = {}) {
  const buf = [];             // { t, ents } in host time, oldest first
  let offset = Infinity;      // local clock minus host clock, from the fastest snapshot seen
  const isAngle = new Set(angles);

  function push(hostT, ents, localNow) {
    const o = localNow - hostT;
    // Follow the fastest arrivals, and drift up slowly so one early packet can't pin it for ever.
    offset = o < offset ? o : offset + (o - offset) * 0.02;
    if (buf.length && hostT <= buf[buf.length - 1].t) return;     // late or repeated
    buf.push({ t: hostT, ents });
    if (buf.length > keep) buf.shift();
  }

  function sample(id, localNow) {
    if (!buf.length) return null;
    const t = localNow - offset - delayMs;
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > t) i--;
    const a = buf[i], b = buf[Math.min(i + 1, buf.length - 1)];
    const ea = a.ents[id], eb = b.ents[id];
    if (!ea && !eb) return null;
    if (!ea || !eb || a === b || t <= a.t) return { ...(t >= b.t ? eb || ea : ea || eb) };
    if (t >= b.t) return { ...eb };
    const k = (t - a.t) / (b.t - a.t);
    const out = { ...eb };
    for (const key in eb) {
      const va = ea[key], vb = eb[key];
      if (typeof va !== 'number' || typeof vb !== 'number') continue;
      if (isAngle.has(key)) {
        let d = (vb - va) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
        out[key] = va + d * k;
      } else out[key] = va + (vb - va) * k;
    }
    return out;
  }

  return { push, sample, reset() { buf.length = 0; offset = Infinity; }, get offset() { return offset; }, get size() { return buf.length; } };
}

// A fixed-rate ticker for the host's snapshot loop that doesn't drift with the frame rate.
export function createTicker(hz, fn) {
  const step = 1000 / hz;
  let acc = 0;
  return dtMs => {
    acc += dtMs;
    if (acc < step) return;
    acc = acc > step * 4 ? 0 : acc - step;
    fn();
  };
}

// A timer that keeps going when the tab is in the background. Browsers pause requestAnimationFrame
// and slow timers on a hidden page, and a host whose tab is hidden would freeze the game for
// everyone. Timers inside a Worker are not slowed, so the host runs its rules from this instead.
//
//   const beat = createHeartbeat(30, dtSeconds => hostStep(dtSeconds))     beat.stop()
export function createHeartbeat(hz, fn) {
  const src = `let t=setInterval(()=>postMessage(0),${Math.round(1000 / hz)});onmessage=()=>clearInterval(t)`;
  let worker = null, timer = null, last = performance.now();
  const tick = () => { const now = performance.now(); const dt = Math.min(0.25, (now - last) / 1000); last = now; fn(dt); };
  try {
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = tick;
  } catch { timer = setInterval(tick, 1000 / hz); }
  return { stop() { worker?.postMessage(0); worker?.terminate(); clearInterval(timer); } };
}
