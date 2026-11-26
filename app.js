"use strict";
/* Fangstatistik – Frontend. Alle Texte werden per textContent gesetzt (kein innerHTML mit Nutzerdaten). */

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const S = { me: null, csrf: null, lake: "", species: null, today: null, pending: 0 };

/* ---------- Hilfsfunktionen ---------- */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== "list" && k !== "for") e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

/* ---------- Supabase-Anbindung (ersetzt den früheren Python-Server) ---------- */
const CFG = window.FANGBUCH_CONFIG || {};
const LAKE = CFG.LAKE_NAME || "Lerchenberg-Teich.de";
const sb = (window.supabase && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/DEIN-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY))
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { detectSessionInUrl: false, persistSession: true, autoRefreshToken: true } })
  : null;

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,}$/;
const GROUP_RE = /^[A-Za-z0-9ÄÖÜäöüß./_ -]{1,32}$/;
const LINK_ERR = "Der Link ist ungültig oder abgelaufen. Bitte einen neuen anfordern.";
const berlinToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const labelOf = (f, l) => f.trim().slice(0, 1).toUpperCase() + ". " + l.trim();
let recoveryVerified = false;

function fail(msg, status) { const e = new Error(msg); e.status = status || 400; throw e; }

function pgFail(error, status) {
  const m = error.message || "";
  if (error.code === "P0001") fail(m, 400);
  if (status === 401 || /JWT/i.test(m)) fail("Bitte anmelden.", 401);
  if (error.code === "42501") fail("Keine Berechtigung.", 403);
  fail("Fehler: " + (m || "Unbekannt"), status || 500);
}

function authFail(error) {
  const m = error.message || "", code = error.code || "";
  if (code === "email_not_confirmed" || /not confirmed/i.test(m)) fail("Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Bestätigungsmail).", 403);
  if (code === "invalid_credentials" || /invalid login/i.test(m)) fail("E-Mail-Adresse oder Passwort ist falsch.", 401);
  if (error.status === 429 || /rate limit|too many|security purposes/i.test(m)) fail("Zu viele Versuche. Bitte später erneut versuchen.", 429);
  if (code === "weak_password") fail("Das Passwort ist zu schwach. Bitte ein längeres, weniger einfaches Passwort wählen.", 400);
  fail(m || "Fehler bei der Anmeldung.", error.status || 400);
}

async function rpc(name, args) {
  const { data, error, status } = await sb.rpc(name, args || {});
  if (error) pgFail(error, status);
  return data;
}

function monthRange(y, m) {
  const pad = (n) => String(n).padStart(2, "0");
  return [`${y}-${pad(m)}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`];
}

function intParam(v, lo, hi, dflt) {
  if (v === null || v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail("Ungültige Angabe.");
  return n;
}

async function fetchCatches(a, e) {
  const out = [], step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error, status } = await sb.from("catches").select("*").gte("catch_date", a).lt("catch_date", e)
      .order("catch_date").order("id").range(from, from + step - 1);
    if (error) pgFail(error, status);
    out.push(...data);
    if (data.length < step) return out;
  }
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const limitArg = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) fail("Bitte eine gültige Länge in cm eingeben.");
  return n;
};

/* Bildet die früheren /api/...-Aufrufe auf Supabase ab, damit die Oberfläche unverändert bleibt. */
async function api(path, method = "GET", b = {}) {
  if (!sb) fail("Die Seite ist noch nicht mit Supabase verbunden. Bitte config.js ausfüllen (siehe README).", 500);
  const url = new URL(path, "https://x.invalid");
  const p = url.pathname, q = url.searchParams, key = method + " " + p;
  const pw = () => {
    const a = String(b.password || ""), c = String(b.password2 || "");
    if (a.length < 8) fail("Das Passwort muss mindestens 8 Zeichen lang sein.");
    if (a.length > 200) fail("Das Passwort ist zu lang.");
    if (a !== c) fail("Die beiden Passwörter stimmen nicht überein.");
    return a;
  };

  if (key === "GET /api/me") {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { user: null, lake: LAKE };
    const { data: pr, error, status } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (error) pgFail(error, status);
    if (!pr) { await sb.auth.signOut({ scope: "local" }); return { user: null, lake: LAKE }; }
    return { lake: LAKE, csrf: null, today: berlinToday(), user: {
      id: pr.id, first_name: pr.first_name, last_name: pr.last_name, email: session.user.email, group_id: pr.group_id,
      is_admin: pr.is_admin, approved: pr.approved, label: labelOf(pr.first_name, pr.last_name) } };
  }

  if (key === "POST /api/register") {
    const email = clean(b.email, 254).toLowerCase(), first = clean(b.first_name, 60), last = clean(b.last_name, 60), gid = clean(b.group_id, 32);
    if (!EMAIL_RE.test(email)) fail("Bitte eine gültige E-Mail-Adresse eingeben.");
    if (first.length < 1 || last.length < 2) fail("Bitte vollständigen Vor- und Nachnamen angeben.");
    if (!GROUP_RE.test(gid)) fail("Bitte die Sportgruppen-ID angeben.");
    const password = pw();
    const { data, error } = await sb.auth.signUp({ email, password, options: {
      data: { first_name: first, last_name: last, group_id: gid }, emailRedirectTo: location.origin + location.pathname } });
    if (error) {
      if (/database error/i.test(error.message)) fail("Bitte Name und Sportgruppen-ID prüfen.");
      authFail(error);
    }
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) fail("Mit dieser E-Mail-Adresse existiert bereits ein Profil.", 409);
    return { ok: true, verify_pending: true };
  }

  if (key === "POST /api/login") {
    const { error } = await sb.auth.signInWithPassword({ email: clean(b.email, 254).toLowerCase(), password: String(b.password || "") });
    if (error) authFail(error);
    return { ok: true };
  }

  if (key === "POST /api/logout") { await sb.auth.signOut(); return { ok: true }; }

  if (key === "POST /api/resend-verification") {
    const { error } = await sb.auth.resend({ type: "signup", email: clean(b.email, 254).toLowerCase(), options: { emailRedirectTo: location.origin + location.pathname } });
    if (error && (error.status === 429 || /rate limit|security purposes/i.test(error.message))) authFail(error);
    return { ok: true };
  }

  if (key === "POST /api/forgot") {
    const { error } = await sb.auth.resetPasswordForEmail(clean(b.email, 254).toLowerCase(), { redirectTo: location.origin + location.pathname });
    if (error && (error.status === 429 || /rate limit|security purposes/i.test(error.message))) authFail(error);
    return { ok: true };   // immer dieselbe Antwort – verrät nicht, ob die Adresse registriert ist
  }

  if (key === "POST /api/verify") {
    const { error } = await sb.auth.verifyOtp({ token_hash: String(b.token || ""), type: "signup" });
    if (error) fail(LINK_ERR);
    await sb.auth.signOut({ scope: "local" });
    return { ok: true };
  }

  if (key === "POST /api/reset") {
    const password = pw();
    if (!recoveryVerified) {
      const { error } = await sb.auth.verifyOtp({ token_hash: String(b.token || ""), type: "recovery" });
      if (error) fail(LINK_ERR);
      recoveryVerified = true;
    }
    const { error } = await sb.auth.updateUser({ password });
    if (error) authFail(error);
    recoveryVerified = false;
    await sb.auth.signOut({ scope: "global" });   // alle alten Sitzungen beenden
    return { ok: true };
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) fail("Bitte anmelden.", 401);

  if (key === "GET /api/species") {
    const { data, error, status } = await sb.from("species").select("*");
    if (error) pgFail(error, status);
    return { species: data.map((r) => ({ id: r.id, name: r.name, aliases: r.aliases, min: numOrNull(r.min_cm), max: numOrNull(r.max_cm), image: r.image, other: r.is_other })) };
  }

  if (key === "GET /api/catches") {
    const today = berlinToday();
    const y = intParam(q.get("year"), 1990, 2100, +today.slice(0, 4));
    const whole = q.get("scope") === "year";
    const m = whole ? null : intParam(q.get("month"), 1, 12, +today.slice(5, 7));
    const [a, e] = whole ? [`${y}-01-01`, `${y + 1}-01-01`] : monthRange(y, m);
    const rows = await fetchCatches(a, e);
    return { year: y, month: m, catches: rows.map((r) => ({ id: r.id, date: r.catch_date, species: r.species_name, species_id: r.species_id,
      length: Number(r.length_cm), status: r.size_status, min: numOrNull(r.min_cm_at), max: numOrNull(r.max_cm_at), angler: r.angler_name,
      by_admin: r.added_by_admin, fate: r.fate, health: r.health, remark: r.remark })) };
  }

  if (key === "POST /api/catches") {
    await rpc("add_catch", { p_date: b.date, p_species_id: b.species_id, p_species_other: b.species_other || "", p_length: b.length,
      p_fate: b.fate, p_health: b.health || "none", p_remark: b.remark || "", p_confirmed: b.confirmed === true });
    return { ok: true };
  }

  if (key === "POST /api/admin/catches") {
    await rpc("admin_add_catch", { p_date: b.date, p_species_id: b.species_id, p_species_other: b.species_other || "", p_length: b.length,
      p_angler_user: b.angler_user_id || null, p_angler_name: b.angler_name || "",
      p_fate: b.fate, p_health: b.health || "none", p_remark: b.remark || "", p_confirmed: b.confirmed === true });
    return { ok: true };
  }

  if (key === "GET /api/admin/users") {
    const rows = await rpc("admin_list_users");
    return { users: rows.map((r) => ({ id: r.id, first_name: r.first_name, last_name: r.last_name, email: r.email, group_id: r.group_id,
      is_admin: r.is_admin, verified: r.verified, approved: r.approved, label: labelOf(r.first_name, r.last_name) })) };
  }

  let m;
  if (method === "POST" && (m = p.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/(admin|approve|verify|set-password)$/))) {
    if (m[2] === "admin") await rpc("admin_set_admin", { p_user: m[1], p_admin: b.is_admin === true });
    else if (m[2] === "approve") await rpc("admin_set_approved", { p_user: m[1], p_approved: b.approved === true });
    else if (m[2] === "verify") await rpc("admin_verify_user", { p_user: m[1] });
    else await rpc("admin_set_password", { p_user: m[1], p_password: pw() });
    return { ok: true };
  }

  if (method === "POST" && (m = p.match(/^\/api\/admin\/species\/(\d+)$/))) {
    await rpc("admin_set_limits", { p_species: +m[1], p_min: limitArg(b.min), p_max: limitArg(b.max) });
    return { ok: true };
  }

  if (key === "GET /api/admin/summary") {
    const today = berlinToday();
    return await rpc("admin_summary", { p_year: intParam(q.get("year"), 1990, 2100, +today.slice(0, 4)), p_month: intParam(q.get("month"), 1, 12, null) });
  }

  fail("Nicht gefunden.", 404);
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

