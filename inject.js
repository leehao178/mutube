// Add TizenTube script to the page. Don't inject more than once.
//
// Restore 4k support by hooking window.MediaSource.isTypeSupported to remove the height/width parameters.
// I am not actually sure why this works since isTypeSupported still returns false for VP09 codecs.
// YouTube does detect spoofing by checking nonsensical values for height/width so maybe that affects something?
// HDR still does not work, but at least 4k works now.
//
(function () {
if (document.mutube) return;
document.mutube = true;

// Cobalt goes straight from readyState "loading" to "complete" without ever firing
// DOMContentLoaded. TizenTube is injected while still "loading", so its modules that
// wait for that event (player buttons incl. Speed Controls, extra subtitles) never
// start. Fire it ourselves at load if Cobalt didn't. Dispatched on document and
// window separately (non-bubbling) so listeners on either get it exactly once.
var dclFired = false;
document.addEventListener('DOMContentLoaded', function () { dclFired = true; });
window.addEventListener('load', function () {
  if (dclFired) return;
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window.dispatchEvent(new Event('DOMContentLoaded'));
});

var script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=" + Date.now();
script.async = true;
document.head.appendChild(script);

const originalIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);

window.MediaSource.isTypeSupported = function(mimeType) {
  const parts = mimeType
    .split(';')
    .map(part => part.trim())
    .filter(part => part);

  const filtered = parts.filter(part => {
    return !(part.startsWith('width=') || part.startsWith('height='));
  });

  const cleaned = filtered.join('; ');
  return originalIsTypeSupported(cleaned);
};

// Clean playback controls: while a video plays full screen with no UI
// showing, the remote acts directly on the video instead of opening YouTube's
// player controls, and any overlay YouTube shows meanwhile is made invisible:
//   OK (center)  pause / resume
//   Left/Right   seek -/+ CP_SEEK_SECONDS (holding repeats the seek)
//   Up/Down x2   double-tap: playback speed -/+ CP_RATE_STEP (this video only)
// A single Up/Down there is held for CP_DOUBLE_TAP_MS, then replayed to
// YouTube (opening the controls as usual).
// Once the controls are open (e.g. via Up/Down), keys work as usual. Any other
// key reveals the UI again and is handled normally. Set CLEAN_PAUSE = false
// for the stock behaviour.
//
// "No UI showing" uses the same signal as TizenTube's clock: the watch page
// element is focusable only while the video plays without controls.
// The overlay is hidden without relying on YouTube's element names: every
// element that is not the <video> or one of its ancestors gets opacity 0.
var CLEAN_PAUSE = true;
// Shows an on-screen log of key events and decisions (top-left).
var CP_DEBUG = false;
var CP_SEEK_SECONDS = 10;
var KEY_OK = 13, KEY_LEFT = 37, KEY_UP = 38, KEY_RIGHT = 39, KEY_DOWN = 40;
var CP_ATTR = 'data-mutube-cp';
var CP_REPEAT_MS = 600;
var CP_SEEK_REPEAT_MS = 250;
// Seeks within this window build on the previous target, since the player's
// current time lags behind while it is still seeking.
var CP_SEEK_CHAIN_MS = 2000;
var CP_REVEAL_MIN_MS = 1000;
var CP_REVEAL_MAX_MS = 8000;
var CP_DOUBLE_TAP_MS = 300;
var CP_RATE_STEP = 0.25, CP_RATE_MIN = 0.25, CP_RATE_MAX = 2;
var CP_RATE_SHOW_MS = 1000;

var cp = { active: false, swallow: 0, tap: null, replaying: false, rate: 0, rateVid: '', rateTimer: null, lastDown: 0, seekAt: 0, seekTarget: 0, hidden: [], observers: [], timer: null };

var cpStyle = document.createElement('style');
cpStyle.textContent = '[' + CP_ATTR + '] { opacity: 0 !important; }';
document.head.appendChild(cpStyle);

function cpUiHidden() {
  var w = document.querySelector('ytlr-watch-default');
  return !!w && w.getAttribute('hybridnavfocusable') === 'true';
}

// Buffering (e.g. right after a seek) counts as playing.
function cpIsPlaying(p, v) {
  try { if (p.getPlayerStateObject().isPlaying) return true; } catch (e) {}
  return !!v && !v.paused && !v.ended;
}

function cpSetPlaying(p, v, play) {
  try {
    if (play) p.playVideo(); else p.pauseVideo();
    return;
  } catch (e) {}
  if (v) { if (play) v.play(); else v.pause(); }
}

var cpLines = [];
function cpLog(msg) {
  if (!CP_DEBUG || !document.body) return;
  var box = document.getElementById('mutube-cp-debug');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mutube-cp-debug';
    box.style.cssText = 'position:fixed;left:24px;top:24px;z-index:2147483647;' +
      'background-color:rgba(0,0,0,0.8);color:#7fff7f;font-size:20px;line-height:26px;padding:8px 12px;';
    document.body.appendChild(box);
  }
  cpLines.push(msg);
  if (cpLines.length > 10) cpLines.shift();
  while (box.firstChild) box.removeChild(box.firstChild);
  cpLines.forEach(function (l) {
    var row = document.createElement('div');
    row.textContent = l;
    box.appendChild(row);
  });
}

