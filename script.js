/* ==========================================================
   Dos videos en una página
   - VIDEO 1 (#heroVideo): bucle ping-pong. Va de inicio a fin y
     regresa de fin a inicio, sin saltos.
   - VIDEO 2 (#stage): avanza y retrocede con el scroll.

   Para probar otros videos, cambia data-webm y data-mp4 en el HTML.
   ========================================================== */

const CONFIG = {
  minLoadTime: 900,      // ms mínimos de la animación de carga
  maxLoadWait: 10000,    // ms máximos esperando un video
  heroSpeed: 0.5,          // velocidad del bucle (1 = normal, 0.5 = mitad)
  smoothing: 0.3,        // scroll: más alto = responde más rápido
  touchSmoothing: 0.55, // en el teléfono el scroll ya tiene inercia
  fadeScreens: 0.5       // cuánto scroll (en pantallas) dura el cambio del video 1 al 2
};

const isTouch = window.matchMedia("(pointer: coarse)").matches;
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);

const els = {
  heroLayer: document.getElementById("heroLayer"),
  heroVideo: document.getElementById("heroVideo"),
  scene: document.getElementById("scene"),
  stage: document.getElementById("stage"),
  sceneStatus: document.getElementById("sceneStatus"),
  loader: document.getElementById("loader"),
  loaderCount: document.getElementById("loaderCount"),
  loaderError: document.getElementById("loaderError"),
  routeFill: document.getElementById("routeFill"),
  routePlane: document.getElementById("routePlane"),
  progressFill: document.getElementById("progressFill"),
  hint: document.getElementById("hint"),
  chapters: Array.from(document.querySelectorAll(".chapter"))
};

/* ---------- Utilidades para recorrer un video ---------- */

// Mantiene una sola búsqueda activa y sustituye las pendientes por la más
// reciente para que el video no se quede reproduciendo posiciones atrasadas.
function makeSeeker(video) {
  let seeking = false;
  let queuedTime = null;

  function seekNext() {
    if (seeking || queuedTime === null) return;

    const t = queuedTime;
    queuedTime = null;
    if (Math.abs(video.currentTime - t) < 0.001 && !video.seeking) return;

    seeking = true;
    video.currentTime = t;
  }

  video.addEventListener("seeked", () => {
    seeking = false;
    seekNext();
  });

  return function seek(t) {
    queuedTime = t;
    seekNext();
  };
}

function videoFps(video) {
  const fps = parseFloat(video.dataset.fps);
  return isNaN(fps) || fps <= 0 ? 24 : fps;
}

// Elige WebM o MP4 (en Safari se prefiere MP4)
function pickSource(video) {
  const options = [
    { src: video.dataset.webm, type: 'video/webm; codecs="vp9"' },
    { src: video.dataset.mp4,  type: 'video/mp4; codecs="avc1.42E01E"' }
  ].filter((o) => o.src);
  if (isSafari) options.reverse();
  for (const o of options) {
    if (video.canPlayType(o.type) !== "") return o.src;
  }
  return options.length ? options[options.length - 1].src : "";
}

function loadVideo(video, onProgress) {
  return new Promise((resolve, reject) => {
    const src = pickSource(video);
    if (!src) return reject(new Error("Falta data-webm o data-mp4 en el video"));

    video.muted = true;
    video.src = src;

    const timeout = setTimeout(() => {
      if (video.readyState >= 2) { onProgress(1); resolve(); }
      else reject(new Error("El video " + src + " tardó demasiado en cargar"));
    }, CONFIG.maxLoadWait);

    function updateBuffered() {
      if (!video.duration || !video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1);
      onProgress(Math.min(1, end / video.duration));
    }

    video.addEventListener("progress", updateBuffered);
    video.addEventListener("loadedmetadata", updateBuffered);
    video.addEventListener("canplaythrough", () => {
      clearTimeout(timeout);
      onProgress(1);
      resolve();
    }, { once: true });
    video.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("No se pudo cargar " + src));
    }, { once: true });

    video.load();

    // En iPhone el video no baja datos hasta que "se reproduce" una vez
    const p = video.play();
    if (p && p.then) p.then(() => video.pause()).catch(() => {});
  });
}

/* ---------- Animación de carga breve ---------- */

let loaderProgress = 0; // 0 a 1, según lo descargado del video 1