const fmtLen = (x) => (x === null || x === undefined ? "–" : String(Number(x).toFixed(1)).replace(".", ",").replace(/,0$/, ""));
const fmtDate = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4);
const pad2 = (n) => String(n).padStart(2, "0");

/* Umlaute für die Suche: Variante 1 ä→a, Variante 2 ä→ae */
function foldKeys(s) {
  s = s.toLowerCase().replace(/ß/g, "ss");
  const a = s.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
  const b = s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
  return a === b ? [a] : [a, b];
}

function statusOf(len, mn, mx) {
  if (mn !== null && mn !== undefined && len < mn) return "under";
  if (mx !== null && mx !== undefined && len > mx) return "over";
  return "ok";
}
const NOT_OK_HINT = "Wenn der Fisch eine Krankheit oder Verletzung hatte, bitte Krankheit oder Verletzung beschreiben.";
const SICK_RELEASE_HINT = "Achtung: Kranke oder verletzte Fische zurückzusetzen ist gefährlich für die Gesundheit des Gewässers.";
const FATE_TEXT = { taken: "entnommen", released: "zurückgesetzt", unknown: "–" };
const HEALTH_TEXT = { none: "", disease: "Krankheit", injury: "Verletzung" };

function radioGroup(name, options, initial, onChange, legendText) {
  let value = initial;
  const set = h("fieldset", { class: "radios" }, h("legend", { text: legendText }));
  options.forEach(([v, text], i) => {
    const input = h("input", { type: "radio", name, value: v, id: `${name}-${i}`, checked: v === initial,
      onchange: () => { value = v; onChange(); } });
    set.append(h("label", { class: "radio", for: `${name}-${i}` }, input, h("span", { text })));
  });
  return { el: set, get value() { return value; }, reset() { value = null; set.querySelectorAll("input").forEach((i) => { i.checked = false; }); },
    select(v) { value = v; set.querySelectorAll("input").forEach((i) => { i.checked = i.value === v; }); } };
}
const STATUS_TEXT = { under: "zu klein", over: "zu groß", ok: "maßig" };

/* ---------- Fischart-Auswahl mit Vorschlägen ---------- */
function speciesCombo(onPick) {
  let sel = null, active = -1, items = [];
  const input = h("input", {
    type: "text", id: "sp-input", autocomplete: "off", role: "combobox", "aria-expanded": "false",
    "aria-controls": "sp-list", "aria-autocomplete": "list", placeholder: "Fischart eintippen oder auswählen …", spellcheck: false,
  });
  const list = h("ul", { id: "sp-list", role: "listbox", hidden: true });
  const picked = h("div", { class: "picked", hidden: true });
  const wrap = h("div", { class: "combo" }, input, list);

  const byName = (a, b) => a.name.localeCompare(b.name, "de");
  function matches(q) {
    const all = S.species.filter((s) => !s.other).sort(byName);
    const other = S.species.find((s) => s.other);
    if (!q.trim()) return [...all, other];
    const qk = foldKeys(q.trim());
    const starts = [], contains = [];
    for (const s of all) {
      const nameKeys = foldKeys(s.name);
      const aliasKeys = s.aliases ? s.aliases.split(",").flatMap((x) => foldKeys(x.trim())) : [];
      if (nameKeys.some((n) => qk.some((k) => n.startsWith(k)))) starts.push(s);
      else if ([...nameKeys, ...aliasKeys].some((n) => qk.some((k) => n.includes(k)))) contains.push(s);
    }
    const res = [...starts, ...contains];
    if (other && other.name && foldKeys(other.name).some((n) => qk.some((k) => n.startsWith(k)))) res.push(other);
    return res;
  }

  function hl(text, q) {
    // markiert den getippten Teil (nur wenn direkt im Namen gefunden)
    const i = q ? foldKeys(text)[0].indexOf(foldKeys(q)[0]) : -1;
    if (i < 0 || foldKeys(text)[0].length !== text.length) return text;
    return [text.slice(0, i), h("mark", { text: text.slice(i, i + q.length) }), text.slice(i + q.length)];
  }

  function render() {
    const q = input.value;
    items = matches(q);
    list.replaceChildren();
    if (!items.length) {
      list.append(h("li", { class: "none" }, "Keine passende Fischart in der Liste."));
      const other = S.species.find((s) => s.other);
      items = [other];
      list.append(h("li", { role: "option", "aria-selected": "false", onmousedown: (e) => { e.preventDefault(); pick(other); } },
        h("img", { src: other.image, alt: "" }), h("span", {}, h("strong", { text: "Sonstige" }), h("br"), h("small", { text: "Fisch nicht in der Liste – selbst eintragen" }))));
    } else {
      items.forEach((s, i) => {
        const nm = h("strong", {}, hl(s.name, q));
        const alias = s.aliases && !s.other ? h("small", { text: s.aliases }) : s.other ? h("small", { text: "Fisch nicht in der Liste – selbst eintragen" }) : null;
        list.append(h("li", {
          role: "option", id: "sp-opt-" + i, "aria-selected": String(i === active),
          onmousedown: (e) => { e.preventDefault(); pick(s); },
        }, h("img", { src: s.image, alt: "", loading: "lazy" }), h("span", {}, nm, alias ? h("br") : null, alias)));
      });
    }
    open(true);
  }
  function open(v) {
    list.hidden = !v;
    input.setAttribute("aria-expanded", String(v));
  }
  function setActive(i) {
    active = i;
    [...list.querySelectorAll("li[role=option]")].forEach((li, n) => {
      li.setAttribute("aria-selected", String(n === i));
      if (n === i) { li.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", li.id); }
    });
  }
  function pick(s) {
    sel = s;
    input.value = s.name;
    open(false);
    picked.hidden = false;
    let rule = "Keine Maße hinterlegt";
    if (s.min !== null || s.max !== null) {
      rule = [s.min !== null ? "Mindestmaß " + fmtLen(s.min) + " cm" : null, s.max !== null ? "Höchstmaß " + fmtLen(s.max) + " cm" : null].filter(Boolean).join(" · ");
    }
    picked.replaceChildren(h("img", { src: s.image, alt: "Abbildung " + s.name }),
      h("div", {}, h("strong", { text: s.name }), h("div", { class: "hint", text: rule })));
    onPick(s);
  }
  function clearPick() {
    if (!sel) return;
    sel = null; picked.hidden = true; onPick(null);
  }

  input.addEventListener("input", () => { clearPick(); active = -1; render(); });
  input.addEventListener("focus", () => { if (!sel) render(); else input.select(); });
  input.addEventListener("blur", () => open(false));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) render(); setActive(Math.min(items.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter") { if (!list.hidden) { e.preventDefault(); const s = items[active >= 0 ? active : (items.length === 1 ? 0 : -1)]; if (s) pick(s); } }
    else if (e.key === "Escape") open(false);
  });
  return { el: h("div", {}, wrap, picked), get value() { return sel; }, input };
}

