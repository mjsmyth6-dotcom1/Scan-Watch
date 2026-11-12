/*
 * player.js
 * Puts a YouTube video in the stage and keeps YouTube's "more videos" suggestions out of sight.
 * YouTube's own controls are turned off. Once the video is playing, a clear layer sits over it so taps
 * never reach YouTube, and our own pause button is used instead. A cover hides the screen when paused or finished.
 * Uses only YouTube's own embedded player and the browser's postMessage.
 */
(function (root) {
  'use strict';
  var YT = 'https://www.youtube.com';

  function makeCover() {
    var c = document.createElement('div');
    c.style.cssText = 'position:absolute;inset:0;z-index:2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem;' +
      'background:#004EA8;color:#fff;font-family:Raleway,Calibri,sans-serif;text-align:center;padding:1.5rem;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:800;font-size:clamp(2rem,6vw,3.5rem);line-height:1.1;';
    var b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'font-family:inherit;font-weight:800;font-size:1.75rem;min-height:4.5rem;padding:0 2.5rem;border:0;border-radius:999px;background:#fff;color:#004EA8;cursor:pointer;';
    c.appendChild(h); c.appendChild(b);
    return { el: c, heading: h, button: b };
  }

  function mount(stage, id) {
    stage.innerHTML = '';
    var f = document.createElement('iframe');
    f.title = 'Video';
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    /* No popups and no top navigation, so nothing in the player can send a student to YouTube or Safari. */
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    f.src = embedUrl(id);
    var cover = makeCover();
    /* Clear layer over the video. It stays out of the way until the video has started,
       so the first tap can reach YouTube's own play button (iPadOS needs that tap). */
    var shield = document.createElement('div');
    shield.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;';
    var pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.setAttribute('aria-label', 'Pause');
    pauseBtn.style.cssText = 'position:absolute;left:1rem;bottom:1rem;z-index:1;width:4.5rem;height:4.5rem;border:0;border-radius:50%;' +
      'background:#004EA8;display:none;align-items:center;justify-content:center;cursor:pointer;';
    pauseBtn.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect x="6" y="4" width="6" height="22" rx="2" fill="#fff"/><rect x="18" y="4" width="6" height="22" rx="2" fill="#fff"/></svg>';
    /* YouTube flashes its title bar and "More videos" for a few seconds after every play or resume.
       Black panels hide those two areas for that time. */
    var maskTop = document.createElement('div');
    maskTop.style.cssText = 'position:absolute;left:0;right:0;top:0;height:18%;z-index:1;background:#000;pointer-events:none;display:none;';
    var maskBottom = document.createElement('div');
    maskBottom.style.cssText = 'position:absolute;right:0;bottom:0;width:48%;height:20%;z-index:1;background:#000;pointer-events:none;display:none;';
    var maskTimer = null;
    function masks(on) { maskTop.style.display = maskBottom.style.display = on ? 'block' : 'none'; }
    function maskFor(ms) { clearTimeout(maskTimer); masks(true); maskTimer = setTimeout(function () { masks(false); }, ms); }
    stage.appendChild(f);
    stage.appendChild(maskTop);
    stage.appendChild(maskBottom);
    stage.appendChild(shield);
    stage.appendChild(pauseBtn);
    stage.appendChild(cover.el);

    var win = null, coverTimer = null, retry = null, heard = false, mode = null, started = false, playing = false;

    function send(msg) { if (win) { try { win.postMessage(JSON.stringify(msg), YT); } catch (e) {} } }
    function command(func, args) { send({ event: 'command', func: func, args: args || [] }); }

    function show(kind) {
      mode = kind;
      if (!kind) { cover.el.style.display = 'none'; return; }
      cover.heading.textContent = kind === 'ended' ? 'All done' : 'Paused';
      cover.button.textContent = kind === 'ended' ? 'Watch again' : 'Keep watching';
      cover.el.style.display = 'flex';
    }

    cover.button.addEventListener('click', function () {
      if (mode === 'ended') command('seekTo', [0, true]);
      command('playVideo');
      show(null);
    });

    function pauseNow() { command('pauseVideo'); show('paused'); }
    shield.addEventListener('click', pauseNow);
    pauseBtn.addEventListener('click', pauseNow);

    function onState(s) {
      clearTimeout(coverTimer);
      if (s === 1 || s === 3) {
        show(null);
        if (!playing && started) maskFor(7000);
        playing = true;
        if (!started) { started = true; shield.style.pointerEvents = 'auto'; }
        if (started) pauseBtn.style.display = 'flex';
      } else if (s === 0) { playing = false; masks(false); pauseBtn.style.display = 'none'; show('ended'); }
      else if (s === 2) { playing = false; masks(false); pauseBtn.style.display = 'none'; coverTimer = setTimeout(function () { show('paused'); }, 100); }
    }

    function onMessage(e) {
      if (e.origin !== YT || !win || e.source !== win) return;
      var d;
      try { d = JSON.parse(e.data); } catch (x) { return; }
      if (!d) return;
      heard = true;
      if (d.event === 'onStateChange' && typeof d.info === 'number') onState(d.info);
      else if (d.event === 'infoDelivery' && d.info && typeof d.info.playerState === 'number') onState(d.info.playerState);
    }
    window.addEventListener('message', onMessage);

    f.addEventListener('load', function () {
      win = f.contentWindow;
      var tries = 0;
      /* Ask the player to start sending its state, and keep asking until it answers. */
      retry = setInterval(function () {
        tries++;
        if (heard || tries > 24) { clearInterval(retry); return; }
        send({ event: 'listening', id: 1, channel: 'widget' });
      }, 250);
    });

    return {
      destroy: function () {
        clearTimeout(coverTimer); clearTimeout(maskTimer); clearInterval(retry);
        window.removeEventListener('message', onMessage);
        stage.innerHTML = '';
      },
      _command: command,
      _state: function () { return { heard: heard, mode: mode, started: started }; }
    };
  }

  root.WatchPlayer = { mount: mount };
})(window);
