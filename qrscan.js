/*
 * qrscan.js
 * A small QR code reader written for the Year 1 Scan and Watch page.
 * No outside code and no network access. Reads QR versions 1 to 10 (byte, alphanumeric and numeric modes).
 *
 * Use: decodeQR(rgbaPixels, width, height) returns the text in the code, or null.
 */
(function (root) {
  'use strict';

  /* ---------- Reed-Solomon over GF(256) ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function ginv(a) { return EXP[255 - LOG[a]]; }

  /* Corrects cw (data then error codewords) in place. Returns false if it cannot be fixed. */
  function rsCorrect(cw, nsym) {
    var n = cw.length, syn = [], any = false, i, j, k;
    for (j = 0; j < nsym; j++) {
      var s = 0;
      for (i = 0; i < n; i++) s = gmul(s, EXP[j]) ^ cw[i];
      syn.push(s);
      if (s) any = true;
    }
    if (!any) return true;

    var C = [1], B = [1], L = 0, m = 1, b = 1, coef, T;
    for (var nn = 0; nn < nsym; nn++) {
      var d = syn[nn];
      for (i = 1; i <= L; i++) d ^= gmul(C[i] || 0, syn[nn - i]);
      if (d === 0) { m++; continue; }
      coef = gmul(d, ginv(b));
      if (2 * L <= nn) {
        T = C.slice();
        while (C.length < B.length + m) C.push(0);
        for (i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
        L = nn + 1 - L; B = T; b = d; m = 1;
      } else {
        while (C.length < B.length + m) C.push(0);
        for (i = 0; i < B.length; i++) C[i + m] ^= gmul(coef, B[i]);
        m++;
      }
    }
    while (C.length <= L) C.push(0);
    if (L * 2 > nsym) return false;

    var locs = [];
    for (var p = 0; p < n; p++) {
      var v = 0;
      for (k = 0; k <= L; k++) if (C[k]) v ^= gmul(C[k], EXP[(255 - (p * k) % 255) % 255]);
      if (v === 0) locs.push(p);
    }
    if (locs.length !== L) return false;

    var omega = [];
    for (i = 0; i < nsym; i++) {
      var o = 0;
      for (j = 0; j <= i; j++) if (j <= L) o ^= gmul(C[j], syn[i - j]);
      omega.push(o);
    }
    for (i = 0; i < locs.length; i++) {
      var pw = locs[i], xinv = EXP[(255 - pw) % 255];
      var num = 0, den = 0, xp = 1;
      for (k = 0; k < nsym; k++) { num ^= gmul(omega[k], xp); xp = gmul(xp, xinv); }
      xp = 1;
      for (k = 1; k <= L; k += 2) { den ^= gmul(C[k], xp); xp = gmul(xp, gmul(xinv, xinv)); }
      if (den === 0) return false;
      cw[n - 1 - pw] ^= gmul(gmul(EXP[pw], num), ginv(den));
    }
    return true;
  }

  /* ---------- QR tables ---------- */
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
  var EC_FROM_BITS = [1, 0, 3, 2]; /* format bits 00,01,10,11 map to M,L,H,Q (index into BLOCKS levels L,M,Q,H) */
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function fmtBch(d) {
    var v = d << 10, i;
    for (i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0x537 << (i - 10);
    return (d << 10) | v;
  }
  var FORMATS = [];
  (function () { for (var d = 0; d < 32; d++) FORMATS.push(fmtBch(d) ^ 0x5412); })();
  function popcount(x) { var c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

  function readFormat(M, dim) {
    function g(x, y) { return M[y * dim + x]; }
    var a = 0, b = 0, i, j;
    for (i = 0; i < 6; i++) a = (a << 1) | g(i, 8);
    a = (a << 1) | g(7, 8); a = (a << 1) | g(8, 8); a = (a << 1) | g(8, 7);
    for (j = 5; j >= 0; j--) a = (a << 1) | g(8, j);
    for (j = dim - 1; j >= dim - 7; j--) b = (b << 1) | g(8, j);
    for (i = dim - 8; i < dim; i++) b = (b << 1) | g(i, 8);
    var best = -1, bestD = 99;
    for (i = 0; i < 32; i++) {
      var d = Math.min(popcount(a ^ FORMATS[i]), popcount(b ^ FORMATS[i]));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 3) return null;
    return { ec: EC_FROM_BITS[best >> 3], mask: best & 7 };
  }

  function functionMask(dim, version) {
    var F = new Uint8Array(dim * dim), x, y, i, j;
    function fill(x0, y0, x1, y1) {
      for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) if (xx >= 0 && yy >= 0 && xx < dim && yy < dim) F[yy * dim + xx] = 1;
    }
    fill(0, 0, 8, 8); fill(dim - 8, 0, dim - 1, 8); fill(0, dim - 8, 8, dim - 1);
    fill(6, 0, 6, dim - 1); fill(0, 6, dim - 1, 6);
    var pos = ALIGN[version];
    for (i = 0; i < pos.length; i++) for (j = 0; j < pos.length; j++) {
      var cx = pos[i], cy = pos[j];
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      fill(cx - 2, cy - 2, cx + 2, cy + 2);
    }
    if (version >= 7) { fill(dim - 11, 0, dim - 9, 5); fill(0, dim - 11, 5, dim - 9); }
    return F;
  }

  function maskBit(mask, i, j) { /* i = row, j = column */
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

  function parseStream(bytes, version) {
    var pos = 0, total = bytes.length * 8, out = [], i;
    var cc = version < 10 ? [10, 9, 8] : [12, 11, 16];
    function read(n) {
      if (pos + n > total) throw 0;
      var v = 0;
      for (var k = 0; k < n; k++) { v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1); pos++; }
      return v;
    }
    function pushStr(s) { for (var k = 0; k < s.length; k++) out.push(s.charCodeAt(k)); }
    try {
      while (pos + 4 <= total) {
        var mode = read(4), n;
        if (mode === 0) break;
        if (mode === 1) {
          n = read(cc[0]);
          while (n >= 3) { pushStr(('000' + read(10)).slice(-3)); n -= 3; }
          if (n === 2) pushStr(('00' + read(7)).slice(-2));
          else if (n === 1) pushStr(String(read(4)));
        } else if (mode === 2) {
          n = read(cc[1]);
          while (n >= 2) { var v = read(11); pushStr(ALNUM[Math.floor(v / 45)] + ALNUM[v % 45]); n -= 2; }
          if (n === 1) pushStr(ALNUM[read(6)]);
        } else if (mode === 4) {
          n = read(cc[2]);
          for (i = 0; i < n; i++) out.push(read(8));
        } else if (mode === 7) {
          var f = read(8);
          if ((f & 0xC0) === 0x80) read(8); else if ((f & 0xE0) === 0xC0) read(16);
        } else {
          return null;
        }
      }
    } catch (e) { return null; }
    var u8 = new Uint8Array(out);
    if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('utf-8').decode(u8); } catch (e2) {} }
    var s = ''; for (i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  /* Turns a sampled module grid into text, or null. */
  function decodeMatrix(M, dim) {
    var version = (dim - 17) / 4;
    if (version < 1 || version > 10 || version !== Math.floor(version)) return null;
    var fmt = readFormat(M, dim);
    if (!fmt) return null;
    var F = functionMask(dim, version), bits = [], x, y, dx, vert, up = true;
    for (x = dim - 1; x > 0; x -= 2) {
      if (x === 6) x = 5;
      for (vert = 0; vert < dim; vert++) {
        y = up ? dim - 1 - vert : vert;
        for (dx = 0; dx < 2; dx++) {
          var xx = x - dx;
          if (!F[y * dim + xx]) bits.push(M[y * dim + xx] ^ (maskBit(fmt.mask, y, xx) ? 1 : 0));
        }
      }
      up = !up;
    }
    var tb = BLOCKS[version][fmt.ec], ecLen = tb[0], blocks = [], i, k;
    for (i = 0; i < tb[1]; i++) blocks.push(tb[2]);
    for (i = 0; i < tb[3]; i++) blocks.push(tb[4]);
    var totalData = 0; for (i = 0; i < blocks.length; i++) totalData += blocks[i];
    var totalCw = totalData + ecLen * blocks.length;
    if (bits.length < totalCw * 8) return null;
    var cw = new Array(totalCw);
    for (i = 0; i < totalCw; i++) { var v = 0; for (k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k]; cw[i] = v; }

    var blk = [], maxData = Math.max(tb[2], tb[4]);
    for (i = 0; i < blocks.length; i++) blk.push(new Array(blocks[i] + ecLen));
    var p = 0;
    for (i = 0; i < maxData; i++) for (k = 0; k < blocks.length; k++) if (i < blocks[k]) blk[k][i] = cw[p++];
    for (i = 0; i < ecLen; i++) for (k = 0; k < blocks.length; k++) blk[k][blocks[k] + i] = cw[p++];
    var data = [];
    for (k = 0; k < blocks.length; k++) {
      if (!rsCorrect(blk[k], ecLen)) return null;
      for (i = 0; i < blocks[k]; i++) data.push(blk[k][i]);
    }
    return parseStream(data, version);
  }

  /* ---------- Image handling ---------- */
  function toGray(rgba, w, h) {
    var g = new Uint8Array(w * h), i, j;
    for (i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }

  /* Local average threshold using an integral image. 1 = dark. */
  function binarise(gray, w, h, winDiv, ratio) {
    var win = Math.max(15, Math.floor(Math.min(w, h) / winDiv)) | 1, r = win >> 1;
    var I = new Float64Array((w + 1) * (h + 1)), x, y;
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) { row += gray[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    var bin = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        var mean = sum / ((x1 - x0) * (y1 - y0));
        bin[y * w + x] = gray[y * w + x] < mean * ratio ? 1 : 0;
      }
    }
    return bin;
  }

  /* Looks along a line through (cx, cy) and checks the dark/light run pattern. Returns { c, m } or null. */
  function crossCheck(bin, w, h, cx, cy, dx, dy, pat, psum, inner) {
    var x = Math.floor(cx), y = Math.floor(cy);
    function inb(a, b) { return a >= 0 && b >= 0 && a < w && b < h; }
    if (!inb(x, y) || !bin[y * w + x]) return null;
    var st = [0, 0, 0, 0, 0], px = x, py = y, na = 0, nb = 0;
    while (inb(px, py) && bin[py * w + px] === 1) { na++; px -= dx; py -= dy; }
    while (inb(px, py) && bin[py * w + px] === 0) { st[1]++; px -= dx; py -= dy; }
    if (!inb(px, py) || st[1] === 0) return null;
    while (inb(px, py) && bin[py * w + px] === 1) { st[0]++; px -= dx; py -= dy; }
    if (st[0] === 0) return null;
    px = x + dx; py = y + dy;
    while (inb(px, py) && bin[py * w + px] === 1) { nb++; px += dx; py += dy; }
    while (inb(px, py) && bin[py * w + px] === 0) { st[3]++; px += dx; py += dy; }
    if (!inb(px, py) || st[3] === 0) return null;
    while (inb(px, py) && bin[py * w + px] === 1) { st[4]++; px += dx; py += dy; }
    if (st[4] === 0) return null;
    st[2] = na + nb;
    var total, m, k;
    if (inner) {
      /* alignment pattern: only the light ring, the dark centre and the next light ring are measured */
      total = st[1] + st[2] + st[3]; m = total / 3;
      for (k = 1; k < 4; k++) if (Math.abs(st[k] - m) > 0.6 * m) return null;
    } else {
      total = st[0] + st[1] + st[2] + st[3] + st[4]; m = total / psum;
      if (total < psum) return null;
      for (k = 0; k < 5; k++) if (Math.abs(st[k] - pat[k] * m) > 0.7 * m * Math.max(1, pat[k])) return null;
    }
    var axis = dx ? x : y;
    return { c: axis + 0.5 + (nb - (na - 1)) / 2, m: m };
  }

  /* Finds candidate centres of a 5-run pattern (finder 1:1:3:1:1 or alignment 1:1:1:1:1). */
  function findPatterns(bin, w, h, pat, x0, y0, x1, y1, inner) {
    var psum = 0, k, found = [];
    for (k = 0; k < 5; k++) psum += pat[k];
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    for (var y = y0; y < y1; y++) {
      var lens = [], starts = [], cur = bin[y * w + x0], s = x0, x;
      var firstDark = cur === 1;
      for (x = x0 + 1; x <= x1; x++) {
        var v = x < x1 ? bin[y * w + x] : -1;
        if (v !== cur) { lens.push(x - s); starts.push(s); s = x; cur = v; }
      }
      var r0 = inner ? (firstDark ? 1 : 2) : (firstDark ? 0 : 1);
      for (var r = r0; inner ? (r + 3 < lens.length) : (r + 4 < lens.length); r += 2) {
        var m, ok = true, total, cx0;
        if (inner) {
          /* light, dark, light with a dark run on each side */
          total = lens[r] + lens[r + 1] + lens[r + 2]; m = total / 3;
          for (k = 0; k < 3; k++) if (Math.abs(lens[r + k] - m) > 0.6 * m) { ok = false; break; }
          cx0 = starts[r + 1] + lens[r + 1] / 2;
        } else {
          total = lens[r] + lens[r + 1] + lens[r + 2] + lens[r + 3] + lens[r + 4];
          if (total < psum) continue;
          m = total / psum;
          for (k = 0; k < 5; k++) if (Math.abs(lens[r + k] - pat[k] * m) > 0.6 * m * Math.max(1, pat[k])) { ok = false; break; }
          cx0 = starts[r + 2] + lens[r + 2] / 2;
        }
        if (!ok) continue;
        var cx = cx0;
        var vt = crossCheck(bin, w, h, cx, y + 0.5, 0, 1, pat, psum, inner);
        if (!vt) continue;
        var hz = crossCheck(bin, w, h, cx, vt.c, 1, 0, pat, psum, inner);
        if (!hz) continue;
        var mm = (vt.m + hz.m) / 2, px = hz.c, py = vt.c, merged = false;
        for (k = 0; k < found.length; k++) {
          var f = found[k];
          if (Math.abs(f.x - px) < 1.5 * f.m && Math.abs(f.y - py) < 1.5 * f.m && Math.abs(f.m - mm) < 0.5 * f.m + 1) {
            f.x = (f.x * f.n + px) / (f.n + 1); f.y = (f.y * f.n + py) / (f.n + 1); f.m = (f.m * f.n + mm) / (f.n + 1); f.n++;
            merged = true; break;
          }
        }
        if (!merged) found.push({ x: px, y: py, m: mm, n: 1 });
      }
    }
    return found;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* Picks likely (top-left, top-right, bottom-left) sets from the finder candidates. */
  function pickTriples(c) {
    c = c.filter(function (f) { return f.n >= 2; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 10);
    var out = [], i, j, k, t, A, B, C, dAB, dAC, cos, sc, mmin, mmax;
    for (i = 0; i < c.length; i++) for (j = i + 1; j < c.length; j++) for (k = j + 1; k < c.length; k++) {
      var tri = [c[i], c[j], c[k]];
      for (t = 0; t < 3; t++) {
        A = tri[t]; B = tri[(t + 1) % 3]; C = tri[(t + 2) % 3];
        dAB = dist(A, B); dAC = dist(A, C);
        if (Math.abs(dAB - dAC) / Math.max(dAB, dAC) > 0.4) continue;
        cos = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (dAB * dAC);
        if (Math.abs(cos) > 0.4) continue;
        mmin = Math.min(A.m, B.m, C.m); mmax = Math.max(A.m, B.m, C.m);
        if (mmax / mmin > 1.7) continue;
        var mod = (A.m + B.m + C.m) / 3, side = (dAB + dAC) / 2 / mod;
        if (side < 8 || side > 75) continue;
        sc = Math.abs(dAB - dAC) / ((dAB + dAC) / 2) + Math.abs(cos);
        var cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        out.push({ tl: A, tr: cr > 0 ? B : C, bl: cr > 0 ? C : B, score: sc, mod: mod, side: side });
      }
    }
    out.sort(function (a, b) { return a.score - b.score; });
    return out.slice(0, 5);
  }

  function homography(src, dst) {
    var A = [], i, j, k;
    for (i = 0; i < 4; i++) {
      var u = src[i][0], v = src[i][1], x = dst[i][0], y = dst[i][1];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
    }
    for (i = 0; i < 8; i++) {
      var p = i;
      for (j = i + 1; j < 8; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      var tmp = A[i]; A[i] = A[p]; A[p] = tmp;
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (j = 0; j < 8; j++) {
        if (j === i) continue;
        var f = A[j][i] / A[i][i];
        for (k = i; k < 9; k++) A[j][k] -= f * A[i][k];
      }
    }
    var a = A[0][8] / A[0][0], b = A[1][8] / A[1][1], c = A[2][8] / A[2][2], d = A[3][8] / A[3][3],
        e = A[4][8] / A[4][4], f2 = A[5][8] / A[5][5], g = A[6][8] / A[6][6], hh = A[7][8] / A[7][7];
    return function (u, v) { var q = g * u + hh * v + 1; return [(a * u + b * v + c) / q, (d * u + e * v + f2) / q]; };
  }

  function sampleGrid(bin, w, h, map, dim) {
    var M = new Uint8Array(dim * dim), off = 0.2, offs = [[0, 0], [off, 0], [-off, 0], [0, off], [0, -off]], u, v, k;
    for (v = 0; v < dim; v++) for (u = 0; u < dim; u++) {
      var cnt = 0;
      for (k = 0; k < 5; k++) {
        var p = map(u + 0.5 + offs[k][0], v + 0.5 + offs[k][1]), px = Math.floor(p[0]), py = Math.floor(p[1]);
        if (!(px >= 0 && py >= 0 && px < w && py < h)) return null;
        cnt += bin[py * w + px];
      }
      M[v * dim + u] = cnt >= 3 ? 1 : 0;
    }
    return M;
  }

  /* Module size measured along the line between two finder centres, so tilted codes are not over-measured. */
  function measureModule(bin, w, h, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), sgn, ts = [];
    dx /= L; dy /= L;
    for (sgn = 1; sgn >= -1; sgn -= 2) {
      var state = 1, trans = 0, t, found = null, lim = a.m * 6;
      for (t = 0; t < lim; t += 0.25) {
        var px = Math.floor(a.x + sgn * dx * t), py = Math.floor(a.y + sgn * dy * t);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        var v = bin[py * w + px];
        if (v !== state) { state = v; trans++; if (trans === 3) { found = t; break; } }
      }
      if (found === null) return null;
      ts.push(found);
    }
    return (ts[0] + ts[1]) / 7;
  }

  function tryTriple(bin, w, h, t) {
    var ms3 = [measureModule(bin, w, h, t.tl, t.tr), measureModule(bin, w, h, t.tl, t.bl), measureModule(bin, w, h, t.tr, t.tl),
               measureModule(bin, w, h, t.bl, t.tl)], sum = 0, cnt = 0, ti, i, j;
    for (i = 0; i < ms3.length; i++) if (ms3[i]) { sum += ms3[i]; cnt++; }
    if (cnt < 2) return null;
    var side = (dist(t.tl, t.tr) + dist(t.tl, t.bl)) / 2 / (sum / cnt);
    var v0 = Math.round((side + 7 - 17) / 4), tries = [v0, v0 + 1, v0 - 1];
    for (ti = 0; ti < tries.length; ti++) {
      var version = tries[ti];
      if (version < 1 || version > 10) continue;
      var dim = 17 + 4 * version, span = dim - 7;
      var P0 = t.tl, P1 = t.tr, P2 = t.bl, ms = dist(P0, P1) / span;
      var src4 = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], null];
      var base = [P1.x + P2.x - P0.x, P1.y + P2.y - P0.y];
      src4[3] = [dim - 3.5, dim - 3.5];
      if (version >= 2) {
        var f = (dim - 10) / span;
        var ax = P0.x + f * (P1.x - P0.x) + f * (P2.x - P0.x), ay = P0.y + f * (P1.y - P0.y) + f * (P2.y - P0.y);
        var rad = 5 * ms, best = null, bd = 1e9;
        var al = findPatterns(bin, w, h, [1, 1, 1, 1, 1], ax - rad, ay - rad, ax + rad, ay + rad, true);
        for (i = 0; i < al.length; i++) {
          var dd = Math.hypot(al[i].x - ax, al[i].y - ay);
          if (al[i].n >= 2 && dd < bd && dd < rad && Math.abs(al[i].m - ms) < 0.5 * ms) { bd = dd; best = al[i]; }
        }
        if (best) { base = [best.x, best.y]; src4[3] = [dim - 6.5, dim - 6.5]; }
        else { base = [ax, ay]; src4[3] = [dim - 6.5, dim - 6.5]; }
      }
      /* Try the best guess for the fourth point first, then nudge it around in half-module steps. */
      var offsets = [[0, 0]], ring;
      if (ti === 0) {
        for (ring = 1; ring <= 4; ring++) {
          var rr = ring * 0.5 * ms;
          for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) if (i || j) offsets.push([i * rr, j * rr]);
        }
      }
      for (i = 0; i < offsets.length; i++) {
        var H = homography(src4, [[P0.x, P0.y], [P1.x, P1.y], [P2.x, P2.y], [base[0] + offsets[i][0], base[1] + offsets[i][1]]]);
        if (!H) continue;
        var M = sampleGrid(bin, w, h, H, dim);
        if (!M) continue;
        var res = decodeMatrix(M, dim);
        if (res !== null && res !== '') return res;
      }
    }
    return null;
  }

  function decodeBinary(bin, w, h) {
    var finders = findPatterns(bin, w, h, [1, 1, 3, 1, 1], 0, 0, w, h);
    var triples = pickTriples(finders), i;
    for (i = 0; i < triples.length; i++) {
      var r = tryTriple(bin, w, h, triples[i]);
      if (r !== null) return r;
    }
    return null;
  }

  function decodeQR(rgba, w, h) {
    var gray = toGray(rgba, w, h), params = [[5, 0.88], [8, 0.92], [4, 0.82]], i;
    for (i = 0; i < params.length; i++) {
      var r = decodeBinary(binarise(gray, w, h, params[i][0], params[i][1]), w, h);
      if (r !== null) return r;
    }
    return null;
  }

  root.decodeQR = decodeQR;
  if (typeof module !== 'undefined' && module.exports) module.exports = { decodeQR: decodeQR, rsCorrect: rsCorrect };
})(typeof window !== 'undefined' ? window : this);