/* ---------- Längeneingabe mit Live-Farbe ---------- */
function lengthField(getSpecies) {
  const input = h("input", { type: "text", inputMode: "decimal", id: "len-input", class: "len", autocomplete: "off", placeholder: "0", "aria-describedby": "len-msg", maxLength: 6 });
  const msg = h("p", { class: "lenmsg", id: "len-msg" });
  function parse() {
    const v = input.value.trim().replace(",", ".");
    if (!/^\d{1,3}(\.\d?)?$/.test(v)) return null;
    const n = parseFloat(v);
    return n >= 1 && n <= 300 ? n : null;
  }
  function update() {
    const n = parse();
    input.classList.remove("ok", "warn");
    msg.className = "lenmsg";
    msg.textContent = "";
    if (input.value.trim() === "") return;
    if (n === null) { msg.textContent = "Bitte eine Länge zwischen 1 und 300 cm eingeben (z. B. 54,5)."; msg.classList.add("warn"); return; }
    const sp = getSpecies();
    const st = sp ? statusOf(n, sp.min, sp.max) : "ok";
    if (st === "ok") {
      input.classList.add("ok"); msg.classList.add("ok");
      msg.textContent = sp && (sp.min !== null || sp.max !== null) ? "✔ Maßig" : "✔ Länge erfasst";
    } else {
      input.classList.add("warn"); msg.classList.add("warn");
      msg.textContent = st === "under" ? `⚠ Fisch ist zu klein (Mindestmaß ${fmtLen(sp.min)} cm)` : `⚠ Fisch ist zu groß (Höchstmaß ${fmtLen(sp.max)} cm)`;
    }
  }
  input.addEventListener("input", update);
  return { el: h("div", {}, h("div", { class: "row" }, h("div", {}, input)), h("span", { class: "unit", text: "Maßeinheit: cm" }), msg), update, get value() { return parse(); }, input };
}

/* ---------- Bestätigungsdialog ---------- */
function confirmCatch(rows, warnings) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { "aria-labelledby": "dlg-t" });
    const dl = h("dl");
    rows.forEach(([k, v, cls]) => dl.append(h("dt", { text: k }), h("dd", { class: cls || "", text: v })));
    dlg.append(
      h("h2", { id: "dlg-t", text: "Eintragung kontrollieren" }),
      h("p", { text: "Bitte prüfe alle Angaben sorgfältig:" }), dl,
      ...(warnings || []).map((w) => h("p", { class: "warn-t", text: "⚠ " + w })),
      h("div", { class: "warnbox", text: "Achtung: Nach dem Speichern ist der Fang festgeschrieben und kann nicht mehr geändert oder gelöscht werden." }),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", id: "dlg-ok", onclick: () => { dlg.close("ok"); } }, "Ja, Fang festschreiben"),
        h("button", { class: "btn secondary", type: "button", onclick: () => dlg.close("cancel") }, "Zurück zur Kontrolle")));
    dlg.addEventListener("close", () => { const ok = dlg.returnValue === "ok"; dlg.remove(); resolve(ok); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector(".secondary").focus();
  });
}

