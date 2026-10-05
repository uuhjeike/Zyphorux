/* Zyphorux · loads posts.txt and renders it. No libraries, no timers, no loops running in the background. */
(() => {
  'use strict';

  const POSTS_FILE = 'posts.txt';
  const PAGE_SIZE = 15;                       // posts shown at a time; the rest load on request
  const avatarEl = document.querySelector('.avatar img');
  const AVATAR = avatarEl ? avatarEl.src : '';

  /* ---------- 1. split the file into posts ---------- */
  // Posts are written like this, newest first:
  //   -
  //   Post
  //   -
  //   Post
  //   -
  // A line holding only "-" is a separator. Blank lines around it are ignored and
  // empty chunks are dropped, so posts never merge and extra spacing does no harm.
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

  /* ---------- 2. links and media ---------- */
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
  const VID_EXT = /\.(mp4|webm|ogv)$/i;

  // Normal GitHub page links become direct file links:
  // github.com/user/repo/blob/main/pic.png  ->  raw.githubusercontent.com/user/repo/main/pic.png
  function directUrl(u) {
    if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
      if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
    }
    return u;
  }

  function youtubeId(u) {
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        if (m) id = m[1];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
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

    const id = youtubeId(u);
    if (id) return { type: 'yt', id, start: youtubeStart(u) };

    const d = directUrl(u);
    const isAttachment = u.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/assets/');
    if (IMG_EXT.test(d.pathname) || isAttachment || md) return { type: 'img', src: d.href, alt, page: url };
    if (VID_EXT.test(d.pathname)) return { type: 'video', src: d.href };
    return null;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function buildMedia(m) {
    if (m.type === 'img') {
      const img = el('img');
      img.src = m.src;
      img.alt = m.alt || 'Image shared in this transmission';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {   // broken link: show a plain link instead of a gap
        const a = el('a', '', 'Image could not be loaded. Open the link.');
        a.href = m.page; a.target = '_blank'; a.rel = 'noopener noreferrer';
        img.replaceWith(a);
      }, { once: true });
      return img;
    }
    if (m.type === 'video') {
      const v = el('video');
      v.src = m.src; v.controls = true; v.preload = 'none'; v.playsInline = true;
      return v;
    }
    // YouTube: a still thumbnail now, the real player only after a tap (keeps the page light).
    const btn = el('button', 'yt');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Play video');
    const th = el('img');
    th.src = `https://i.ytimg.com/vi/${m.id}/hqdefault.jpg`;
    th.alt = '';
    th.loading = 'lazy';
    th.decoding = 'async';
    btn.append(th);
    btn.addEventListener('click', () => {
      const f = el('iframe', 'yt-frame');
      f.src = `https://www.youtube-nocookie.com/embed/${m.id}?autoplay=1&rel=0${m.start ? '&start=' + m.start : ''}`;
      f.title = 'Video shared in this transmission';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      btn.replaceWith(f);
      f.focus();
    }, { once: true });
    return btn;
  }

  /* ---------- 3. text: **bold**, *italic*, links ---------- */
  const INLINE = /(https?:\/\/[^\s<>]+)|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*/g;

  function writeInline(text, parent) {
    let last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) {
        let url = m[1], tail = '';
        const t = url.match(/[.,;:!?)\]'"]+$/);
        if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
        const a = el('a', '', url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 56) + (url.length > 64 ? '…' : ''));
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        parent.append(a);
        if (tail) parent.append(tail);
      } else if (m[2]) parent.append(el('b', '', m[2]));
      else parent.append(el('em', '', m[3]));
      last = INLINE.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  /* ---------- 4. one post ---------- */
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
      if (media.type === 'img' && group) {      // consecutive images share one grid
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
    av.src = AVATAR; av.alt = ''; av.width = 46; av.height = 46; av.loading = 'lazy'; av.decoding = 'async';
    const who = el('div', 'post-who');
    who.append(el('b', '', 'Zyphorux'), el('span', '', 'Riftborn Guardian · Realm 07'));
    const st = el('div', 'post-stamp', `Echo ${String(number).padStart(3, '0')}`);
    head.append(av, who, st);
    post.append(head, body);
    return post;
  }

  /* ---------- 5. load and show ---------- */
  async function loadPosts() {
    const feed = document.getElementById('feed');
    if (!feed) return;
    const say = (msg) => { feed.replaceChildren(el('p', 'feed-msg', msg)); };

    try {
      const res = await fetch(POSTS_FILE, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const posts = splitPosts(await res.text());   // file order: the top block is the newest
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

  /* ---------- 6. mark the current section in the nav (one observer, no scroll handler) ---------- */
  function trackNav() {
    if (!('IntersectionObserver' in window)) return;
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

  trackNav();
  loadPosts();
})();
