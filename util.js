// Small helpers shared by every script: DOM, storage, shuffling, sharing.
const $ = (s) => document.querySelector(s);

const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) n.append(c);
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One way to share in every game: the phone's share sheet on a touch screen, the clipboard elsewhere or
// when the sheet fails. Resolves to 'shared', 'cancelled', 'copied' or 'failed'.
async function shareOrCopy(data, copy) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share(data); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  try { await navigator.clipboard.writeText(copy); return 'copied'; } catch { return 'failed'; }
}

// The end of a challenge, the same in every game. Non-breaking spaces: a score never wraps onto a line alone.
function verdictText(mine, theirs, name) {
  const nb = (s) => s.replace(/ /g, '\u00a0');
  return mine > theirs ? `Tu bats ${name}${nb(` : ${mine} contre ${theirs}.`)}`
    : mine < theirs ? `${name} gagne${nb(` : ${theirs} contre ${mine}.`)}`
    : `Égalité avec ${name}${nb(` : ${mine} partout.`)}`;
}

// The name a shared result or a challenge is signed with.
const playerName = () => store.get('deezerUser')?.name || store.get('pseudo') || store.get('myName') || 'Un pote';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadScript(src) {
  return new Promise((ok, fail) => document.head.append(el('script', { src, onload: ok, onerror: () => fail(new Error('chargement impossible')) })));
}