/* ---------- Fangformular (Benutzer + Admin-Nachtrag) ---------- */
function catchForm({ admin }) {
  let species = null;
  const err = h("p", { class: "error", role: "alert" });
  const combo = speciesCombo((s) => { species = s; lf.update(); otherWrap.hidden = !(s && s.other); updFate(); });
  const lf = lengthField(() => species);
  lf.input.addEventListener("input", () => updFate());
  const dateIn = h("input", { type: "date", id: "f-date", max: S.today, value: S.today, required: true });
  const otherIn = h("input", { type: "text", id: "f-other", maxLength: 60, placeholder: "Name des Fisches" });
  const otherWrap = h("div", { hidden: true }, h("label", { for: "f-other", text: "Welche Fischart? (Sonstige)" }), otherIn);

  let anglerSel, anglerName, anglerNameWrap, members = [];
  const remarkIn = h("textarea", { id: "f-remark", maxLength: 300, rows: 3 });
  const remarkLabel = h("label", { for: "f-remark" });
  const remarkHint = h("p", { class: "hint" });
  const fateG = radioGroup("fate", [["taken", "Entnommen"], ["released", "Zurückgesetzt"]], null, () => { updFate(); updRemark(); }, "Verbleib des Fisches");
  const fateHint = h("p", { class: "hint warn-t", hidden: true });
  const sickHint = h("p", { class: "sick-warn", role: "alert", hidden: true, text: SICK_RELEASE_HINT });
  const healthG = radioGroup("health", [["none", "Unauffällig"], ["disease", "Krankheit"], ["injury", "Verletzung"]], "none", () => { updRemark(); updFate(); }, "Zustand des Fisches");
  // Nicht maßiger Fisch + Entnahme: Krankheit oder Verletzung wählen und Bemerkung eintragen
  const notOk = () => { const n = lf.value; return !!species && n !== null && statusOf(n, species.min, species.max) !== "ok"; };
  function updFate() {
    const need = fateG.value === "taken" && notOk();
    const noneInput = form.querySelector("#health-0");
    if (noneInput) noneInput.disabled = need;
    if (need && healthG.value === "none") healthG.reset();
    if (!need && healthG.value === null) healthG.select("none");
    fateHint.hidden = !notOk();
    fateHint.textContent = NOT_OK_HINT;
    sickHint.hidden = !(fateG.value === "released" && healthG.value && healthG.value !== "none");
    updRemark();
  }
  const takenNotOk = () => fateG.value === "taken" && notOk();
  const remarkRequired = () => takenNotOk() || healthG.value !== "none";
  function updRemark() {
    const req = remarkRequired();
    remarkLabel.textContent = req ? "Bemerkung (Pflichtfeld)" : "Bemerkung (optional)";
    remarkHint.textContent = takenNotOk() ? "Pflicht bei Entnahme eines nicht maßigen Fisches – bitte Art der Krankheit bzw. Verletzung beschreiben."
      : healthG.value !== "none" ? "Bei Krankheit oder Verletzung ist eine Bemerkung Pflicht – bitte kurz beschreiben." : "Bei maßigen, unauffälligen Fischen ist keine Bemerkung nötig.";
    remarkIn.placeholder = healthG.value !== "none" ? "Was war zu sehen? z. B. Pilzbefall, Hakenverletzung" : "";
  }
  const parts = [];
  if (admin) {
    anglerSel = h("select", { id: "f-angler" });
    anglerName = h("input", { type: "text", id: "f-aname", maxLength: 80, placeholder: "Vor- und Nachname, z. B. Max Mustermann", autocomplete: "off" });
    anglerNameWrap = h("div", { hidden: true }, h("label", { for: "f-aname", text: "Name des Anglers (nicht registriert)" }), anglerName,
      h("p", { class: "hint", text: "Wird als „M. Mustermann“ eingetragen." }));
    anglerSel.addEventListener("change", () => { anglerNameWrap.hidden = anglerSel.value !== "other"; });
    api("/api/admin/users").then((d) => {
      members = d.users;
      anglerSel.append(h("option", { value: "", text: "– bitte wählen –" }));
      members.forEach((u) => anglerSel.append(h("option", { value: u.id, text: `${u.label}  (${u.first_name} ${u.last_name}, ID ${u.group_id})` })));
      anglerSel.append(h("option", { value: "other", text: "Anderer Angler (nicht registriert) …" }));
    });
    parts.push(h("label", { for: "f-angler", text: "Angler" }), anglerSel, anglerNameWrap);
  } else {
    parts.push(h("label", { text: "Angler" }), h("p", {}, h("strong", { text: S.me.label }), h("span", { class: "hint", text: "  (wird automatisch eingetragen)" })));
  }
  parts.push(h("label", { for: "f-date", text: "Fangdatum" }), dateIn,
    h("label", { for: "sp-input", text: "Fischart" }), combo.el, otherWrap,
    h("label", { for: "len-input", text: "Länge" }), lf.el, fateG.el, fateHint, healthG.el, sickHint, remarkLabel, remarkIn, remarkHint, err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: admin ? "Nachtragen …" : "Fang speichern …" })));

  const form = h("form", { class: "card", novalidate: true, onsubmit: onSubmit }, ...parts);
  updRemark(); updFate();

  async function onSubmit(e) {
    e.preventDefault();
    err.textContent = "";
    const len = lf.value;
    let anglerLabel = S.me.label, payload = {};
    if (!dateIn.value) return (err.textContent = "Bitte das Fangdatum eintragen.");
    if (dateIn.value > S.today) return (err.textContent = "Das Fangdatum darf nicht in der Zukunft liegen.");
    if (!species) return (err.textContent = "Bitte eine Fischart aus der Liste wählen (oder „Sonstige“).");
    if (species.other && otherIn.value.trim().length < 2) return (err.textContent = "Bitte bei „Sonstige“ die Fischart eintragen.");
    if (len === null) return (err.textContent = "Bitte die Länge in cm eingeben (1–300).");
    if (!fateG.value) return (err.textContent = "Bitte angeben, ob der Fisch entnommen oder zurückgesetzt wurde.");
    if (takenNotOk() && (!healthG.value || healthG.value === "none")) return (err.textContent = "Wird ein nicht maßiger Fisch entnommen, bitte Krankheit oder Verletzung auswählen.");
    if (remarkRequired() && remarkIn.value.trim().length < 3) { remarkIn.focus(); return (err.textContent = "Bitte eine Bemerkung eintragen (Pflicht bei Entnahme eines nicht maßigen Fisches und bei Krankheit oder Verletzung)."); }
    if (admin) {
      if (!anglerSel.value) return (err.textContent = "Bitte den Angler wählen.");
      if (anglerSel.value === "other") {
        const nm = anglerName.value.trim().replace(/\s+/g, " ");
        const m = nm.match(/^(\S+)\s+(.+)$/);
        if (!m) return (err.textContent = "Bitte Vor- und Nachnamen des Anglers eingeben.");
        anglerLabel = m[1][0].toUpperCase() + ". " + m[2];
        payload.angler_name = nm;
      } else {
        const u = members.find((x) => String(x.id) === anglerSel.value);
        anglerLabel = u.label;
        payload.angler_user_id = u.id;
      }
    }
    const st = statusOf(len, species.min, species.max);
    const rows = [["Angler", anglerLabel], ["Datum", fmtDate(dateIn.value)],
      ["Fischart", species.other ? "Sonstige: " + otherIn.value.trim() : species.name], ["Länge", fmtLen(len) + " cm", st === "ok" ? "ok-t" : "warn-t"]];
    const warnings = st === "under" ? [`Der Fisch ist zu klein (Mindestmaß ${fmtLen(species.min)} cm).`] : st === "over" ? [`Der Fisch ist zu groß (Höchstmaß ${fmtLen(species.max)} cm).`] : [];
    rows.push(["Verbleib", fate_label(fateG.value)]);
    if (healthG.value !== "none") rows.push(["Zustand", HEALTH_TEXT[healthG.value], "warn-t"]);
    rows.push(["Bemerkung", remarkIn.value.trim() || "–"]);
    if (st !== "ok") warnings.push(NOT_OK_HINT);
    if (fateG.value === "released" && healthG.value !== "none") warnings.push(SICK_RELEASE_HINT.replace(/^Achtung: /, ""));
    if (!(await confirmCatch(rows, warnings))) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api(admin ? "/api/admin/catches" : "/api/catches", "POST", {
        ...payload, date: dateIn.value, species_id: species.id, species_other: otherIn.value, length: len, confirmed: true,
        fate: fateG.value, health: healthG.value, remark: remarkIn.value.trim() });
      toast("✔ Fang festgeschrieben.");
      route(true);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  }
  return form;
}

/* ---------- Monatsauswahl ---------- */
function periodBar(state, reload, { withMonth = true, years } = {}) {
  const now = new Date();
  const yrs = years || Array.from({ length: now.getFullYear() - 2019 }, (_, i) => now.getFullYear() - i);
  if (!yrs.includes(state.year)) yrs.unshift(state.year);
  const ySel = h("select", { "aria-label": "Jahr", onchange: () => { state.year = +ySel.value; reload(); } },
    yrs.map((y) => h("option", { value: y, selected: y === state.year, text: y })));
  const els = [];
  if (withMonth) {
    const mSel = h("select", { "aria-label": "Monat", onchange: () => { state.month = +mSel.value; reload(); } },
      MONTHS.map((m, i) => h("option", { value: i + 1, selected: i + 1 === state.month, text: m })));
    const step = (d) => { let m = state.month + d, y = state.year; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } state.month = m; state.year = y; reload(); };
    els.push(h("button", { class: "btn secondary small", type: "button", "aria-label": "Vorheriger Monat", onclick: () => step(-1) }, "‹"), mSel,
      h("button", { class: "btn secondary small", type: "button", "aria-label": "Nächster Monat", onclick: () => step(1) }, "›"));
  }
  els.push(ySel);
  return els;
}

const printBtn = () => h("button", { class: "btn small no-print", type: "button", onclick: () => window.print() }, "🖨 Drucken / als PDF speichern");