function cpMark(el) {
  if (el.nodeType !== 1 || (el.id || '').indexOf('mutube-') === 0 || el.hasAttribute(CP_ATTR)) return;
  // Inline !important (as TizenTube uses on Cobalt) plus the stylesheet rule;
  // the attribute remembers the element's previous inline opacity.
  el.setAttribute(CP_ATTR, el.style.opacity || '');
  el.style.setProperty('opacity', '0', 'important');
  cp.hidden.push(el);
}

function cpUnmark(el) {
  var prev = el.getAttribute(CP_ATTR);
  el.removeAttribute(CP_ATTR);
  if (prev) el.style.setProperty('opacity', prev);
  else el.style.removeProperty('opacity');
}

function cpHideUi(v) {
  if (cp.hidden.length || !v) return;
  var keep = v;
  for (var parent = v.parentNode; parent && parent !== document.documentElement; parent = parent.parentNode) {
    var kids = parent.childNodes;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== keep) cpMark(kids[i]);
    }
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        for (var j = 0; j < m.addedNodes.length; j++) cpMark(m.addedNodes[j]);
      });
    });
    obs.observe(parent, { childList: true });
    cp.observers.push(obs);
    keep = parent;
  }
}

function cpReveal() {
  clearInterval(cp.timer);
  cp.timer = null;
  cp.observers.forEach(function (o) { o.disconnect(); });
  cp.observers = [];
  cp.hidden.forEach(cpUnmark);
  cp.hidden = [];
}

// While playing, keep the overlay invisible until YouTube has auto-hidden
// whatever it showed (controls, seek bar), so nothing flashes up.
function cpScheduleReveal() {
  var start = Date.now();
  clearInterval(cp.timer);
  cp.timer = setInterval(function () {
    var dt = Date.now() - start;
    if ((dt >= CP_REVEAL_MIN_MS && cpUiHidden()) || dt > CP_REVEAL_MAX_MS) cpReveal();
  }, 200);
}

function cpPause(p, v) {
  cp.active = true;
  clearInterval(cp.timer);
  cpHideUi(v);
  cpSetPlaying(p, v, false);
}

function cpResume(p, v) {
  cp.active = false;
  cpSetPlaying(p, v, true);
  cpScheduleReveal();
}

function cpSeek(p, v, delta) {
  var now = Date.now(), t, d;
  if (now - cp.seekAt < CP_SEEK_CHAIN_MS) t = cp.seekTarget;
  else try { t = p.getCurrentTime(); } catch (e) { t = v ? v.currentTime : 0; }
  try { d = p.getDuration(); } catch (e) { d = v ? v.duration : 0; }
  t = Math.max(0, t + delta);
  if (d > 1) t = Math.min(t, d - 1);
  cp.seekTarget = t;
  cp.seekAt = now;
  cpHideUi(v);
  try { p.seekTo(t, true); } catch (e) { if (v) v.currentTime = t; }
  if (!cp.active) cpScheduleReveal();
  return 'SEEK ' + Math.round(t);
}

function cpVid() {
  try { return document.querySelector('.html5-video-player').getVideoData().video_id || ''; } catch (e) { return ''; }
}

function cpShowRate(r) {
  if (!document.body) return;
  var el = document.getElementById('mutube-rate');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mutube-rate';
    el.style.cssText = 'position:fixed;right:48px;top:36px;z-index:2147483647;' +
      'background-color:rgba(0,0,0,0.6);color:#fff;font-size:28px;line-height:36px;padding:6px 16px;border-radius:8px;';
    document.body.appendChild(el);
  }
  el.textContent = r + 'x';
  el.style.display = 'block';
  clearTimeout(cp.rateTimer);
  cp.rateTimer = setTimeout(function () { el.style.display = 'none'; }, CP_RATE_SHOW_MS);
}

// TizenTube resets playbackRate to its own setting on every 'canplay' (e.g.
// after each seek); re-apply ours afterwards, but only for the same video.
// 'emptied' fires when a new video is loaded into the element.
function cpWatchRate(v) {
  if (v.mutubeRate) return;
  v.mutubeRate = true;
  v.addEventListener('emptied', function () { cp.rate = 0; });
  v.addEventListener('canplay', function () {
    setTimeout(function () {
      if (!cp.rate) return;
      if (cpVid() !== cp.rateVid) { cp.rate = 0; return; }
      if (v.playbackRate !== cp.rate) v.playbackRate = cp.rate;
    }, 0);
  });
}

