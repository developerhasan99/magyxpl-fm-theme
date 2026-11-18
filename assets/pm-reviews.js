/* pm-reviews.js: theme-owned reviews (sections/pm-reviews.liquid). Custom element <pm-reviews>.
   Data: assets/pm-reviews.json (scripts/build_reviews.py), fetched once per page (window.__pmReviewsCache, shared by
   every instance) when a section comes within 600px of the viewport.
   Renders the cards into masonry columns (1 below 750, 2 from 750, data-cols from 990), load more, histogram filter
   (click a row = only that rating, click again or "Wyczyść filtr" = all; aria-pressed + live region), photo dialog.
   All review text goes in through textContent. Strings come from the section's JSON config (locale keys). */
(function () {
  'use strict';

  if (!window.customElements || window.customElements.get('pm-reviews')) return;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STAR_PATH = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';
  var CHECK_PATH = 'm20 6-11 11-5-5';
  var PLURAL_SAMPLE = { one: '1', few: '2', many: '5', other: '5' };
  var DAY = 86400000;

  var cache = window.__pmReviewsCache || (window.__pmReviewsCache = {});

  function loadData(url) {
    if (!cache[url]) {
      cache[url] = fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('pm-reviews: HTTP ' + res.status);
        return res.json();
      });
      cache[url].catch(function () {
        delete cache[url];
      });
    }
    return cache[url];
  }

  function fill(template, map) {
    // Placeholders are [key]: curly braces inside a Liquid output tag break the Liquid lexer.
    return String(template || '').replace(/\[(\w+)\]/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(map, key) ? String(map[key]) : match;
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function svg(path, size, opts) {
    var node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', size);
    node.setAttribute('height', size);
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    if (opts && opts.stroke) {
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '2');
      node.setAttribute('stroke-linecap', 'round');
      node.setAttribute('stroke-linejoin', 'round');
    } else {
      node.setAttribute('fill', 'currentColor');
    }
    if (opts && opts.className) node.setAttribute('class', opts.className);
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    node.appendChild(p);
    return node;
  }

  function parseDay(iso) {
    var parts = String(iso || '').split('-');
    if (parts.length !== 3) return null;
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    return isNaN(d.getTime()) ? null : d;
  }

  class PmReviews extends HTMLElement {
    connectedCallback() {
      if (this._ready) return;
      this._ready = true;

      var cfgNode = this.querySelector('[data-pm-rv-config]');
      try {
        this.cfg = JSON.parse(cfgNode ? cfgNode.textContent : '{}');
      } catch (e) {
        this.cfg = {};
      }
      this.t = this.cfg.t || {};
      this.lang = this.cfg.lang || document.documentElement.lang || 'pl';
      this.mode = this.dataset.mode || 'product';
      this.handle = this.dataset.productHandle || '';
      this.assetBase = this.dataset.assetBase || '';
      this.initial = parseInt(this.dataset.initial, 10) || 6;
      this.step = parseInt(this.dataset.more, 10) || 6;
      this.desktopCols = parseInt(this.dataset.cols, 10) || 2;

      try {
        this.pluralRules = new Intl.PluralRules(this.lang);
      } catch (e) {
        this.pluralRules = null;
      }
      try {
        this.rtf = new Intl.RelativeTimeFormat(this.lang, { numeric: 'auto' });
      } catch (e) {
        this.rtf = null;
      }

      this.listEl = this.querySelector('[data-pm-rv-list]');
      this.loadingEl = this.querySelector('[data-pm-rv-loading]');
      this.emptyEl = this.querySelector('[data-pm-rv-empty]');
      this.errorEl = this.querySelector('[data-pm-rv-error]');
      this.moreWrap = this.querySelector('[data-pm-rv-more-wrap]');
      this.moreBtn = this.querySelector('[data-pm-rv-more]');
      this.statusEl = this.querySelector('[data-pm-rv-status]');
      this.filterEl = this.querySelector('[data-pm-rv-filter]');
      this.filterText = this.querySelector('[data-pm-rv-filter-text]');
      this.clearBtn = this.querySelector('[data-pm-rv-clear]');
      this.bars = Array.prototype.slice.call(this.querySelectorAll('[data-pm-rv-star]'));
      this.dialog = this.querySelector('[data-pm-rv-dialog]');
      this.dialogImg = this.querySelector('[data-pm-rv-dialog-img]');

      this.star = 0;
      this.cards = [];
      this.cols = [];
      this.colCount = 0;

      var self = this;
      this.bars.forEach(function (bar) {
        bar.addEventListener('click', function () {
          var star = parseInt(bar.getAttribute('data-pm-rv-star'), 10) || 0;
          self.setFilter(self.star === star ? 0 : star);
        });
      });
      if (this.clearBtn) {
        this.clearBtn.addEventListener('click', function () {
          var active = self.barFor(self.star);
          self.setFilter(0);
          if (active) active.focus();
        });
      }
      if (this.moreBtn) {
        this.moreBtn.addEventListener('click', function () {
          self.showMore();
        });
      }
      this.setupDialog();

      this.mq750 = window.matchMedia('(min-width: 750px)');
      this.mq990 = window.matchMedia('(min-width: 990px)');
      this.onMedia = function () {
        self.layoutColumns();
      };
      [this.mq750, this.mq990].forEach(function (mq) {
        if (mq.addEventListener) mq.addEventListener('change', self.onMedia);
        else if (mq.addListener) mq.addListener(self.onMedia);
      });

      if ('IntersectionObserver' in window) {
        this.io = new IntersectionObserver(
          function (entries) {
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
              self.io.disconnect();
              self.io = null;
              self.load();
            }
          },
          { rootMargin: '600px 0px' }
        );
        this.io.observe(this);
      } else {
        this.load();
      }
    }

    disconnectedCallback() {
      if (this.io) this.io.disconnect();
      var self = this;
      [this.mq750, this.mq990].forEach(function (mq) {
        if (!mq) return;
        if (mq.removeEventListener) mq.removeEventListener('change', self.onMedia);
        else if (mq.removeListener) mq.removeListener(self.onMedia);
      });
    }

    load() {
      if (this.loading || this.data) return this.loading;
      var self = this;
      var src = this.dataset.src;
      if (!src) return null;
      this.loading = loadData(src)
        .then(function (data) {
          self.data = data || {};
          self.prepare();
          if (self.star) self.setFilter(self.star);
          else self.render();
        })
        .catch(function () {
          self.loading = null;
          if (self.loadingEl) self.loadingEl.hidden = true;
          if (self.errorEl) self.errorEl.hidden = false;
          if (self.listEl) self.listEl.setAttribute('aria-busy', 'false');
        });
      return this.loading;
    }

    /* Source list for this instance: shop reviews only, or all; product mode puts this product's reviews first */
    prepare() {
      var all = Array.isArray(this.data.reviews) ? this.data.reviews : [];
      var base = this.mode === 'shop' ? all.filter(function (r) { return r.s; }) : all.slice();
      if (this.mode === 'product' && this.handle) {
        var handle = this.handle;
        var mine = base.filter(function (r) { return r.p === handle; });
        var rest = base.filter(function (r) { return r.p !== handle; });
        base = mine.concat(rest);
      }
      this.base = base;
      this.products = this.data.products || {};
      this.updateSummary();
    }

    /* Summary numbers recounted from the source list (shop mode differs from the store totals rendered by Liquid) */
    updateSummary() {
      var hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      var sum = 0;
      this.base.forEach(function (r) {
        var v = Math.round(r.r) || 0;
        if (hist[v] != null) hist[v] += 1;
        sum += v;
      });
      var count = this.base.length;
      this.hist = hist;
      if (!count) return;
      var avg = sum / count;
      var big = String(Number(avg.toFixed(2)));
      if (big.indexOf('.') < 0) big += '.0';
      big = big.replace('.', ',');
      var short = avg.toFixed(1).replace('.', ',');

      var avgEl = this.querySelector('[data-pm-rv-avg]');
      if (avgEl) avgEl.textContent = big;
      var avgStars = this.querySelector('[data-pm-rv-avg-stars]');
      if (avgStars) avgStars.setAttribute('aria-label', fill(this.t.rating_aria, { rating: short }));
      var basedEl = this.querySelector('[data-pm-rv-based]');
      if (basedEl) basedEl.textContent = this.plural(this.t.based_on, count);
      var headEl = this.querySelector('[data-pm-rv-head]');
      if (headEl) headEl.textContent = short + ' · ' + this.plural(this.t.count, count);

      var self = this;
      this.bars.forEach(function (bar) {
        var star = parseInt(bar.getAttribute('data-pm-rv-star'), 10);
        var n = hist[star] || 0;
        var nEl = bar.querySelector('[data-pm-rv-n]');
        if (nEl) nEl.textContent = String(n);
        var fillEl = bar.querySelector('[data-pm-rv-fill]');
        if (fillEl) fillEl.style.setProperty('--pm-rv-pct', Math.round((n / count) * 1000) / 10 + '%');
        bar.setAttribute('aria-label', fill(self.t.filter_aria, { stars: star, count: n }));
        bar.disabled = n === 0;
      });
    }

    plural(forms, n) {
      forms = forms || {};
      var cat = this.pluralRules ? this.pluralRules.select(n) : n === 1 ? 'one' : 'other';
      var key = forms[cat] ? cat : 'other';
      /* each form was rendered by Liquid with a sample count (1, 2 or 5): swap that number for n */
      return String(forms[key] || '').replace(PLURAL_SAMPLE[key] || PLURAL_SAMPLE.other, String(n));
    }

    barFor(star) {
      for (var i = 0; i < this.bars.length; i++) {
        if (parseInt(this.bars[i].getAttribute('data-pm-rv-star'), 10) === star) return this.bars[i];
      }
      return null;
    }

    view() {
      var star = this.star;
      if (!this.base) return [];
      return star ? this.base.filter(function (r) { return Math.round(r.r) === star; }) : this.base;
    }

    setFilter(star) {
      this.star = star;
      var self = this;
      this.bars.forEach(function (bar) {
        var s = parseInt(bar.getAttribute('data-pm-rv-star'), 10);
        bar.setAttribute('aria-pressed', s === star ? 'true' : 'false');
      });
      this.classList.toggle('is-filtered', !!star);

      if (!this.data) {
        this.load();
        return;
      }
      this.render();

      var total = this.view().length;
      var countText = this.plural(this.t.count, total);
      var message = star ? fill(this.t.filter_on, { stars: star, count: countText }) : fill(this.t.filter_off, { count: countText });
      if (this.filterEl) {
        this.filterEl.hidden = !star;
        if (this.filterText) this.filterText.textContent = star ? message : '';
      }
      this.announce(message);
    }

    announce(message) {
      if (!this.statusEl) return;
      this.statusEl.textContent = '';
      var node = this.statusEl;
      window.setTimeout(function () {
        node.textContent = message;
      }, 50);
    }

    render() {
      if (this.loadingEl) this.loadingEl.hidden = true;
      if (this.errorEl) this.errorEl.hidden = true;
      this.cards = [];
      this.shown = 0;
      this.colCount = 0;
      this.layoutColumns();
      this.append(this.initial);
      if (this.listEl) this.listEl.setAttribute('aria-busy', 'false');
      if (this.emptyEl) this.emptyEl.hidden = this.view().length > 0;
    }

    columnsWanted() {
      // "1" = single-column list (Judge.me layout) at every width
      if (this.desktopCols === 1) return 1;
      if (this.mq990 && this.mq990.matches) return Math.max(1, Math.min(3, this.desktopCols));
      if (this.mq750 && this.mq750.matches) return 2;
      return 1;
    }

    layoutColumns() {
      if (!this.listEl) return;
      var n = this.columnsWanted();
      if (n === this.colCount && this.cols.length) return;
      this.colCount = n;
      this.listEl.textContent = '';
      this.cols = [];
      for (var i = 0; i < n; i++) {
        var col = el('div', 'pm-rv__col');
        col.setAttribute('role', 'none');
        this.listEl.appendChild(col);
        this.cols.push(col);
      }
      var self = this;
      this.cards.forEach(function (card) {
        self.place(card);
      });
    }

    place(card) {
      var target = this.cols[0];
      for (var i = 1; i < this.cols.length; i++) {
        if (this.cols[i].offsetHeight < target.offsetHeight) target = this.cols[i];
      }
      target.appendChild(card);
    }

    append(n) {
      var list = this.view();
      var next = list.slice(this.shown, this.shown + n);
      var first = null;
      for (var i = 0; i < next.length; i++) {
        var card = this.card(next[i]);
        this.cards.push(card);
        this.place(card);
        if (!first) first = card;
      }
      this.shown += next.length;
      if (this.moreWrap) this.moreWrap.hidden = this.shown >= list.length;
      return first;
    }

    showMore() {
      var first = this.append(this.step);
      var total = this.view().length;
      this.announce(fill(this.t.shown, { shown: this.shown, total: total }));
      if (first && this.moreWrap && this.moreWrap.hidden) {
        first.setAttribute('tabindex', '-1');
        first.focus({ preventScroll: true });
      }
    }

    relativeDate(iso) {
      var d = parseDay(iso);
      if (!d) return iso || '';
      var now = new Date();
      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var days = Math.max(0, Math.round((today - d) / DAY));
      if (!this.rtf) return iso;
      if (days < 7) return this.rtf.format(-days, 'day');
      if (days < 30) return this.rtf.format(-Math.floor(days / 7), 'week');
      if (days < 365) return this.rtf.format(-Math.max(1, Math.floor(days / 30)), 'month');
      return this.rtf.format(-Math.floor(days / 365), 'year');
    }

    photoUrl(file) {
      if (/^(https?:)?\/\//.test(file)) return file;
      return this.assetBase + file;
    }

    productUrl(handle) {
      var root = this.cfg.root || '/';
      if (root.charAt(root.length - 1) !== '/') root += '/';
      return root + 'products/' + encodeURIComponent(handle);
    }

    card(r) {
      var self = this;
      var rating = Math.max(0, Math.min(5, Math.round(r.r) || 0));
      var article = el('article', 'pm-review');
      article.setAttribute('role', 'listitem');
      var body = el('div', 'pm-review__body');
      article.appendChild(body);

      var meta = el('div', 'pm-review__meta');
      var who = el('div', 'pm-review__who');
      var whoInner = el('div');
      whoInner.appendChild(el('p', 'pm-review__name', r.n || ''));
      if (r.v) {
        var verified = el('span', 'pm-review__verified');
        verified.appendChild(svg(CHECK_PATH, 12, { stroke: true }));
        verified.appendChild(document.createTextNode(this.t.verified || ''));
        whoInner.appendChild(verified);
      }
      who.appendChild(whoInner);
      meta.appendChild(who);

      var ratingWrap = el('div', 'pm-review__rating');
      var stars = el('span', 'pm-review__stars');
      stars.setAttribute('role', 'img');
      stars.setAttribute('aria-label', fill(this.t.rating_aria, { rating: rating }));
      for (var i = 1; i <= 5; i++) {
        stars.appendChild(svg(STAR_PATH, 12, i > rating ? { className: 'is-empty' } : null));
      }
      ratingWrap.appendChild(stars);
      if (r.d) {
        var time = el('time', 'pm-review__date', this.relativeDate(r.d));
        time.setAttribute('datetime', r.d);
        ratingWrap.appendChild(time);
      }
      meta.appendChild(ratingWrap);
      body.appendChild(meta);

      var content = el('div', 'pm-rv__content');
      if (r.t) content.appendChild(el('p', 'pm-rv__title', r.t));
      if (r.b) content.appendChild(el('p', 'pm-rv__text', r.b));
      body.appendChild(content);

      if (Array.isArray(r.img) && r.img.length) {
        var photos = el('ul', 'pm-rv__photos');
        r.img.forEach(function (file, index) {
          var src = self.photoUrl(file);
          var li = el('li');
          var btn = el('button', 'pm-rv__thumb');
          btn.type = 'button';
          btn.setAttribute('aria-label', fill(self.t.photo_open, { index: index + 1, name: r.n || '' }));
          var img = el('img');
          img.src = src;
          img.alt = '';
          img.width = 56;
          img.height = 56;
          img.loading = 'lazy';
          img.decoding = 'async';
          btn.appendChild(img);
          btn.addEventListener('click', function () {
            self.openPhoto(src, fill(self.t.photo_alt, { name: r.n || '' }), btn);
          });
          li.appendChild(btn);
          photos.appendChild(li);
        });
        body.appendChild(photos);
      }

      var showProduct = r.p && this.products[r.p] && (this.mode === 'all' || (this.mode === 'product' && r.p !== this.handle));
      if (showProduct) {
        var line = el('p', 'pm-rv__product');
        var link = el('a', null, fill(this.t.product_line, { title: this.products[r.p].t || r.p }));
        link.href = this.productUrl(r.p);
        line.appendChild(link);
        body.appendChild(line);
      }
      return article;
    }

    setupDialog() {
      var dialog = this.dialog;
      if (!dialog) return;
      var self = this;
      var closeBtn = dialog.querySelector('[data-pm-rv-dialog-close]');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          dialog.close();
        });
      }
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', function () {
        if (self.lastTrigger && document.contains(self.lastTrigger)) self.lastTrigger.focus();
      });
    }

    openPhoto(src, alt, trigger) {
      var dialog = this.dialog;
      if (!dialog || typeof dialog.showModal !== 'function') {
        window.open(src, '_blank', 'noopener');
        return;
      }
      this.lastTrigger = trigger;
      if (this.dialogImg) {
        this.dialogImg.src = src;
        this.dialogImg.alt = alt;
      }
      dialog.showModal();
      var closeBtn = dialog.querySelector('[data-pm-rv-dialog-close]');
      if (closeBtn) closeBtn.focus();
    }
  }

  window.customElements.define('pm-reviews', PmReviews);
})();
