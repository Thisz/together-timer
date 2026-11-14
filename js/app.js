/* Together Timer: one shared Firebase record per unguessable room URL. */
'use strict';
const firebaseConfig = {
  apiKey: "AIzaSyClaupvLuPGzFoOhRZgQnMlmspbT41YRbg",
  authDomain: "together-timer-ec5eb.firebaseapp.com",
  databaseURL: "https://together-timer-ec5eb-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "together-timer-ec5eb",
  storageBucket: "together-timer-ec5eb.firebasestorage.app",
  messagingSenderId: "517730156823",
  appId: "1:517730156823:web:d9a0c2bce51dbdbaa93752"
};
const el = id => document.getElementById(id);
const circumference = 2 * Math.PI * 96;
const controls = ['startPauseButton', 'restartButton', 'minusButton', 'plusButton'];
let database, roomRef, unsubscribe = null, roomId = null, state = null;
let serverOffset = 0, ready = false, busy = false, wasFinished = false;
let joinedRoom = null, pendingCreatorName = null;
let audioContext = null, lastAlarmKey = null;
const SOUND_KEY = 'togetherTimerSoundEnabled';
let soundEnabled = localStorage.getItem(SOUND_KEY) !== 'false';
let presenceRef = null, presenceRoomRef = null, presenceCallback = null, currentUid = null, connectionRef = null;
el('ringProgress').style.strokeDasharray = String(circumference);
const now = () => Date.now() + serverOffset;
function unlockAlarmAudio() {
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext = new AudioContextClass();
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch (error) { console.warn('Audio unavailable', error); }
}
document.addEventListener('pointerdown', unlockAlarmAudio, {passive:true});
document.addEventListener('keydown', unlockAlarmAudio);
function playFinishedChime() {
  if (!soundEnabled) return false;
  unlockAlarmAudio();
  if (!audioContext) return false;
  if (audioContext.state !== 'running') { audioContext.resume().catch(() => {}); return false; }
  const start = audioContext.currentTime + 0.04;
  [0, 0.42, 0.84].forEach((delay, index) => {
    [659.25, 783.99].forEach((frequency, note) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const at = start + delay + note * 0.11;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.34);
    });
  });
  return true;
}
function renderSoundToggle() {
  const button = el('soundToggleButton');
  button.textContent = soundEnabled ? '🔊 Alert sound: On' : '🔇 Alert sound: Off';
  button.setAttribute('aria-pressed', String(soundEnabled));
}
el('soundToggleButton').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem(SOUND_KEY, String(soundEnabled));
  if (soundEnabled) unlockAlarmAudio();
  el('soundFeedback').textContent = soundEnabled ? 'Sound alerts enabled on this device.' : 'Sound alerts muted on this device.';
  renderSoundToggle();
});
renderSoundToggle();
const feedback = message => { el('connectionFeedback').textContent = message || ''; };
const fmtEvent = ms => {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return days + 'd ' + String(hours).padStart(2, '0') + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
};
el('timerType').addEventListener('change', () => {
  const eventMode = el('timerType').value === 'event';
  el('durationFields').hidden = eventMode;
  el('eventDateField').hidden = !eventMode;
});
const fmt = ms => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const remaining = s => s ? (s.running ? Math.max(0, s.endAt - now()) : Math.max(0, s.remaining)) : 0;
const validId = id => /^[a-f0-9]{32}$/.test(id || '');
const isHost = () => !!(state && state.ownerUid && state.ownerUid === currentUid);
const mayControl = () => !!(state && (!state.ownerUid || isHost() || state.controlsMode !== 'host'));
function leavePresence() {
  if (presenceRoomRef && presenceCallback) presenceRoomRef.off('value', presenceCallback);
  presenceCallback = null; presenceRoomRef = null;
  if (presenceRef) { const old = presenceRef; presenceRef = null; old.remove().catch(() => {}); }
  connectionRef = null;
  el('participantsList').replaceChildren();
  el('participantCount').textContent = '';
}
function connectPresence(id) {
  presenceRoomRef = database.ref('presence/' + id);
  presenceCallback = presenceRoomRef.on('value', snap => {
    if (id !== roomId) return;
    const list = el('participantsList'); list.replaceChildren();
    const users = Object.entries(snap.val() || {}).filter(([,v]) => v && v.name);
    el('participantCount').textContent = users.length + ' online';
    users.forEach(([uid,v]) => {
      const item = document.createElement('div'); item.className = 'participant-item';
      item.textContent = v.name + (uid === state?.ownerUid ? ' · Host' : '') + (uid === currentUid ? ' · You' : '');
      list.append(item);
    });
    if (!users.length) list.textContent = 'No one has joined the participant list yet.';
  }, error => feedback('Participant list unavailable: ' + error.message));
  const savedName = localStorage.getItem('togetherTimerParticipantName') || '';
  if (joinedRoom === id && savedName) el('participantName').value = savedName;
}
async function registerPresence() {
  if (!roomId || !currentUid || !ready || joinedRoom !== roomId) return;
  const name = el('participantName').value.trim().slice(0,40);
  if (!name) { feedback('Please enter your name to join the participant list.'); return; }
  localStorage.setItem('togetherTimerParticipantName', name);
  const id = roomId;
  const ref = database.ref('presence/' + id + '/' + currentUid);
  try {
    await ref.onDisconnect().remove();
    if (roomId !== id) return;
    await ref.set({name,onlineAt:firebase.database.ServerValue.TIMESTAMP});
    presenceRef = ref;
    feedback('');
  } catch(error) { feedback('Could not join participant list: ' + error.message); }
}
el('joinPresenceButton').addEventListener('click', () => {
  const input = el('participantName');
  const button = el('joinPresenceButton');
  if (input.hidden) {
    input.hidden = false;
    button.textContent = 'Save name';
    input.focus();
    input.select();
    return;
  }
  if (!input.value.trim()) { feedback('Please enter your name.'); input.focus(); return; }
  registerPresence().then(() => {
    input.hidden = true;
    button.textContent = 'Edit name';
  });
});
el('confirmJoinButton').addEventListener('click', () => {
  const name = el('joinName').value.trim().slice(0,40);
  if (!name) { el('joinError').textContent='Please enter your name to join.'; el('joinError').hidden=false; return; }
  if (!ready || !roomId) { el('joinError').textContent='Timer is not ready. Try again.'; el('joinError').hidden=false; return; }
  el('joinError').hidden=true;
  localStorage.setItem('togetherTimerParticipantName',name);
  el('participantName').value=name;
  joinedRoom=roomId;
  el('joinGate').hidden=true;
  el('timerContents').hidden=false;
  rememberCreated(roomId, state?.title || 'Shared countdown', state?.originalDuration || 0, 'joined');
  registerPresence();
  render();
});
el('controlsMode').addEventListener('change', async event => {
  if (!isHost() || !roomId) return;
  const id=roomId, mode=event.target.value;
  try { await database.ref('timers/'+id+'/controlsMode').set(mode); }
  catch(error) { feedback('Could not change permissions: '+error.message); el('controlsMode').value=state.controlsMode||'everyone'; }
});