function printHead(title, period) {
  return h("div", { class: "print-head" }, h("h1", { text: `${S.lake} – ${title}` }), h("p", { text: period }),
    h("p", { text: "Gedruckt am " + fmtDate(S.today) }));
}

/* ---------- Ansichten ---------- */
const fate_label = (f) => (f === "taken" ? "Entnommen" : "Zurückgesetzt");

function viewNew() {
  return [h("h1", { text: "Neuen Fang registrieren" }), catchForm({ admin: false })];
}

async function viewList() {
  const st = viewList.st || (viewList.st = { year: +S.today.slice(0, 4), month: +S.today.slice(5, 7), mode: "month" });
  const box = h("div");
  async function load() {
    const yearMode = st.mode === "year";
    const d = await api(yearMode ? `/api/catches?year=${st.year}&scope=year` : `/api/catches?year=${st.year}&month=${st.month}`);
    const seg = h("div", { class: "seg" },
      h("button", { type: "button", class: yearMode ? "" : "on", onclick: () => { st.mode = "month"; load(); } }, "Monat"),
      h("button", { type: "button", class: yearMode ? "on" : "", onclick: () => { st.mode = "year"; load(); } }, "Jahresübersicht"));
    const bar = h("div", { class: "toolbar no-print" }, seg, ...periodBar(st, load, { withMonth: !yearMode }), h("span", { class: "grow" }), printBtn());
    const period = yearMode ? `Jahr ${st.year}` : `${MONTHS[st.month - 1]} ${st.year}`;
    let table;
    if (!d.catches.length) table = h("div", { class: "empty", text: yearMode ? "Für dieses Jahr sind noch keine Fänge eingetragen." : "Für diesen Monat sind noch keine Fänge eingetragen." });
    else {
      table = h("div", { class: "tablewrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "Nr." }), h("th", { text: "Datum" }), h("th", { text: "Angler" }), h("th", { text: "Fischart" }),
          h("th", { class: "num", text: "Länge (cm)" }), h("th", { text: "Maß" }), h("th", { text: "Verbleib" }), h("th", { text: "Bemerkung" }))),
        h("tbody", {}, d.catches.map((c, i) => h("tr", { class: c.status !== "ok" ? "is-warn" : "" },
          h("td", { text: i + 1 }), h("td", { text: fmtDate(c.date) }),
          h("td", {}, c.angler, c.by_admin ? h("span", { class: "badge no-print", title: "Von Admin nachgetragen", text: "nachgetragen" }) : null),
          h("td", { text: c.species }), h("td", { class: "num", text: fmtLen(c.length) }),
          h("td", { class: "st-" + c.status, text: c.status === "ok" ? "maßig" : c.status === "under" ? "⚠ zu klein" : "⚠ zu groß" }),
          h("td", { text: FATE_TEXT[c.fate] || "–" }),
          h("td", {}, c.health !== "none" ? h("strong", { class: "warn-t", text: HEALTH_TEXT[c.health] + (c.remark ? ": " : "") }) : null, c.remark))))));
    }
    const sum = d.catches.length ? h("p", { class: "hint", text: `${d.catches.length} Fänge im ${period}` + (d.catches.some((c) => c.status !== "ok") ? ` · davon ${d.catches.filter((c) => c.status !== "ok").length} unter-/übermaßig` : "") }) : null;
    box.replaceChildren(bar, h("div", { class: "card" }, printHead("Fangliste " + period, yearMode ? "Jahresübersicht der Fangliste" : "Monatliche Fangliste"), table, sum));
  }
  await load();
  return [h("h1", { class: "no-print", text: "Fangliste" }), box];
}

async function viewSummary() {
  const st = viewSummary.st || (viewSummary.st = { year: +S.today.slice(0, 4), month: +S.today.slice(5, 7), mode: "month" });
  const box = h("div");
  async function load() {
    const d = await api(`/api/admin/summary?year=${st.year}` + (st.mode === "month" ? `&month=${st.month}` : ""));
    const seg = h("div", { class: "seg" },
      h("button", { type: "button", class: st.mode === "month" ? "on" : "", onclick: () => { st.mode = "month"; load(); } }, "Monat"),
      h("button", { type: "button", class: st.mode === "year" ? "on" : "", onclick: () => { st.mode = "year"; load(); } }, "Jahr"));
    const bar = h("div", { class: "toolbar no-print" }, seg, ...periodBar(st, load, { withMonth: st.mode === "month", years: d.years.slice() }), h("span", { class: "grow" }), printBtn());
    const period = st.mode === "month" ? `${MONTHS[st.month - 1]} ${st.year}` : `Jahr ${st.year}`;
    let content;
    if (!d.rows.length) content = h("div", { class: "empty", text: "Keine Fänge in diesem Zeitraum." });
    else {
      const total = d.rows.reduce((a, r) => a + r.count, 0);
      const tu = d.rows.reduce((a, r) => a + r.under, 0), to = d.rows.reduce((a, r) => a + r.over, 0);
      const ttk = d.rows.reduce((a, r) => a + r.taken, 0), trl = d.rows.reduce((a, r) => a + r.released, 0), tsk = d.rows.reduce((a, r) => a + r.sick, 0);
      content = h("div", { class: "tablewrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "Fischart" }), h("th", { class: "num", text: "Anzahl" }), h("th", { class: "num", text: "entnommen" }), h("th", { class: "num", text: "zurück-gesetzt" }), h("th", { class: "num", text: "krank / verletzt" }), h("th", { class: "num", text: "zu klein" }),
          h("th", { class: "num", text: "zu groß" }), h("th", { class: "num", text: "kleinster (cm)" }), h("th", { class: "num", text: "Ø (cm)" }), h("th", { class: "num", text: "größter (cm)" }))),
        h("tbody", {}, d.rows.map((r) => h("tr", {}, h("td", { text: r.species }), h("td", { class: "num", text: r.count }), h("td", { class: "num", text: r.taken || "–" }), h("td", { class: "num", text: r.released || "–" }),
          h("td", { class: "num" + (r.sick ? " st-under" : ""), text: r.sick || "–" }),
          h("td", { class: "num" + (r.under ? " st-under" : ""), text: r.under || "–" }), h("td", { class: "num" + (r.over ? " st-over" : ""), text: r.over || "–" }),
          h("td", { class: "num", text: fmtLen(r.min) }), h("td", { class: "num", text: fmtLen(r.avg) }), h("td", { class: "num", text: fmtLen(r.max) }))),
          h("tr", { class: "total" }, h("td", { text: "Gesamt" }), h("td", { class: "num", text: total }), h("td", { class: "num", text: ttk || "–" }), h("td", { class: "num", text: trl || "–" }), h("td", { class: "num", text: tsk || "–" }), h("td", { class: "num", text: tu || "–" }), h("td", { class: "num", text: to || "–" }), h("td"), h("td"), h("td")))));
      if (st.mode === "year") {
        const species = [...new Set(d.per_month.map((x) => x.species))].sort((a, b) => a.localeCompare(b, "de"));
        const cell = (m, s) => (d.per_month.find((x) => x.month === m && x.species === s) || { count: 0 }).count;
        const matrix = h("div", { class: "tablewrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", { text: "Fischart" }), MONTHS.map((m) => h("th", { class: "num", text: m.slice(0, 3) })), h("th", { class: "num", text: "Σ" }))),
          h("tbody", {}, species.map((s) => h("tr", {}, h("td", { text: s }), MONTHS.map((_, i) => h("td", { class: "num", text: cell(i + 1, s) || "·" }),),
            h("td", { class: "num", text: d.rows.find((r) => r.species === s).count }))),
            h("tr", { class: "total" }, h("td", { text: "Gesamt" }), MONTHS.map((_, i) => h("td", { class: "num", text: species.reduce((a, s) => a + cell(i + 1, s), 0) || "·" })), h("td", { class: "num", text: total })))));
        content = h("div", {}, content, h("h2", { text: "Verteilung nach Monaten" }), matrix);
      }
    }
    box.replaceChildren(bar, h("div", { class: "card" }, printHead("Fangauswertung " + period, st.mode === "month" ? "Monatsauswertung nach Fischart" : "Jahreszusammenfassung nach Fischart"), content));
  }
  await load();
  return [h("h1", { class: "no-print", text: "Auswertung" }), box];
}

