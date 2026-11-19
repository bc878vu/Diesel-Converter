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

  /* ---------- density resolution (Step 1) ---------- */
  // Returns { mode, density, totalKg, warning }.
  // mode: 'sample' | 'bulk' | 'none' (warning mode khatam 2026-11-02)
  function resolveDensity(prevDensity, litres, kg) {
    if (!isNum(litres) || !isNum(kg) || litres <= 0 || kg <= 0) {
      return { mode: "none", density: prevDensity, totalKg: null, warning: false };
    }
    // Doosri value agar 1 litre ke wazan jaisi lage (0.70–1.00) to wahi
    // seedhi density hai — chahe sample 5 ho ya 50 ya 5000 (user ki
    // hidayat 2026-11-02: 5 + 0.82 aur 50 + 0.82 dono par density 0.82
    // hi aani chahiye). Total = sample litres x density. Warna (bari
    // value = pooray sample ka wazan) density = wazan / litres.
    if (kg >= 0.70 && kg <= 1.00) {
      return { mode: "bulk", density: kg, totalKg: litres * kg, warning: false };
    }
    // Koi range check nahi: choti ya bari, har reading seedhi accept hoti
    // hai — koi warning kabhi nahi aayegi (user ki hidayat 2026-11-02).
    var d = kg / litres;
    return { mode: "sample", density: d, totalKg: null, warning: false };
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
      if (ch === "+" || ch === "-" || ch === "−" || ch === "*" || ch === "×" ||
          ch === "/" || ch === "÷" || ch === "^" || ch === "%" ||
          ch === "!" || ch === "(" || ch === ")" || ch === "²") {
        var op = ch;
        if (op === "−") op = "-"; // v17: calculator ka − button + keyboard minus (U+2212) ASCII minus hai
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
  function xlsxDateSerial(iso) {
    // v24: "2026-11-19" -> Excel serial 46345 (days since 1899-12-30).
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return null;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569;
  }
  function xlsxTimeFrac(t) {
    // v24: "20:00:00" (ya "20:00") -> 0.8333... (din ka hissa).
    var p = String(t || "").split(":");
    if (p.length < 2 || isNaN(+p[0]) || isNaN(+p[1])) return null;
    return ((+p[0]) * 3600 + (+p[1]) * 60 + (+p[2] || 0)) / 86400;
  }
  function fmtCsvNum(n) {
    // Template shows whole numbers without decimals (5000, not 5000.00)
    return String(Math.round((parseFloat(n) || 0) * 100) / 100);
  }
  function escXml(v) {
    return String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var XLSX_CRC_TABLE = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function xlsxCrc32(bytes) {
    var crc = 0xFFFFFFFF, i;
    for (i = 0; i < bytes.length; i++) crc = XLSX_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function xlsxZip(files) {
    // Minimal ZIP writer with STORED (uncompressed) entries — Excel reads
    // stored entries fine, and this avoids shipping a DEFLATE compressor.
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    function u16(v) { var b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
    function u32(v) { var b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }
    files.forEach(function (f) {
      var data = enc.encode(f.data);
      var name = enc.encode(f.name);
      var crc = xlsxCrc32(data);
      [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)].forEach(function (x) { parts.push(x); });
      parts.push(name, data);
      [u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)].forEach(function (x) { central.push(x); });
      central.push(name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = 0;
    central.forEach(function (x) { cdSize += x.length; });
    var end = [u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)];
    return new Blob(parts.concat(central).concat(end), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  // v25: reports oldest-first — Boss order 19 Nov 21:36 PKT ("new record
  // nichy ay, old top pr he rhy"). Reports (Excel + HTML) sort ASCENDING
  // by business date, then time, then created_at. The in-app LIST stays
  // newest-first (query order record_date.desc) — ONLY the two report
  // builders call this, on a COPY, so recShown/list never change.
  function sortRowsAsc(rows) {
    function tkey(r) {
      var d = String(r.record_date || "");
      var t = String(r.record_time || "");
      var p = t ? t.split(":") : ["00", "00", "00"];
      while (p.length < 3) p.push("00");
      t = p.map(function (x) { return ("0" + (x || "00")).slice(-2); }).join(":");
      return d + " " + t + " " + String(r.created_at || "");
    }
    return rows.slice().sort(function (a, b) {
      var ka = tkey(a), kb = tkey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  function buildReportXlsx(rows) {
    // v24: Boss ki apni template file (diesel-records (6).xlsx) ka EXACT
    // format — 10 columns, Saved By KHATAM, Temp/Density Litres/KG se
    // PEHLE, 2-row header + Diesel group, REAL Excel date/time values,
    // DDEBF7 total. Data hamesha live records se (koi hardcode nahi).
    // Style index (target file ki styles.xml jaisi): 0 default, 1 sub-header
    // (12b), 2 data (12), 3 total formula (12b + DDEBF7), 4 blank row,
    // 5 title (16b + gray125), 6 date d-mmm-yy, 7 time h:mm AM/PM,
    // 8 density 0.000, 9 Diesel (12b, LTB), 10 header filler TB,
    // 11 header top LRT, 12 header bottom LRB, 13 Total label (12b +
    // DDEBF7, LTB), 14 total filler TB, 15 total filler RTB.
    rows = sortRowsAsc(rows); // v25: oldest first (Boss order 19 Nov 21:36 PKT)
    var widths = [10.77734375, 11.33203125, 9.33203125, 11.77734375, 23.6640625, 17.88671875, 7.33203125, 8.88671875, 10.77734375, 10.109375];
    var cols = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    var n = rows.length;
    var totalRow = 8 + n;
    function strCell(ref, style, v) { return "<c r=\"" + ref + "\" s=\"" + style + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" + escXml(v) + "</t></is></c>"; }
    function numCell(ref, style, v) { return "<c r=\"" + ref + "\" s=\"" + style + "\"><v>" + v + "</v></c>"; }
    function formulaCell(ref, style, formula, cached) { return "<c r=\"" + ref + "\" s=\"" + style + "\"><f>" + formula + "</f><v>" + cached + "</v></c>"; }
    function emptyCell(ref, style) { return "<c r=\"" + ref + "\" s=\"" + style + "\"/>"; }
    var sheetRows = [], i, j;
    var titleRow = "<row r=\"1\" spans=\"1:10\" ht=\"30\" customHeight=\"1\">" + strCell("A1", 5, "Incoming Diesel ");
    for (i = 1; i < 10; i++) titleRow += emptyCell(cols[i] + "1", 5);
    sheetRows.push(titleRow + "</row>");
    var h2 = ["Date", "Time", "Vehicle", "Driver", "Company", "Receiver"];
    var hr = "<row r=\"2\" spans=\"1:10\" ht=\"15.6\">";
    h2.forEach(function (h, hi) { hr += strCell(cols[hi] + "2", 11, h); });
    hr += strCell("G2", 9, "Diesel");
    for (i = 7; i < 10; i++) hr += emptyCell(cols[i] + "2", 10);
    sheetRows.push(hr + "</row>");
    var sub3 = ["Temp", "Density", "Litres", "KG's"];
    var sr = "<row r=\"3\" spans=\"1:10\" ht=\"15.6\">";
    for (i = 0; i < 6; i++) sr += emptyCell(cols[i] + "3", 12);
    sub3.forEach(function (h, hi) { sr += strCell(cols[6 + hi] + "3", 1, h); });
    sheetRows.push(sr + "</row>");
    rows.forEach(function (r, idx) {
      var rr = 4 + idx;
      var ds = xlsxDateSerial(r.record_date);
      var tf = xlsxTimeFrac(r.record_time);
      sheetRows.push("<row r=\"" + rr + "\" spans=\"1:10\" ht=\"15.6\">" +
        (ds === null ? strCell("A" + rr, 6, "") : numCell("A" + rr, 6, ds)) +
        (tf === null ? strCell("B" + rr, 7, "") : numCell("B" + rr, 7, tf)) +
        strCell("C" + rr, 2, r.vehicle_number || "") +
        strCell("D" + rr, 2, r.driver_name || "") +
        strCell("E" + rr, 2, r.company_name || "") +
        strCell("F" + rr, 2, r.receiver_name || r.saved_by_name || "") +
        strCell("G" + rr, 2, r.diesel_temperature == null ? "" : fmtCsvNum(r.diesel_temperature) + "°C") +
        (r.diesel_density_g_per_l == null ? strCell("H" + rr, 2, "") : numCell("H" + rr, 8, fmtCsvNum(r.diesel_density_g_per_l))) +
        numCell("I" + rr, 2, fmtCsvNum(r.diesel_litres)) +
        numCell("J" + rr, 2, fmtCsvNum(r.diesel_kg)) + "</row>");
    });
    for (i = 0; i < 4; i++) {
      var br = 4 + n + i, brow = "<row r=\"" + br + "\" spans=\"1:10\">";
      for (j = 0; j < 10; j++) brow += emptyCell(cols[j] + br, 4);
      sheetRows.push(brow + "</row>");
    }
    var tot = sumTotals(rows);
    var tr = "<row r=\"" + totalRow + "\" spans=\"1:10\" ht=\"15.6\">" + strCell("A" + totalRow, 13, "Total");
    for (i = 1; i < 7; i++) tr += emptyCell(cols[i] + totalRow, 14);
    tr += emptyCell("H" + totalRow, 15);
    tr += formulaCell("I" + totalRow, 3, "SUM(I4:I" + (totalRow - 1) + ")", fmtCsvNum(tot.litres));
    tr += formulaCell("J" + totalRow, 3, "SUM(J4:J" + (totalRow - 1) + ")", fmtCsvNum(tot.kg));
    sheetRows.push(tr + "</row>");
    var colsXml = "<cols>";
    widths.forEach(function (w, wi) { colsXml += "<col min=\"" + (wi + 1) + "\" max=\"" + (wi + 1) + "\" width=\"" + w + "\" customWidth=\"1\"/>"; });
    colsXml += "</cols>";
    var sheetXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
      + "<dimension ref=\"A1:J" + totalRow + "\"/>"
      + "<sheetViews><sheetView showGridLines=\"1\" workbookViewId=\"0\"/></sheetViews>"
      + "<sheetFormatPr defaultRowHeight=\"14.4\"/>"
      + colsXml
      + "<sheetData>" + sheetRows.join("") + "</sheetData>"
      + "<mergeCells count=\"9\"><mergeCell ref=\"A1:J1\"/><mergeCell ref=\"G2:J2\"/><mergeCell ref=\"F2:F3\"/><mergeCell ref=\"E2:E3\"/><mergeCell ref=\"D2:D3\"/><mergeCell ref=\"C2:C3\"/><mergeCell ref=\"B2:B3\"/><mergeCell ref=\"A2:A3\"/><mergeCell ref=\"A" + totalRow + ":H" + totalRow + "\"/></mergeCells>"
      + "<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>"
      + "<pageSetup orientation=\"landscape\"/>"
      + "</worksheet>";
    var bSides = ["0000", "1111", "1011", "0011", "1110", "1101", "0111"];
    var bNames = ["left", "right", "top", "bottom"];
    var bordersXml = "<borders count=\"7\">";
    bSides.forEach(function (bs) {
      var bx = "<border>";
      bNames.forEach(function (sn, si) { bx += bs.charAt(si) === "1" ? "<" + sn + " style=\"thin\"><color auto=\"1\"/></" + sn + ">" : "<" + sn + "/>"; });
      bordersXml += bx + "<diagonal/></border>";
    });
    bordersXml += "</borders>";
    var xfSpec = ["0,0,0,0,0", "0,2,0,1,1", "0,3,0,1,1", "0,2,2,1,1", "0,0,0,1,0", "0,1,1,1,1", "15,3,0,1,1", "18,3,0,1,1", "166,3,0,1,1", "0,2,0,2,1", "0,2,0,3,1", "0,2,0,4,1", "0,2,0,5,1", "0,2,2,2,1", "0,2,2,3,1", "0,2,2,6,1"];
    var xfsXml = "<cellXfs count=\"16\">";
    xfSpec.forEach(function (sp) {
      var p = sp.split(",");
      var x = "<xf numFmtId=\"" + p[0] + "\" fontId=\"" + p[1] + "\" fillId=\"" + p[2] + "\" borderId=\"" + p[3] + "\" xfId=\"0\"";
      if (p[0] !== "0") x += " applyNumberFormat=\"1\"";
      if (p[1] !== "0") x += " applyFont=\"1\"";
      if (p[2] !== "0") x += " applyFill=\"1\"";
      if (p[3] !== "0") x += " applyBorder=\"1\"";
      if (p[4] === "1") x += " applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\"/></xf>";
      else x += "/>";
      xfsXml += x;
    });
    xfsXml += "</cellXfs>";
    var stylesXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">"
      + "<numFmts count=\"1\"><numFmt numFmtId=\"166\" formatCode=\"0.000\"/></numFmts>"
      + "<fonts count=\"4\">"
      + "<font><sz val=\"11\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/></font>"
      + "<font><b/><sz val=\"16\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/></font>"
      + "<font><b/><sz val=\"12\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/></font>"
      + "<font><sz val=\"12\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/></font>"
      + "</fonts>"
      + "<fills count=\"3\">"
      + "<fill><patternFill patternType=\"none\"/></fill>"
      + "<fill><patternFill patternType=\"gray125\"/></fill>"
      + "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFDDEBF7\"/><bgColor indexed=\"64\"/></patternFill></fill>"
      + "</fills>"
      + bordersXml
      + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
      + xfsXml
      + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>"
      + "</styleSheet>";
    var workbookXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
      + "<sheets><sheet name=\"Diesel Records\" sheetId=\"1\" r:id=\"rId1\"/></sheets>"
      + "</workbook>";
    var workbookRels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>"
      + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
      + "</Relationships>";
    var rootRels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>"
      + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>"
      + "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>"
      + "</Relationships>";
    var contentTypes = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
      + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
      + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
      + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
      + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
      + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
      + "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
      + "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>"
      + "</Types>";
    var coreXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">"
      + "<dc:title>Incoming Diesel</dc:title><dc:creator>Diesel Converter</dc:creator>"
      + "</cp:coreProperties>";
    var appXml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
      + "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">"
      + "<Application>Diesel Converter</Application>"
      + "</Properties>";
    return xlsxZip([
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rootRels },
      { name: "xl/workbook.xml", data: workbookXml },
      { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
      { name: "xl/worksheets/sheet1.xml", data: sheetXml },
      { name: "xl/styles.xml", data: stylesXml },
      { name: "docProps/core.xml", data: coreXml },
      { name: "docProps/app.xml", data: appXml }
    ]);
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
    density = res.density;
    if (res.mode === "bulk") {
      bulkBoxEl.hidden = false;
      bulkKgEl.textContent = fmt2(res.totalKg);
      bulkFormulaEl.textContent = fmtDensity(litres) + " L × " +
        density.toFixed(3) + " = " + fmt2(res.totalKg) + " kg";
    } else {
      bulkBoxEl.hidden = true;
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
  function closeCalc() { calcOverlay.hidden = true; maybeAutoReload(); }
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
  var editingRecordId = null;

  /* ----- offline: cache + outbox (v16) -----
     Records cache: aakhri server list localStorage me (visitor ke liye
     bhi) — offline kholne par wahi list + totals + filters dikhte hain.
     Outbox: offline (ya failed) save/update/delete yahan queue hote hain
     aur internet aate hi IN ORDER sync hote hain. Har create ki apni
     client-UUID hoti hai — retry par bhi wahi id jati hai, is liye
     dobara save se duplicate kabhi nahi banega. Koi op kabhi chup-chaap
     drop nahi hota: 5xx/network par 30s backoff, 4xx par 5 min backoff
     + saaf wajah; 409 (pehle se save ho chuka) ko kamyabi mana jata hai. */
  var REC_CACHE_KEY = "diesel_records_cache_v1";
  var REC_OUTBOX_KEY = "diesel_outbox_v1";
  function storeJSON(key, val) {
    try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage optional */ }
  }
  function readJSON(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function newClientId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var h = function () { return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1); };
    return h() + h() + "-" + h() + "-4" + h().slice(1) + "-" + h() + "-" + h() + h() + h();
  }
  var recOutbox = readJSON(REC_OUTBOX_KEY) || [];
  var serverRecords = []; // aakhri server list (cache ya fetch se)
  var outboxBusy = false;
  function saveOutbox() { storeJSON(REC_OUTBOX_KEY, recOutbox); updateOfflineBadge(); }
  function saveRecCache() { storeJSON(REC_CACHE_KEY, { savedAt: Date.now(), rows: serverRecords }); }
  function loadRecCache() {
    var c = readJSON(REC_CACHE_KEY);
    return (c && c.rows) ? c.rows : null;
  }
  function updateOfflineBadge() {
    var el = $("offlineBadge");
    if (!el) return;
    var n = recOutbox.length;
    if (!navigator.onLine) {
      el.hidden = false;
      el.textContent = n ? ("Offline • Sync pending (" + n + ")")
        : "Offline — internet nahi hai";
    } else if (n) {
      el.hidden = false;
      el.textContent = "Sync pending (" + n + ")";
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }
  function applyOutboxToList() {
    // allRecords = server list + queued ops ka overlay. Pending create
    // upar, pending edit values overwrite, pending delete row hata deta
    // hai. Server se fetch ke baad bhi yehi overlay dobara lagta hai, is
    // liye queued record refetch se ghayab nahi hota.
    var base = serverRecords.slice();
    recOutbox.forEach(function (op) {
      var i, found = -1;
      for (i = 0; i < base.length; i += 1) {
        if (String(base[i].id) === String(op.id)) { found = i; break; }
      }
      if (op.kind === "create") {
        if (found === -1) {
          var row = Object.assign({}, op.row, { _pending: true });
          base.unshift(row);
        }
      } else if (op.kind === "update") {
        if (found !== -1) {
          base[found] = Object.assign({}, base[found], op.row, { _pending: true });
        }
      } else if (op.kind === "delete") {
        if (found !== -1) base.splice(found, 1);
      }
    });
    allRecords = base;
  }
  function queueOp(op) {
    // Coalesce: ek hi record par pehle se queued op ho to merge karein.
    var existing = null;
    recOutbox.forEach(function (o) { if (String(o.id) === String(op.id)) existing = o; });
    if (existing) {
      if (op.kind === "delete" && existing.kind === "create") {
        // Server par gaya hi nahi tha — create op hi hata dein.
        recOutbox = recOutbox.filter(function (o) { return o !== existing; });
        saveOutbox();
        return "dropped";
      }
      if (op.kind === "update" && (existing.kind === "create" || existing.kind === "update")) {
        // Field-wise merge (replace nahi): form row me owner_id jaisi
        // cheezein nahi hotin — poora replace karne se woh kho jatin
        // aur pending row apni Edit/Delete kho deta.
        existing.row = Object.assign({}, existing.row, op.row, { id: existing.id });
        existing.at = op.at || new Date().toISOString();
        existing.nextRetry = 0;
        saveOutbox();
        return "merged";
      }
      if (op.kind === "delete" && existing.kind === "update") {
        recOutbox = recOutbox.filter(function (o) { return o !== existing; });
      }
    }
    op.at = op.at || new Date().toISOString();
    op.nextRetry = 0;
    op.lastError = null;
    recOutbox.push(op);
    saveOutbox();
    return "queued";
  }
  function trySendOp(op) {
    // Ek op server ko bhejne ki koshish. Resolve: {failed:false} ya
    // {failed:true, status} — status 0 = network failure, 409 (create
    // pehle se maujood) = kamyabi. Offline ho to koi network call nahi.
    if (!navigator.onLine) return Promise.resolve({ failed: true, status: 0 });
    var req;
    if (op.kind === "create") {
      req = recApi("/diesel_records", {
        method: "POST",
        body: JSON.stringify(op.row),
        prefer: "return=representation",
        authToken: authSession.access_token
      });
    } else if (op.kind === "update") {
      req = recApi("/diesel_records?id=eq." + encodeURIComponent(op.id), {
        method: "PATCH",
        body: JSON.stringify(op.row),
        prefer: "return=representation",
        authToken: authSession.access_token
      });
    } else {
      req = recApi("/diesel_records?id=eq." + encodeURIComponent(op.id), {
        method: "DELETE",
        authToken: authSession.access_token
      });
    }
    return req.then(function (res) {
      if (res.ok) return { failed: false };
      if (res.status === 409 && op.kind === "create") return { failed: false };
      return { failed: true, status: res.status };
    }).catch(function () { return { failed: true, status: 0 }; });
  }
  function flushOutbox(force) {
    // Outbox IN ORDER sync karein. Pehli failure par ruk jayein (order
    // barkarar) — failed op queued rehta hai, backoff ke sath. Kabhi
    // reject nahi karta, taake caller chain (sync/load) chalta rahe.
    // force=true (online aana / sheet khulna) backoff nazar-andaz karke
    // fori try karta hai — ye asli state change hai; 3s cycle (force
    // nahi) backoff ka ehtram karta hai taake failing server ko na kootay.
    if (!recConfigured || !authSession || !authSession.access_token) return Promise.resolve(false);
    if (!navigator.onLine || outboxBusy || !recOutbox.length) return Promise.resolve(false);
    var now = Date.now();
    var earliest = Infinity;
    recOutbox.forEach(function (op) { if ((op.nextRetry || 0) < earliest) earliest = op.nextRetry || 0; });
    if (!force && now < earliest) return Promise.resolve(false);
    outboxBusy = true;
    var done = 0;
    function step() {
      if (!recOutbox.length) return Promise.resolve(done);
      var op = recOutbox[0];
      if (!force && Date.now() < (op.nextRetry || 0)) return Promise.resolve(done);
      return trySendOp(op).then(function (r) {
        if (!r.failed) {
          recOutbox.shift();
          done += 1;
          saveOutbox();
          return step();
        }
        if (r.status && r.status >= 400 && r.status < 500) {
          op.lastError = "HTTP " + r.status;
          op.nextRetry = Date.now() + 5 * 60 * 1000;
          recMsg("Database ne record reject kiya (HTTP " + r.status + ") — record queue mein mehfooz hai, admin se SQL check karwayein.", false);
        } else {
          op.lastError = r.status ? ("HTTP " + r.status) : "network";
          op.nextRetry = Date.now() + 30000;
          recMsg("Sync ruk gaya — internet aate hi dobara hoga.", false);
        }
        saveOutbox();
        return done;
      });
    }
    return step().then(function (n) {
      outboxBusy = false;
      updateOfflineBadge();
      return n > 0;
    });
  }

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
  function authHasRealName() {
    if (!authSession || !authSession.user) return false;
    var meta = authSession.user.user_metadata || {};
    return !!(meta.full_name && String(meta.full_name).trim());
  }
  function isOwnRecord(r) {
    return !!(authSession && authSession.user && r.owner_id &&
      String(r.owner_id) === String(authSession.user.id));
  }
  function displaySavedBy(r) {
    // Old records saved before the real name was set carry the email
    // as saved_by_name. Once the owner sets his real name, show that
    // name instead of the stored email — mail kabhi display nahi hogi.
    var stored = r.saved_by_name || "";
    if (stored.indexOf("@") !== -1 && authHasRealName() &&
        (isOwnRecord(r) || stored === (authSession.user.email || ""))) {
      return authName();
    }
    return stored;
  }
  function cancelEdit() {
    editingRecordId = null;
    $("recSaveBtn").textContent = "Record Save Karein";
    $("recCancelEditBtn").hidden = true;
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
    // Logged-in state shows ONLY the header chip + logout icon (no big box).
    // The auth box appears only when it has content: the login form when
    // logged out, or the one-time real-name setup when the name is missing.
    var loggedIn = !!authSession;
    $("authLoggedOut").hidden = loggedIn;
    $("authNameSetup").hidden = !loggedIn || authHasRealName();
    $("authBox").hidden = loggedIn && authHasRealName();
    $("recUserChip").textContent = loggedIn ? authName() : "";
    $("recUserChip").hidden = !loggedIn;
    $("authLogoutBtn").hidden = !loggedIn;
    if (!loggedIn) {
      cancelEdit();
    }
    $("recSaveBtn").disabled = !recConfigured || !loggedIn;
  }
  var authBusy = false;
  function authStamp(s) {
    if (s && s.expires_in) s.expires_at = Date.now() + s.expires_in * 1000;
    return s;
  }
  function authAdopt() {
    // Doosri tab/device ne refresh kar liya ho to us ka naya session
    // apna lein — purane refresh token par 400/401 aana logout nahi.
    try {
      var raw = window.localStorage.getItem("diesel_auth");
      if (!raw) return false;
      var st = JSON.parse(raw);
      if (st && st.access_token && (!authSession || st.access_token !== authSession.access_token)) {
        authSession = st;
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }
  function authRefresh() {
    // Access token (1 ghanta) khatam hone se pehle refresh — session
    // kabhi khud se logout na ho. Sirf 400/401 invalid token par
    // expired; network/5xx par session barkarar, baad mein dobara
    // try hoga (timer har 20 min koshish karta hai). Aik waqt mein
    // sirf aik refresh (doosri tab ke sath race nahi).
    if (authBusy) return Promise.resolve({ inFlight: true });
    if (!authSession || !authSession.refresh_token) return Promise.resolve({ expired: true });
    authBusy = true;
    return authCall("/token?grant_type=refresh_token", { refresh_token: authSession.refresh_token })
      .then(function (r) {
        if (r.ok) return r.json().then(function (s) { authSaveSession(authStamp(s)); return { ok: true }; });
        if (r.status === 400 || r.status === 401) return authAdopt() ? { ok: true } : { expired: true };
        return { transient: true };
      })
      .catch(function () { return { transient: true }; })
      .then(function (out) { authBusy = false; return out; });
  }
  function authDone(out) {
    if (out && out.expired) {
      authSaveSession(null);
      authMsg("Session khatam ho gaya — dobara login karein.", false);
    }
    renderAuth();
  }
  function authKeep(fromBoot) {
    // Token khatam hone se 10 min pehle refresh kar lo. expires_at
    // nahi hai (purana session) to boot par kuch nahi — sheet khulte
    // waqt aik dafa refresh kar ke expires_at lag jata hai.
    if (!authSession || !authSession.access_token) return;
    if (!authSession.expires_at) { if (!fromBoot) authRefresh().then(authDone); return; }
    if (Date.now() > authSession.expires_at - 600000) authRefresh().then(authDone);
  }
  function authValidate() {
    // Session check: EXPIRED token (401/403 + refresh fail) par hi logout;
    // network failure ya transient server error par session BARKARAR
    // rehta hai — offline user cache + outbox se kaam karta rahega.
    if (!authSession || !authSession.access_token) { renderAuth(); return; }
    var cfg = window.DIESEL_CONFIG;
    fetch(cfg.SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + authSession.access_token
      }
    }).then(function (res) {
      if (res.ok) {
        return res.json().then(function (user) { return { user: user }; });
      }
      if (res.status === 401 || res.status === 403) {
        return authRefresh().then(function (out) {
          if (out.ok) return { user: authSession.user };
          if (out.expired) throw { expired: true };
          throw { transient: true };
        });
      }
      throw { transient: true };
    }).then(function (out) {
      if (out && out.user && authSession) {
        authSession.user = out.user;
        authSaveSession(authSession);
      }
      renderAuth();
    }).catch(function (err) {
      if (err && err.expired) {
        authSaveSession(null);
        authMsg("Session khatam ho gaya — dobara login karein.", false);
      }
      // Network failure / transient error: session barkarar.
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
      var byName = displaySavedBy(r);
      // Sirf EK naam: Receiver aur By hamesha ek hi shakhs hota hai
      // (receiver login wale ka real naam hai), is liye dono dikhane se
      // naam double lagta tha. Receiver ho to wohi, warna By.
      var oneName = r.receiver_name ? (" • Receiver: " + r.receiver_name)
        : (byName ? " • By: " + byName : "");
      meta.textContent = (r.record_date || "") +
        (r.record_time ? " " + String(r.record_time).slice(0, 5) : "") +
        " • Driver: " + (r.driver_name || "") +
        (r.company_name ? " • Company: " + r.company_name : "") +
        oneName +
        (r.diesel_temperature != null ? " • Temp: " + fmtCsvNum(r.diesel_temperature) + "°C" : "") +
        (r.diesel_density_g_per_l != null ? " • Density: " + fmtCsvNum(r.diesel_density_g_per_l) : "") +
        (r._pending ? " • ⏳ Sync pending" : "");
      item.appendChild(top);
      item.appendChild(meta);
      // Edit/Delete sirf apne record par — doosre user ka record par
      // ye buttons kabhi render hi nahi honge. Asli rok database ki
      // RLS policy hai (owner_id = auth.uid()), ye sirf UI hai.
      if (isOwnRecord(r)) {
        var actions = document.createElement("div");
        actions.className = "rec-actions";
        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", function () { startEdit(r); });
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "rec-del";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", function () { deleteRecord(r); });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        item.appendChild(actions);
      }
      list.appendChild(item);
    });
  }
  function startEdit(r) {
    if (!isOwnRecord(r)) {
      recMsg("Sirf apna record edit ho sakta hai.", false);
      return;
    }
    editingRecordId = r.id;
    $("recVehicle").value = r.vehicle_number || "";
    $("recDriver").value = r.driver_name || "";
    $("recCompany").value = r.company_name || "";
    $("recDate").value = r.record_date || "";
    $("recTime").value = r.record_time ? String(r.record_time).slice(0, 5) : "";
    $("recLitres").value = r.diesel_litres != null ? r.diesel_litres : "";
    $("recKg").value = r.diesel_kg != null ? r.diesel_kg : "";
    $("recTemp").value = r.diesel_temperature != null ? r.diesel_temperature : "";
    $("recDensity").value = r.diesel_density_g_per_l != null ? r.diesel_density_g_per_l : "";
    $("recSaveBtn").textContent = "Record Update Karein";
    $("recCancelEditBtn").hidden = false;
    recMsg("Edit mode: apna record update karein, phir Record Update Karein dabayein.", true);
    $("recVehicle").focus();
  }
  function deleteRecord(r) {
    if (!isOwnRecord(r)) {
      recMsg("Sirf apna record delete ho sakta hai.", false);
      return;
    }
    if (!window.confirm("Ye record pakka delete karna hai?")) return;
    var op = { kind: "delete", id: r.id };
    trySendOp(op).then(function (res) {
      if (!res.failed) {
        recMsg("Record delete ho gaya.", true);
        if (editingRecordId === r.id) cancelEdit();
        loadRecords();
        return;
      }
      var q = queueOp(op);
      if (q === "dropped") {
        // Pending create hi tha — server par gaya hi nahi tha.
        applyOutboxToList();
        renderPickers();
        renderRecList();
        recMsg("Record delete ho gaya (offline — abhi server par save hi nahi hua tha).", true);
        if (editingRecordId === r.id) cancelEdit();
        return;
      }
      applyOutboxToList();
      renderPickers();
      renderRecList();
      if (editingRecordId === r.id) cancelEdit();
      recMsg(!navigator.onLine || res.status === 0
        ? "Internet nahi hai — record delete queue mein hai, internet aate hi sync hoga."
        : "Record delete queue mein hai — internet/database theek hote hi sync hoga.", false);
    });
  }
  $("recCancelEditBtn").addEventListener("click", function () {
    cancelEdit();
    $("recVehicle").value = "";
    $("recDriver").value = "";
    $("recCompany").value = "";
    $("recLitres").value = "";
    $("recKg").value = "";
    $("recTemp").value = "";
    $("recDensity").value = "";
    recMsg("", true);
  });
  function fetchRecordsRows() {
    return recApi("/diesel_records?select=*&order=record_date.desc,created_at.desc&limit=1000")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
  }
  function loadRecords() {
    if (!recConfigured) { renderRecList(); return; }
    fetchRecordsRows()
      .then(function (rows) {
        serverRecords = rows || [];
        saveRecCache();
        applyOutboxToList();
        renderPickers();
        renderRecList();
      })
      .catch(function () {
        if (!navigator.onLine) {
          // Offline: aakhri saved list cache se dikhayein (visitor ko bhi).
          if (!serverRecords.length) {
            var cached = loadRecCache();
            if (cached) serverRecords = cached;
          }
          applyOutboxToList();
          renderPickers();
          renderRecList();
          recMsg(serverRecords.length
            ? "Internet nahi hai — aakhri saved records dikhaye ja rahe hain."
            : "Internet nahi hai — records dekhne ke liye online hona zaroori hai.", false);
        } else {
          recMsg("Records load nahi hue — database/table check karein.", false);
          renderRecList();
        }
        updateOfflineBadge();
      });
  }
  // Auto-sync: sheet khuli ho to list khud-ba-khud update hogi,
  // refresh dabane ki zaroorat nahi. Har 3 second me database se
  // chup-chaap check hota hai; dobara render SIRF tab jab data badla
  // ho (na filter badalta hai, na search, na khula hua form).
  // Ownership ID se pehchani jati hai (owner_id = login wali ID),
  // is liye jis marzi device se usi ID se login ho, us ke apne
  // records par Edit/Delete khud aa jayenge.
  var recSyncTimer = null;
  function recordsSignature(rows) {
    return (rows || []).map(function (r) {
      return [r.id, r.record_date, r.record_time, r.vehicle_number,
        r.driver_name, r.company_name, r.receiver_name, r.saved_by_name,
        r.diesel_litres, r.diesel_kg, r.diesel_temperature,
        r.diesel_density_g_per_l, r.owner_id].join("|");
    }).join("\n");
  }
  var recSyncBusy = false;
  function syncRecords() {
    if (!recConfigured || recOverlay.hidden || recSyncBusy) return;
    recSyncBusy = true;
    // Pehle outbox flush (internet aate hi queued ops sync hon), phir
    // server se taaza list — signature ka mawazna SIRF server list se,
    // warna pending overlay har cycle me dobara render karwayega.
    flushOutbox()
      .then(function () { return fetchRecordsRows(); })
      .then(function (rows) {
        rows = rows || [];
        if (recordsSignature(rows) !== recordsSignature(serverRecords)) {
          serverRecords = rows;
          saveRecCache();
          applyOutboxToList();
          renderPickers();
          renderRecList();
        }
      })
      .catch(function () { /* khamoshi: agla cycle phir try karega */ })
      .then(function () { recSyncBusy = false; });
  }
  function startRecordSync() {
    stopRecordSync();
    recSyncTimer = setInterval(syncRecords, 3000);
  }
  function stopRecordSync() {
    if (recSyncTimer) { clearInterval(recSyncTimer); recSyncTimer = null; }
  }
  // Tab par wapas aate hi fori check (doosri device/tab se login ya
  // record ke baad bhi refresh ki zaroorat nahi).
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) syncRecords();
  });
  window.addEventListener("focus", function () { syncRecords(); });
  window.addEventListener("online", function () {
    updateOfflineBadge();
    flushOutbox(true);
    syncRecords();
  });
  window.addEventListener("offline", function () { updateOfflineBadge(); });
  function openRecords() {
    recOverlay.hidden = false;
    $("recSetupNote").hidden = recConfigured;
    renderAuth();
    if (recConfigured) { authKeep(false); authValidate(); }
    if (!$("recDate").value) $("recDate").value = localISODate(new Date());
    if (!$("recTime").value) {
      var now = new Date();
      var hh = String(now.getHours());
      if (hh.length < 2) hh = "0" + hh;
      var mm = String(now.getMinutes());
      if (mm.length < 2) mm = "0" + mm;
      $("recTime").value = hh + ":" + mm;
    }
    // Temp + Density: dono fields poori tarah independent — user khud likhe;
    // converter se koi auto-fill nahi (khaali ho to save par null jayega).
    // Pehle queued ops sync hon, phir taaza list aaye.
    flushOutbox(true).then(function () { loadRecords(); });
    startRecordSync();
    updateOfflineBadge();
  }
  function closeRecords() { recOverlay.hidden = true; stopRecordSync(); maybeAutoReload(); }
  $("openRecords").addEventListener("click", openRecords);
  $("closeRecords").addEventListener("click", closeRecords);
  recOverlay.addEventListener("click", function (ev) {
    if (ev.target === recOverlay) closeRecords();
  });

  // Record form me koi auto calculation nahi: user Litres aur KG
  // dono khud likhega. (Upar wala converter apni jagah auto hi rahega.)
  $("authPwToggle").addEventListener("click", function () {
    var pw = $("authPassword");
    var show = pw.type === "password";
    pw.type = show ? "text" : "password";
    $("authPwToggle").textContent = show ? "🙈" : "👁️";
    $("authPwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
    pw.focus();
  });
  $("authLoginBtn").addEventListener("click", function () {
    if (!recConfigured) { authMsg("Database setup pending — pehle Supabase set karein.", false); return; }    var email = $("authEmail").value.trim();
    var password = $("authPassword").value;
    if (!email || !password) { authMsg("Email aur password zaroori hain.", false); return; }
    authCall("/token?grant_type=password", { email: email, password: password })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (s) {
        authSaveSession(authStamp(s));
        authMsg("Login ho gaya.", true);
        renderAuth();
        loadRecords();
      })
      .catch(function () {
        authMsg(!navigator.onLine
          ? "Internet nahi hai — login ke liye online hona zaroori hai."
          : "Login nahi hua — email/password check karein.", false);
      });
  });
  $("authLogoutBtn").addEventListener("click", function () {
    if (authSession && authSession.access_token) {
      authCall("/logout", {}, authSession.access_token).catch(function () { /* ignore */ });
    }
    authSaveSession(null);
    authMsg("Logout ho gaya.", true);
    renderAuth();
    renderRecList();
  });
  $("authSaveNameBtn").addEventListener("click", function () {
    var nameEl = $("authNameMsg");
    var name = $("authRealName").value.trim();
    if (!name) {
      nameEl.textContent = "Apna real naam likhein.";
      nameEl.className = "form-msg err";
      return;
    }
    if (!authSession || !authSession.access_token) return;
    var cfg = window.DIESEL_CONFIG;
    fetch(cfg.SUPABASE_URL + "/auth/v1/user", {
      method: "PUT",
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + authSession.access_token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ data: { full_name: name } })
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (user) {
      authSession.user = user;
      authSaveSession(authSession);
      nameEl.textContent = "Naam save ho gaya — ab har record me yehi naam aayega.";
      nameEl.className = "form-msg ok";
      renderAuth();
      renderRecList();
    }).catch(function () {
      nameEl.textContent = !navigator.onLine
        ? "Internet nahi hai — naam save karne ke liye online hona zaroori hai."
        : "Naam save nahi hua — dobara try karein.";
      nameEl.className = "form-msg err";
    });
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
    // Real name ke baghair save bilkul nahi: warna trigger ka email
    // fallback phir By me mail le aayega. Naam set karein, phir save.
    if (!authHasRealName()) {
      recMsg("Pehle apna real naam set karein — upar naam wale box me naam likhein, phir record save karein. Email se record save nahi hoga.", false);
      if (!$("authNameSetup").hidden) $("authRealName").focus();
      return;
    }
    var vehicle = $("recVehicle").value.trim();
    var driver = $("recDriver").value.trim();
    var date = $("recDate").value;
    var litres = toNum($("recLitres").value);
    var kg = toNum($("recKg").value);
    // v17: Temperature (°C) + Density (g/L) — dono optional; khaali ho to
    // null save hoga (report mein "—"). Density 0 ya manfi nahi ho sakti.
    var tempRaw = toNum($("recTemp").value);
    var densRaw = toNum($("recDensity").value);
    var tempVal = isNum(tempRaw) ? tempRaw : null;
    var densVal = (isNum(densRaw) && densRaw > 0) ? densRaw : null;
    // Litres ya KG me se kam az kam ek: dono ki pabandi khatam. Jo khaali
    // rahega us me 0 save hoga (koi field empty nahi rahegi) aur koi auto
    // calculation nahi hogi — doosri value khud likhni hogi.
    var hasLitres = isNum(litres) && litres > 0;
    var hasKg = isNum(kg) && kg > 0;
    if (!vehicle || !driver || !date || (!hasLitres && !hasKg)) {
      recMsg("Vehicle, Driver, Date zaroori hain, aur Litres ya KG me se kam az kam ek value zaroori hai.", false);
      return;
    }
    // Receiver box khatam: receiver seedha logged-in user ka real naam.
    var row = {
      vehicle_number: vehicle,
      driver_name: driver,
      company_name: $("recCompany").value.trim() || null,
      receiver_name: authName(),
      record_date: date,
      record_time: $("recTime").value || null,
      diesel_litres: hasLitres ? litres : 0,
      diesel_kg: hasKg ? kg : 0,
      diesel_temperature: tempVal,
      diesel_density_g_per_l: densVal,
      saved_by_name: authName()
    };
    $("recSaveBtn").disabled = true;
    var isEdit = !!editingRecordId;
    var op;
    if (isEdit) {
      op = { kind: "update", id: editingRecordId, row: row };
    } else {
      row.id = newClientId();
      row.owner_id = authSession.user ? authSession.user.id : null;
      op = { kind: "create", id: row.id, row: row };
    }
    trySendOp(op)
      .then(function (r) {
        if (!r.failed) {
          recMsg(isEdit ? "Record update ho gaya." : "Record save ho gaya.", true);
          cancelEdit();
          $("recLitres").value = "";
          $("recKg").value = "";
          loadRecords();
          return;
        }
        // Bheja nahi gaya (offline ya server error) — queue mein daalein,
        // record kabhi zaya nahi hoga. Form khaali kar dein (values outbox
        // mein mehfooz hain) taake agla record likha ja sake.
        queueOp(op);
        applyOutboxToList();
        renderPickers();
        renderRecList();
        cancelEdit();
        $("recLitres").value = "";
        $("recKg").value = "";
        if (!navigator.onLine || r.status === 0) {
          recMsg(isEdit
            ? "Internet nahi hai — record update queue mein hai, internet aate hi sync hoga."
            : "Internet nahi hai — record save ho gaya (offline), internet aate hi sync hoga.", false);
        } else if (r.status >= 400 && r.status < 500) {
          recMsg("Database ne record reject kiya (HTTP " + r.status + ") — record queue mein mehfooz hai, admin se SQL check karwayein.", false);
        } else {
          recMsg("Sync ruk gaya — record queue mein mehfooz hai, internet aate hi dobara hoga.", false);
        }
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
  function escHtml(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // v25 (2026-11-19): HTML report = Excel template ka MIRROR — title
  // "Incoming Diesel" (gray125), 2-row header + Diesel group,
  // Temp/Density Litres/KG se PEHLE, date d-mmm-yy, time h:mm AM/PM,
  // Density 0.000, Litres/KG General (5000, not 5000.00), Total row
  // DDEBF7, widths Excel ke proportional. Saved By KHATAM, subtitle
  // khatam. Print button + @page landscape barkarar.
  function fmtDateShort(iso) {
    var p = String(iso || "").split("-");
    if (p.length < 3) return "";
    var m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(p[1], 10) - 1];
    if (!m) return "";
    return parseInt(p[2], 10) + "-" + m + "-" + String(p[0]).slice(-2);
  }
  function fmtTime12(t) {
    var p = String(t || "").split(":");
    if (p.length < 2) return "";
    var h = parseInt(p[0], 10), m = p[1].slice(0, 2);
    if (isNaN(h) || isNaN(parseInt(m, 10))) return "";
    var ap = h < 12 ? "AM" : "PM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + m + " " + ap;
  }
  function buildReportHTML(rows) {
    rows = sortRowsAsc(rows); // v25: oldest first (Boss order 19 Nov 21:36 PKT)
    var tot = sumTotals(rows);
    var trs = rows.map(function (r) {
      var dens = (r.diesel_density_g_per_l == null || isNaN(Number(r.diesel_density_g_per_l))) ? "" : Number(r.diesel_density_g_per_l).toFixed(3);
      return "<tr><td>" + escHtml(fmtDateShort(r.record_date)) + "</td><td>" + escHtml(fmtTime12(r.record_time)) + "</td><td>" + escHtml(r.vehicle_number || "") + "</td><td>" + escHtml(r.driver_name || "") + "</td><td>" + escHtml(r.company_name || "") + "</td><td>" + escHtml(r.receiver_name || "") + "</td><td>" + (r.diesel_temperature == null ? "" : escHtml(fmtCsvNum(r.diesel_temperature)) + "°C") + "</td><td>" + escHtml(dens) + "</td><td>" + escHtml(fmtCsvNum(r.diesel_litres)) + "</td><td>" + escHtml(fmtCsvNum(r.diesel_kg)) + "</td></tr>";
    }).join("");
    if (!trs) trs = "<tr><td colspan=\"10\" class=\"empty\">Koi record nahi mila.</td></tr>";
    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Incoming Diesel</title><style>"
      + "body{font-family:Calibri,Arial,sans-serif;margin:0;background:#fff;color:#000}"
      + "table{width:100%;min-width:900px;border-collapse:collapse;background:#fff;table-layout:fixed}"
      + ".table-wrap{overflow-x:auto}"
      + "td,th{border:1px solid #000;text-align:center;vertical-align:middle;font-size:12px;line-height:1.25;padding:3px 6px;overflow-wrap:anywhere}"
      + "td.title-cell{font-size:16px;font-weight:700;background-color:#fff;background-image:radial-gradient(#7f7f7f .8px,transparent 1px);background-size:4px 4px;padding:5px 8px}"
      + "thead th{font-weight:700;background:#fff}"
      + "thead tr.hrow1 th{position:sticky;top:0;z-index:1}"
      + "thead tr.hrow2 th{position:sticky;top:21px;z-index:1}"
      + "tbody tr:hover td{background:#f2f7f2}"
      + "tr{break-inside:avoid}"
      + "tfoot td{background:#ddebf7;font-weight:700}"
      + ".empty{text-align:center;opacity:.7;padding:24px}"
      + ".print-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 32px;background:#fff;border-bottom:1px solid #d8e2da}.print-bar button{background:#0b3d20;color:#fff;border:1px solid #0b3d20;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer}.print-bar button:active{background:#14532d}"
      + "@media (max-width:600px){.print-bar{padding:12px 16px}td,th{padding:3px 4px}}"
      + "@media print{@page{size:landscape;margin:14mm}body{background:#fff}.print-bar{display:none!important}.table-wrap{overflow:visible}table{min-width:0}thead{display:table-header-group}tfoot{display:table-footer-group}td.title-cell,th,tfoot td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}"
      + "</style></head><body>"
      + "<div class=\"print-bar\"><button type=\"button\" onclick=\"window.print()\">Print Karein / PDF Save Karein</button></div>"
      + "<div class=\"table-wrap\"><table><colgroup><col style=\"width:8.8%\"><col style=\"width:9.3%\"><col style=\"width:7.7%\"><col style=\"width:9.7%\"><col style=\"width:19.4%\"><col style=\"width:14.7%\"><col style=\"width:6%\"><col style=\"width:7.3%\"><col style=\"width:8.8%\"><col style=\"width:8.3%\"></colgroup>"
      + "<thead><tr><td colspan=\"10\" class=\"title-cell\">Incoming Diesel</td></tr><tr class=\"hrow1\"><th rowspan=\"2\">Date</th><th rowspan=\"2\">Time</th><th rowspan=\"2\">Vehicle</th><th rowspan=\"2\">Driver</th><th rowspan=\"2\">Company</th><th rowspan=\"2\">Receiver</th><th colspan=\"4\">Diesel</th></tr><tr class=\"hrow2\"><th>Temp</th><th>Density</th><th>Litres</th><th>KG's</th></tr></thead>"
      + "<tbody>" + trs + "</tbody>"
      + "<tfoot><tr><td colspan=\"8\">Total</td><td>" + escHtml(fmtCsvNum(tot.litres)) + "</td><td>" + escHtml(fmtCsvNum(tot.kg)) + "</td></tr></tfoot></table></div>"
      + "</body></html>";
  }
  $("recReport").addEventListener("click", function () {
    var html = buildReportHTML(recShown);
    var blob = new Blob([html], { type: "text/html;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diesel-report.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  $("recDownload").addEventListener("click", function () {
    var blob = buildReportXlsx(recShown);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diesel-records.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  /* ----- service worker auto-update: naya version khud lagao ----- */
  /* Koi cache clear / reload nahi: naya SW milte hi page khud refresh ho
     jata hai. Sirf ek ehtiyat: agar Record ya Calculator sheet khuli ho
     (aadha likha record na khoye) to refresh sheet band hote hi hota hai.
     Pehli install par reload nahi hota (swHadController guard). */
  var swHadController = false;
  var swReloaded = false;
  var swUpdatePending = false;
  function swOverlayOpen() {
    return !recOverlay.hidden || !calcOverlay.hidden;
  }
  function maybeAutoReload() {
    if (swReloaded) return;
    if (swOverlayOpen()) { swUpdatePending = true; return; }
    swReloaded = true;
    swUpdatePending = false;
    location.reload();
  }
  if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) {
    swHadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .then(function (reg) {
        function checkUpdate() {
          if (reg && reg.update) reg.update().catch(function () {});
          if (swUpdatePending) maybeAutoReload();
        }
        checkUpdate();
        document.addEventListener("visibilitychange", function () { if (!document.hidden) checkUpdate(); });
        window.addEventListener("focus", checkUpdate);
        setInterval(checkUpdate, 60000);
      })
      .catch(function () { /* offline support is optional */ });
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swHadController) maybeAutoReload();
    });
  }

  /* ----- initial render ----- */
  applySample();
  calcRender();

  /* ----- session keeper (infinity session): token khatam hone se
     pehle refresh — app khula ho to har 20 min check, tab wapas
     aane / online hone / focus par bhi, aur boot par fori. ----- */
  authKeep(true);
  setInterval(function () { authKeep(true); }, 20 * 60 * 1000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) authKeep(true); });
  window.addEventListener("online", function () { authKeep(true); });
  window.addEventListener("focus", function () { authKeep(true); });
})();
