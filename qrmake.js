/*
 * qrmake.js
 * A small QR code maker written for the Year 1 Scan and Watch teacher page.
 * No outside code and no network access. Makes QR versions 1 to 10 in byte mode.
 *
 * Use: makeQR(text, level) where level is 'L', 'M', 'Q' or 'H' (default 'M').
 * Returns { size, dark(x, y) } or throws if the text is too long.
 */
(function (root) {
  'use strict';

  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }

  /* Per version, for levels L, M, Q, H: [error codewords per block, blocks A, data per block A, blocks B, data per block B] */
  var BLOCKS = [null,
    [[7,1,19,0,0],[10,1,16,0,0],[13,1,13,0,0],[17,1,9,0,0]],
    [[10,1,34,0,0],[16,1,28,0,0],[22,1,22,0,0],[28,1,16,0,0]],
    [[15,1,55,0,0],[26,1,44,0,0],[18,2,17,0,0],[22,2,13,0,0]],
    [[20,1,80,0,0],[18,2,32,0,0],[26,2,24,0,0],[16,4,9,0,0]],
    [[26,1,108,0,0],[24,2,43,0,0],[18,2,15,2,16],[22,2,11,2,12]],
    [[18,2,68,0,0],[16,4,27,0,0],[24,4,19,0,0],[28,4,15,0,0]],
    [[20,2,78,0,0],[18,4,31,0,0],[18,2,14,4,15],[26,4,13,1,14]],
    [[24,2,97,0,0],[22,2,38,2,39],[22,4,18,2,19],[26,4,14,2,15]],
    [[30,2,116,0,0],[22,3,36,2,37],[20,4,16,4,17],[24,4,12,4,13]],
    [[18,2,68,2,69],[26,4,43,1,44],[24,6,19,2,20],[28,6,15,2,16]]
  ];
  var ALIGN = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42], [6,26,46], [6,28,50]];
  var LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  var LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(text));
    var s = unescape(encodeURIComponent(text)), out = [], i;
    for (i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function rsEncode(data, ecLen) {
    var gen = [1], i, j;
    for (i = 0; i < ecLen; i++) {
      var next = new Array(gen.length + 1).fill(0);
      for (j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= gmul(gen[j], EXP[i]); }
      gen = next;
    }
    var rem = new Array(ecLen).fill(0);
    for (i = 0; i < data.length; i++) {
      var f = data[i] ^ rem[0];
      rem.shift(); rem.push(0);
      if (f) for (j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], f);
    }
    return rem;
  }

  /* Remainder of value shifted up by degree, divided by poly (a BCH check code). */
  function bch(value, poly, degree) {
    var v = value << degree, i;
    for (i = 30; i >= degree; i--) if ((v >> i) & 1) v ^= poly << (i - degree);
    return v;
  }

  function maskBit(mask, i, j) {
    switch (mask) {
      case 0: return (i + j) % 2 === 0;
      case 1: return i % 2 === 0;
      case 2: return j % 3 === 0;
      case 3: return (i + j) % 3 === 0;
      case 4: return (((i >> 1) + Math.floor(j / 3)) % 2) === 0;
      case 5: return ((i * j) % 2 + (i * j) % 3) === 0;
      case 6: return (((i * j) % 2 + (i * j) % 3) % 2) === 0;
      default: return (((i + j) % 2 + (i * j) % 3) % 2) === 0;
    }
  }

  function penalty(M, dim) {
    var score = 0, x, y, run, i;
    function at(a, b) { return M[b * dim + a]; }
    for (y = 0; y < dim; y++) {
      run = 1;
      for (x = 1; x <= dim; x++) {
        if (x < dim && at(x, y) === at(x - 1, y)) run++;
        else { if (run >= 5) score += 3 + run - 5; run = 1; }
      }
    }
    for (x = 0; x < dim; x++) {
      run = 1;
      for (y = 1; y <= dim; y++) {
        if (y < dim && at(x, y) === at(x, y - 1)) run++;
        else { if (run >= 5) score += 3 + run - 5; run = 1; }
      }
    }
    for (y = 0; y < dim - 1; y++) for (x = 0; x < dim - 1; x++) {
      var c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
    var pat = [1, 0, 1, 1, 1, 0, 1], dirs = [[1, 0], [0, 1]], d;
    for (d = 0; d < 2; d++) for (y = 0; y < dim; y++) for (x = 0; x < dim; x++) {
      var dx = dirs[d][0], dy = dirs[d][1], ex = x + dx * 6, ey = y + dy * 6;
      if (ex >= dim || ey >= dim) continue;
      var ok = true;
      for (i = 0; i < 7; i++) if (at(x + dx * i, y + dy * i) !== pat[i]) { ok = false; break; }
      if (!ok) continue;
      var before = true, after = true;
      for (i = 1; i <= 4; i++) {
        var bx = x - dx * i, by = y - dy * i, axx = ex + dx * i, ayy = ey + dy * i;
        if (bx < 0 || by < 0 || bx >= dim || by >= dim || at(bx, by) !== 0) before = false;
        if (axx >= dim || ayy >= dim || at(axx, ayy) !== 0) after = false;
      }
      if (before) score += 40;
      if (after) score += 40;
    }
    var dark = 0;
    for (i = 0; i < M.length; i++) dark += M[i];
    score += Math.floor(Math.abs(dark * 100 / M.length - 50) / 5) * 10;
    return score;
  }

  function makeQR(text, level) {
    level = level || 'M';
    var li = LEVEL_INDEX[level];
    if (li === undefined) throw new Error('Unknown error correction level');
    var bytes = utf8(text), version, tb, i, j, k;
    for (version = 1; version <= 10; version++) {
      tb = BLOCKS[version][li];
      var cap = tb[1] * tb[2] + tb[3] * tb[4];
      var ccBits = version < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= cap * 8) break;
    }
    if (version > 10) throw new Error('That link is too long for a QR code here. Try a shorter one.');
    var dim = 17 + 4 * version, ecLen = tb[0];
    var blocks = [];
    for (i = 0; i < tb[1]; i++) blocks.push(tb[2]);
    for (i = 0; i < tb[3]; i++) blocks.push(tb[4]);
    var dataCw = 0; for (i = 0; i < blocks.length; i++) dataCw += blocks[i];

    /* data bits */
    var bits = [];
    function put(v, n) { for (var b = n - 1; b >= 0; b--) bits.push((v >> b) & 1); }
    put(4, 4); put(bytes.length, version < 10 ? 8 : 16);
    for (i = 0; i < bytes.length; i++) put(bytes[i], 8);
    for (i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (i = 0; i < bits.length; i += 8) { var v = 0; for (j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    for (i = 0; cw.length < dataCw; i++) cw.push(i % 2 ? 0x11 : 0xEC);

    /* blocks, error correction and interleaving */
    var dataBlocks = [], ecBlocks = [], pos = 0;
    for (i = 0; i < blocks.length; i++) {
      var d = cw.slice(pos, pos + blocks[i]); pos += blocks[i];
      dataBlocks.push(d); ecBlocks.push(rsEncode(d, ecLen));
    }
    var final = [], maxData = Math.max(tb[2], tb[4] || 0);
    for (i = 0; i < maxData; i++) for (k = 0; k < blocks.length; k++) if (i < blocks[k]) final.push(dataBlocks[k][i]);
    for (i = 0; i < ecLen; i++) for (k = 0; k < blocks.length; k++) final.push(ecBlocks[k][i]);
    var stream = [];
    for (i = 0; i < final.length; i++) for (j = 7; j >= 0; j--) stream.push((final[i] >> j) & 1);

    /* function patterns */
    var M = new Uint8Array(dim * dim), F = new Uint8Array(dim * dim);
    function setF(x, y, v) { if (x >= 0 && y >= 0 && x < dim && y < dim) { M[y * dim + x] = v; F[y * dim + x] = 1; } }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var m = Math.max(Math.abs(dx), Math.abs(dy));
        setF(cx + dx, cy + dy, (m === 4 || m === 2) ? 0 : 1);
      }
    }
    finder(3, 3); finder(dim - 4, 3); finder(3, dim - 4);
    for (i = 8; i < dim - 8; i++) { setF(i, 6, i % 2 === 0 ? 1 : 0); setF(6, i, i % 2 === 0 ? 1 : 0); }
    var ap = ALIGN[version];
    for (i = 0; i < ap.length; i++) for (j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (var ay = -2; ay <= 2; ay++) for (var ax = -2; ax <= 2; ax++) {
        var mm = Math.max(Math.abs(ax), Math.abs(ay));
        setF(ap[i] + ax, ap[j] + ay, mm === 1 ? 0 : 1);
      }
    }
    for (i = 0; i < 9; i++) { if (!F[8 * dim + i]) setF(i, 8, 0); if (!F[i * dim + 8]) setF(8, i, 0); }
    for (i = 0; i < 8; i++) { setF(dim - 1 - i, 8, 0); if (i < 7) setF(8, dim - 1 - i, 0); }
    setF(8, dim - 8, 1);
    if (version >= 7) {
      var vinfo = (version << 12) | bch(version, 0x1F25, 12);
      for (i = 0; i < 18; i++) {
        var bit = (vinfo >> i) & 1;
        setF(i % 3 + dim - 11, Math.floor(i / 3), bit);
        setF(Math.floor(i / 3), i % 3 + dim - 11, bit);
      }
    }

    /* place data in the zigzag order */
    var order = [], up = true, x, y, vert, dx2;
    for (x = dim - 1; x > 0; x -= 2) {
      if (x === 6) x = 5;
      for (vert = 0; vert < dim; vert++) {
        y = up ? dim - 1 - vert : vert;
        for (dx2 = 0; dx2 < 2; dx2++) if (!F[y * dim + x - dx2]) order.push([x - dx2, y]);
      }
      up = !up;
    }

    /* pick the mask with the lowest penalty */
    var best = null, bestScore = 1e9, bestMask = 0, mask;
    for (mask = 0; mask < 8; mask++) {
      var T = M.slice();
      for (i = 0; i < order.length; i++) {
        var bitv = i < stream.length ? stream[i] : 0;
        T[order[i][1] * dim + order[i][0]] = bitv ^ (maskBit(mask, order[i][1], order[i][0]) ? 1 : 0);
      }
      var fmt = (LEVEL_BITS[level] << 3) | mask;
      var fbits = ((fmt << 10) | bch(fmt, 0x537, 10)) ^ 0x5412;
      var p1 = [[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]];
      for (i = 0; i < 15; i++) T[p1[i][1] * dim + p1[i][0]] = (fbits >> (14 - i)) & 1;
      for (i = 0; i < 7; i++) T[(dim - 1 - i) * dim + 8] = (fbits >> (14 - i)) & 1;
      for (i = 7; i < 15; i++) T[8 * dim + (dim - 15 + i)] = (fbits >> (14 - i)) & 1;
      var sc = penalty(T, dim);
      if (sc < bestScore) { bestScore = sc; best = T; bestMask = mask; }
    }
    var out = best;
    return { size: dim, version: version, mask: bestMask, dark: function (x, y) { return out[y * dim + x] === 1; } };
  }

  /* An SVG string with a four module quiet zone, ready to drop into a page. */
  function qrSvg(text, level) {
    var q = makeQR(text, level), n = q.size + 8, d = '', x, y;
    for (y = 0; y < q.size; y++) {
      var x0 = -1;
      for (x = 0; x <= q.size; x++) {
        var on = x < q.size && q.dark(x, y);
        if (on && x0 < 0) x0 = x;
        if (!on && x0 >= 0) { d += 'M' + (x0 + 4) + ' ' + (y + 4) + 'h' + (x - x0) + 'v1h-' + (x - x0) + 'z'; x0 = -1; }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  root.makeQR = makeQR;
  root.qrSvg = qrSvg;
  if (typeof module !== 'undefined' && module.exports) module.exports = { makeQR: makeQR, qrSvg: qrSvg };
})(typeof window !== 'undefined' ? window : this);