function passwordDialog(name) {
  return new Promise((resolve) => {
    const err = h("p", { class: "error", role: "alert" });
    const pw1 = h("input", { type: "password", minLength: 8, maxLength: 200, autocomplete: "new-password", required: true });
    const pw2 = h("input", { type: "password", minLength: 8, maxLength: 200, autocomplete: "new-password", required: true });
    const dlg = h("dialog", { "aria-labelledby": "pw-t" },
      h("h2", { id: "pw-t", text: "Neues Passwort für " + name }),
      h("p", { class: "hint", text: "Alle bestehenden Anmeldungen dieses Mitglieds werden dabei beendet. Bitte das neue Passwort sicher weitergeben." }),
      h("label", {}, "Neues Passwort (mind. 8 Zeichen)"), pw1,
      h("label", {}, "Passwort wiederholen"), pw2, err,
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: () => {
          if (pw1.value.length < 8) { err.textContent = "Mindestens 8 Zeichen."; return; }
          if (pw1.value !== pw2.value) { err.textContent = "Die beiden Passwörter stimmen nicht überein."; return; }
          dlg.close("ok");
        } }, "Passwort setzen"),
        h("button", { class: "btn secondary", type: "button", onclick: () => dlg.close("cancel") }, "Abbrechen")));
    dlg.addEventListener("close", () => { const v = dlg.returnValue === "ok" ? pw1.value : null; dlg.remove(); resolve(v); });
    document.body.append(dlg); dlg.showModal(); pw1.focus();
  });
}

async function viewMembers() {
  const d = await api("/api/admin/users");
  const pending = d.users.filter((u) => !u.approved);
  S.pending = pending.length; renderTop();
  const users = [...pending, ...d.users.filter((u) => u.approved)];
  const rows = users.map((u) => {
    const apBtn = u.id === S.me.id ? null : h("button", { class: u.approved ? "btn secondary small" : "btn small", type: "button", text: u.approved ? "Sperren" : "Freischalten" });
    if (apBtn) apBtn.addEventListener("click", async () => {
      if (u.approved && !confirm(`${u.first_name} ${u.last_name} sperren? Das Mitglied kann sich dann zwar anmelden, aber keine Fänge mehr sehen oder eintragen.`)) return;
      try { await api(`/api/admin/users/${u.id}/approve`, "POST", { approved: !u.approved }); toast(u.approved ? "Mitglied gesperrt." : "Mitglied freigeschaltet."); route(true); } catch (e) { toast(e.message); }
    });
    const btn = h("button", { class: "btn secondary small", type: "button", disabled: u.id === S.me.id }, u.is_admin ? "Admin entziehen" : "Zum Admin machen");
    btn.addEventListener("click", async () => {
      try { await api(`/api/admin/users/${u.id}/admin`, "POST", { is_admin: !u.is_admin }); toast("Gespeichert."); route(true); } catch (e) { toast(e.message); }
    });
    const verifyBtn = u.verified ? null : h("button", { class: "btn secondary small", type: "button", text: "E-Mail bestätigen" });
    if (verifyBtn) verifyBtn.addEventListener("click", async () => {
      try { await api(`/api/admin/users/${u.id}/verify`, "POST", {}); toast("E-Mail als bestätigt markiert."); route(true); } catch (e) { toast(e.message); }
    });
    const pwBtn = h("button", { class: "btn secondary small", type: "button", text: "Passwort setzen" });
    pwBtn.addEventListener("click", async () => {
      const pw = await passwordDialog(`${u.first_name} ${u.last_name}`);
      if (!pw) return;
      try { await api(`/api/admin/users/${u.id}/set-password`, "POST", { password: pw, password2: pw }); toast("Neues Passwort gesetzt – bitte sicher an das Mitglied weitergeben."); route(true); } catch (e) { toast(e.message); }
    });
    return h("tr", {}, h("td", { text: `${u.first_name} ${u.last_name}` }), h("td", { text: u.email }), h("td", { text: u.group_id }),
      h("td", {}, u.is_admin ? h("strong", { text: "Admin" }) : "Mitglied", u.approved ? null : h("span", { class: "badge", text: "wartet auf Freischaltung" }),
        u.verified ? null : h("span", { class: "badge", text: "E-Mail unbestätigt" })),
      h("td", { class: "member-actions" }, apBtn, btn, verifyBtn, pwBtn));
  });
  const info = pending.length
    ? h("p", { class: "warn-t", text: `${pending.length} ${pending.length === 1 ? "Neuanmeldung wartet" : "Neuanmeldungen warten"} auf Freischaltung. Bitte Name und Sportgruppen-ID prüfen und dann „Freischalten“ klicken.` })
    : h("p", { class: "hint", text: "Keine offenen Neuanmeldungen." });
  return [h("h1", { text: "Mitglieder" }), info, h("div", { class: "card tablewrap" }, h("table", {},
    h("thead", {}, h("tr", {}, ["Name", "E-Mail", "Sportgruppen-ID", "Rolle", "Aktionen"].map((t) => h("th", { text: t })))), h("tbody", {}, rows)))];
}

/* ---------- Blanko-Fangliste zum Auslegen (analoge Nachträge) ---------- */
function viewBlank() {
  const st = viewBlank.st || (viewBlank.st = { month: +S.today.slice(5, 7), year: +S.today.slice(0, 4), sheets: 1 });
  const box = h("div");
  const years = [st.year - 1, st.year, st.year + 1];
  function render() {
    const mSel = h("select", { id: "b-month", "aria-label": "Monat", onchange: () => { st.month = +mSel.value; render(); } },
      h("option", { value: 0, selected: st.month === 0, text: "– leer (handschriftlich) –" }), MONTHS.map((m, i) => h("option", { value: i + 1, selected: st.month === i + 1, text: m })));
    const ySel = h("select", { id: "b-year", "aria-label": "Jahr", onchange: () => { st.year = +ySel.value; render(); } },
      years.map((y) => h("option", { value: y, selected: y === st.year, text: y })));
    const nSel = h("select", { id: "b-sheets", "aria-label": "Anzahl Blätter", onchange: () => { st.sheets = +nSel.value; render(); } },
      [1, 2, 3, 4, 5].map((n) => h("option", { value: n, selected: n === st.sheets, text: n + (n === 1 ? " Blatt" : " Blätter") })));
    const bar = h("div", { class: "toolbar no-print" }, mSel, ySel, nSel, h("span", { class: "grow" }), printBtn());
    const limits = S.species.filter((s) => !s.other && s.min !== null).sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map((s) => `${s.name} ${fmtLen(s.min)}`).join(" · ");
    const cols = ["Nr.", "Datum", "Name des Anglers (Vor- und Nachname)", "Fischart", "Länge (cm)", "Verbleib", "Zustand", "Bemerkung"];
    const sheets = Array.from({ length: st.sheets }, (_, n) => h("section", { class: "blank-sheet" },
      h("div", { class: "sheet-head" },
        h("h2", { text: `${S.lake} – Fangliste` }),
        h("p", { class: "sheet-period" }, "Monat: ", h("strong", { text: st.month ? MONTHS[st.month - 1] : "______________" }), "   Jahr: ", h("strong", { text: st.month ? String(st.year) : "________" }),
          st.sheets > 1 ? `   ·   Blatt ${n + 1} von ${st.sheets}` : "")),
      h("p", { class: "sheet-note", text: "Bitte jeden Fang sofort eintragen. Wird ein nicht maßiger Fisch entnommen: Krankheit oder Verletzung ankreuzen und eine Bemerkung eintragen. Eingetragene Fänge können später nicht mehr geändert werden." }),
      h("table", { class: "blank" },
        h("thead", {}, h("tr", {}, cols.map((c, i) => h("th", { class: "c" + i, text: c })))),
        h("tbody", {}, Array.from({ length: 18 }, (_, i) => h("tr", {}, h("td", { class: "c0", text: n * 18 + i + 1 }), h("td"), h("td"), h("td"), h("td"), 
          h("td", { class: "chk" }, "☐ entnommen", h("br"), "☐ zurückgesetzt"), h("td", { class: "chk" }, "☐ Krankheit", h("br"), "☐ Verletzung"), h("td"))))),
      h("p", { class: "sheet-limits", text: "Mindestmaße (cm): " + limits })));
    box.replaceChildren(bar, ...sheets);
  }
  render();
  return [h("h1", { class: "no-print", text: "Blanko-Fangliste" }),
    h("p", { class: "hint no-print", text: "Zum Auslegen am Gewässer: ausdrucken (A4 hoch), Fänge per Hand eintragen und später unter „Fang nachtragen“ erfassen. Auf Wunsch mit vorausgefülltem Monat/Jahr." }), box];
}