const SAVED_KEY = 'togetherTimerCreatedRoomsV1';
function savedTimers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && validId(item.id)).slice(0, 30) : [];
  } catch (_) { return []; }
}
function storeTimers(items) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(items.slice(0, 30))); }
  catch (error) { console.warn('Could not save timer list', error); }
  renderSavedTimers();
  renderDashboard();
  setControls();
}
function rememberCreated(id, title, duration, kind = 'created') {
  const list = savedTimers().filter(item => item.id !== id);
  list.unshift({id, title: title || 'Untitled timer', duration, kind, createdAt: Date.now()});
  storeTimers(list);
}
function openSavedTimer(id) {
  if (!validId(id) || !database) return;
  try {
    history.replaceState({}, '', location.pathname + '?room=' + id);
    localStorage.setItem('togetherTimerRoom', id);
  } catch (error) { console.warn(error); }
  join(id);
  window.scrollTo({top:0, behavior:'smooth'});
}
function renderSavedTimers() {
  const list = savedTimers(), panel = el('savedTimersPanel'), holder = el('savedTimersList');
  panel.hidden = list.length === 0;
  el('savedCount').textContent = String(list.length);
  holder.replaceChildren();
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'saved-timer';
    const info = document.createElement('div');
    info.className = 'saved-timer-info';
    const title = document.createElement('strong');
    title.textContent = item.title || 'Untitled timer';
    const detail = document.createElement('small');
    detail.textContent = (item.kind === 'joined' ? 'Joined' : 'Created') + (item.id === roomId ? ' · Currently open' : '');
    info.append(title, detail);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'button secondary saved-open';
    open.textContent = item.id === roomId ? 'Viewing' : 'Open';
    open.disabled = item.id === roomId;
    open.addEventListener('click', () => openSavedTimer(item.id));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button secondary saved-edit';
    edit.textContent = 'Edit name';
    edit.setAttribute('aria-label', 'Edit name of ' + (item.title || 'Untitled timer'));
    edit.disabled = item.id === roomId && !!state?.ownerUid && !isHost();
    edit.addEventListener('click', () => {
      const editor = document.createElement('div');
      editor.className = 'saved-name-editor';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 60;
      input.value = item.title || '';
      input.setAttribute('aria-label', 'New timer name');
      const message = document.createElement('small');
      message.setAttribute('role', 'status');
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'button primary saved-open';
      save.textContent = 'Save';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button secondary saved-open';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', renderSavedTimers);
      save.addEventListener('click', async () => {
        const newTitle = input.value.trim();
        if (!newTitle) { message.textContent = 'Please enter a timer name.'; return; }
        if (!database) { message.textContent = 'Not connected. Try again.'; return; }
        save.disabled = true;
        try {
          // Update the shared title so every participant sees the change.
          await database.ref('timers/' + item.id + '/title').set(newTitle);
          const updated = savedTimers().map(t => t.id === item.id ? {...t, title:newTitle} : t);
          storeTimers(updated);
        } catch (error) {
          message.textContent = 'Could not rename timer: ' + error.message;
          save.disabled = false;
        }
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') save.click();
        if (event.key === 'Escape') renderSavedTimers();
      });
      editor.append(input, save, cancel, message);
      row.replaceChildren(editor);
      input.focus();
      input.select();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (item.title || 'Untitled timer') + ' from My timers');
    remove.addEventListener('click', () => {
      const removingOpenTimer = item.id === roomId;
      const remainingTimers = savedTimers().filter(t => t.id !== item.id);
      storeTimers(remainingTimers);
      if (removingOpenTimer || remainingTimers.length === 0) {
        showSetup();
        detach();
        try { localStorage.removeItem('togetherTimerRoom'); } catch (error) { console.warn(error); }
        try { history.replaceState({}, '', location.pathname); } catch (error) { console.warn(error); }
        feedback('');
        renderSavedTimers();
      }
    });
    row.append(info, open, edit, remove);
    holder.append(row);
  });
}

