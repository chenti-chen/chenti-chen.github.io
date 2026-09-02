/* Inline CV preview: renders the CV PDF to <canvas> pages with PDF.js so it
   works on every browser, including iOS Safari and Android Chrome, which do
   not render multi-page PDFs inside an <iframe>.

   - Pages are rendered lazily as they scroll into view and released again
     when they scroll far away, so memory stays bounded on phones/iPads.
   - Bitmaps are drawn at container width x devicePixelRatio (capped at 2)
     with a floor of ~150 dpi so pinch-zoomed text stays legible.
   - Width or pixel-ratio changes redraw the visible pages in place.
   - Any failure falls back to a one-line message with the PDF link. */
(function () {
  'use strict';

  var MIN_BITMAP_WIDTH = 1275; // ~150 dpi for a Letter page
  var MAX_DPR = 2;
  var LOAD_TIMEOUT_MS = 25000;

  function init() {
    var root = document.getElementById('cv-embed');
    if (!root) { return; }

    var status = root.querySelector('.cv-embed__status');
    var pagesEl = root.querySelector('.cv-embed__pages');
    var pdfUrl = root.getAttribute('data-pdf');
    var workerUrl = root.getAttribute('data-worker');

    function setStatus(text) {
      if (!status) { return; }
      status.textContent = text;
      if (pdfUrl) {
        status.appendChild(document.createTextNode(' — '));
        var a = document.createElement('a');
        a.href = pdfUrl;
        a.textContent = 'open the PDF';
        status.appendChild(a);
        status.appendChild(document.createTextNode('.'));
      }
    }

    function releaseCanvas(canvas) {
      if (!canvas) { return; }
      canvas.width = 0;
      canvas.height = 0;
      if (canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
    }

    function fail(text) {
      root.classList.add('cv-embed--failed');
      root.classList.remove('cv-embed--loaded', 'cv-embed--loading');
      Array.prototype.forEach.call(pagesEl.querySelectorAll('canvas'), releaseCanvas);
      pagesEl.innerHTML = '';
      setStatus(text);
    }

    if (!window.pdfjsLib || !pdfUrl) {
      fail('Preview unavailable in this browser');
      return;
    }
    if (workerUrl) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    root.classList.add('cv-embed--loading');
    setStatus('Loading the CV…');

    var pdfDoc = null;
    var pages = [];
    var observer = null;

    function pixelRatio() {
      return Math.min(window.devicePixelRatio || 1, MAX_DPR);
    }

    function contentWidth() {
      var cs = window.getComputedStyle(pagesEl);
      return pagesEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    }

    /* Identity of a rendering: the bitmap width it was drawn at. */
    function renderKey() {
      var w = contentWidth();
      if (!w) { return 0; }
      return Math.max(Math.round(w * pixelRatio()), MIN_BITMAP_WIDTH);
    }

    function renderPage(entry) {
      var key = renderKey();
      if (!key) { return; }
      if (entry.renderedKey === key || entry.rendering) { return; }
      entry.rendering = true;
      pdfDoc.getPage(entry.num).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var vp = page.getViewport({ scale: key / base.width });
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
          releaseCanvas(entry.canvas);
          entry.canvas = canvas;
          entry.el.appendChild(canvas);
          entry.renderedKey = key;
          entry.rendering = false;
          if (!root.classList.contains('cv-embed--loaded')) {
            root.classList.add('cv-embed--loaded');
            root.classList.remove('cv-embed--loading');
          }
          if (entry.dirty) {
            entry.dirty = false;
            renderPage(entry);
          }
        });
      }).catch(function () {
        entry.rendering = false;
        if (!entry.canvas) {
          fail('Preview could not be rendered');
        }
        // otherwise keep the previous bitmap; CSS scales it
      });
    }

    function releasePage(entry) {
      if (entry.rendering) { entry.dirty = true; return; }
      releaseCanvas(entry.canvas);
      entry.canvas = null;
      entry.renderedKey = null;
    }

    function onIntersect(records) {
      records.forEach(function (rec) {
        var entry = rec.target.__cvPage;
        if (!entry) { return; }
        if (rec.isIntersecting) {
          renderPage(entry);
        } else if (entry.canvas) {
          releasePage(entry);
        }
      });
    }

    function buildSlots(doc) {
      pdfDoc = doc;
      pagesEl.innerHTML = '';
      pages = [];
      if (window.IntersectionObserver) {
        observer = new IntersectionObserver(onIntersect, { rootMargin: '100% 0px' });
      }
      var chain = Promise.resolve();
      var n;
      for (n = 1; n <= doc.numPages; n++) {
        (function (num) {
          chain = chain.then(function () {
            return doc.getPage(num);
          }).then(function (page) {
            var vp = page.getViewport({ scale: 1 });
            var el = document.createElement('div');
            el.className = 'cv-embed__slot';
            el.style.aspectRatio = vp.width + ' / ' + vp.height;
            var entry = { num: num, el: el, canvas: null, renderedKey: null, rendering: false, dirty: false };
            el.__cvPage = entry;
            pages.push(entry);
            pagesEl.appendChild(el);
            if (observer) {
              observer.observe(el);
            } else {
              renderPage(entry);
            }
          });
        })(n);
      }
      return chain;
    }

    /* Width or pixel-ratio changed: redraw visible pages, forget stale ones. */
    var resizeTimer = null;
    function onLayoutChange() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!pdfDoc) { return; }
        var key = renderKey();
        pages.forEach(function (entry) {
          if (entry.renderedKey === null || entry.renderedKey === key) { return; }
          if (Math.abs(key - entry.renderedKey) / entry.renderedKey <= 0.2 && pixelRatio() === entry.dpr) { return; }
          if (observer) {
            // re-observing fires an initial callback with the current visibility
            observer.unobserve(entry.el);
            observer.observe(entry.el);
          } else {
            renderPage(entry);
          }
        });
      }, 250);
    }

    function watchDpr() {
      if (!window.matchMedia) { return; }
      var mq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      var handler = function () {
        if (mq.removeEventListener) { mq.removeEventListener('change', handler); } else { mq.removeListener(handler); }
        onLayoutChange();
        watchDpr();
      };
      if (mq.addEventListener) { mq.addEventListener('change', handler); } else { mq.addListener(handler); }
    }

    var task;
    try {
      task = window.pdfjsLib.getDocument({ url: pdfUrl });
    } catch (e) {
      fail('Preview could not be loaded');
      return;
    }
    var watchdog = setTimeout(function () {
      if (!pdfDoc) {
        try { task.destroy(); } catch (e) { /* ignore */ }
        fail('Preview is taking too long to load');
      }
    }, LOAD_TIMEOUT_MS);

    task.promise.then(function (doc) {
      clearTimeout(watchdog);
      return buildSlots(doc);
    }).then(function () {
      window.addEventListener('resize', onLayoutChange);
      watchDpr();
    }).catch(function () {
      clearTimeout(watchdog);
      fail('Preview could not be loaded');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