function viewLimits() {
  const all = S.species.filter((s) => !s.other).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const rows = all.map((s) => {
    const mn = h("input", { type: "text", inputMode: "decimal", value: s.min === null ? "" : fmtLen(s.min), "aria-label": "Mindestmaß " + s.name, placeholder: "–" });
    const mx = h("input", { type: "text", inputMode: "decimal", value: s.max === null ? "" : fmtLen(s.max), "aria-label": "Höchstmaß " + s.name, placeholder: "–" });
    const btn = h("button", { class: "btn small", type: "button" }, "Speichern");
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/admin/species/${s.id}`, "POST", { min: mn.value.trim().replace(",", "."), max: mx.value.trim().replace(",", ".") });
        S.species = (await api("/api/species")).species;
        toast(`${s.name}: gespeichert (gilt für neue Fänge).`);
      } catch (e) { toast(e.message); }
    });
    return h("tr", {}, h("td", {}, h("img", { src: s.image, alt: "", class: "thumb" }), " ", s.name), h("td", {}, mn), h("td", {}, mx), h("td", {}, btn));
  });
  return [h("h1", { text: "Schonmaße" }),
    h("p", { class: "hint", text: "Leer lassen = kein Maß. Die hinterlegten Werte sind Beispielwerte – bitte mit der Gewässerordnung abgleichen. Änderungen gelten nur für neue Fänge; bereits festgeschriebene Fänge behalten das damals gültige Maß." }),
    h("div", { class: "card tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Fischart" }), h("th", { text: "Mindestmaß (cm)" }), h("th", { text: "Höchstmaß (cm)" }), h("th"))), h("tbody", {}, rows)))];
}

function viewAuth(mode) {
  const err = h("p", { class: "error", role: "alert" });
  const f = (id, label, type, extra) => [h("label", { for: id, text: label }), h("input", { id, type, required: true, ...extra })];
  let form;
  if (mode === "register") {
    form = h("form", { class: "card narrow", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      const g = (id) => form.querySelector("#" + id).value;
      if (g("r-pw") !== g("r-pw2")) return (err.textContent = "Die beiden Passwörter stimmen nicht überein.");
      try {
        const mail = g("r-email");
        await api("/api/register", "POST", { email: mail, password: g("r-pw"), password2: g("r-pw2"), first_name: g("r-fn"), last_name: g("r-ln"), group_id: g("r-gid") });
        document.getElementById("app").replaceChildren(viewMailSent(mail));
      } catch (ex) { err.textContent = ex.message; }
    } },
      h("h1", { text: "Profil erstellen" }),
      ...f("r-fn", "Vorname", "text", { autocomplete: "given-name", maxLength: 60 }),
      ...f("r-ln", "Nachname", "text", { autocomplete: "family-name", maxLength: 60 }),
      ...f("r-gid", "Sportgruppen-ID", "text", { maxLength: 32, autocomplete: "off" }),
      ...f("r-email", "E-Mail-Adresse", "email", { autocomplete: "email", maxLength: 254 }),
      ...f("r-pw", "Passwort (mind. 8 Zeichen)", "password", { autocomplete: "new-password", minLength: 8, maxLength: 200 }),
      ...f("r-pw2", "Passwort wiederholen", "password", { autocomplete: "new-password", minLength: 8, maxLength: 200 }),
      err, h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Profil erstellen" }),
        h("a", { class: "btn secondary", href: "#/login", text: "Ich habe schon ein Profil" })));
  } else {
    form = h("form", { class: "card narrow", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      try {
        await api("/api/login", "POST", { email: form.querySelector("#l-email").value, password: form.querySelector("#l-pw").value });
        await boot(); location.hash = "#/neu";
      } catch (ex) {
        err.textContent = ex.message;
        if (ex.status === 403) {
          const mail = form.querySelector("#l-email").value;
          err.after(h("button", { class: "btn secondary small", type: "button", onclick: async (e) => {
            try { await api("/api/resend-verification", "POST", { email: mail }); e.target.remove(); toast("Falls die Adresse registriert ist, wurde eine neue Bestätigungsmail gesendet."); } catch (x) { toast(x.message); }
          } }, "Bestätigungsmail erneut senden"));
        }
      }
    } },
      h("h1", { text: "Anmelden" }),
      h("p", { class: "hint", text: `Fangstatistik ${S.lake}. Zum Eintragen und Einsehen der Fänge ist ein Profil nötig.` }),
      ...f("l-email", "E-Mail-Adresse", "email", { autocomplete: "username" }),
      ...f("l-pw", "Passwort", "password", { autocomplete: "current-password" }),
      err, h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Anmelden" }),
        h("a", { class: "btn secondary", href: "#/registrieren", text: "Neues Profil erstellen" })),
      h("p", {}, h("a", { href: "#/passwort-vergessen", text: "Passwort vergessen?" })));
  }
  return [form];
}

function viewMailSent(mail) {
  return h("div", { class: "card narrow" }, h("h1", { text: "Fast geschafft" }),
    h("p", {}, "Wir haben eine E-Mail an ", h("strong", { text: mail }), " gesendet. Bitte öffne den Link darin, um deine E-Mail-Adresse zu bestätigen. Danach muss ein Admin dein Profil noch freischalten, bevor du Fänge eintragen kannst."),
    h("p", { class: "hint", text: "Nichts angekommen? Bitte auch den Spam-Ordner prüfen. Auf der Anmeldeseite kannst du die Mail erneut anfordern." }),
    h("div", { class: "actions" }, h("a", { class: "btn", href: "#/login", text: "Zur Anmeldung" })));
}

function viewForgot() {
  const err = h("p", { class: "error", role: "alert" });
  const form = h("form", { class: "card narrow", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    try {
      await api("/api/forgot", "POST", { email: form.querySelector("#fg-email").value });
      form.replaceChildren(h("h1", { text: "E-Mail unterwegs" }),
        h("p", { text: "Falls zu dieser Adresse ein Profil existiert, haben wir einen Link zum Zurücksetzen des Passworts gesendet (gültig 1 Stunde)." }),
        h("div", { class: "actions" }, h("a", { class: "btn", href: "#/login", text: "Zur Anmeldung" })));
    } catch (ex) { err.textContent = ex.message; }
  } }, h("h1", { text: "Passwort vergessen" }),
    h("p", { class: "hint", text: "Gib die E-Mail-Adresse deines Profils ein. Wir senden dir einen Link zum Festlegen eines neuen Passworts." }),
    h("label", { for: "fg-email", text: "E-Mail-Adresse" }), h("input", { id: "fg-email", type: "email", required: true, autocomplete: "email", maxLength: 254 }),
    err, h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Link anfordern" }), h("a", { class: "btn secondary", href: "#/login", text: "Abbrechen" })));
  return [form];
}

function viewReset(token) {
  const err = h("p", { class: "error", role: "alert" });
  const form = h("form", { class: "card narrow", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    const a = form.querySelector("#rs-pw").value, b = form.querySelector("#rs-pw2").value;
    if (a !== b) return (err.textContent = "Die beiden Passwörter stimmen nicht überein.");
    try {
      await api("/api/reset", "POST", { token, password: a, password2: b });
      form.replaceChildren(h("h1", { text: "Passwort geändert" }), h("p", { text: "Du kannst dich jetzt mit dem neuen Passwort anmelden." }),
        h("div", { class: "actions" }, h("a", { class: "btn", href: "#/login", text: "Zur Anmeldung" })));
    } catch (ex) { err.textContent = ex.message; err.after(h("p", {}, h("a", { href: "#/passwort-vergessen", text: "Neuen Link anfordern" }))); }
  } }, h("h1", { text: "Neues Passwort festlegen" }),
    h("label", { for: "rs-pw", text: "Neues Passwort (mind. 8 Zeichen)" }), h("input", { id: "rs-pw", type: "password", required: true, minLength: 8, maxLength: 200, autocomplete: "new-password" }),
    h("label", { for: "rs-pw2", text: "Passwort wiederholen" }), h("input", { id: "rs-pw2", type: "password", required: true, minLength: 8, maxLength: 200, autocomplete: "new-password" }),
    err, h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Passwort speichern" })));
  return [form];
}

async function viewVerify(token) {
  const card = h("div", { class: "card narrow" }, h("h1", { text: "E-Mail-Adresse bestätigen" }), h("p", { text: "Einen Moment …" }));
  api("/api/verify", "POST", { token }).then(() => {
    card.replaceChildren(h("h1", { text: "E-Mail bestätigt ✔" }), h("p", { text: "Deine E-Mail-Adresse ist bestätigt. Jetzt muss noch ein Admin dein Profil freischalten. Du kannst dich bereits anmelden und dort den Status sehen." }),
      h("div", { class: "actions" }, h("a", { class: "btn", href: "#/login", text: "Zur Anmeldung" })));
  }).catch((ex) => {
    card.replaceChildren(h("h1", { text: "Bestätigung fehlgeschlagen" }), h("p", { class: "error", text: ex.message }),
      h("div", { class: "actions" }, h("a", { class: "btn", href: "#/login", text: "Zur Anmeldung" })));
  });
  return [card];
}

function viewPending() {
  const card = h("div", { class: "card narrow" }, h("h1", { text: "Freischaltung ausstehend" }),
    h("p", {}, "Hallo ", h("strong", { text: S.me.first_name }), ", dein Profil ist angelegt und die E-Mail-Adresse bestätigt. ",
      "Ein Admin muss es noch freischalten. Danach kannst du Fänge eintragen und die Fangliste sehen."),
    h("p", { class: "hint", text: "Das kann etwas dauern. Bei Fragen wende dich bitte an die Verantwortlichen am Teich." }),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: async () => {
      await boot();
      if (S.me && S.me.approved) { toast("✔ Dein Profil ist freigeschaltet."); location.hash = "#/neu"; }
      else toast("Noch nicht freigeschaltet.");
      route(true);
    } }, "Status erneut prüfen")));
  return [card];
}

/* ---------- Rahmen & Routing ---------- */
function renderTop() {
  const top = document.getElementById("top");
  const hash = location.hash || "#/";
  const link = (href, text) => h("a", { href, class: hash.startsWith(href) ? "active" : "", text });
  const brand = h("a", { class: "brand", href: "#/" }, h("img", { src: "logo.svg", alt: "" }), S.lake);
  if (!S.me) return top.replaceChildren(brand);
  const nav = !S.me.approved ? null : h("nav", { "aria-label": "Hauptmenü" }, link("#/neu", "Fang eintragen"), link("#/liste", "Fangliste"),
    S.me.is_admin ? link("#/admin", S.pending ? `Admin (${S.pending} neu)` : "Admin") : null);
  top.replaceChildren(brand, nav, h("div", { class: "who" }, h("span", { text: S.me.first_name + " " + S.me.last_name + (S.me.is_admin ? " (Admin)" : "") }),
    h("button", { class: "btn secondary small", type: "button", onclick: async () => { await api("/api/logout", "POST"); S.me = null; S.csrf = null; location.hash = "#/login"; route(true); } }, "Abmelden")));
}

function adminTabs(active) {
  const t = [["#/admin/auswertung", "Auswertung"], ["#/admin/nachtragen", "Fang nachtragen"], ["#/admin/mitglieder", "Mitglieder"], ["#/admin/blanko", "Blanko-Fangliste"], ["#/admin/masse", "Schonmaße"]];
  return h("div", { class: "tabs no-print" }, t.map(([href, txt]) => h("a", { href, class: href === active ? "active" : "", text: txt })));
}

async function route() {
  const app = document.getElementById("app");
  const hash = location.hash || "#/";
  renderTop();
  try {
    let content;
    const tokenRoute = hash.match(/^#\/(bestaetigen|passwort-zuruecksetzen)\/([\w-]{20,200})$/);
    if (tokenRoute) content = tokenRoute[1] === "bestaetigen" ? await viewVerify(tokenRoute[2]) : viewReset(tokenRoute[2]);
    else if (hash === "#/passwort-vergessen") content = viewForgot();
    else if (!S.me) {
      content = viewAuth(hash === "#/registrieren" ? "register" : "login");
    } else if (!S.me.approved) content = viewPending();
    else if (hash === "#/liste") content = await viewList();
    else if (hash.startsWith("#/admin")) {
      if (!S.me.is_admin) content = [h("p", { class: "error", text: "Nur für Administratoren." })];
      else {
        const sub = hash === "#/admin" ? "#/admin/auswertung" : hash;
        let v;
        if (sub === "#/admin/nachtragen") v = [h("h1", { text: "Fang nachtragen" }), h("p", { class: "hint", text: "Zum Ergänzen der analogen Fangliste. Auch nachgetragene Fänge sind nach dem Speichern festgeschrieben." }), catchForm({ admin: true })];
        else if (sub === "#/admin/mitglieder") v = await viewMembers();
        else if (sub === "#/admin/blanko") v = viewBlank();
        else if (sub === "#/admin/masse") v = viewLimits();
        else v = await viewSummary();
        content = [adminTabs(sub), ...v];
      }
    } else content = viewNew();
    app.replaceChildren(...content);
    document.title = "Fangstatistik – " + S.lake;
  } catch (e) {
    if (e.status === 401) { S.me = null; renderTop(); app.replaceChildren(...viewAuth("login")); }
    else app.replaceChildren(h("p", { class: "error", text: e.message }));
  }
}

async function boot() {
  const me = await api("/api/me");
  S.lake = me.lake; S.me = me.user; S.csrf = me.csrf || null; S.today = me.today || new Date().toISOString().slice(0, 10);
  S.pending = 0;
  if (S.me && S.me.approved) S.species = (await api("/api/species")).species;
  if (S.me && S.me.approved && S.me.is_admin) {
    try { S.pending = (await api("/api/admin/users")).users.filter((u) => !u.approved).length; } catch (_) { /* nicht kritisch */ }
  }
}

window.addEventListener("hashchange", () => route());
boot().then(() => {
  if (!location.hash || location.hash === "#/") location.hash = S.me ? "#/neu" : "#/login";
  else route();
}).catch((e) => { document.getElementById("app").textContent = "Fehler beim Laden: " + e.message; });