function runLoaderAnimation() {
  const track = els.routeFill;
  const total = track.getTotalLength();
  const start = performance.now();
  let shown = 0;

  function place(p) {
    track.style.strokeDashoffset = String(100 - p * 100);
    const pt = track.getPointAtLength(total * p);
    const ahead = track.getPointAtLength(Math.min(total, total * p + 1));
    const angle = Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180 / Math.PI;
    els.routePlane.setAttribute("transform", "translate(" + pt.x + " " + pt.y + ") rotate(" + angle + ")");
    els.loaderCount.textContent = Math.round(p * 100) + "%";
  }

  place(0);

  return new Promise((resolve) => {
    function tick(now) {
      const byTime = Math.min(1, (now - start) / CONFIG.minLoadTime);
      const target = Math.min(byTime, loaderProgress);
      shown += (target - shown) * 0.3;
      if (target - shown < 0.002) shown = target;
      place(shown);

      if (shown >= 1) return resolve();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

/* ---------- VIDEO 1: bucle ping-pong ----------
   El tiempo avanza con el reloj (no con los saltos del video), así la
   velocidad es siempre la misma aunque el teléfono tarde en responder.
   Al llegar al final se invierte la dirección, y al llegar al inicio
   vuelve a invertirse: no hay saltos ni cortes. */

const hero = {
  video: els.heroVideo,
  seek: makeSeeker(els.heroVideo),
  fps: videoFps(els.heroVideo),
  duration: 0,
  time: 0,
  dir: 1,
  lastTs: 0,
  visible: true
};

function heroTick(now) {
  const dt = Math.min(0.1, (now - hero.lastTs) / 1000); // máx. 0,1 s: evita saltos tras una pausa
  hero.lastTs = now;

  if (hero.visible && !document.hidden && hero.duration > 0) {
    const frameStep = 1 / hero.fps;
    const end = Math.max(frameStep, hero.duration - frameStep); // último fotograma

    hero.time += hero.dir * dt * CONFIG.heroSpeed;

    // Rebote en los extremos (ping-pong)
    if (hero.time >= end) { hero.time = end - (hero.time - end); hero.dir = -1; }
    if (hero.time <= 0)   { hero.time = -hero.time;               hero.dir = 1; }
    hero.time = Math.min(end, Math.max(0, hero.time));

    hero.seek(Math.round(hero.time * hero.fps) / hero.fps);
  }
  requestAnimationFrame(heroTick);
}

// El video 1 solo se mueve mientras se ve (se controla en onScroll con hero.visible)

/* ---------- VIDEO 2: controlado por el scroll ---------- */

const scroll = {
  video: els.stage,
  seek: makeSeeker(els.stage),
  fps: videoFps(els.stage),
  duration: 0,
  shown: 0,
  target: 0,
  ready: false,
  error: false
};

function scrollTick() {
  if (scroll.ready) {
    const smoothing = isTouch ? CONFIG.touchSmoothing : CONFIG.smoothing;
    scroll.shown += (scroll.target - scroll.shown) * smoothing;
    if (Math.abs(scroll.target - scroll.shown) < 0.5 / scroll.fps) scroll.shown = scroll.target;

    // Siempre un fotograma exacto: sin mezclas, sin efecto fantasma
    const t = Math.min(scroll.duration - 0.01, Math.max(0, Math.round(scroll.shown * scroll.fps) / scroll.fps));
    scroll.seek(t);
  }
  requestAnimationFrame(scrollTick);
}

/* ---------- Scroll de la página ---------- */

function smoothstep(x) {
  return x * x * (3 - 2 * x);
}

// "fade" (0 a 1): cambio del video 1 al video 2, justo al empezar a bajar.
// "p" (0 a 1): recorrido del video 2 una vez hecho el cambio.
function getSceneState() {
  const rect = els.scene.getBoundingClientRect();
  const scrolled = Math.max(0, -rect.top);
  const total = els.scene.offsetHeight - window.innerHeight;
  const fadeDist = Math.min(total * 0.5, window.innerHeight * CONFIG.fadeScreens);
  const fade = fadeDist > 0 ? Math.min(1, scrolled / fadeDist) : 1;
  const rest = total - fadeDist;
  const p = rest > 0 ? Math.min(1, Math.max(0, (scrolled - fadeDist) / rest)) : 1;
  return { fade, p };
}

function updateChapters(p) {
  els.chapters.forEach((ch) => {
    const start = parseFloat(ch.dataset.start);
    const end = parseFloat(ch.dataset.end);
    ch.classList.toggle("is-active", p >= start && p <= end);
  });
}

function updatePageProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const p = max > 0 ? window.scrollY / max : 0;
  els.progressFill.style.width = p * 100 + "%";
}

function onScroll() {
  const { fade, p } = getSceneState();

  // Hasta que el video 2 esté listo, el video 1 sigue visible
  const f = scroll.ready ? smoothstep(fade) : 0;
  els.heroLayer.style.opacity = String(1 - f);
  hero.visible = f < 1;

  scroll.target = p * scroll.duration;
  updateChapters(p);
  updatePageProgress();

  // Aviso solo si el usuario ya bajó y el video 2 todavía no está listo
  if (!scroll.error) {
    els.sceneStatus.classList.toggle("is-hidden", scroll.ready || window.scrollY < 20);
  }
}

/* ---------- Inicio ---------- */

async function loadScrollVideo() {
  try {
    await loadVideo(scroll.video, () => {});
    scroll.duration = scroll.video.duration;
    if (!isFinite(scroll.duration) || scroll.duration <= 0) {
      throw new Error("No se pudo leer la duración del video 2");
    }
    scroll.video.currentTime = 0;
    scroll.ready = true;
    onScroll();
    scroll.shown = scroll.target;
    els.sceneStatus.classList.add("is-hidden");
  } catch (err) {
    console.error(err);
    scroll.error = true;
    els.sceneStatus.classList.remove("is-hidden");
    els.sceneStatus.classList.add("is-error");
    els.sceneStatus.textContent =
      "No se pudo cargar el video 2. Revisa los nombres en data-webm y data-mp4 y que los archivos estén junto a index.html. Detalle: " +
      err.message;
  }
}

async function init() {
  window.addEventListener("scroll", onScroll, { passive: true });

  const animation = runLoaderAnimation();

  try {
    // 1) Solo se espera al video 1; el video 2 baja después, mientras ves el inicio
    await loadVideo(hero.video, (p) => { loaderProgress = p; });
    hero.duration = hero.video.duration;
    if (!isFinite(hero.duration) || hero.duration <= 0) {
      throw new Error("No se pudo leer la duración del video 1");
    }

    await animation;

    hero.video.currentTime = 0;
    hero.lastTs = performance.now();
    requestAnimationFrame(heroTick);
    requestAnimationFrame(scrollTick);
    els.loader.classList.add("is-done");

    // 2) Ahora sí, el video del scroll
    loadScrollVideo();
  } catch (err) {
    console.error(err);
    els.loaderError.hidden = false;
    els.loaderError.textContent =
      "No se pudo cargar el video 1. Revisa los nombres en data-webm y data-mp4 y que los archivos estén junto a index.html. Detalle: " +
      err.message;
  }
}

init();
