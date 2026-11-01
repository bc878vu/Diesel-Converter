/* Diesel Converter — application logic.
   Hand-written expression engine only; no dynamic code execution
   and no dialog APIs anywhere in this file. */
(function () {
  "use strict";

  /* ---------- small helpers ---------- */
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function toNum(v) {
    if (v === "" || v === null || v === undefined) return NaN;
    var n = parseFloat(v);
    return isFinite(n) ? n : NaN;
  }
  function fmt2(n) { return Number(n).toFixed(2); }
  function fmtDensity(d) {
    var s = Number(d).toFixed(4);
    return String(parseFloat(s));
  }
  function fmtResult(x) {
    if (x === 0) return "0";
    return String(parseFloat(Number(x).toPrecision(12)));
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- density resolution (Step 1) ---------- */
  // Returns { mode, density, totalKg, warning }.
  // mode: 'sample' | 'bulk' | 'warning' | 'none'
  function resolveDensity(prevDensity, litres, kg) {
    if (!isNum(litres) || !isNum(kg) || litres <= 0 || kg <= 0) {
      return { mode: "none", density: prevDensity, totalKg: null, warning: false };
    }
    // Bulk pattern: many litres + a per-litre-looking weight.
    if (litres > 10 && kg >= 0.70 && kg <= 1.00) {
      return { mode: "bulk", density: kg, totalKg: litres * kg, warning: false };
    }
    var d = kg / litres;
    if (d >= 0.70 && d <= 1.00) {
      return { mode: "sample", density: d, totalKg: null, warning: false };
    }
    // Out of range and not bulk: warn, keep the previous good density.
    return { mode: "warning", density: prevDensity, totalKg: null, warning: true };
  }
  function litresToKg(litres, density) { return litres * density; }
  function kgToLitres(kg, density) { return kg / density; }

  /* ---------- calculator engine: tokenizer + recursive-descent parser ---------- */
  function CalcError(message) { this.message = message; }
  CalcError.prototype = Object.create(Error.prototype);

  function tokenize(src) {
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (ch === " " || ch === "\t") { i += 1; continue; }
      if ((ch >= "0" && ch <= "9") || ch === ".") {
        var j = i;
        var dots = 0;
        while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) {
          if (src[j] === ".") dots += 1;
          j += 1;
        }
        if (dots > 1) throw new CalcError("Bad number");
        tokens.push({ type: "num", value: parseFloat(src.slice(i, j)) });
        i = j;
        continue;
      }
      if (ch >= "a" && ch <= "z") {
        var k = i;
        while (k < src.length && src[k] >= "a" && src[k] <= "z") k += 1;
        tokens.push({ type: "ident", value: src.slice(i, k) });
        i = k;
        continue;
      }
      if (ch === "π") { tokens.push({ type: "ident", value: "pi" }); i += 1; continue; }
      if (ch === "√") { tokens.push({ type: "ident", value: "sqrt" }); i += 1; continue; }
      if (ch === "+" || ch === "-" || ch === "*" || ch === "×" ||
          ch === "/" || ch === "÷" || ch === "^" || ch === "%" ||
          ch === "!" || ch === "(" || ch === ")" || ch === "²") {
        var op = ch;
        if (op === "×") op = "*";
        if (op === "÷") op = "/";
        tokens.push({ type: "op", value: op });
        i += 1;
        continue;
      }
      throw new CalcError("Bad character: " + ch);
    }
    tokens.push({ type: "end", value: null });
    return tokens;
  }

  function makeParser(tokens, angleMode) {
    var pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function isOp(v) { var t = peek(); return t.type === "op" && t.value === v; }
    function eatOp(v) { if (isOp(v)) { pos += 1; return true; } return false; }

    function parseExpression() {
      var v = parseTerm();
      while (true) {
        if (eatOp("+")) { v = v + parseTerm(); continue; }
        if (eatOp("-")) { v = v - parseTerm(); continue; }
        break;
      }
      return v;
    }
    function parseTerm() {
      var v = parseUnary();
      while (true) {
        if (eatOp("*")) { v = v * parseUnary(); continue; }
        if (eatOp("/")) {
          var div = parseUnary();
          if (div === 0) throw new CalcError("Division by zero");
          v = v / div;
          continue;
        }
        // Implicit multiplication: number, function, constant or '(' follows.
        var t = peek();
        if (t.type === "num" || t.type === "ident" ||
            (t.type === "op" && t.value === "(")) {
          v = v * parseUnary();
          continue;
        }
        break;
      }
      return v;
    }
    function parseUnary() {
      if (eatOp("-")) return -parseUnary();
      if (eatOp("+")) return parseUnary();
      return parsePower();
    }
    function parsePower() {
      var base = parsePostfix();
      if (eatOp("^")) {
        var exp = parseUnary(); // right-associative
        var r = Math.pow(base, exp);
        if (!isFinite(r)) throw new CalcError("Result out of range");
        return r;
      }
      return base;
    }
    function parsePostfix() {
      var v = parsePrimary();
      while (true) {
        if (eatOp("!")) {
          if (v < 0 || Math.floor(v) !== v || v > 170) {
            throw new CalcError("Factorial needs a whole number 0-170");
          }
          var f = 1;
          for (var i = 2; i <= v; i += 1) f *= i;
          v = f;
          continue;
        }
        if (eatOp("%")) { v = v / 100; continue; }
        if (eatOp("²")) { v = v * v; continue; }
        break;
      }
      return v;
    }
    function trig(name, x) {
      var rad = angleMode === "DEG" ? x * Math.PI / 180 : x;
      if (name === "sin") return Math.sin(rad);
      if (name === "cos") return Math.cos(rad);
      return Math.tan(rad);
    }
    function invTrig(name, x) {
      if (x < -1 || x > 1) throw new CalcError("Out of range for inverse trig");
      var rad = name === "asin" ? Math.asin(x)
        : name === "acos" ? Math.acos(x) : Math.atan(x);
      return angleMode === "DEG" ? rad * 180 / Math.PI : rad;
    }
    function parsePrimary() {
      var t = next();
      if (t.type === "num") return t.value;
      if (t.type === "op" && t.value === "(") {
        var v = parseExpression();
        if (!eatOp(")")) throw new CalcError("Unclosed bracket");
        return v;
      }
      if (t.type === "ident") {
        if (t.value === "pi") return Math.PI;
        if (t.value === "e") return Math.E;
        var fns = ["sin", "cos", "tan", "asin", "acos", "atan", "ln", "log", "sqrt"];
        if (fns.indexOf(t.value) !== -1) {
          if (!eatOp("(")) throw new CalcError("Function needs brackets");
          var arg = parseExpression();
          if (!eatOp(")")) throw new CalcError("Unclosed bracket");
          if (t.value === "sin" || t.value === "cos" || t.value === "tan") {
            return trig(t.value, arg);
          }
          if (t.value === "asin" || t.value === "acos" || t.value === "atan") {
            return invTrig(t.value, arg);
          }
          if (t.value === "ln") {
            if (arg <= 0) throw new CalcError("ln needs a positive number");
            return Math.log(arg);
          }
          if (t.value === "log") {
            if (arg <= 0) throw new CalcError("log needs a positive number");
            return Math.log10(arg);
          }
          if (arg < 0) throw new CalcError("Square root of a negative number");
          return Math.sqrt(arg);
        }
      }
      throw new CalcError("Unexpected input");
    }
    return {
      parse: function () {
        if (peek().type === "end") throw new CalcError("Empty expression");
        var v = parseExpression();
        if (peek().type !== "end") throw new CalcError("Unexpected input");
        if (!isFinite(v)) throw new CalcError("Result out of range");
        return v;
      }
    };
  }

  function evaluateExpression(src, angleMode) {
    var tokens = tokenize(src);
    var parser = makeParser(tokens, angleMode === "RAD" ? "RAD" : "DEG");
    return parser.parse();
  }

  /* ---------- records helpers (pure) ---------- */
  function localISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1);
    if (m.length < 2) m = "0" + m;
    var day = String(d.getDate());
    if (day.length < 2) day = "0" + day;
    return y + "-" + m + "-" + day;
  }
  function weekBounds(now) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var shift = (d.getDay() + 6) % 7; // Monday = 0
    var start = new Date(d);
    start.setDate(d.getDate() - shift);
    var end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { from: localISODate(start), to: localISODate(end) };
  }
  function parseISODate(s) {
    var parts = String(s || "").split("-");
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  function addDaysISO(s, days) {
    var d = parseISODate(s);
    d.setDate(d.getDate() + days);
    return localISODate(d);
  }
  function weekStartISO(s) {
    var d = parseISODate(s);
    var shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return localISODate(d);
  }
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function monthLabel(yyyymm) {
    var parts = String(yyyymm || "").split("-");
    var m = parseInt(parts[1], 10);
    if (!m || m < 1 || m > 12) return yyyymm;
    return MONTH_NAMES[m - 1] + " " + parts[0];
  }
  function weekLabel(startISO) {
    var endISO = addDaysISO(startISO, 6);
    var a = parseISODate(startISO);
    var b = parseISODate(endISO);
    return a.getDate() + " " + MONTH_SHORT[a.getMonth()] + " – " +
      b.getDate() + " " + MONTH_SHORT[b.getMonth()] + " " + b.getFullYear();
  }
  function filterRecords(records, mode, customFrom, customTo, now, selected) {
    var from = null;
    var to = null;
    if (mode === "weekly") {
      if (selected && selected.week) {
        from = selected.week; to = addDaysISO(selected.week, 6);
      } else {
        var w = weekBounds(now || new Date());
        from = w.from; to = w.to;
      }
    } else if (mode === "monthly") {
      var prefix = (selected && selected.month) ||
        localISODate(now || new Date()).slice(0, 7);
      return records.filter(function (r) {
        return (r.record_date || "").slice(0, 7) === prefix;
      });
    } else if (mode === "yearly") {
      var year = (selected && selected.year) ||
        String((now || new Date()).getFullYear());
      return records.filter(function (r) {
        return (r.record_date || "").slice(0, 4) === year;
      });
    } else if (mode === "custom") {
      from = customFrom || null;
      to = customTo || null;
    }
    if (mode === "all" || (!from && !to)) return records.slice();
    return records.filter(function (r) {
      var d = r.record_date || "";
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }
  function searchRecords(records, q) {
    if (!q) return records.slice();
    var needle = String(q).toLowerCase();
    return records.filter(function (r) {
      var hay = [r.company_name, r.record_date, r.vehicle_number,
        r.receiver_name, r.driver_name]
        .map(function (v) { return String(v || "").toLowerCase(); })
        .join(" ");
      return hay.indexOf(needle) !== -1;
    });
  }
  function sumTotals(records) {
    var litres = 0;
    var kg = 0;
    records.forEach(function (r) {
      litres += parseFloat(r.diesel_litres) || 0;
      kg += parseFloat(r.diesel_kg) || 0;
    });
    return { litres: litres, kg: kg, count: records.length };
  }
  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  function buildCSV(rows) {
    var lines = ["Date,Time,Vehicle,Driver,Company,Receiver,Litres,KG,Saved By"];
    rows.forEach(function (r) {
      lines.push([
        r.record_date, r.record_time, r.vehicle_number, r.driver_name,
        r.company_name, r.receiver_name, r.diesel_litres, r.diesel_kg,
        r.saved_by_name
      ].map(csvCell).join(","));
    });
    return "\ufeff" + lines.join("\n") + "\n";
  }

  /* ---------- node test exports ---------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      resolveDensity: resolveDensity,
      litresToKg: litresToKg,
      kgToLitres: kgToLitres,
      tokenize: tokenize,
      evaluateExpression: evaluateExpression,
      fmt2: fmt2,
      fmtDensity: fmtDensity,
      fmtResult: fmtResult,
      filterRecords: filterRecords,
      searchRecords: searchRecords,
      sumTotals: sumTotals,
      buildCSV: buildCSV,
      localISODate: localISODate,
      weekBounds: weekBounds,
      weekStartISO: weekStartISO,
      monthLabel: monthLabel,
      weekLabel: weekLabel
    };
  }
  if (typeof document === "undefined") return;

  /* ================= DOM application ================= */
  var $ = function (id) { return document.getElementById(id); };

  /* ----- converter state ----- */
  var density = 0.832;
  var firstMode = "L2K"; // or 'K2L'
  var firstInputVal = 10;
  var secondInputVal = 5;
  var lastFirstResult = 8.32;

  var sampleLitresEl = $("sampleLitres");
  var sampleKgEl = $("sampleKg");
  var directEl = $("directDensity");
  var warningEl = $("densityWarning");
  var bulkBoxEl = $("bulkBox");
  var bulkKgEl = $("bulkKg");
  var bulkFormulaEl = $("bulkFormula");
  var presetChipsEl = $("presetChips");

  function renderConverters() {
    var d3 = density.toFixed(3);
    // Converter 1 (flippable)
    var firstInputEl = $("firstInput");
    var v1 = toNum(firstInputEl.value);
    if (firstMode === "L2K") {
      var kg = isNum(v1) ? litresToKg(v1, density) : NaN;
      lastFirstResult = kg;
      $("firstTitle").textContent = "Liters se KG";
      $("firstSub").textContent = "Liters daakhil karo";
      $("firstUnit").textContent = "L";
      $("firstResult").textContent = isNum(kg) ? fmt2(kg) : "0.00";
      $("firstResultUnit").textContent = "KG";
      $("firstFormula").textContent = isNum(v1)
        ? (fmtDensity(v1) + " L × " + d3 + " = " + fmt2(kg) + " kg") : "";
    } else {
      var litres = isNum(v1) ? kgToLitres(v1, density) : NaN;
      lastFirstResult = litres;
      $("firstTitle").textContent = "KG se Liters";
      $("firstSub").textContent = "Kilograms daakhil karo";
      $("firstUnit").textContent = "kg";
      $("firstResult").textContent = isNum(litres) ? fmt2(litres) : "0.00";
      $("firstResultUnit").textContent = "Liters";
      $("firstFormula").textContent = isNum(v1)
        ? (fmtDensity(v1) + " kg ÷ " + d3 + " = " + fmt2(litres) + " L") : "";
    }
    // Converter 2 (fixed KG -> Liters)
    var v2 = toNum($("secondInput").value);
    var l2 = isNum(v2) ? kgToLitres(v2, density) : NaN;
    $("secondResult").textContent = isNum(l2) ? fmt2(l2) : "0.00";
    $("secondFormula").textContent = isNum(v2)
      ? (fmtDensity(v2) + " kg ÷ " + d3 + " = " + fmt2(l2) + " L") : "";
  }

  function syncDensityDisplays() {
    if (document.activeElement !== directEl) {
      directEl.value = fmtDensity(density);
    }
    var chips = presetChipsEl.querySelectorAll(".chip");
    chips.forEach(function (c) {
      var pv = parseFloat(c.getAttribute("data-density"));
      if (Math.abs(pv - density) < 0.0005) c.classList.add("chip-active");
      else c.classList.remove("chip-active");
    });
  }

  function applySample() {
    var litres = toNum(sampleLitresEl.value);
    var kg = toNum(sampleKgEl.value);
    var res = resolveDensity(density, litres, kg);
    if (res.mode === "warning") {
      warningEl.hidden = false;
      bulkBoxEl.hidden = true;
    } else {
      warningEl.hidden = true;
      density = res.density;
      if (res.mode === "bulk") {
        bulkBoxEl.hidden = false;
        bulkKgEl.textContent = fmt2(res.totalKg);
        bulkFormulaEl.textContent = fmtDensity(litres) + " L × " +
          density.toFixed(3) + " = " + fmt2(res.totalKg) + " kg";
      } else {
        bulkBoxEl.hidden = true;
      }
    }
    syncDensityDisplays();
    renderConverters();
  }

  function applyDirect(value) {
    var d = toNum(value);
    if (!isNum(d) || d <= 0) return;
    density = d;
    sampleLitresEl.value = "1";
    sampleKgEl.value = fmtDensity(d);
    warningEl.hidden = true;
    bulkBoxEl.hidden = true;
    syncDensityDisplays();
    renderConverters();
  }

  sampleLitresEl.addEventListener("input", applySample);
  sampleKgEl.addEventListener("input", applySample);
  directEl.addEventListener("input", function () { applyDirect(directEl.value); });
  presetChipsEl.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".chip");
    if (!btn) return;
    applyDirect(btn.getAttribute("data-density"));
  });
  $("firstInput").addEventListener("input", renderConverters);
  $("secondInput").addEventListener("input", renderConverters);

  $("swapFirst").addEventListener("click", function () {
    // Carry the currently displayed result over as the new input.
    var carried = isNum(lastFirstResult) ? Number(lastFirstResult).toFixed(2) : "";
    firstMode = firstMode === "L2K" ? "K2L" : "L2K";
    $("swapFirst").setAttribute("aria-pressed", firstMode === "K2L" ? "true" : "false");
    $("firstInput").value = carried;
    renderConverters();
  });

  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    done();
  }
  $("copyFirst").addEventListener("click", function () {
    copyText($("firstFormula").textContent, $("copyFirst"));
  });
  $("copySecond").addEventListener("click", function () {
    copyText($("secondFormula").textContent, $("copySecond"));
  });

  /* ----- scientific calculator ----- */
  var calcOverlay = $("calcOverlay");
  var calcExprEl = $("calcExpr");
  var calcPreviewEl = $("calcPreview");
  var calcHistoryEl = $("calcHistory");
  var calcExpr = "";
  var calcAngle = "DEG";
  var calcInv = false;
  var calcMemory = 0;
  var calcHistory = [];
  var calcLastResult = null;

  function calcRender() {
    calcExprEl.textContent = calcExpr || "0";
    var preview = "";
    if (calcExpr) {
      try {
        var v = evaluateExpression(calcExpr, calcAngle);
        preview = "= " + fmtResult(v);
      } catch (e) { preview = ""; }
    }
    calcPreviewEl.textContent = preview;
    $("degBtn").textContent = calcAngle;
    $("degBtn").classList.toggle("toggle-on", calcAngle === "RAD");
    $("invBtn").classList.toggle("toggle-on", calcInv);
    $("sinBtn").textContent = calcInv ? "asin" : "sin";
    $("cosBtn").textContent = calcInv ? "acos" : "cos";
    $("tanBtn").textContent = calcInv ? "atan" : "tan";
    $("memNote").hidden = calcMemory === 0;
    calcHistoryEl.innerHTML = "";
    calcHistory.forEach(function (h) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = h.expr + " = " + h.result;
      b.addEventListener("click", function () {
        calcExpr = h.expr;
        calcRender();
      });
      calcHistoryEl.appendChild(b);
    });
  }
  function calcCurrentValue() {
    if (calcExpr) {
      try { return evaluateExpression(calcExpr, calcAngle); } catch (e) { /* fall through */ }
    }
    return calcLastResult;
  }
  function calcNegate() {
    var m = calcExpr.match(/\(-(\d+\.?\d*)\)$/);
    if (m) {
      calcExpr = calcExpr.slice(0, -m[0].length) + m[1];
      return;
    }
    var n = calcExpr.match(/(\d+\.?\d*)$/);
    if (n) {
      calcExpr = calcExpr.slice(0, -n[0].length) + "(-" + n[0] + ")";
      return;
    }
    calcExpr += "-";
  }
  function calcPress(key) {
    if (key === "clear") { calcExpr = ""; calcPreviewEl.textContent = ""; calcRender(); return; }
    if (key === "back") { calcExpr = calcExpr.slice(0, -1); calcRender(); return; }
    if (key === "=") {
      if (!calcExpr) return;
      try {
        var v = evaluateExpression(calcExpr, calcAngle);
        var r = fmtResult(v);
        calcHistory.unshift({ expr: calcExpr, result: r });
        calcHistory = calcHistory.slice(0, 5);
        calcLastResult = v;
        calcExpr = r;
        calcPreviewEl.textContent = "= " + r;
      } catch (e) {
        calcPreviewEl.textContent = "Error — hisaab check karein";
      }
      calcRender();
      // Keep the error text visible after render cleared the preview.
      if (calcPreviewEl.textContent === "" && calcExpr) {
        try { evaluateExpression(calcExpr, calcAngle); }
        catch (e) { calcPreviewEl.textContent = "Error — hisaab check karein"; }
      }
      return;
    }
    if (key === "deg") { calcAngle = calcAngle === "DEG" ? "RAD" : "DEG"; calcRender(); return; }
    if (key === "inv") { calcInv = !calcInv; calcRender(); return; }
    if (key === "mc") { calcMemory = 0; calcRender(); return; }
    if (key === "mr") {
      if (calcMemory !== 0) { calcExpr += fmtResult(calcMemory); calcRender(); }
      return;
    }
    if (key === "mplus" || key === "mminus") {
      var cur = calcCurrentValue();
      if (cur === null || cur === undefined || !isFinite(cur)) return;
      calcMemory += (key === "mplus" ? cur : -cur);
      calcRender();
      return;
    }
    if (key === "neg") { calcNegate(); calcRender(); return; }
    if (key === "sin") { calcExpr += calcInv ? "asin(" : "sin("; calcRender(); return; }
    if (key === "cos") { calcExpr += calcInv ? "acos(" : "cos("; calcRender(); return; }
    if (key === "tan") { calcExpr += calcInv ? "atan(" : "tan("; calcRender(); return; }
    if (key === "ln") { calcExpr += "ln("; calcRender(); return; }
    if (key === "log") { calcExpr += "log("; calcRender(); return; }
    if (key === "sqrt") { calcExpr += "√("; calcRender(); return; }
    if (key === "square") { calcExpr += "²"; calcRender(); return; }
    if (key === "power") { calcExpr += "^"; calcRender(); return; }
    if (key === "fact") { calcExpr += "!"; calcRender(); return; }
    if (key === "pi") { calcExpr += "π"; calcRender(); return; }
    if (key === "e") { calcExpr += "e"; calcRender(); return; }
    if (key === "percent") { calcExpr += "%"; calcRender(); return; }
    calcExpr += key;
    calcRender();
  }
  $("calcGrid").addEventListener("click", function (ev) {
    var btn = ev.target.closest(".ckey");
    if (!btn) return;
    calcPress(btn.getAttribute("data-key"));
  });
  function openCalc() { calcOverlay.hidden = false; calcRender(); }
  function closeCalc() { calcOverlay.hidden = true; }
  $("openCalc").addEventListener("click", openCalc);
  $("closeCalc").addEventListener("click", closeCalc);
  calcOverlay.addEventListener("click", function (ev) {
    if (ev.target === calcOverlay) closeCalc();
  });
  document.addEventListener("keydown", function (ev) {
    if (calcOverlay.hidden) return;
    var k = ev.key;
    if (k >= "0" && k <= "9") { calcPress(k); return; }
    if (k === ".") { calcPress("."); return; }
    if (k === "+") { calcPress("+"); return; }
    if (k === "-") { calcPress("−"); return; }
    if (k === "*") { calcPress("×"); return; }
    if (k === "/") { ev.preventDefault(); calcPress("÷"); return; }
    if (k === "^") { calcPress("^"); return; }
    if (k === "%") { calcPress("%"); return; }
    if (k === "(" || k === ")") { calcPress(k); return; }
    if (k === "!") { calcPress("!"); return; }
    if (k === "Enter" || k === "=") { ev.preventDefault(); calcPress("="); return; }
    if (k === "Backspace") { calcPress("back"); return; }
    if (k === "Escape") { closeCalc(); }
  });

  /* ----- records ----- */
  var recOverlay = $("recOverlay");
  var recConfigured = (function () {
    var cfg = window.DIESEL_CONFIG || {};
    var url = cfg.SUPABASE_URL || "";
    var key = cfg.SUPABASE_ANON_KEY || "";
    return url.indexOf("YOUR-PROJECT") === -1 && key !== "YOUR-ANON-KEY" && !!url && !!key;
  })();
  var allRecords = [];
  var recFilter = "all";
  var recCustomFrom = "";
  var recCustomTo = "";
  var recQuery = "";
  var recShown = [];
  var recSelectedMonth = "";
  var recSelectedWeek = "";
  var recSelectedYear = "";

  function recApi(path, options) {
    var cfg = window.DIESEL_CONFIG;
    var token = (options && options.authToken) || cfg.SUPABASE_ANON_KEY;
    var headers = {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token
    };
    if (options && options.body) headers["Content-Type"] = "application/json";
    if (options && options.prefer) headers.Prefer = options.prefer;
    return fetch(cfg.SUPABASE_URL + "/rest/v1" + path, {
      method: (options && options.method) || "GET",
      headers: headers,
      body: (options && options.body) || undefined
    });
  }
  /* ----- auth: registered users only can save ----- */
  var authSession = null;
  try {
    var stored = window.localStorage.getItem("diesel_auth");
    if (stored) authSession = JSON.parse(stored);
  } catch (e) { authSession = null; }
  function authSaveSession(session) {
    authSession = session || null;
    try {
      if (session) window.localStorage.setItem("diesel_auth", JSON.stringify(session));
      else window.localStorage.removeItem("diesel_auth");
    } catch (e) { /* storage optional */ }
  }
  function authName() {
    if (!authSession || !authSession.user) return "";
    var meta = authSession.user.user_metadata || {};
    return meta.full_name || authSession.user.email || "";
  }
  function authCall(path, body, token) {
    var cfg = window.DIESEL_CONFIG;
    return fetch(cfg.SUPABASE_URL + "/auth/v1" + path, {
      method: "POST",
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + (token || cfg.SUPABASE_ANON_KEY),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });
  }
  function authMsg(text, ok) {
    var el = $("authMsg");
    el.textContent = text;
    el.className = "form-msg" + (ok ? " ok" : text ? " err" : "");
  }
  function renderAuth() {
    var loggedIn = !!authSession;
    $("authLoggedOut").hidden = loggedIn;
    $("authLoggedIn").hidden = !loggedIn;
    if (loggedIn) {
      $("authUserName").textContent = authName();
      $("authUserEmail").textContent = authSession.user.email || "";
    }
    $("recBy").value = loggedIn ? authName() : "";
    $("recSaveBtn").disabled = !recConfigured || !loggedIn;
  }
  function authValidate() {
    if (!authSession || !authSession.access_token) { renderAuth(); return; }
    var cfg = window.DIESEL_CONFIG;
    fetch(cfg.SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + authSession.access_token
      }
    }).then(function (res) {
      if (res.ok) return res.json();
      if (authSession.refresh_token) {
        return authCall("/token?grant_type=refresh_token",
          { refresh_token: authSession.refresh_token })
          .then(function (r) {
            if (!r.ok) throw new Error("refresh failed");
            return r.json();
          })
          .then(function (s) { authSaveSession(s); return s.user; });
      }
      throw new Error("session expired");
    }).then(function (user) {
      if (user && authSession) {
        authSession.user = user;
        authSaveSession(authSession);
      }
      renderAuth();
    }).catch(function () {
      authSaveSession(null);
      renderAuth();
    });
  }
  function recMsg(text, ok) {
    var el = $("recMsg");
    el.textContent = text;
    el.className = "form-msg" + (ok ? " ok" : text ? " err" : "");
  }
  function distinctSorted(values) {
    var seen = {};
    var out = [];
    values.forEach(function (v) {
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    out.sort();
    out.reverse();
    return out;
  }
  function renderPickerList(elId, values, selected, labelFn, onPick) {
    var el = $(elId);
    el.innerHTML = "";
    if (values.length === 0) {
      var note = document.createElement("span");
      note.className = "rec-empty";
      note.textContent = "Abhi koi record nahi hai.";
      el.appendChild(note);
      return;
    }
    values.forEach(function (v) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (v === selected ? " chip-active" : "");
      b.textContent = labelFn(v);
      b.addEventListener("click", function () { onPick(v); });
      el.appendChild(b);
    });
  }
  function renderPickers() {
    // Monthly: full month list (all 12 names) + a year list beside it,
    // so month + year are picked together (e.g. November + 2026).
    // Yearly: full year list around the current year.
    // Weekly: weeks that have records, plus the current week.
    // Lists never depend on records existing, so they show even with
    // an empty table — picking a period with no records shows 0 records.
    var today = localISODate(new Date());
    var curYear = parseInt(today.slice(0, 4), 10);
    var yearRange = [];
    for (var y = curYear - 2; y <= curYear + 2; y += 1) yearRange.push(String(y));
    var weeks = distinctSorted(allRecords.map(function (r) {
      return r.record_date ? weekStartISO(r.record_date) : "";
    }).concat([weekStartISO(today)]));
    if (!recSelectedMonth) recSelectedMonth = today.slice(0, 7);
    if (!recSelectedWeek && weeks.length) recSelectedWeek = weeks[0];
    if (!recSelectedYear) recSelectedYear = String(curYear);
    var selMonthNum = recSelectedMonth.slice(5, 7);
    var selMonthYear = recSelectedMonth.slice(0, 4);
    var allMonths = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
    renderPickerList("monthList", allMonths, selMonthNum, function (v) {
      return MONTH_NAMES[parseInt(v, 10) - 1];
    }, function (v) {
      recSelectedMonth = selMonthYear + "-" + v; renderPickers(); renderRecList();
    });
    renderPickerList("monthYearList", yearRange, selMonthYear, function (v) { return v; }, function (v) {
      recSelectedMonth = v + "-" + selMonthNum; renderPickers(); renderRecList();
    });
    renderPickerList("weekList", weeks, recSelectedWeek, weekLabel, function (v) {
      recSelectedWeek = v; renderPickers(); renderRecList();
    });
    renderPickerList("yearList", yearRange, recSelectedYear, function (v) { return v; }, function (v) {
      recSelectedYear = v; renderPickers(); renderRecList();
    });
  }
  function updatePickerVisibility() {
    $("monthPicker").hidden = recFilter !== "monthly";
    $("weekPicker").hidden = recFilter !== "weekly";
    $("yearPicker").hidden = recFilter !== "yearly";
    $("customDates").hidden = recFilter !== "custom";
  }
  function renderRecList() {
    var filtered = filterRecords(allRecords, recFilter, recCustomFrom, recCustomTo, new Date(), {
      month: recSelectedMonth, week: recSelectedWeek, year: recSelectedYear
    });
    recShown = searchRecords(filtered, recQuery);
    var totals = sumTotals(recShown);
    $("totLitres").textContent = fmt2(totals.litres);
    $("totKg").textContent = fmt2(totals.kg);
    $("totCount").textContent = totals.count + " records";
    var list = $("recList");
    list.innerHTML = "";
    if (recShown.length === 0) {
      var e = document.createElement("p");
      e.className = "rec-empty";
      e.textContent = "Koi record nahi mila.";
      list.appendChild(e);
      return;
    }
    recShown.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "rec-item";
      var top = document.createElement("div");
      top.className = "rec-top";
      var v = document.createElement("span");
      v.textContent = r.vehicle_number || "";
      var q = document.createElement("span");
      q.textContent = fmt2(parseFloat(r.diesel_litres) || 0) + " L • " +
        fmt2(parseFloat(r.diesel_kg) || 0) + " KG";
      top.appendChild(v);
      top.appendChild(q);
      var meta = document.createElement("div");
      meta.className = "rec-meta";
      meta.textContent = (r.record_date || "") +
        (r.record_time ? " " + String(r.record_time).slice(0, 5) : "") +
        " • Driver: " + (r.driver_name || "") +
        (r.company_name ? " • Company: " + r.company_name : "") +
        (r.receiver_name ? " • Receiver: " + r.receiver_name : "") +
        (r.saved_by_name ? " • By: " + r.saved_by_name : "");
      item.appendChild(top);
      item.appendChild(meta);
      list.appendChild(item);
    });
  }
  function loadRecords() {
    if (!recConfigured) { renderRecList(); return; }
    recApi("/diesel_records?select=*&order=record_date.desc,created_at.desc&limit=1000")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (rows) {
        allRecords = rows || [];
        renderPickers();
        renderRecList();
      })
      .catch(function () {
        recMsg("Records load nahi hue — database/table check karein.", false);
        renderRecList();
      });
  }
  function openRecords() {
    recOverlay.hidden = false;
    $("recSetupNote").hidden = recConfigured;
    renderAuth();
    if (recConfigured) authValidate();
    if (!$("recDate").value) $("recDate").value = localISODate(new Date());
    if (!$("recTime").value) {
      var now = new Date();
      var hh = String(now.getHours());
      if (hh.length < 2) hh = "0" + hh;
      var mm = String(now.getMinutes());
      if (mm.length < 2) mm = "0" + mm;
      $("recTime").value = hh + ":" + mm;
    }
    loadRecords();
  }
  function closeRecords() { recOverlay.hidden = true; }
  $("openRecords").addEventListener("click", openRecords);
  $("closeRecords").addEventListener("click", closeRecords);
  recOverlay.addEventListener("click", function (ev) {
    if (ev.target === recOverlay) closeRecords();
  });

  $("recLitres").addEventListener("input", function () {
    var l = toNum($("recLitres").value);
    if (isNum(l) && l > 0 && density > 0) {
      $("recKg").value = fmt2(litresToKg(l, density));
    }
  });
  $("recKg").addEventListener("input", function () {
    var k = toNum($("recKg").value);
    if (isNum(k) && k > 0 && density > 0) {
      $("recLitres").value = fmt2(kgToLitres(k, density));
    }
  });
  $("authLoginBtn").addEventListener("click", function () {
    if (!recConfigured) { authMsg("Database setup pending — pehle Supabase set karein.", false); return; }
    var email = $("authEmail").value.trim();
    var password = $("authPassword").value;
    if (!email || !password) { authMsg("Email aur password zaroori hain.", false); return; }
    authCall("/token?grant_type=password", { email: email, password: password })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (s) {
        authSaveSession(s);
        authMsg("Login ho gaya.", true);
        renderAuth();
      })
      .catch(function () { authMsg("Login nahi hua — email/password check karein.", false); });
  });
  $("authLogoutBtn").addEventListener("click", function () {
    if (authSession && authSession.access_token) {
      authCall("/logout", {}, authSession.access_token).catch(function () { /* ignore */ });
    }
    authSaveSession(null);
    authMsg("Logout ho gaya.", true);
    renderAuth();
  });

  $("recForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!recConfigured) {
      recMsg("Database setup pending — pehle config.js mein Supabase set karein.", false);
      return;
    }
    if (!authSession) {
      recMsg("Record save karne ke liye pehle login karein — visitor sirf dekh sakte hain.", false);
      return;
    }
    var vehicle = $("recVehicle").value.trim();
    var driver = $("recDriver").value.trim();
    var date = $("recDate").value;
    var litres = toNum($("recLitres").value);
    var kg = toNum($("recKg").value);
    if (!vehicle || !driver || !date || !isNum(litres) || litres <= 0 ||
        !isNum(kg) || kg <= 0) {
      recMsg("Vehicle, Driver, Date, Litres aur KG zaroori hain.", false);
      return;
    }
    var row = {
      vehicle_number: vehicle,
      driver_name: driver,
      company_name: $("recCompany").value.trim() || null,
      receiver_name: $("recReceiver").value.trim() || null,
      record_date: date,
      record_time: $("recTime").value || null,
      diesel_litres: litres,
      diesel_kg: kg,
      owner_id: authSession.user ? authSession.user.id : null,
      saved_by_name: authName() || null
    };
    $("recSaveBtn").disabled = true;
    recApi("/diesel_records", {
      method: "POST",
      body: JSON.stringify(row),
      prefer: "return=representation",
      authToken: authSession.access_token
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function () {
        recMsg("Record save ho gaya.", true);
        $("recLitres").value = "";
        $("recKg").value = "";
        loadRecords();
      })
      .catch(function () {
        recMsg("Record save nahi hua — database/table check karein.", false);
      })
      .then(function () {
        renderAuth();
      });
  });

  document.querySelectorAll(".filter-chip").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".filter-chip").forEach(function (b) {
        b.classList.remove("chip-active");
      });
      btn.classList.add("chip-active");
      recFilter = btn.getAttribute("data-filter");
      updatePickerVisibility();
      renderPickers();
      renderRecList();
    });
  });
  $("customFrom").addEventListener("change", function () {
    recCustomFrom = $("customFrom").value;
    renderRecList();
  });
  $("customTo").addEventListener("change", function () {
    recCustomTo = $("customTo").value;
    renderRecList();
  });
  $("recSearch").addEventListener("input", function () {
    recQuery = $("recSearch").value.trim();
    renderRecList();
  });
  $("recDownload").addEventListener("click", function () {
    var csv = buildCSV(recShown);
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diesel-records.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  /* ----- install button ----- */
  var installBtn = $("installBtn");
  var installSteps = $("installSteps");
  function updateInstallVisibility() {
    var standalone = false;
    try {
      standalone = window.matchMedia("(display-mode: standalone)").matches ||
        !!window.navigator.standalone;
    } catch (e) { /* ignore */ }
    if (standalone) { installBtn.hidden = true; installSteps.hidden = true; }
  }
  window.addEventListener("beforeinstallprompt", function () {
    installBtn.hidden = false;
  });
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || "");
  if (isIOS && !window.navigator.standalone) {
    installBtn.hidden = false;
  }
  installBtn.addEventListener("click", function () {
    installSteps.hidden = !installSteps.hidden;
  });
  updateInstallVisibility();

  /* ----- service worker ----- */
  if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .catch(function () { /* offline support is optional */ });
  }

  /* ----- initial render ----- */
  applySample();
  calcRender();
})();