function showDashboard() {
  detach();
  el('timerPanel').hidden = true;
  el('setupPanel').hidden = true;
  el('dashboardPanel').hidden = false;
  el('savedTimersPanel').hidden = true;
  document.title = 'My timers — Together Timer';
  try { history.replaceState({}, '', location.pathname); localStorage.removeItem('togetherTimerRoom'); } catch (_) {}
  renderDashboard();
}
function renderDashboard() {
  const holder = el('dashboardList');
  holder.replaceChildren();
  const items = savedTimers();
  el('dashboardEmpty').hidden = items.length > 0;
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'dashboard-timer';
    const heading = document.createElement('strong');
    heading.textContent = item.title || 'Untitled timer';
    const meta = document.createElement('small');
    meta.textContent = item.kind === 'joined' ? 'Joined timer' : 'Created by you';
    const actions = document.createElement('div');
    actions.className = 'invite-actions';
    const open = document.createElement('button');
    open.className = 'button primary'; open.textContent = 'Open';
    open.addEventListener('click', () => openSavedTimer(item.id));
    const share = document.createElement('button');
    share.className = 'button secondary'; share.textContent = 'Share';
    share.addEventListener('click', async () => {
      const url = new URL(location.pathname, location.origin);
      url.searchParams.set('room', item.id);
      try {
        if (navigator.share) await navigator.share({title:item.title || 'Together Timer',text:'Join my shared countdown',url:url.href});
        else { await navigator.clipboard.writeText(url.href); feedback('Invitation link copied.'); }
      } catch (error) { if (error.name !== 'AbortError') feedback('Share this link: ' + url.href); }
    });
    actions.append(open, share);
    card.append(heading, meta, actions);
    holder.append(card);
  });
}
function showCreate() {
  detach();
  el('dashboardPanel').hidden = true;
  showSetup();
  el('savedTimersPanel').hidden = false;
  try { history.replaceState({}, '', location.pathname); localStorage.removeItem('togetherTimerRoom'); } catch (_) {}
}
el('dashboardCreateButton').addEventListener('click', showCreate);
el('inviteDashboardButton').addEventListener('click', showDashboard);
el('inviteCreateButton').addEventListener('click', showCreate);
el('declineInviteButton').addEventListener('click', () => {
  showDashboard();
  feedback('Invitation declined. You have not joined this timer.');
});
function setControls() {
  controls.forEach(id => el(id).disabled = !ready || busy || !mayControl() || joinedRoom !== roomId || state?.timerType === 'event');
  ['eventMinusDay','eventPlusDay','eventMinusHour','eventPlusHour'].forEach(id => el(id).disabled = !ready || busy || !mayControl() || joinedRoom !== roomId);
  el('shareButton').disabled = !ready || joinedRoom !== roomId;
  el('renameCurrentButton').disabled = !ready || !isHost();
  el('hostSettings').hidden = !ready || !isHost();
  el('guestPermissions').hidden = !ready || isHost();
  el('guestPermissions').textContent = state?.ownerUid ? (mayControl() ? 'The host allows everyone to control this timer.' : 'Only the host can control this timer.') : 'Older timer: shared controls are enabled.';
  if (state && isHost()) el('controlsMode').value = state.controlsMode || 'everyone';
  el('saveTimerButton').disabled = !ready;
  el('saveTimerButton').hidden = !ready || !roomId || savedTimers().some(item => item.id === roomId);
}
function render() {
  if (!state) return;
  const left = remaining(state), full = Math.max(1, state.originalDuration);
  el('countdown').textContent = state.timerType === 'event' ? fmtEvent(left) : fmt(left);
  el('countdown').classList.toggle('event-countdown', state.timerType === 'event');
  el('ringProgress').style.strokeDashoffset = String(circumference * (1 - Math.max(0, Math.min(1, left / full))));
  el('timerLabel').textContent = state.title || 'Shared countdown';
  const finished = left <= 0;
  el('timerStatus').textContent = finished ? (state.timerType === 'event' ? 'Event time has arrived!' : 'Time is up') : state.timerType === 'event' ? 'Counting down to your event · synchronised' : state.running ? 'Running · synchronised' : left === state.originalDuration ? 'Ready to start' : 'Paused · synchronised';
  el('timerControls').hidden = state.timerType === 'event';
  el('eventAdjustControls').hidden = state.timerType !== 'event';
  el('eventDetails').hidden = state.timerType !== 'event';
  if (state.timerType === 'event') el('eventDetails').textContent = 'Event: ' + new Date(state.endAt).toLocaleString(undefined, {dateStyle:'full', timeStyle:'short'});
  el('startPauseButton').textContent = finished ? 'Start again' : state.running ? 'Pause' : left === state.originalDuration ? 'Start' : 'Resume';
  document.title = state.running && !finished ? fmt(left) + ' — Together Timer' : 'Together Timer';
  if (finished && !wasFinished && ready && joinedRoom === roomId && state.running) {
    const alarmKey = roomId + ':' + state.endAt;
    if (lastAlarmKey !== alarmKey) {
      lastAlarmKey = alarmKey;
      const played = soundEnabled ? playFinishedChime() : false;
      if (soundEnabled && !played) el('soundFeedback').textContent = 'Sound was blocked by the browser. Interact with the page to enable audio.';
      if (soundEnabled && 'vibrate' in navigator) navigator.vibrate([200, 100, 200]);
    }
  }
  wasFinished = finished;
  setControls();
}
function showTimer() {
  el('setupPanel').hidden = true;
  el('dashboardPanel').hidden = true;
  el('savedTimersPanel').hidden = false;
  el('timerPanel').hidden = false;
  el('joinGate').hidden = joinedRoom === roomId;
  el('timerContents').hidden = joinedRoom !== roomId;
}
function showSetup() {
  el('timerPanel').hidden = true;
  el('dashboardPanel').hidden = true;
  el('savedTimersPanel').hidden = false;
  el('setupPanel').hidden = false;
  el('shareFeedback').hidden = true;
  document.title = 'Together Timer';
}
function detach() {
  if (roomRef && unsubscribe) { try { roomRef.off('value', unsubscribe); } catch (error) { console.warn('Listener cleanup failed', error); } unsubscribe = null; }
  leavePresence();
  joinedRoom = null;
  roomRef = null; roomId = null; state = null; ready = false;
  wasFinished = false;
  lastAlarmKey = null;
}
function join(id) {
  if (!validId(id)) { feedback('Invalid timer link.'); showSetup(); return; }
  detach();
  roomId = id;
  joinedRoom = pendingCreatorName ? id : null;
  if (pendingCreatorName) {
    el('participantName').value = pendingCreatorName;
    localStorage.setItem('togetherTimerParticipantName', pendingCreatorName);
    pendingCreatorName = null;
  }
  el('joinName').value = localStorage.getItem('togetherTimerParticipantName') || '';
  roomRef = database.ref('timers/' + id);
  showTimer();
  feedback('Connecting to shared timer…');
  setControls();
  renderSavedTimers();
  unsubscribe = roomRef.on('value', snapshot => {
    const data = snapshot.val();
    if (!data || typeof data.originalDuration !== 'number') {
      ready = false; state = null;
      feedback('This timer could not be found. Create a new one.');
      el('timerStatus').textContent = 'Timer unavailable';
      setControls();
      return;
    }
    state = data;
    el('inviteTitle').textContent = data.title || 'Shared countdown';
    ready = true;
    if (!presenceRoomRef) connectPresence(id);
    if (joinedRoom === id) registerPresence();
    feedback('');
    render();
  }, error => {
    ready = false;
    feedback('Cannot access this timer: ' + error.message + '. Check Firebase Authentication and database rules.');
    setControls();
  });
}
async function change(transform, allowEvent = false) {
  if (!roomRef || !ready || busy || !mayControl() || joinedRoom !== roomId || (state?.timerType === 'event' && !allowEvent)) return;
  busy = true; setControls();
  try {
    const result = await roomRef.transaction(current => {
      if (!current || typeof current.originalDuration !== 'number') return;
      if (current.ownerUid && current.ownerUid !== currentUid && current.controlsMode === 'host') return;
      const t = now(), left = current.running ? Math.max(0, current.endAt - t) : Math.max(0, current.remaining);
      const next = transform(current, left, t);
      if (!next) return;
      next.updatedAt = t;
      return next;
    }, undefined, false);
    if (!result.committed) feedback('Timer update was not applied. Try again.');
    else feedback('');
  } catch (error) {
    feedback('Could not update timer: ' + error.message);
  } finally { busy = false; setControls(); }
}
el('startPauseButton').addEventListener('click', () => change((s, left, t) => {
  if (s.running && left > 0) return {...s, running:false, remaining:left, endAt:0};
  const amount = left > 0 ? left : s.originalDuration;
  return {...s, running:true, remaining:amount, endAt:t + amount};
}));
el('restartButton').addEventListener('click', () => change((s, left, t) => ({
  ...s, remaining:s.originalDuration, endAt:s.running ? t + s.originalDuration : 0
})));
function adjust(delta) {
  change((s, left, t) => {
    const amount = Math.max(0, left + delta);
    return {...s, originalDuration:Math.max(1000, s.originalDuration + delta),
      remaining:amount, running:s.running && amount > 0,
      endAt:s.running && amount > 0 ? t + amount : 0};
  });
}
function adjustEvent(delta) {
  if (!roomRef || !ready || busy || !mayControl() || joinedRoom !== roomId || state?.timerType !== 'event') return;
  change((s, left, t) => {
    if (s.timerType !== 'event' || !s.running) return;
    const endAt = s.endAt + delta;
    const duration = endAt - t;
    if (duration < 1000 || duration > 31536000000) return;
    return {...s, endAt, remaining:duration, originalDuration:Math.max(duration, s.originalDuration + delta)};
  }, true);
}
el('eventMinusDay').addEventListener('click', () => adjustEvent(-86400000));
el('eventPlusDay').addEventListener('click', () => adjustEvent(86400000));
el('eventMinusHour').addEventListener('click', () => adjustEvent(-3600000));
el('eventPlusHour').addEventListener('click', () => adjustEvent(3600000));
el('minusButton').addEventListener('click', () => adjust(-60000));
el('plusButton').addEventListener('click', () => adjust(60000));
el('createButton').addEventListener('click', async () => {
  const eventMode = el('timerType').value === 'event';
  const seconds = ['hours','minutes','seconds'].map(id => Math.max(0, Number(el(id).value) || 0));
  const eventAt = eventMode ? new Date(el('eventDateTime').value).getTime() : 0;
  const duration = eventMode ? Math.floor(eventAt - now()) : Math.floor((seconds[0] * 3600 + seconds[1] * 60 + seconds[2]) * 1000);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 31536000000) {
    el('setupError').textContent = eventMode ? 'Choose a future event date and time within the next year.' : 'Enter a duration between one second and one year.';
    el('setupError').hidden = false; return;
  }
  const creatorName = el('creatorName').value.trim().slice(0,40);
  if (!creatorName) {
    el('setupError').textContent = 'Please enter your name.';
    el('setupError').hidden = false;
    el('creatorName').focus();
    return;
  }
  const requestedTitle = el('timerName').value.trim();
  if (!requestedTitle) {
    el('setupError').textContent = 'Please enter a name for your timer.';
    el('setupError').hidden = false;
    el('timerName').focus();
    return;
  }
  el('setupError').hidden = true;
  el('createButton').disabled = true;
  try {
    if (!database) throw Error('Firebase is not connected yet.');
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const title = requestedTitle.slice(0, 60);
    await database.ref('timers/' + id).set({
      title, originalDuration:duration, remaining:duration,
      running:eventMode, endAt:eventMode ? eventAt : 0, updatedAt:now(), ownerUid:currentUid, controlsMode:'everyone', ...(eventMode ? {timerType:'event'} : {})
    });
    history.replaceState({}, '', location.pathname + '?room=' + id);
    localStorage.setItem('togetherTimerRoom', id);
    rememberCreated(id, title, duration);
    pendingCreatorName = creatorName;
    join(id);
  } catch (error) {
    el('setupError').textContent = 'Could not create timer: ' + error.message;
    el('setupError').hidden = false;
  } finally { el('createButton').disabled = false; }
});
el('renameCurrentButton').addEventListener('click', () => {
  if (!roomId || !ready || !state || !isHost()) return;
  const id = roomId;
  const name = state.title || 'Untitled timer';
  const existing = savedTimers().find(item => item.id === id);
  if (existing) {
    const row = Array.from(el('savedTimersList').children).find(node => node.querySelector('[aria-label="Edit name of ' + name + '"]'));
    const button = row && row.querySelector('.saved-edit');
    if (button) {
      button.click();
      el('savedTimersPanel').scrollIntoView({behavior:'smooth',block:'center'});
      return;
    }
  }
  const next = window.prompt('Enter a new name for this timer:', name);
  if (next === null) return;
  const title = next.trim().slice(0, 60);
  if (!title) { feedback('Please enter a timer name.'); return; }
  database.ref('timers/' + id + '/title').set(title).then(() => {
    if (savedTimers().some(item => item.id === id)) {
      storeTimers(savedTimers().map(item => item.id === id ? {...item,title} : item));
    }
    feedback('Timer renamed for everyone sharing it.');
  }).catch(error => feedback('Could not rename timer: ' + error.message));
});
el('saveTimerButton').addEventListener('click', () => {
  if (!ready || !roomId || !state) return;
  rememberCreated(roomId, state.title || 'Untitled timer', state.originalDuration);
  feedback('Timer saved to My Timers on this device.');
});
el('shareButton').addEventListener('click', async () => {
  if (!roomId) return;
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', roomId);
  try {
    if (navigator.share) {
      await navigator.share({title:'Together Timer',text:'Join my live countdown',url:url.href});
      return;
    }
    await navigator.clipboard.writeText(url.href);
    el('shareFeedback').textContent = 'Live timer link copied.';
  } catch (error) {
    if (error.name === 'AbortError') return;
    el('shareFeedback').textContent = url.href;
  }
  el('shareFeedback').hidden = false;
});
el('resetButton').addEventListener('click', () => {
  // Show the form first so listener cleanup cannot prevent navigation.
  showSetup();
  try { localStorage.removeItem('togetherTimerRoom'); } catch (error) { console.warn(error); }
  try { history.replaceState({}, '', location.pathname); } catch (error) { console.warn(error); }
  detach();
  renderSavedTimers();
  feedback('');
});
setInterval(() => { if (ready && state) render(); }, 200);
async function init() {
  try {
    if (typeof firebase === 'undefined') throw Error('Firebase scripts did not load. Check your internet connection.');
    firebase.initializeApp(firebaseConfig);
    database = firebase.database();
    database.ref('.info/serverTimeOffset').on('value', snap => { serverOffset = Number(snap.val()) || 0; });
    const credential = await firebase.auth().signInAnonymously();
    currentUid = credential.user.uid;
    const params = new URLSearchParams(location.search);
    const id = params.get('room') || localStorage.getItem('togetherTimerRoom');
    if (id) join(id);
    else { showDashboard(); feedback(''); }
    renderSavedTimers();
  } catch (error) {
    feedback('Firebase connection failed: ' + error.message + '. Enable Anonymous sign-in in Firebase Authentication.');
  }
}
init();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
