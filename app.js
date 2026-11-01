/* Lexicon: SAT vocabulary with a diagnostic sweep and spaced repetition.
   All progress lives on the device (localStorage). No accounts, no server. */
"use strict";

const KEY = "lexicon.v1";
const MASTERED_IVL = 21; // days between reviews before a word counts as mastered
const $view = document.getElementById("view");
let WORDS = [], BYID = new Map(), BYPOS = {};
let S; // persistent state
let cleanupKeys = null;

/* ---------- utilities ---------- */
const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtIvl = (d) => d < 1 ? "<1d" : d < 14 ? `${Math.round(d)}d` : d < 60 ? `${Math.round(d / 7)}w` : d < 365 ? `${Math.round(d / 30)}mo` : `${(d / 365).toFixed(1)}y`;
const def = (w) => w.s[0];

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/* ---------- state ---------- */
function freshState() {
  return { v: 1, order: shuffle(WORDS.map((w) => w.id)), checked: 0, p: {}, pile: [],
           settings: { newPerDay: 15, batch: 25 }, log: {}, days: [] };
}
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* storage unavailable */ }
  return null;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Couldn't save progress on this device"); }
}
function touchDay(kind) {
  const d = today();
  S.log[d] = S.log[d] || { new: 0, rev: 0, chk: 0 };
  S.log[d][kind]++;
  if (!S.days.includes(d)) S.days.push(d);
}
function streak() {
  const set = new Set(S.days); let d = today(), n = 0;
  if (!set.has(d)) d--; // today not done yet still keeps yesterday's streak
  while (set.has(d)) { n++; d--; }
  return n;
}

/* ---------- word status ---------- */
// u = unchecked, k = known (passed check), s = study pile (not yet introduced), c = active flashcard
const status = (id) => {
  const p = S.p[id];
  if (!p) return "unchecked";
  if (p.st === "k") return "known";
  if (p.st === "s") return "queued";
  return p.ivl >= MASTERED_IVL ? "mastered" : "learning";
};
const COLORS = { mastered: "var(--good)", known: "var(--accent)", learning: "var(--warn)", queued: "var(--bad)", unchecked: "var(--line)" };
const LABELS = { mastered: "Mastered", known: "Already knew", learning: "Learning", queued: "To study", unchecked: "Not checked" };

function counts() {
  const c = { mastered: 0, known: 0, learning: 0, queued: 0, unchecked: 0, due: 0 };
  const t = today();
  for (const w of WORDS) {
    const s = status(w.id); c[s]++;
    const p = S.p[w.id];
    if (p && p.st === "c" && p.due <= t) c.due++;
  }
  const newLeft = Math.max(0, S.settings.newPerDay - ((S.log[t] && S.log[t].new) || 0));
  c.newToday = Math.min(newLeft, c.queued);
  return c;
}

/* ---------- SM-2 scheduling ---------- */
function preview(p, g) { return schedule({ ...p }, g).ivl; }
function schedule(p, g) { // g: 0 again, 1 hard, 2 good, 3 easy
  p.ef = p.ef || 2.5; p.reps = p.reps || 0; p.ivl = p.ivl || 0;
  if (g === 0) {
    if (p.reps > 0) p.lapses = (p.lapses || 0) + 1;
    p.reps = 0; p.ivl = 0; p.ef = Math.max(1.3, p.ef - 0.2);
  } else {
    if (g === 1) { p.ivl = p.reps === 0 ? 1 : Math.max(p.ivl + 1, p.ivl * 1.2); p.ef = Math.max(1.3, p.ef - 0.15); }
    if (g === 2) { p.ivl = p.reps === 0 ? 1 : p.reps === 1 ? 3 : p.ivl * p.ef; }
    if (g === 3) { p.ivl = p.reps === 0 ? 4 : Math.max(p.ivl + 1, p.ivl * p.ef * 1.3); p.ef += 0.15; }
    p.reps++;
  }
  p.ivl = Math.round(p.ivl * 10) / 10;
  p.due = today() + Math.max(0, Math.round(p.ivl));
  return p;
}

