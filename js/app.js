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
el('ringProgress').style.strokeDasharray = String(circumference);
const now = () => Date.now() + serverOffset;
const feedback = message => { el('connectionFeedback').textContent = message || ''; };
const fmt = ms => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const remaining = s => s ? (s.running ? Math.max(0, s.endAt - now()) : Math.max(0, s.remaining)) : 0;
const validId = id => /^[a-f0-9]{32}$/.test(id || '');

const SAVED_KEY = 'togetherTimerCreatedRoomsV1';
function savedTimers() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && validId(item.id)).slice(0, 4) : [];
  } catch (_) { return []; }
}
function storeTimers(items) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(items.slice(0, 4))); }
  catch (error) { console.warn('Could not save timer list', error); }
  if (typeof setControls === 'function') setControls();
}
function rememberCreated(id, title, duration) {
  const list = savedTimers().filter(item => item.id !== id);
  list.unshift({id, title: title || 'Untitled timer', duration, createdAt: Date.now()});
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
  el('savedCount').textContent = list.length + '/4';
  holder.replaceChildren();
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'saved-timer';
    const info = document.createElement('div');
    info.className = 'saved-timer-info';
    const title = document.createElement('strong');
    title.textContent = item.title || 'Untitled timer';
    const detail = document.createElement('small');
    detail.textContent = fmt(item.duration || 0) + (item.id === roomId ? ' · Currently open' : '');
    info.append(title, detail);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'button secondary saved-open';
    open.textContent = item.id === roomId ? 'Viewing' : 'Open';
    open.disabled = item.id === roomId;
    open.addEventListener('click', () => openSavedTimer(item.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'saved-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (item.title || 'Untitled timer') + ' from My timers');
    remove.addEventListener('click', () => {
      const removingOpenTimer = item.id === roomId;
      storeTimers(savedTimers().filter(t => t.id !== item.id));
      if (removingOpenTimer || savedTimers().length === 0) {
        showSetup();
        detach();
        try { localStorage.removeItem('togetherTimerRoom'); } catch (error) { console.warn(error); }
        try { history.replaceState({}, '', location.pathname); } catch (error) { console.warn(error); }
        feedback('');
        renderSavedTimers();
      }
    });
    row.append(info, open, remove);
    holder.append(row);
  });
}

function setControls() {
  controls.forEach(id => el(id).disabled = !ready || busy);
  el('shareButton').disabled = !ready;
  el('saveTimerButton').disabled = !ready;
  el('saveTimerButton').hidden = !ready || !roomId || savedTimers().some(item => item.id === roomId);
}
function render() {
  if (!state) return;
  const left = remaining(state), full = Math.max(1, state.originalDuration);
  el('countdown').textContent = fmt(left);
  el('ringProgress').style.strokeDashoffset = String(circumference * (1 - Math.max(0, Math.min(1, left / full))));
  el('timerLabel').textContent = state.title || 'Shared countdown';
  const finished = left <= 0;
  el('timerStatus').textContent = finished ? 'Time is up' : state.running ? 'Running · synchronised' : left === state.originalDuration ? 'Ready to start' : 'Paused · synchronised';
  el('startPauseButton').textContent = finished ? 'Start again' : state.running ? 'Pause' : left === state.originalDuration ? 'Start' : 'Resume';
  document.title = state.running && !finished ? fmt(left) + ' — Together Timer' : 'Together Timer';
  if (finished && !wasFinished && ready && 'vibrate' in navigator) navigator.vibrate([200, 100, 200]);
  wasFinished = finished;
  setControls();
}
function showTimer() {
  el('setupPanel').hidden = true;
  el('timerPanel').hidden = false;
}
function showSetup() {
  el('timerPanel').hidden = true;
  el('setupPanel').hidden = false;
  el('shareFeedback').hidden = true;
  document.title = 'Together Timer';
}
function detach() {
  if (roomRef && unsubscribe) { try { roomRef.off('value', unsubscribe); } catch (error) { console.warn('Listener cleanup failed', error); } unsubscribe = null; }
  roomRef = null; roomId = null; state = null; ready = false;
  wasFinished = false;
}
function join(id) {
  if (!validId(id)) { feedback('Invalid timer link.'); showSetup(); return; }
  detach();
  roomId = id;
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
    ready = true;
    feedback('');
    render();
  }, error => {
    ready = false;
    feedback('Cannot access this timer: ' + error.message + '. Check Firebase Authentication and database rules.');
    setControls();
  });
}
async function change(transform) {
  if (!roomRef || !ready || busy) return;
  busy = true; setControls();
  try {
    const result = await roomRef.transaction(current => {
      if (!current || typeof current.originalDuration !== 'number') return;
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
el('minusButton').addEventListener('click', () => adjust(-60000));
el('plusButton').addEventListener('click', () => adjust(60000));
el('createButton').addEventListener('click', async () => {
  const seconds = ['hours','minutes','seconds'].map(id => Math.max(0, Number(el(id).value) || 0));
  const duration = Math.floor((seconds[0] * 3600 + seconds[1] * 60 + seconds[2]) * 1000);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 31536000000) {
    el('setupError').textContent = 'Enter a duration between one second and one year.';
    el('setupError').hidden = false; return;
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
      running:false, endAt:0, updatedAt:now()
    });
    history.replaceState({}, '', location.pathname + '?room=' + id);
    localStorage.setItem('togetherTimerRoom', id);
    rememberCreated(id, title, duration);
    join(id);
  } catch (error) {
    el('setupError').textContent = 'Could not create timer: ' + error.message;
    el('setupError').hidden = false;
  } finally { el('createButton').disabled = false; }
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
    await firebase.auth().signInAnonymously();
    const params = new URLSearchParams(location.search);
    const id = params.get('room') || localStorage.getItem('togetherTimerRoom');
    if (id) join(id);
    else feedback('');
    renderSavedTimers();
  } catch (error) {
    feedback('Firebase connection failed: ' + error.message + '. Enable Anonymous sign-in in Firebase Authentication.');
  }
}
init();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