function cpChangeRate(v, delta) {
  if (!v) return 'no video';
  var r = Math.round((v.playbackRate + delta) / CP_RATE_STEP) * CP_RATE_STEP;
  r = Math.min(CP_RATE_MAX, Math.max(CP_RATE_MIN, r));
  cpWatchRate(v);
  cp.rate = r;
  cp.rateVid = cpVid();
  v.playbackRate = r;
  cpShowRate(r);
  return 'RATE ' + r;
}

// A single Up/Down: give it back to YouTube the way TizenTube injects keys.
function cpFlushTap() {
  var code = cp.tap.code;
  clearTimeout(cp.tap.timer);
  cp.tap = null;
  cpExit();
  cp.replaying = true;
  try {
    ['keydown', 'keyup'].forEach(function (type) {
      var ev = document.createEvent('Event');
      ev.initEvent(type, true, true);
      ev.keyCode = code;
      ev.which = code;
      document.dispatchEvent(ev);
    });
  } finally {
    cp.replaying = false;
  }
}

function cpExit() {
  if (cp.tap) { clearTimeout(cp.tap.timer); cp.tap = null; }
  cp.active = false;
  cpReveal();
}

function cpBlock(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function cpOnKey(e) {
  if (!CLEAN_PAUSE) return;
  var result = cpHandleKey(e);
  if (CP_DEBUG && e.type === 'keydown') {
    var w = document.querySelector('ytlr-watch-default');
    cpLog('code=' + e.keyCode + ' wd=' + (w ? w.getAttribute('hybridnavfocusable') : 'none') +
      ' active=' + cp.active + ' hidden=' + cp.hidden.length + ' -> ' + result);
  }
}

function cpHandleKey(e) {
  if (cp.replaying) return 'replay';
  var code = e.key === 'Enter' ? KEY_OK : e.keyCode;
  if (e.type === 'keydown' && cp.tap && cp.tap.code !== code) cpFlushTap();
  var isSeek = code === KEY_LEFT || code === KEY_RIGHT;
  var isRate = code === KEY_UP || code === KEY_DOWN;
  if (code !== KEY_OK && !isSeek && !isRate) {
    if (e.type === 'keydown' && (cp.active || cp.hidden.length)) { cpExit(); return 'other key, reveal'; }
    return 'other key';
  }

  // keypress/keyup belong to the press whose keydown we handled.
  if (e.type !== 'keydown') {
    if (cp.swallow === code) {
      cpBlock(e);
      if (e.type === 'keyup') cp.swallow = 0;
    }
    return e.type;
  }

  var p = document.querySelector('.html5-video-player');
  var v = document.querySelector('video');
  var delta = code === KEY_LEFT ? -CP_SEEK_SECONDS : CP_SEEK_SECONDS;
  var now = Date.now();
  var isRepeat = cp.swallow === code && now - cp.lastDown < CP_REPEAT_MS;
  cp.lastDown = now;
  if (isRepeat) {
    cpBlock(e);
    if (isSeek && p && now - cp.seekAt >= CP_SEEK_REPEAT_MS) return cpSeek(p, v, delta);
    return 'repeat';
  }
  cp.swallow = 0;

  if (!p) return 'pass: no player';
  if (window.isPipPlaying) return 'pass: pip';
  if (!cp.active && !cp.hidden.length) {
    if (!cpUiHidden()) return 'pass: ui showing';
    if (!cpIsPlaying(p, v)) return 'pass: not playing';
  }

  var action;
  if (isRate) {
    if (cp.tap) {
      clearTimeout(cp.tap.timer);
      cp.tap = null;
      action = cpChangeRate(v, code === KEY_UP ? -CP_RATE_STEP : CP_RATE_STEP);
    } else {
      cp.tap = { code: code, timer: setTimeout(cpFlushTap, CP_DOUBLE_TAP_MS) };
      action = 'wait 2nd tap';
    }
  } else if (isSeek) {
    action = cpSeek(p, v, delta);
  } else if (cp.active) {
    cpResume(p, v);
    action = 'RESUME';
  } else {
    cpPause(p, v);
    action = 'PAUSE';
  }
  cp.swallow = code;
  cpBlock(e);
  return action;
}

// Capture on window runs before YouTube's and TizenTube's document listeners.
window.addEventListener('keydown', cpOnKey, true);
window.addEventListener('keypress', cpOnKey, true);
window.addEventListener('keyup', cpOnKey, true);
window.addEventListener('hashchange', cpExit);
})();