/* ---------- multiple choice ---------- */
function choicesFor(w) {
  const pos = def(w).p, target = def(w).d;
  const avoid = new Set([w.w, ...w.syn.map((x) => x.toLowerCase())]);
  const pool = BYPOS[pos] || WORDS;
  const picks = [], used = new Set([target]);
  let guard = 0;
  while (picks.length < 3 && guard++ < 200) {
    const o = pool[Math.floor(Math.random() * pool.length)];
    const d = def(o).d;
    if (o.id === w.id || used.has(d) || avoid.has(o.w) || o.syn.map((x) => x.toLowerCase()).includes(w.w)) continue;
    used.add(d); picks.push(d);
  }
  return shuffle([{ d: target, ok: true }, ...picks.map((d) => ({ d, ok: false }))]);
}

function renderMC(w, onAnswer, opts = {}) {
  const ch = choicesFor(w);
  return {
    html: `
      <div class="prompt"><div class="word">${esc(w.w)}</div><div class="pos">${esc(def(w).p)}</div>
        ${opts.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ""}</div>
      <div class="opts">
        ${ch.map((c, i) => `<button class="opt" data-i="${i}">${esc(c.d)}</button>`).join("")}
        ${opts.idk ? `<button class="opt idk" data-i="idk">I don't know this one</button>` : ""}
      </div>
      <div id="fb"></div>`,
    bind() {
      const buttons = [...$view.querySelectorAll(".opt")];
      const pick = (btn) => {
        if (!btn || btn.disabled) return;
        buttons.forEach((b) => (b.disabled = true));
        const i = btn.dataset.i;
        const ok = i !== "idk" && ch[+i].ok;
        buttons.forEach((b) => { if (b.dataset.i !== "idk" && ch[+b.dataset.i].ok) b.classList.add("right"); });
        if (!ok && i !== "idk") btn.classList.add("wrong");
        onAnswer(ok);
      };
      buttons.forEach((b) => b.addEventListener("click", () => pick(b)));
      keys((k) => { if (k >= "1" && k <= "4") pick(buttons[+k - 1]); if (k === "0" || k === "?") pick(buttons.find((b) => b.dataset.i === "idk")); });
    },
  };
}

function wordDetail(w) {
  return `${w.s.map((s) => `<div class="sense"><span class="p">${esc(s.p)}</span>${esc(s.d)}${s.e ? `<span class="ex">“${esc(s.e)}”</span>` : ""}</div>`).join("")}
    ${w.syn.length ? `<div class="syn"><b>Similar:</b> ${esc(w.syn.join(", "))}</div>` : ""}
    ${w.ant.length ? `<div class="syn"><b>Opposite:</b> ${esc(w.ant.join(", "))}</div>` : ""}`;
}

function keys(fn) {
  if (cleanupKeys) cleanupKeys();
  const h = (e) => { if (e.target.tagName === "INPUT") return; fn(e.key, e); };
  document.addEventListener("keydown", h);
  cleanupKeys = () => document.removeEventListener("keydown", h);
}

function qhead(done, total, back = "#home") {
  return `<div class="qhead"><a class="x" href="${back}" aria-label="Exit">×</a>
    <div class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
    <span class="n">${done} / ${total}</span></div>`;
}

/* ---------- views ---------- */
function viewHome() {
  const c = counts(), total = WORDS.length, knowNow = c.mastered + c.known;
  const pct = (n) => (n / total) * 100;
  const studyN = c.due + c.newToday;
  const checkLeft = total - S.checked;
  $view.innerHTML = `
    <h1>${knowNow === total ? "Every word, mastered." : "Know every SAT word."}</h1>
    <p class="lede">${S.checked === 0 ? "Start by checking which words you already know. Every miss becomes a flashcard." : "Check the rest of the list, and study what's due each day."}</p>
    <div class="card hero">
      <div class="big">${knowNow.toLocaleString()} <small>of ${total.toLocaleString()} words known</small></div>
      <div class="bar">
        <i style="width:${pct(c.mastered)}%;background:var(--good)"></i>
        <i style="width:${pct(c.known)}%;background:var(--accent)"></i>
        <i style="width:${pct(c.learning)}%;background:var(--warn)"></i>
        <i style="width:${pct(c.queued)}%;background:var(--bad)"></i>
      </div>
      <div class="legend">
        ${["mastered", "known", "learning", "queued", "unchecked"].map((k) => `<span style="--c:${COLORS[k]}">${LABELS[k]} ${c[k]}</span>`).join("")}
      </div>
    </div>
    <div class="actions">
      <a class="action ${studyN && S.checked ? "primary" : ""} ${studyN ? "" : "dim"}" href="#study">
        <span class="ico">⟳</span><span><b>Study flashcards</b><span class="sub">${studyN ? `${c.due} review${c.due === 1 ? "" : "s"} · ${c.newToday} new` : c.learning || c.queued ? "All done for today" : "Misses from the check land here"}</span></span>
        <span class="count">${studyN || ""}</span></a>
      <a class="action ${!studyN || !S.checked ? "primary" : ""} ${checkLeft ? "" : "dim"}" href="#check">
        <span class="ico">✓</span><span><b>${S.checked ? "Continue the check" : "Start the word check"}</b><span class="sub">${checkLeft ? `${checkLeft.toLocaleString()} words left · ${S.settings.batch} per round` : "Whole list checked"}</span></span>
        <span class="count">${checkLeft ? Math.round((S.checked / total) * 100) + "%" : ""}</span></a>
    </div>
    <h2>How it works</h2>
    <div class="card fine">
      <b>1. Check.</b> Pick the right definition for each word. Words you miss or don't know go to your study pile.<br><br>
      <b>2. Study.</b> A few new words join your flashcards each day. Cards you struggle with come back sooner; ones you know come back less often.<br><br>
      <b>3. Master.</b> A word counts as mastered once you remember it after a ${MASTERED_IVL}-day gap.
    </div>`;
}

/* --- diagnostic check --- */
function viewCheck() {
  if (S.checked >= WORDS.length) {
    $view.innerHTML = `<div class="done"><div class="emoji">🎉</div><h1>You've checked every word.</h1>
      <p class="lede">Everything you missed is in your study pile.</p><a class="btn primary block" href="#study">Study flashcards</a></div>`;
    return;
  }
  document.body.classList.add("focus");
  const start = S.checked, size = Math.min(S.settings.batch, WORDS.length - start);
  let i = 0, known = 0, missed = [];
  const next = () => {
    if (i >= size) return summary();
    const w = BYID.get(S.order[start + i]);
    const mc = renderMC(w, (ok) => {
      S.checked = start + i + 1;
      if (ok) { S.p[w.id] = { st: "k" }; known++; }
      else { S.p[w.id] = { st: "s" }; S.pile.push(w.id); missed.push(w); }
      touchDay("chk"); save();
      i++;
      const fb = document.getElementById("fb");
      if (ok) { fb.innerHTML = `<div class="feedback good"><b>Correct</b></div>`; setTimeout(next, 650); }
      else {
        fb.innerHTML = `<div class="feedback bad"><b>Added to your study pile</b>${wordDetail(w)}</div>
          <div class="sticky-foot"><button class="btn primary block" id="go">Next</button></div>`;
        document.getElementById("go").addEventListener("click", next);
        keys((k) => { if (k === "Enter" || k === " ") next(); });
      }
    }, { idk: true, hint: `Round ${Math.floor(start / S.settings.batch) + 1} · word ${start + i + 1} of ${WORDS.length}` });
    $view.innerHTML = qhead(i, size) + mc.html;
    mc.bind();
  };
  const summary = () => {
    document.body.classList.remove("focus");
    const left = WORDS.length - S.checked;
    $view.innerHTML = `<div class="done"><div class="emoji">${missed.length ? "📚" : "🌟"}</div>
      <h1>Round complete</h1><p class="lede">You knew ${known} of ${size}. ${missed.length ? `${missed.length} word${missed.length === 1 ? "" : "s"} added to your study pile.` : ""}</p></div>
      ${missed.length ? `<div class="card">${missed.map((w) => `<div class="sense"><b>${esc(w.w)}</b>: ${esc(def(w).d)}</div>`).join("")}</div>` : ""}
      <div class="stack">
        ${left ? `<button class="btn primary block" id="again">Next round (${left.toLocaleString()} left)</button>` : ""}
        <a class="btn block" href="#study">Study flashcards</a>
        <a class="btn ghost block" href="#home">Home</a>
      </div>`;
    const a = document.getElementById("again");
    if (a) a.addEventListener("click", viewCheck);
  };
  next();
}

/* --- spaced-repetition study --- */
function buildSession() {
  const t = today(), c = counts();
  const due = WORDS.filter((w) => S.p[w.id] && S.p[w.id].st === "c" && S.p[w.id].due <= t)
    .sort((a, b) => S.p[a.id].due - S.p[b.id].due).map((w) => w.id);
  const fresh = S.pile.filter((id) => S.p[id] && S.p[id].st === "s").slice(0, c.newToday);
  // spread new cards through the reviews
  const q = [...due];
  fresh.forEach((id, k) => q.splice(Math.min(q.length, Math.round(((k + 1) * q.length) / (fresh.length + 1)) + k), 0, id));
  return q;
}

function viewStudy() {
  let queue = buildSession();
  if (!queue.length) {
    const c = counts();
    $view.innerHTML = `<div class="done"><div class="emoji">✅</div><h1>${c.learning || c.queued ? "All caught up" : "Nothing to study yet"}</h1>
      <p class="lede">${c.learning || c.queued
        ? `Come back tomorrow for your next reviews.${c.queued ? ` ${c.queued} word${c.queued === 1 ? "" : "s"} still waiting to be introduced.` : ""}`
        : "Words you miss in the check become flashcards here."}</p>
      ${S.checked < WORDS.length ? `<a class="btn primary block" href="#check">${S.checked ? "Continue the check" : "Start the word check"}</a>` : ""}</div>`;
    return;
  }
  document.body.classList.add("focus");
  const total = queue.length; let done = 0, again = 0;
  const show = () => {
    if (!queue.length) return finish();
    const id = queue[0], w = BYID.get(id);
    let p = S.p[id];
    const isNew = p.st === "s";
    if (isNew) { p = S.p[id] = { st: "c", reps: 0, ivl: 0, ef: 2.5, due: today(), lapses: 0 }; S.pile = S.pile.filter((x) => x !== id); touchDay("new"); save(); }
    const grade = (g) => {
      schedule(p, g); touchDay("rev");
      queue.shift();
      if (g === 0) { queue.splice(Math.min(queue.length, 3), 0, id); again++; } else done++;
      save(); show();
    };
    const head = qhead(done, total, "#home");
    if (p.reps < 2) {
      // recognition stage: pick the definition
      const mc = renderMC(w, (ok) => {
        const fb = document.getElementById("fb");
        fb.innerHTML = `<div class="feedback ${ok ? "good" : "bad"}"><b>${ok ? "Correct" : "Not quite. It'll come back in a moment."}</b>${wordDetail(w)}</div>
          <div class="sticky-foot"><button class="btn primary block" id="go">Continue</button></div>`;
        const go = () => grade(ok ? 2 : 0);
        document.getElementById("go").addEventListener("click", go);
        keys((k) => { if (k === "Enter" || k === " ") go(); });
      }, { hint: isNew ? "New word" : "Pick the meaning" });
      $view.innerHTML = head + mc.html; mc.bind();
    } else {
      // recall stage: think of the meaning, then flip and grade yourself
      $view.innerHTML = head + `
        <div class="card flash" id="flash">
          <div class="prompt" style="padding:0"><div class="word">${esc(w.w)}</div><div class="pos">${esc(def(w).p)}</div>
          <div class="hint">Say the meaning to yourself, then tap to check</div></div>
          <div id="back"></div>
        </div>
        <div class="sticky-foot" id="foot"><button class="btn primary block" id="flip">Show meaning</button></div>`;
      const flip = () => {
        document.getElementById("back").innerHTML = `<div class="back">${wordDetail(w)}</div>`;
        document.querySelector("#flash .hint").remove();
        const labels = ["Again", "Hard", "Good", "Easy"], cls = ["again", "hard", "good", "easy"];
        document.getElementById("foot").innerHTML = `<div class="grades">${labels.map((l, g) =>
          `<button class="grade ${cls[g]}" data-g="${g}">${l}<small>${g === 0 ? "soon" : fmtIvl(preview(p, g))}</small></button>`).join("")}</div>`;
        document.querySelectorAll(".grade").forEach((b) => b.addEventListener("click", () => grade(+b.dataset.g)));
        keys((k) => { if (k >= "1" && k <= "4") grade(+k - 1); });
      };
      document.getElementById("flip").addEventListener("click", flip);
      document.getElementById("flash").addEventListener("click", () => { if (!document.querySelector(".back")) flip(); });
      keys((k, e) => { if (k === " " || k === "Enter") { e.preventDefault(); flip(); } });
    }
  };
  const finish = () => {
    document.body.classList.remove("focus");
    const c = counts();
    $view.innerHTML = `<div class="done"><div class="emoji">🔥</div><h1>Session done</h1>
      <p class="lede">${done} card${done === 1 ? "" : "s"} reviewed${again ? `, ${again} repeated until they stuck` : ""}. ${streak() > 1 ? `${streak()}-day streak.` : ""}</p></div>
      <div class="stats"><div class="stat"><b>${c.mastered}</b><span>Mastered</span></div>
      <div class="stat"><b>${c.learning}</b><span>Learning</span></div><div class="stat"><b>${c.queued}</b><span>Waiting</span></div></div>
      <div class="stack" style="margin-top:18px">
        ${S.checked < WORDS.length ? `<a class="btn primary block" href="#check">Check more words</a>` : ""}
        <a class="btn block" href="#home">Home</a></div>`;
  };
  show();
}

/* --- word browser --- */
let wordFilter = "all", wordQuery = "";
function viewWords() {
  const c = counts();
  const filters = [["all", "All", WORDS.length], ["learning", "Learning", c.learning], ["queued", "To study", c.queued],
    ["mastered", "Mastered", c.mastered], ["known", "Already knew", c.known], ["unchecked", "Not checked", c.unchecked]];
  $view.innerHTML = `<h1>Word list</h1>
    <input class="search" type="search" placeholder="Search ${WORDS.length.toLocaleString()} words" value="${esc(wordQuery)}" autocomplete="off" autocapitalize="off">
    <div class="chips">${filters.map(([k, l, n]) => `<button class="chip ${wordFilter === k ? "on" : ""}" data-f="${k}">${l} ${n}</button>`).join("")}</div>
    <ul class="wlist" id="wl"></ul>`;
  let limit = 80;
  const draw = () => {
    const q = wordQuery.trim().toLowerCase();
    const list = WORDS.filter((w) => (wordFilter === "all" || status(w.id) === wordFilter) && (!q || w.w.startsWith(q) || (q.length > 2 && w.w.includes(q))));
    document.getElementById("wl").innerHTML = list.slice(0, limit).map((w) =>
      `<li><button data-id="${w.id}"><span class="dot" style="--c:${COLORS[status(w.id)]}"></span><span class="w">${esc(w.w)}</span><span class="d">${esc(def(w).d)}</span></button></li>`).join("")
      + (list.length > limit ? `<li class="more"><button class="btn ghost block" id="more">Show more (${list.length - limit})</button></li>` : "")
      + (!list.length ? `<li class="more">No words here yet.</li>` : "");
    const m = document.getElementById("more");
    if (m) m.addEventListener("click", () => { limit += 200; draw(); });
  };
  $view.querySelector(".search").addEventListener("input", (e) => { wordQuery = e.target.value; limit = 80; draw(); });
  $view.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => { wordFilter = b.dataset.f; viewWords(); }));
  document.getElementById("wl").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) sheet(BYID.get(+b.dataset.id)); });
  draw();
}

function sheet(w) {
  const st = status(w.id), p = S.p[w.id];
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(w.w)}">
    <div class="word">${esc(w.w)}</div>
    <div class="legend" style="margin:6px 0 16px"><span style="--c:${COLORS[st]}">${LABELS[st]}${p && p.st === "c" ? ` · next review in ${fmtIvl(Math.max(0, p.due - today()))}` : ""}</span></div>
    ${wordDetail(w)}
    <div class="row">
      ${st === "known" || st === "unchecked" || st === "mastered" ? `<button class="btn" data-a="study">Study it</button>` : ""}
      ${st !== "known" ? `<button class="btn" data-a="known">I know this</button>` : ""}
      <button class="btn primary" data-a="close">Close</button>
    </div></div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); viewWords(); };
  bg.addEventListener("click", (e) => {
    if (e.target === bg) return close();
    const a = e.target.dataset && e.target.dataset.a;
    if (a === "study") { S.p[w.id] = { st: "s" }; S.pile = S.pile.filter((x) => x !== w.id); S.pile.unshift(w.id); save(); toast("Added. It'll show up in your next session."); close(); }
    if (a === "known") { S.p[w.id] = { st: "k" }; S.pile = S.pile.filter((x) => x !== w.id); save(); close(); }
    if (a === "close") close();
  });
}

/* --- settings / about --- */
function viewSettings() {
  const st = S.settings;
  $view.innerHTML = `<h1>Settings</h1>
    <div class="setting"><label>New words per day<small>How many words from your study pile join your flashcards each day</small></label>
      <div class="stepper"><button data-k="newPerDay" data-d="-5">−</button><output id="o-newPerDay">${st.newPerDay}</output><button data-k="newPerDay" data-d="5">+</button></div></div>
    <div class="setting"><label>Words per check round<small>Shorter rounds are easier to fit in</small></label>
      <div class="stepper"><button data-k="batch" data-d="-5">−</button><output id="o-batch">${st.batch}</output><button data-k="batch" data-d="5">+</button></div></div>
    <h2>Your progress</h2>
    <p class="fine">Progress is saved only on this device and browser. Export a backup to move it to another phone or keep it safe.</p>
    <div class="stack">
      <button class="btn block" id="exp">Export backup</button>
      <label class="btn block">Import backup<input type="file" accept="application/json,.json" id="imp" hidden></label>
      <button class="btn block danger" id="reset">Reset all progress</button>
    </div>
    <h2>Install on your phone</h2>
    <p class="fine"><b>iPhone:</b> in Safari tap Share, then "Add to Home Screen".<br><b>Android:</b> in Chrome tap the ⋮ menu, then "Install app" or "Add to Home screen".<br>It works offline once installed.</p>
    <h2>About</h2>
    <p class="fine">${WORDS.length.toLocaleString()} SAT-level words. Word choices come from openly licensed SAT lists; definitions, examples and synonyms come from Princeton WordNet 3.0. Scheduling uses the SM-2 spaced-repetition algorithm.</p>
    <details><summary class="fine">Credits and licenses</summary><pre class="notices" id="notices">Loading…</pre></details>`;
  $view.querySelectorAll(".stepper button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k, lim = k === "batch" ? [10, 100] : [0, 60];
    st[k] = Math.min(lim[1], Math.max(lim[0], st[k] + +b.dataset.d)); save();
    document.getElementById("o-" + k).textContent = st[k];
  }));
  document.getElementById("exp").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `lexicon-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.getElementById("imp").addEventListener("change", async (e) => {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if (!d || !d.p || !Array.isArray(d.order)) throw new Error();
      S = d; save(); toast("Backup restored"); location.hash = "#home";
    } catch (err) { toast("That file isn't a Lexicon backup"); }
  });
  const r = document.getElementById("reset"); let armed = false;
  r.addEventListener("click", () => {
    if (!armed) { armed = true; r.textContent = "Tap again to erase everything"; setTimeout(() => { armed = false; r.textContent = "Reset all progress"; }, 4000); return; }
    S = freshState(); save(); toast("Progress reset"); location.hash = "#home";
  });
  $view.querySelector("details").addEventListener("toggle", async () => {
    const pre = document.getElementById("notices");
    if (pre.dataset.loaded) return;
    try { pre.textContent = await (await fetch("THIRD_PARTY_NOTICES.txt")).text(); pre.dataset.loaded = 1; } catch (e) { pre.textContent = "Couldn't load notices offline."; }
  });
}

