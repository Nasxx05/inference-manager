/*
 * AgentFund — small DOM helpers.
 * All text is set with textContent, so no HTML escaping is needed anywhere.
 */

export function $(id) {
  return document.getElementById(id);
}

export function show(el, visible) {
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}

export function setNotice(el, message) {
  if (!el) return;
  if (!message) {
    show(el, false);
    el.textContent = "";
    return;
  }
  el.textContent = message;
  show(el, true);
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Builds <dt>/<dd> pairs. value may be a string or a Node. */
export function fillKv(container, pairs) {
  if (!container) return;
  container.innerHTML = "";
  pairs.forEach(function (pair) {
    const dt = el("dt", null, pair[0]);
    const dd = document.createElement("dd");
    const value = pair[1];
    if (value && typeof value === "object" && value.nodeType) dd.appendChild(value);
    else dd.textContent = value === undefined || value === null ? "" : String(value);
    container.appendChild(dt);
    container.appendChild(dd);
  });
}

export function fillList(container, items) {
  if (!container) return;
  container.innerHTML = "";
  (items || []).forEach(function (text) {
    container.appendChild(el("li", null, text));
  });
}

export function fillPhaseRows(container, phases, formatter) {
  if (!container) return;
  container.innerHTML = "";
  (phases || []).forEach(function (p) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", null, p.phase || "Phase"));
    tr.appendChild(el("td", null, formatter(p.low, p.high)));
    container.appendChild(tr);
  });
}

export function numSpan(value, className) {
  return el("span", className || "num", value);
}

/** "10 credits" with the number in the monospace gold style. */
export function creditsLine(container, value, suffix) {
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(numSpan(value));
  container.appendChild(document.createTextNode(" " + (suffix || "credits")));
  return container;
}

export function round(n) {
  return Math.max(1, Math.round(Number(n) || 0));
}

export function range(low, high) {
  return round(low) + "–" + round(high);
}