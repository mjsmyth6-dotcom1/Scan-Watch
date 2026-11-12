/* Shared helpers. */

/* Accepts a YouTube link, a youtu.be link, "video:ID" or a bare 11 character ID. Returns the ID or null. */
function parseVideoId(text) {
  if (!text) return null;
  text = String(text).trim();
  var idRe = /^[A-Za-z0-9_-]{11}$/;
  if (text.indexOf('video:') === 0) text = text.slice(6);
  if (idRe.test(text)) return text;
  var u;
  try { u = new URL(text); } catch (e) { return null; }
  var host = u.hostname.replace(/^www\.|^m\./, '');
  var id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      var m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/]+)/);
      if (m) id = m[2];
    }
  }
  return id && idRe.test(id) ? id : null;
}

function embedUrl(id) {
  var u = 'https://www.youtube.com/embed/' + id +
    '?playsinline=1&rel=0&modestbranding=1&fs=0&iv_load_policy=3&disablekb=1&controls=0&enablejsapi=1';
  if (typeof location !== 'undefined' && /^https?:/.test(location.origin)) u += '&origin=' + encodeURIComponent(location.origin);
  return u;
}
