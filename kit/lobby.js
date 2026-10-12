// The lobby: name, create or join by code or link, the player list, ready, "Fill with bots", start,
// kick, mute, report, and the voice opt-in. Plain DOM over the game's canvas. The same panel doubles
// as the in-match "Players" panel (mode 'match'), so mute, report and kick are always one key away.
//
// Colours come from CSS variables on .mp-lobby: --mp-bg, --mp-card, --mp-ink, --mp-dim, --mp-accent,
// --mp-accent-ink, --mp-danger. Set them from the game's stylesheet to match its look.

const CSS = `
.mp-lobby{--mp-bg:rgba(10,12,20,.82);--mp-card:#171a26;--mp-ink:#f1eee6;--mp-dim:#9a9fb3;--mp-accent:#ffc857;--mp-accent-ink:#1b1505;--mp-danger:#ff6b6b;--mp-line:rgba(255,255,255,.1);
position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:var(--mp-bg);color:var(--mp-ink);
font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;overflow:auto;-webkit-tap-highlight-color:transparent}
.mp-lobby[hidden]{display:none}
.mp-card{width:min(440px,100%);background:var(--mp-card);border:1px solid var(--mp-line);border-radius:16px;padding:22px 22px 18px;box-shadow:0 20px 60px rgba(0,0,0,.5);margin:auto}
.mp-card h1{font-size:26px;line-height:1.15;margin:0 0 4px;letter-spacing:.01em}
.mp-card h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--mp-dim);margin:18px 0 8px;font-weight:600}
.mp-tag{color:var(--mp-dim);margin:0 0 14px}
.mp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mp-lobby input[type=text]{flex:1;min-width:0;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--mp-line);background:rgba(0,0,0,.25);color:var(--mp-ink);font:inherit}
.mp-lobby input[type=text]:focus{outline:2px solid var(--mp-accent);outline-offset:1px}
.mp-code{text-transform:uppercase;letter-spacing:.2em;max-width:130px;text-align:center}
.mp-btn{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--mp-line);background:rgba(255,255,255,.06);color:var(--mp-ink);font:600 15px/1 system-ui,sans-serif;cursor:pointer}
.mp-btn:hover{background:rgba(255,255,255,.12)}
.mp-btn:disabled{opacity:.45;cursor:default}
.mp-btn.mp-go{background:var(--mp-accent);color:var(--mp-accent-ink);border-color:transparent}
.mp-btn.mp-go:hover{filter:brightness(1.08)}
.mp-btn.mp-wide{width:100%;margin-top:10px}
.mp-btn.mp-on{outline:2px solid var(--mp-accent)}
.mp-mini{min-height:32px;min-width:44px;padding:0 9px;border-radius:8px;border:1px solid var(--mp-line);background:transparent;color:var(--mp-dim);font:600 12px/1 system-ui,sans-serif;cursor:pointer}
.mp-mini:hover{color:var(--mp-ink);border-color:var(--mp-dim)}
.mp-mini.mp-on{color:var(--mp-danger);border-color:var(--mp-danger)}
.mp-or{color:var(--mp-dim);font-size:13px;margin:14px 0 6px}
.mp-note{color:var(--mp-dim);font-size:13px;margin:10px 0 0}
.mp-err{color:var(--mp-danger);font-size:14px;margin:10px 0 0}
.mp-codebox{display:flex;align-items:center;gap:10px;justify-content:space-between;background:rgba(0,0,0,.25);border-radius:12px;padding:10px 12px}
.mp-codebox b{font:700 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em}
.mp-codebox span{color:var(--mp-dim);font-size:12px;display:block;margin-bottom:3px;letter-spacing:.08em;text-transform:uppercase}
.mp-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.mp-list li{display:flex;align-items:center;gap:8px;min-height:40px;padding:2px 8px;border-radius:8px;background:rgba(255,255,255,.04)}
.mp-list li.mp-gone{opacity:.45}
.mp-dot{width:10px;height:10px;border-radius:50%;background:var(--mp-dim);flex:none;transition:box-shadow .1s}
.mp-dot.mp-ready{background:#6fdc8c}
.mp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-badge{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mp-dim);border:1px solid var(--mp-line);border-radius:6px;padding:2px 5px}
.mp-badge.mp-host{color:var(--mp-accent);border-color:var(--mp-accent)}
.mp-spin{width:18px;height:18px;border-radius:50%;border:3px solid var(--mp-line);border-top-color:var(--mp-accent);animation:mp-spin 1s linear infinite;display:inline-block;vertical-align:-4px;margin-right:8px}
@keyframes mp-spin{to{transform:rotate(360deg)}}
.mp-how{color:var(--mp-dim);font-size:14px;margin:0}
.mp-how b{color:var(--mp-ink)}
.mp-ptt{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:40;width:72px;height:72px;border-radius:50%;border:2px solid var(--mp-accent,#ffc857);background:rgba(10,12,20,.7);color:#fff;font:700 12px/1.1 system-ui,sans-serif;touch-action:none;user-select:none;-webkit-user-select:none}
.mp-ptt.mp-on{background:var(--mp-accent,#ffc857);color:#1b1505}
.mp-ptt[hidden]{display:none}
`;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
};

