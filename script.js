/* Zyphorux · loads posts.txt and renders it.
   v2: priority lazy loading, optimized photos with blur-up preview, host fallbacks,
   YouTube long + Shorts, long + vertical videos. No libraries. */
(() => {
  'use strict';

  const POSTS_FILE = 'posts.txt';
  const PAGE_SIZE = 15;                 // posts shown at a time; the rest load on request
  const IMG_WIDTH = 1280;               // optimized photo width (sharp on phones, ~100-250 KB)
  const MAX_ACTIVE = 4;                 // photos downloading at once (visible ones may go higher)
  const MAX_ACTIVE_VISIBLE = 8;

  const avatarEl = document.querySelector('.avatar img');
  const AVATAR = avatarEl ? avatarEl.getAttribute('src') : '';

  /* ================================================================
     1. split the file into posts   ( "-" on its own line = separator )
     ================================================================ */
  function splitPosts(text) {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const posts = [];
    let cur = [];
    const flush = () => {
      const body = cur.join('\n').trim();
      if (body) posts.push(body);
      cur = [];
    };
    for (const line of lines) {
      if (/^[-–—]+$/.test(line.trim())) flush(); else cur.push(line);
    }
    flush();
    return posts;
  }

  /* ================================================================
     2. links: GitHub page link -> direct file, plus backup addresses
     ================================================================ */
  const RASTER_EXT = /\.(png|jpe?g|webp|avif)$/i;     // can be resized by the optimizer
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
  const VID_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;

  // github.com/user/repo/blob/main/My%20Folder/pic.jpg -> raw.githubusercontent.com/user/repo/main/My%20Folder/pic.jpg
  function directUrl(u) {
    if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3].replace(/^refs\/heads\//, '')}`);
    }
    return u;
  }

  // Same file on other hosts. Any of them may be slow, blocked by an ISP, or out of date
  // (jsDelivr caches branches for hours), so the page tries them one after another.
  function sourceLists(d, isVideo) {
    const direct = d.href;
    let cdn = null;
    if (d.hostname === 'raw.githubusercontent.com') {
      const p = d.pathname.replace(/^(\/[^/]+\/[^/]+)\/refs\/heads\//, '$1/');
      const m = p.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (m) cdn = `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`;
    }
    // original quality (used for the full-size viewer and for videos)
    const orig = isVideo ? [cdn, direct] : [direct, cdn];
    // optimized copy: resized + WebP, served from a global cache
    const opt = (w, extra = '') =>
      `https://wsrv.nl/?url=${encodeURIComponent(direct)}&w=${w}&we&q=${w > 100 ? 80 : 30}&output=${w > 100 ? 'webp' : 'jpg'}${extra}`;
    return { orig: orig.filter(Boolean), opt };
  }

  function youtubeInfo(u) {
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null, short = false;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
        if (m) { id = m[2]; short = m[1] === 'shorts'; }
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? { id, short } : null;
  }

  function youtubeStart(u) {
    const t = u.searchParams.get('t') || u.searchParams.get('start');
    if (!t) return 0;
    if (/^\d+$/.test(t)) return +t;
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }

  // A line that is only a link (or ![alt](link)) becomes media. Anything else stays text.
  function mediaFromLine(line) {
    line = line.trim();
    let alt = '', url = line;
    const md = line.match(/^!\[([^\]]*)\]\((\S+)\)$/);
    if (md) { alt = md[1]; url = md[2]; }
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    let u;
    try { u = new URL(url); } catch { return null; }

    const yt = youtubeInfo(u);
    if (yt) return { type: 'yt', id: yt.id, short: yt.short, start: youtubeStart(u), page: url };

    const d = directUrl(u);
    const isAttachment = u.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/assets/');
    if (VID_EXT.test(d.pathname)) return { type: 'video', page: url, ...sourceLists(d, true) };
    if (IMG_EXT.test(d.pathname) || md) {
      return { type: 'img', alt, page: url, raster: RASTER_EXT.test(d.pathname) || (md && !IMG_EXT.test(d.pathname)), ...sourceLists(d, false) };
    }
    if (isAttachment) return { type: 'img', alt, page: url, raster: false, maybeVideo: true, orig: [d.href], opt: null };
    return null;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  /* ================================================================
     3. priority loader: what you are looking at loads FIRST
     ================================================================
     - an item joins the queue when it is within ~1.5 screens of the viewport
     - items actually on screen jump the queue
     - the rest are loaded closest-first, a few at a time, so nothing fights for bandwidth */
  const queue = new Set();
  let active = 0;

  function distance(node) {
    const r = node.getBoundingClientRect();
    if (r.bottom < 0) return -r.bottom * 1.5;           // above: a little less important
    if (r.top > innerHeight) return r.top - innerHeight;
    return 0;
  }

  function pump() {
    if (!queue.size) return;
    const items = [...queue].sort((a, b) => (b.vis - a.vis) || (distance(a.node) - distance(b.node)));
    for (const it of items) {
      if (active >= (it.vis ? MAX_ACTIVE_VISIBLE : MAX_ACTIVE)) { if (!it.vis) break; else continue; }
      queue.delete(it);
      active++;
      let finished = false;
      it.start(() => { if (finished) return; finished = true; active--; pump(); });
    }
  }

  const supportsIO = 'IntersectionObserver' in window;
  const nearIO = supportsIO ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      nearIO.unobserve(e.target);
      const it = e.target._item;
      if (it && !it.queued) { it.queued = true; queue.add(it); }
      pump();
    });
  }, { rootMargin: '1500px 0px' }) : null;

  const visIO = supportsIO ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const it = e.target._item;
      if (!it) return;
      it.vis = e.isIntersecting;
      if (e.isIntersecting) {
        visIO.unobserve(e.target);
        if (!it.queued) { it.queued = true; queue.add(it); }
        pump();
      }
    });
  }, { rootMargin: '0px' }) : null;

  function schedule(node, start) {
    const it = { node, start, vis: false, queued: false };
    node._item = it;
    if (!supportsIO) { start(() => {}); return; }
    nearIO.observe(node);
    visIO.observe(node);
  }

  /* ================================================================
     4. images
     ================================================================ */
  // Try each address in turn; start the next one if the current one errors OR is slow.
  // The first to finish wins and the others are cancelled.
  function race(srcs, ok, fail, gap = 2200) {
    let next = 0, failed = 0, finished = false, timer = 0;
    const probes = [];
    const launch = () => {
      clearTimeout(timer);
      if (finished || next >= srcs.length) return;
      const src = srcs[next++];
      const p = new Image();
      p.decoding = 'async';
      probes.push(p);
      p.onload = () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        probes.forEach((q) => { if (q !== p) { q.onload = q.onerror = null; q.removeAttribute('src'); } });
        ok(src, p);
      };
      p.onerror = () => {
        if (finished) return;
        failed++;
        if (failed >= srcs.length) { finished = true; clearTimeout(timer); fail(); } else launch();
      };
      p.src = src;
      if (next < srcs.length) timer = setTimeout(launch, gap);
    };
    launch();
  }

  function setRatio(frame, w, h) {
    if (w && h) frame.style.setProperty('--r', (w / h).toFixed(4));
  }

  function broken(node, m, what, retry) {
    const box = el('div', 'broken');
    box.append(el('p', '', what + ' could not be loaded. The file must be in a PUBLIC repository, and the link must match the file name exactly.'));
    const row = el('div', 'broken-row');
    const again = el('button', 'btn-mini', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => box.replaceWith(retry()));
    const a = el('a', '', 'Open link');
    a.href = m.page; a.target = '_blank'; a.rel = 'noopener noreferrer';
    row.append(again, a);
    box.append(row);
    node.replaceWith(box);
    return box;
  }

  function buildImage(m) {
    const frame = el('div', 'frame ph');
    const img = el('img', 'hq');
    img.alt = m.alt || 'Image shared in this transmission';
    img.decoding = 'async';
    frame.append(img);

    const retry = () => buildImage(m);

    schedule(frame, (done) => {
      // 1) tiny blurred preview (about 1 KB): gives the right shape instantly, no layout jump
      let gotFull = false;
      if (m.raster && m.opt) {
        const lq = el('img', 'lq');
        lq.alt = ''; lq.setAttribute('aria-hidden', 'true');
        lq.onload = () => {
          if (gotFull) return;
          setRatio(frame, lq.naturalWidth, lq.naturalHeight);
          frame.insertBefore(lq, img);
          frame.classList.add('has-lq');
        };
        lq.src = m.opt(40);
      }
      // 2) the real photo: optimized copy first, then the originals as backups
      const srcs = (m.raster && m.opt) ? [m.opt(IMG_WIDTH), ...m.orig] : m.orig;
      race(srcs, (src, probe) => {
        gotFull = true;
        img.src = src;
        setRatio(frame, probe.naturalWidth, probe.naturalHeight);
        // never stretch a small picture beyond its real size
        frame.style.setProperty('--w', Math.max(probe.naturalWidth, 220) + 'px');
        frame.classList.add('loaded');
        frame.classList.remove('has-lq');
        setTimeout(() => frame.querySelector('.lq')?.remove(), 600);
        done();
      }, () => {
        done();
        if (m.maybeVideo) frame.replaceWith(buildVideo(m));
        else broken(frame, m, 'Image', retry);
      });
    });

    img.addEventListener('click', () => { if (frame.classList.contains('loaded')) openFull(img, m); });
    return frame;
  }

  // Tap a photo: see it at true full size. Scroll or drag to move around; tap or Esc to close.
  function openFull(img, m) {
    const box = el('div', 'viewer');
    const big = el('img');
    big.src = img.currentSrc || img.src; big.alt = img.alt;
    box.append(big);
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); document.documentElement.classList.remove('lock'); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('lock');
    document.body.append(box);
    // swap in the untouched original as soon as it arrives
    race(m.orig, (src) => { if (box.isConnected) big.src = src; }, () => {}, 3000);
  }

  /* ================================================================
     5. videos (any shape: wide, square, vertical phone video)
     ================================================================ */
  function buildVideo(m) {
    const frame = el('div', 'frame vid');
    const v = el('video');
    v.controls = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'none';
    frame.append(v);

    const srcs = m.orig;
    let i = 0, ready = false, timer = 0;
    const retry = () => buildVideo(m);

    schedule(frame, (done) => {
      const load = () => {
        clearTimeout(timer);
        v.preload = 'metadata';
        v.src = srcs[i] + '#t=0.1';        // phones show a first-frame preview
        v.load();
        timer = setTimeout(next, 9000);    // no answer in 9 s: try the next address
      };
      const next = () => {
        clearTimeout(timer);
        if (ready) return;
        if (++i < srcs.length) load();
        else { done(); broken(frame, m, 'Video', retry); }
      };
      v.addEventListener('loadedmetadata', () => {
        ready = true; clearTimeout(timer);
        setRatio(frame, v.videoWidth, v.videoHeight);   // vertical videos stay inside the screen
        done();
      });
      v.addEventListener('error', next);
      load();
    });
    return frame;
  }

  /* ================================================================
     6. YouTube: long videos and Shorts
     ================================================================ */
  // YouTube Shorts thumbnails are a tall picture centred between black bars.
  // Detect that, so a Short pasted as a normal youtu.be link still gets a tall player.
  function looksVertical(img) {
    try {
      const W = 64, H = 36;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, W, H);
      const px = x.getImageData(0, 0, W, H).data;
      const zone = (x0, x1) => {
        let sum = 0, max = 0, n = 0;
        for (let yy = 0; yy < H; yy++) for (let xx = Math.floor(x0 * W); xx < Math.ceil(x1 * W); xx++) {
          const k = (yy * W + xx) * 4, l = (px[k] + px[k + 1] + px[k + 2]) / 3;
          sum += l; if (l > max) max = l; n++;
        }
        return { mean: sum / n, max };
      };
      const L = zone(0, .28), R = zone(.72, 1), C = zone(.4, .6);
      return L.mean < 8 && R.mean < 8 && L.max < 45 && R.max < 45 && C.mean > 22;
    } catch { return false; }
  }

  function buildYouTube(m) {
    const frame = el('div', 'frame yt-frame-box');
    frame.classList.add(m.short ? 'is-short' : 'is-wide');
    const btn = el('button', 'yt');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play video');
    const th = el('img');
    th.alt = ''; th.decoding = 'async'; th.loading = 'lazy';
    // try the HD thumbnail with pixel access (for Short detection), then plain fallbacks
    const tries = [
      [`https://i.ytimg.com/vi/${m.id}/hq720.jpg`, true],
      [`https://i.ytimg.com/vi/${m.id}/hqdefault.jpg`, true],
      [`https://i.ytimg.com/vi/${m.id}/hqdefault.jpg`, false],
      [`https://i.ytimg.com/vi/${m.id}/mqdefault.jpg`, false],
    ];
    let t = 0, cors = true;
    const tryNext = () => {
      if (t >= tries.length) return;
      const [src, c] = tries[t++];
      cors = c;
      if (c) th.crossOrigin = 'anonymous'; else th.removeAttribute('crossorigin');
      th.src = src;
    };
    th.addEventListener('error', tryNext);
    th.addEventListener('load', () => {
      // YouTube serves a tiny grey 120x90 placeholder (not an error) for missing HD thumbnails
      if (th.naturalWidth <= 120 && t < tries.length) { tryNext(); return; }
      if (cors && !m.short && looksVertical(th)) { frame.classList.remove('is-wide'); frame.classList.add('is-short'); }
    });
    tryNext();
    btn.append(th);
    frame.append(btn);

    btn.addEventListener('click', () => {
      const p = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', modestbranding: '1' });
      if (m.start) p.set('start', m.start);
      if (/^https?:$/.test(location.protocol)) p.set('origin', location.origin);
      const f = el('iframe', 'yt-player');
      f.src = `https://www.youtube-nocookie.com/embed/${m.id}?${p}`;
      f.title = 'Video shared in this transmission';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write';
      f.referrerPolicy = 'strict-origin-when-cross-origin';   // YouTube refuses to play embeds without a referrer
      f.allowFullscreen = true;
      btn.replaceWith(f);
      f.focus();
    }, { once: true });

    const wrap = el('div', 'yt-wrap');
    const open = el('a', 'yt-open', 'Watch on YouTube');
    open.href = m.page; open.target = '_blank'; open.rel = 'noopener noreferrer';
    wrap.append(frame, open);
    return wrap;
  }

  function buildMedia(m) {
    if (m.type === 'img') return buildImage(m);
    if (m.type === 'video') return buildVideo(m);
    return buildYouTube(m);
  }

  /* ================================================================
     7. text: **bold**, *italic*, [label](link), bare links
     ================================================================ */
  const INLINE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*/g;

  function link(url, label) {
    const a = el('a', '', label);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }

  function writeInline(text, parent) {
    let last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) parent.append(link(m[2], m[1]));
      else if (m[3]) {
        let url = m[3], tail = '';
        const t = url.match(/[.,;:!?)\]'"]+$/);
        if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
        parent.append(link(url, url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 56) + (url.length > 64 ? '…' : '')));
        if (tail) parent.append(tail);
      } else if (m[4]) parent.append(el('b', '', m[4]));
      else parent.append(el('em', '', m[5]));
      last = INLINE.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  /* ================================================================
     8. one post
     ================================================================ */
  function avatarSmall() {
    if (!AVATAR) return { src: '', fallback: '' };
    try {
      const abs = new URL(AVATAR, location.href).href;
      return { src: `https://wsrv.nl/?url=${encodeURIComponent(abs)}&w=96&h=96&fit=cover&a=top&q=80&output=webp`, fallback: abs };
    } catch { return { src: AVATAR, fallback: AVATAR }; }
  }
  const AV = avatarSmall();

  function buildPost(raw, number) {
    const lines = raw.split('\n');
    const body = el('div', 'post-body');
    let para = [], group = null;

    const flushPara = () => {
      if (!para.length) return;
      const p = el('p');
      para.forEach((l, i) => { if (i) p.append(el('br')); writeInline(l.trim(), p); });
      body.append(p);
      para = []; group = null;
    };

    for (const line of lines) {
      if (!line.trim()) { flushPara(); continue; }
      const media = mediaFromLine(line);
      if (!media) { para.push(line); continue; }
      flushPara();
      const node = buildMedia(media);
      if (media.type === 'img' && group) {          // consecutive images share one block
        group.append(node);
        group.classList.add('multi');
      } else {
        group = el('div', 'media');
        group.append(node);
        body.append(group);
        if (media.type !== 'img') group = null;
      }
    }
    flushPara();
    if (!body.childNodes.length) return null;

    const post = el('article', 'post');
    const head = el('header', 'post-head');
    const av = el('img', 'post-av');
    av.alt = ''; av.width = 46; av.height = 46; av.decoding = 'async';
    av.addEventListener('error', () => { if (av.src !== AV.fallback) av.src = AV.fallback; }, { once: true });
    av.src = AV.src;
    const who = el('div', 'post-who');
    who.append(el('b', '', 'Zyphorux'), el('span', '', 'Riftborn Guardian · Realm 07'));
    const st = el('div', 'post-stamp', `Echo ${String(number).padStart(3, '0')}`);
    head.append(av, who, st);
    post.append(head, body);
    return post;
  }

  /* ================================================================
     9. load and show
     ================================================================ */
  async function loadPosts() {
    const feed = document.getElementById('feed');
    if (!feed) return;
    const say = (msg) => { feed.replaceChildren(el('p', 'feed-msg', msg)); };

    try {
      const res = await fetch(POSTS_FILE, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const posts = splitPosts(await res.text());   // top block = newest
      if (!posts.length) { say('No transmissions have been posted yet.'); return; }

      feed.replaceChildren();
      let shown = 0;
      const more = el('button', 'more', 'Show older transmissions');
      more.type = 'button';
      more.hidden = true;
      feed.after(more);

      const showNext = () => {
        const frag = document.createDocumentFragment();
        posts.slice(shown, shown + PAGE_SIZE).forEach((raw, i) => {
          const post = buildPost(raw, posts.length - (shown + i));
          if (post) frag.append(post);
        });
        shown += PAGE_SIZE;
        feed.append(frag);
        more.hidden = shown >= posts.length;
      };
      more.addEventListener('click', showNext);
      showNext();
    } catch {
      say('The transmissions could not be loaded. Keep posts.txt in the same folder as index.html and open the page from GitHub Pages or a web server.');
    } finally {
      feed.setAttribute('aria-busy', 'false');
    }
  }

  /* ================================================================
     10. profile photo: fall back to a backup host if the first one fails
     ================================================================ */
  function rescueAvatar() {
    if (!avatarEl || !AVATAR) return;
    let abs; try { abs = new URL(AVATAR, location.href); } catch { return; }
    const d = directUrl(abs);
    const { orig, opt } = sourceLists(d, false);
    const backups = [opt(560), ...orig.slice(1)];
    let i = 0;
    const next = () => { if (i < backups.length) avatarEl.src = backups[i++]; };
    avatarEl.addEventListener('error', next);
    if (avatarEl.complete && avatarEl.naturalWidth === 0) next();   // it already failed before this script ran
  }

  /* ================================================================
     11. mark the current section in the nav
     ================================================================ */
  function trackNav() {
    if (!supportsIO) return;
    const links = [...document.querySelectorAll('.top li a')];
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => {
          const on = a.getAttribute('href') === '#' + e.target.id;
          a.classList.toggle('on', on);
          on ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main > section[id]').forEach((s) => io.observe(s));
  }

  rescueAvatar();
  trackNav();
  loadPosts();
})();
