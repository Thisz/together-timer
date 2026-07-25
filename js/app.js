const setupPanel = document.getElementById('setupPanel');
const timerPanel = document.getElementById('timerPanel');
const countdown = document.getElementById('countdown');
const timerStatus = document.getElementById('timerStatus');
const timerLabel = document.getElementById('timerLabel');
const ringProgress = document.getElementById('ringProgress');
const startPauseButton = document.getElementById('startPauseButton');
const shareFeedback = document.getElementById('shareFeedback');
const setupError = document.getElementById('setupError');

const CIRCUMFERENCE = 2 * Math.PI * 96;
let currentTitle = '';

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

function render(snapshot) {
  countdown.textContent = formatTime(snapshot.remaining);
  const denominator = snapshot.originalDuration || 1;
  const progress = Math.min(1, Math.max(0, snapshot.remaining / denominator));
  ringProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));

  if (snapshot.remaining <= 0) {
    timerStatus.textContent = 'Time is up';
    startPauseButton.textContent = 'Start';
    document.title = 'Time is up — Together Timer';
    if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
  } else if (snapshot.running) {
    timerStatus.textContent = 'Running';
    startPauseButton.textContent = 'Pause';
    document.title = `${formatTime(snapshot.remaining)} — Together Timer`;
  } else {
    timerStatus.textContent = snapshot.remaining === snapshot.originalDuration ? 'Ready to start' : 'Paused';
    startPauseButton.textContent = snapshot.remaining === snapshot.originalDuration ? 'Start' : 'Resume';
    document.title = 'Together Timer';
  }

  saveState(snapshot);
  updateUrl(snapshot);
}

function saveState(snapshot) {
  localStorage.setItem('togetherTimerState', JSON.stringify({ ...snapshot, title: currentTitle }));
}

function updateUrl(snapshot) {
  if (timerPanel.hidden) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('duration', String(snapshot.originalDuration));
  url.searchParams.set('remaining', String(snapshot.remaining));
  url.searchParams.set('running', snapshot.running ? '1' : '0');
  if (snapshot.running && snapshot.endAt) url.searchParams.set('end', String(snapshot.endAt));
  if (currentTitle) url.searchParams.set('title', currentTitle);
  history.replaceState({}, '', url);
}

function showTimer(title) {
  currentTitle = title || '';
  timerLabel.textContent = currentTitle || 'Shared countdown';
  setupPanel.hidden = true;
  timerPanel.hidden = false;
}

function getInputSeconds() {
  const hours = Math.max(0, Number(document.getElementById('hours').value) || 0);
  const minutes = Math.max(0, Number(document.getElementById('minutes').value) || 0);
  const seconds = Math.max(0, Number(document.getElementById('seconds').value) || 0);
  return Math.floor(hours * 3600 + minutes * 60 + seconds);
}

const timer = new TogetherTimer(render, render);
ringProgress.style.strokeDasharray = String(CIRCUMFERENCE);
ringProgress.style.strokeDashoffset = '0';

document.getElementById('createButton').addEventListener('click', () => {
  const totalSeconds = getInputSeconds();
  if (totalSeconds <= 0) {
    setupError.textContent = 'Enter a timer length greater than zero.';
    setupError.hidden = false;
    return;
  }
  setupError.hidden = true;
  showTimer(document.getElementById('timerName').value.trim());
  timer.setDuration(totalSeconds * 1000);
});

startPauseButton.addEventListener('click', () => {
  if (timer.running) timer.pause();
  else if (timer.remaining <= 0) {
    timer.restart();
    timer.start();
  } else timer.start();
});

document.getElementById('restartButton').addEventListener('click', () => timer.restart());
document.getElementById('minusButton').addEventListener('click', () => timer.adjust(-60000));
document.getElementById('plusButton').addEventListener('click', () => timer.adjust(60000));

document.getElementById('resetButton').addEventListener('click', () => {
  timer.stopInterval();
  localStorage.removeItem('togetherTimerState');
  history.replaceState({}, '', window.location.pathname);
  timerPanel.hidden = true;
  setupPanel.hidden = false;
  shareFeedback.hidden = true;
  document.title = 'Together Timer';
});

document.getElementById('shareButton').addEventListener('click', async () => {
  const snapshot = timer.snapshot();
  updateUrl(snapshot);
  const url = window.location.href;
  const text = currentTitle ? `${currentTitle}: join my countdown.` : 'Join my countdown.';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Together Timer', text, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    shareFeedback.textContent = 'Timer link copied.';
  } catch {
    shareFeedback.textContent = url;
  }
  shareFeedback.hidden = false;
});

function restoreFromUrlOrStorage() {
  const params = new URLSearchParams(window.location.search);
  const hasUrlTimer = params.has('duration') || params.has('end');
  let state = null;
  let title = '';

  if (hasUrlTimer) {
    const duration = Number(params.get('duration')) || 0;
    const end = Number(params.get('end')) || null;
    const running = params.get('running') === '1' && Boolean(end);
    const remaining = running ? Math.max(0, end - Date.now()) : Number(params.get('remaining')) || duration;
    state = { originalDuration: duration || remaining, remaining, running, endAt: end };
    title = params.get('title') || '';
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem('togetherTimerState') || 'null');
      if (saved && Number(saved.originalDuration) > 0) {
        state = saved;
        title = saved.title || '';
      }
    } catch {}
  }

  if (state) {
    showTimer(title);
    timer.load(state);
  }
}

restoreFromUrlOrStorage();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