export function createLobby(opts) {
  const {
    mount = document.body, title = 'Multiplayer', tagline = '', howTo = '', minPlayers = 2, maxPlayers = 8, fillTo = maxPlayers,
    pttLabel = 'V', voiceNote = 'Voice goes live between players and is never recorded or stored.',
    actions,          // { create(name), join(code, name, via), solo(name), leave(), start(), copyLink() }
    state,            // () => ({ view, code, error, room, voice, name, linkCode, mode, canStart, startHint, busy })
  } = opts;

  if (!document.getElementById('mp-lobby-css')) mount.ownerDocument.head.append(h('style', { id: 'mp-lobby-css', text: CSS }));
  const root = h('div', { class: 'mp-lobby', role: 'dialog', 'aria-label': title });
  const card = h('div', { class: 'mp-card' });
  root.append(card);
  mount.append(root);
  // Typing a name must not steer the game underneath.
  for (const ev of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'wheel']) root.addEventListener(ev, e => e.stopPropagation());

  let nameDraft = null, codeDraft = '', askAge = false, reportFor = null, copied = 0, lastKey = '';

  function render() {
    const s = state();
    // Rebuilding the card would drop focus mid-typing, so only rebuild when something shown changed.
    const r = s.room, v = s.voice;
    const key = JSON.stringify([s.view, s.code, s.error, s.mode, s.busy, s.canStart, s.startHint, s.quick, s.public, s.startIn, askAge, reportFor, copied > Date.now(),
      r && [r.isHost, r.hostPid, r.pid, r.roster.map(x => [x.pid, x.name, x.ready, !!x.peer, x.bot])],
      v && [v.enabled, v.hasMic, v.muteAll, v.openMic, v.age, r && r.roster.map(x => v.isMuted(x.pid))]]);
    if (key === lastKey) return;
    lastKey = key;
    const focusId = document.activeElement?.id;
    const kids = s.view === 'room' ? roomView(s) : s.view === 'connecting' ? connectingView(s) : landingView(s);
    card.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== ''));
    if (focusId) card.querySelector('#' + focusId)?.focus();
  }

  function landingView(s) {
    const name = nameDraft ?? s.name ?? '';
    const nameInput = h('input', { type: 'text', id: 'mp-name', maxlength: 16, placeholder: 'Your name', value: name, autocomplete: 'nickname', 'aria-label': 'Your name', oninput: e => (nameDraft = e.target.value) });
    const getName = () => (nameInput.value.trim() || 'Player').slice(0, 16);
    const codeInput = h('input', { type: 'text', id: 'mp-code', class: 'mp-code', maxlength: 6, placeholder: 'CODE', value: codeDraft, autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Room code',
      oninput: e => (codeDraft = e.target.value), onkeydown: e => { if (e.key === 'Enter') joinCode(); } });
    const joinCode = () => { const c = codeInput.value.trim().toUpperCase(); if (c.length >= 4) actions.join(c, getName(), 'code'); };
    return [
      h('h1', { text: title }),
      tagline && h('p', { class: 'mp-tag', text: tagline }),
      h('div', { class: 'mp-row' }, nameInput),
      s.linkCode
        ? h('button', { class: 'mp-btn mp-go mp-wide', id: 'mp-join-link', text: 'Join room ' + s.linkCode, onclick: () => actions.join(s.linkCode, getName(), 'link') })
        : h('button', { class: 'mp-btn mp-go mp-wide', id: 'mp-create', text: 'Create a room', onclick: () => actions.create(getName()) }),
      s.linkCode && h('button', { class: 'mp-btn mp-wide', id: 'mp-create', text: 'Create a new room instead', onclick: () => actions.create(getName()) }),
      s.quick && h('button', { class: 'mp-btn mp-wide', id: 'mp-quick', text: 'Quick play with anyone', onclick: () => actions.quick(getName()) }),
      h('p', { class: 'mp-or', text: 'Have a code from a friend?' }),
      h('div', { class: 'mp-row' }, codeInput, h('button', { class: 'mp-btn', id: 'mp-join-code', text: 'Join', onclick: joinCode })),
      h('button', { class: 'mp-btn mp-wide', id: 'mp-solo', text: 'Try it alone with bots', onclick: () => actions.solo(getName()) }),
      s.error && h('p', { class: 'mp-err', role: 'alert', text: s.error }),
      howTo && h('h2', { text: 'How it works' }),
      howTo && Object.assign(h('p', { class: 'mp-how' }), { innerHTML: howTo }),
      h('p', { class: 'mp-note', text: 'Rooms are private: only people with your link or code can join. No account needed.' }),
    ];
  }

  function connectingView(s) {
    return [
      h('h1', { text: title }),
      h('p', {}, h('span', { class: 'mp-spin' }), s.code ? 'Finding room ' + s.code + '…' : 'Looking for a game…'),
      h('p', { class: 'mp-note', text: 'Players connect straight to each other. The first connection can take a few seconds.' }),
      h('button', { class: 'mp-btn mp-wide', text: 'Cancel', onclick: () => actions.leave() }),
    ];
  }

  function roomView(s) {
    const r = s.room, v = s.voice, match = s.mode === 'match';
    const me = r.pid, host = r.isHost;
    const rows = r.roster.map(p => {
      const mine = p.pid === me;
      const dot = h('span', { class: 'mp-dot' + (p.ready || p.bot ? ' mp-ready' : ''), 'data-pid': p.pid, title: p.ready || p.bot ? 'Ready' : 'Not ready' });
      return h('li', { class: !p.bot && !p.peer ? 'mp-gone' : '' },
        dot,
        h('span', { class: 'mp-name', text: p.name + (mine ? ' (you)' : '') + (!p.bot && !p.peer ? ' · reconnecting' : '') }),
        p.pid === r.hostPid && h('span', { class: 'mp-badge mp-host', text: 'Host' }),
        p.bot && h('span', { class: 'mp-badge', text: 'Bot' }),
        !mine && !p.bot && v?.enabled && h('button', { class: 'mp-mini' + (v.isMuted(p.pid) ? ' mp-on' : ''), text: v.isMuted(p.pid) ? 'Muted' : 'Mute', 'aria-pressed': String(v.isMuted(p.pid)), onclick: () => { v.mute(p.pid); render(); } }),
        !mine && !p.bot && h('button', { class: 'mp-mini', text: 'Report', onclick: () => { reportFor = reportFor === p.pid ? null : p.pid; render(); } }),
        // In a public room the host is just whoever got there first, so it can't throw people out.
        host && !mine && !s.public && h('button', { class: 'mp-mini', text: p.bot ? 'Remove' : 'Kick', onclick: () => r.kick(p.pid) }),
      );
    });
    const reportRow = reportFor && r.player(reportFor) && h('div', { class: 'mp-row', style: 'margin-top:8px' },
      h('span', { class: 'mp-note', style: 'margin:0', text: 'Report ' + r.player(reportFor).name + ' for:' }),
      ...['Abusive voice', 'Cheating', 'Bad name'].map(reason => h('button', { class: 'mp-mini', text: reason, onclick: () => { actions.report(reportFor, reason); reportFor = null; render(); } })));

    const voiceBox = v && (
      v.age === 'under' ? [h('p', { class: 'mp-note', text: 'Voice chat is off for players under 13.' })]
      : askAge && v.age !== 'ok' ? [
        h('p', { class: 'mp-note', style: 'margin-top:0', text: 'Voice chat is for players 13 and over. Are you 13 or older?' }),
        h('div', { class: 'mp-row' },
          h('button', { class: 'mp-btn', id: 'mp-age-yes', text: 'Yes, 13 or older', onclick: async () => { v.setAge(true); askAge = false; await v.enable(); render(); } }),
          h('button', { class: 'mp-btn', id: 'mp-age-no', text: 'No', onclick: () => { v.setAge(false); askAge = false; render(); } })),
      ]
      : !v.enabled ? [
        h('button', { class: 'mp-btn', id: 'mp-voice-on', text: 'Turn on voice chat', onclick: async () => { if (v.age !== 'ok') { askAge = true; render(); } else { await v.enable(); render(); } } }),
        h('p', { class: 'mp-note', text: 'Off until you turn it on. Headphones recommended. ' + voiceNote }),
      ]
      : [
        h('p', { class: 'mp-note', style: 'margin-top:0', text: v.hasMic ? 'Voice is on. Hold ' + pttLabel + ' to talk; players near you hear you.' : 'Listening only: the microphone was blocked.' }),
        h('div', { class: 'mp-row' },
          h('button', { class: 'mp-mini' + (v.muteAll ? ' mp-on' : ''), text: v.muteAll ? 'Everyone muted' : 'Mute all', 'aria-pressed': String(v.muteAll), onclick: () => { v.setMuteAll(!v.muteAll); render(); } }),
          v.hasMic && h('button', { class: 'mp-mini' + (v.openMic ? ' mp-on' : ''), text: v.openMic ? 'Open mic is on' : 'Open mic (headphones only)', 'aria-pressed': String(v.openMic), onclick: () => { v.setOpenMic(!v.openMic); render(); } }),
          h('button', { class: 'mp-mini', text: 'Turn voice off', onclick: () => { v.disable(); render(); } })),
      ]);

    const meEntry = r.me;
    const hint = s.startHint || (r.roster.length < minPlayers ? 'Needs ' + minPlayers + ' players. Invite friends or fill with bots.' : '');
    return [
      h('h1', { text: match ? 'Players' : title }),
      !s.solo && h('div', { class: 'mp-codebox' },
        h('div', {}, h('span', { text: s.public ? 'Public room' : 'Room code' }), h('b', { id: 'mp-room-code', text: s.code })),
        h('button', { class: 'mp-btn', id: 'mp-copy', text: copied > Date.now() ? 'Copied' : 'Copy invite link', onclick: async () => { await actions.copyLink(); copied = Date.now() + 1600; render(); setTimeout(render, 1700); } })),
      h('h2', { text: 'Players (' + r.roster.length + '/' + maxPlayers + ')' }),
      h('ul', { class: 'mp-list', id: 'mp-players' }, rows),
      reportRow,
      !match && h('div', { class: 'mp-row', style: 'margin-top:12px' },
        !host && meEntry && h('button', { class: 'mp-btn' + (meEntry.ready ? ' mp-on' : ''), id: 'mp-ready', text: meEntry.ready ? 'Ready' : "I'm ready", 'aria-pressed': String(!!meEntry.ready), onclick: () => r.setReady(!meEntry.ready) }),
        host && !s.public && r.roster.length < Math.min(fillTo, maxPlayers) && h('button', { class: 'mp-btn', id: 'mp-fill', text: 'Fill with bots', onclick: () => r.fillBots(fillTo) }),
        host && h('button', { class: 'mp-btn mp-go', id: 'mp-start', text: 'Start game', disabled: !s.canStart, onclick: () => actions.start() })),
      !match && s.public && h('p', { class: 'mp-note', id: 'mp-auto', text: s.startIn != null ? 'Starting in ' + s.startIn + '. Bots give up their seats as people join.' : 'The game starts by itself in a moment.' }),
      !match && !s.public && (host ? hint && h('p', { class: 'mp-note', text: hint }) : h('p', { class: 'mp-note', text: 'Waiting for ' + (r.player(r.hostPid)?.name || 'the host') + ' to start.' })),
      s.public && h('p', { class: 'mp-note', text: 'Anyone can join this room. There is no voice chat in public rooms; invite friends to a room of your own for that.' }),
      s.error && h('p', { class: 'mp-err', role: 'alert', text: s.error }),
      v && !s.solo && h('h2', { text: 'Voice chat' }),
      v && !s.solo && voiceBox,
      h('div', { class: 'mp-row', style: 'margin-top:16px;justify-content:space-between' },
        h('button', { class: 'mp-mini', id: 'mp-leave', text: 'Leave room', onclick: () => actions.leave() }),
        match && h('button', { class: 'mp-btn', id: 'mp-close', text: 'Back to the game', onclick: () => actions.close() })),
    ];
  }

  // "Is talking" rings on the player dots, without re-rendering the list.
  function pulse(levelOf) {
    for (const dot of card.querySelectorAll('.mp-dot[data-pid]')) {
      const l = levelOf(dot.dataset.pid);
      dot.style.boxShadow = l > 0.06 ? `0 0 0 ${Math.round(2 + l * 6)}px rgba(111,220,140,.35)` : '';
    }
  }

  return {
    el: root, render, pulse,
    show() { root.hidden = false; lastKey = ''; render(); },
    hide() { root.hidden = true; },
    get visible() { return !root.hidden; },
  };
}

// A hold-to-talk button for touch screens, where there is no V key.
export function createTalkButton({ mount = document.body, voice }) {
  const btn = h('button', { class: 'mp-ptt', hidden: true, 'aria-label': 'Hold to talk', text: 'Hold to talk' });
  const set = on => { voice.setTalking(on); btn.classList.toggle('mp-on', on); };
  btn.addEventListener('pointerdown', e => { e.preventDefault(); btn.setPointerCapture(e.pointerId); set(true); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, () => set(false));
  mount.append(btn);
  return { el: btn, update(show) { btn.hidden = !show; } };
}