/* ---------- router ---------- */
const ROUTES = { "": viewHome, home: viewHome, check: viewCheck, study: viewStudy, words: viewWords, settings: viewSettings };
function route() {
  if (cleanupKeys) { cleanupKeys(); cleanupKeys = null; }
  document.body.classList.remove("focus");
  document.querySelectorAll(".sheet-bg").forEach((x) => x.remove());
  const r = location.hash.replace(/^#\/?/, "").split("/")[0];
  (ROUTES[r] || viewHome)();
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === (r || "home")));
  const s = streak();
  document.getElementById("streak").textContent = s ? `🔥 ${s} day${s === 1 ? "" : "s"}` : "";
  window.scrollTo(0, 0);
}

async function init() {
  try {
    WORDS = await (await fetch("words.json")).json();
  } catch (e) {
    $view.innerHTML = `<p class="loading">Couldn't load the word list. Check your connection and reload.</p>`; return;
  }
  WORDS.forEach((w) => { BYID.set(w.id, w); (BYPOS[def(w).p] = BYPOS[def(w).p] || []).push(w); });
  S = load() || freshState();
  // if the word list grows in a later version, add new ids to the end of the check order
  const inOrder = new Set(S.order);
  const added = WORDS.filter((w) => !inOrder.has(w.id)).map((w) => w.id);
  if (added.length) { S.order.push(...shuffle(added)); }
  S.order = S.order.filter((id) => BYID.has(id));
  save();
  window.addEventListener("hashchange", route);
  route();
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
init();
