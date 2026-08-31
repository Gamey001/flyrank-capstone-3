/*!
 * FlyRank embeddable widget loader.
 *
 * Shipped to browsers we do not control, so it is deliberately plain ES5-era
 * JavaScript with no dependencies and no build step, wrapped in an IIFE so it
 * cannot collide with anything already on the customer's page.
 *
 * Everything it needs is derived from its own <script> tag:
 *   <script src="https://api.example.com/embed/v<hash>/widget.js?id=abc123" async></script>
 * The API origin comes from the script URL, the widget id from ?id=.
 */
(function () {
  'use strict';

  var NS = '__flyrankWidget';

  // The customer may paste the snippet twice, or a SPA may re-inject it, so
  // mounted widget ids are tracked on window and a repeat mount is a no-op.
  window[NS] = window[NS] || { mounted: {} };

  function currentScript() {
    if (document.currentScript) return document.currentScript;
    // Fallback for browsers without document.currentScript: the running script
    // is, at parse time, the last one in the document.
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('widget.js') !== -1) return scripts[i];
    }
    return null;
  }

  var script = currentScript();
  if (!script || !script.src) return;

  var scriptUrl;
  try {
    scriptUrl = new URL(script.src, window.location.href);
  } catch (e) {
    return;
  }

  var widgetId = scriptUrl.searchParams.get('id') || script.getAttribute('data-widget-id');
  var apiBase = script.getAttribute('data-api-base') || scriptUrl.origin;
  if (!widgetId) {
    console.error('[flyrank] <script> tag is missing the widget id (?id=...)');
    return;
  }
  if (window[NS].mounted[widgetId]) return;
  window[NS].mounted[widgetId] = true;

  var renderedAt = Date.now();

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props || {}) {
      if (key === 'style') node.style.cssText = props[key];
      else if (key === 'text') node.textContent = props[key];
      else node.setAttribute(key, props[key]);
    }
    (children || []).forEach(function (child) {
      node.appendChild(child);
    });
    return node;
  }

  /**
   * One stylesheet for the page, no matter how many widgets are on it — but
   * every colour is a CSS custom property set on the individual widget root.
   * Two widgets from different customers can therefore share one <style> tag
   * and still keep their own accent and theme; baking the colours into the
   * shared rules would let whichever widget loaded first repaint the others.
   */
  function injectStyles() {
    if (document.getElementById('flyrank-widget-styles')) return;
    var css = [
      '.fr-widget{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      'box-sizing:border-box;max-width:380px;padding:20px;border-radius:12px;',
      'background:var(--fr-bg);color:var(--fr-fg);',
      'border:1px solid var(--fr-border);box-shadow:0 4px 16px rgba(0,0,0,.08);}',
      '.fr-widget *{box-sizing:border-box;}',
      '.fr-widget h3{margin:0 0 4px;font-size:17px;font-weight:600;}',
      '.fr-widget p.fr-desc{margin:0 0 14px;font-size:13px;opacity:.72;}',
      '.fr-widget label{display:block;margin:0 0 4px;font-size:12px;font-weight:600;opacity:.8;}',
      '.fr-field{margin-bottom:11px;}',
      '.fr-widget input,.fr-widget textarea,.fr-widget select{width:100%;padding:9px 10px;font:inherit;',
      'border:1px solid var(--fr-input-border);border-radius:7px;',
      'background:var(--fr-input-bg);color:inherit;}',
      '.fr-widget input:focus,.fr-widget textarea:focus,.fr-widget select:focus{',
      'outline:2px solid var(--fr-accent);outline-offset:1px;border-color:var(--fr-accent);}',
      '.fr-widget textarea{min-height:80px;resize:vertical;}',
      /* A checkbox is not a text field: it must not stretch, and its label
         belongs beside it rather than above it. */
      '.fr-check label{display:flex;align-items:flex-start;gap:8px;margin:0;',
      'font-weight:400;font-size:13px;opacity:1;cursor:pointer;}',
      '.fr-widget .fr-check input{width:auto;flex:0 0 auto;margin-top:2px;accent-color:var(--fr-accent);}',
      '.fr-widget button{width:100%;margin-top:6px;padding:10px 14px;font:inherit;font-weight:600;',
      'color:#fff;background:var(--fr-accent);border:0;border-radius:7px;cursor:pointer;}',
      '.fr-widget button[disabled]{opacity:.6;cursor:progress;}',
      '.fr-status{margin-top:10px;font-size:13px;min-height:18px;}',
      '.fr-status[data-tone="error"]{color:#dc2626;}',
      '.fr-status[data-tone="ok"]{color:#16a34a;}',
      '.fr-err{margin-top:3px;font-size:11px;color:#dc2626;}',
      /* The honeypot: present in the DOM for a bot to find, invisible and
         unreachable by keyboard for a human. `display:none` alone is skipped by
         some form fillers, so it is moved off-screen instead. */
      '.fr-hp{position:absolute!important;left:-9999px!important;top:-9999px!important;',
      'width:1px;height:1px;opacity:0;pointer-events:none;}',
      '.fr-float{position:fixed;z-index:2147483000;bottom:20px;}',
      '.fr-float[data-pos="bottom-right"]{right:20px;}',
      '.fr-float[data-pos="bottom-left"]{left:20px;}',
      '.fr-close{position:absolute;top:8px;right:10px;width:auto;margin:0;padding:2px 6px;',
      'background:none;color:inherit;opacity:.5;font-size:18px;line-height:1;}'
    ].join('');
    document.head.appendChild(el('style', { id: 'flyrank-widget-styles', text: css }));
  }

  function applyTheme(node, accent, theme) {
    var dark = theme === 'dark';
    var palette = {
      '--fr-accent': accent,
      '--fr-bg': dark ? '#1c1c1f' : '#fff',
      '--fr-fg': dark ? '#f2f2f4' : '#18181b',
      '--fr-border': dark ? '#333' : '#e4e4e7',
      '--fr-input-bg': dark ? '#131316' : '#fff',
      '--fr-input-border': dark ? '#3f3f46' : '#d4d4d8'
    };
    for (var key in palette) node.style.setProperty(key, palette[key]);
  }

  function mountPoint(config) {
    var explicit = document.querySelector('[data-flyrank-widget="' + widgetId + '"]');
    if (explicit) return explicit;
    var position = (config.display && config.display.position) || 'inline';
    var host = el('div', position === 'inline' ? {} : { class: 'fr-float', 'data-pos': position });
    if (position === 'inline' && script.parentNode) {
      script.parentNode.insertBefore(host, script.nextSibling);
    } else {
      document.body.appendChild(host);
    }
    return host;
  }

  function buildField(field) {
    var inputId = 'fr-' + widgetId + '-' + field.name;
    var input;
    if (field.type === 'checkbox') {
      input = el('input', { id: inputId, name: field.name, type: 'checkbox' });
      if (field.required) input.setAttribute('required', 'required');
      var wrapper = el('label', { for: inputId }, [input]);
      wrapper.appendChild(document.createTextNode(' ' + field.label + (field.required ? ' *' : '')));
      return el('div', { class: 'fr-field fr-check' }, [wrapper]);
    }
    if (field.type === 'textarea') {
      input = el('textarea', { id: inputId, name: field.name });
    } else if (field.type === 'select') {
      input = el('select', { id: inputId, name: field.name });
      (field.options || []).forEach(function (option) {
        var node = el('option', { value: option, text: option });
        input.appendChild(node);
      });
    } else {
      input = el('input', { id: inputId, name: field.name, type: field.type || 'text' });
    }
    if (field.placeholder) input.setAttribute('placeholder', field.placeholder);
    if (field.required) input.setAttribute('required', 'required');
    if (field.maxLength) input.setAttribute('maxlength', String(field.maxLength));

    return el('div', { class: 'fr-field' }, [
      el('label', { for: inputId, text: field.label + (field.required ? ' *' : '') }),
      input
    ]);
  }

  function render(config) {
    var display = config.display || {};
    var accent = display.accentColor || '#4f46e5';
    injectStyles();

    var host = mountPoint(config);
    var form = el('form', { class: 'fr-widget', novalidate: 'novalidate' });
    form.style.position = 'relative';
    applyTheme(form, accent, display.theme);

    form.appendChild(el('h3', { text: config.title }));
    if (config.description) form.appendChild(el('p', { class: 'fr-desc', text: config.description }));

    (config.fields || []).forEach(function (field) {
      form.appendChild(buildField(field));
    });

    // Honeypot. Rendered with the field name the API expects for this widget,
    // autocomplete off so a password manager never fills it for a real user.
    var honeypot = el('div', { class: 'fr-hp', 'aria-hidden': 'true' }, [
      el('label', { for: 'fr-hp-' + widgetId, text: 'Leave this field empty' }),
      el('input', {
        id: 'fr-hp-' + widgetId,
        type: 'text',
        name: config.honeypotField,
        tabindex: '-1',
        autocomplete: 'off'
      })
    ]);
    form.appendChild(honeypot);

    var button = el('button', { type: 'submit', text: config.buttonText || 'Submit' });
    form.appendChild(button);
    var status = el('div', { class: 'fr-status', role: 'status', 'aria-live': 'polite' });
    form.appendChild(status);

    if (display.position && display.position !== 'inline') {
      var close = el('button', { type: 'button', class: 'fr-close', text: '×', 'aria-label': 'Close' });
      close.addEventListener('click', function () {
        host.parentNode.removeChild(host);
      });
      form.appendChild(close);
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit(config, form, button, status);
    });

    host.appendChild(form);

    var delay = display.delaySeconds || 0;
    if (delay > 0) {
      host.style.display = 'none';
      setTimeout(function () {
        host.style.display = '';
      }, delay * 1000);
    }
  }

  function collect(form, config) {
    var data = {};
    (config.fields || []).forEach(function (field) {
      var node = form.elements[field.name];
      if (!node) return;
      data[field.name] = node.type === 'checkbox' ? node.checked : node.value;
    });
    var hp = form.elements[config.honeypotField];
    if (hp) data[config.honeypotField] = hp.value;
    return data;
  }

  function showFieldErrors(form, details) {
    Array.prototype.forEach.call(form.querySelectorAll('.fr-err'), function (node) {
      node.parentNode.removeChild(node);
    });
    (details || []).forEach(function (issue) {
      var name = (issue.path || '').split('.').pop();
      var input = form.elements[name];
      if (!input || !input.parentNode) return;
      input.parentNode.appendChild(el('div', { class: 'fr-err', text: issue.message }));
    });
  }

  function submit(config, form, button, status) {
    button.disabled = true;
    status.textContent = '';
    status.removeAttribute('data-tone');

    var body = {
      widgetId: widgetId,
      data: collect(form, config),
      // Used server-side as one spam signal: a form filled in 40ms was not
      // filled by a person.
      elapsedMs: Date.now() - renderedAt,
      pageUrl: window.location.href
    };

    fetch(apiBase + '/api/public/submissions', {
      method: 'POST',
      // Cross-origin by design — the API answers the preflight this triggers.
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'content-type': 'application/json',
        // A retry after a flaky network must not create a second lead.
        'idempotency-key': idempotencyKey()
      },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok, status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        if (result.ok) {
          form.reset();
          status.setAttribute('data-tone', 'ok');
          status.textContent = (result.payload && result.payload.message) || config.successMessage;
          // The lead is in. A further submission from this form is a new lead
          // and needs its own idempotency key and its own fill timer.
          pendingKey = null;
          renderedAt = Date.now();
          return;
        }
        status.setAttribute('data-tone', 'error');
        if (result.status === 429) {
          status.textContent = 'Too many submissions — please try again in a minute.';
        } else {
          status.textContent = (result.payload && result.payload.error && result.payload.error.message) ||
            'Something went wrong. Please try again.';
          showFieldErrors(form, result.payload && result.payload.error && result.payload.error.details);
        }
      })
      .catch(function () {
        status.setAttribute('data-tone', 'error');
        status.textContent = 'Network error — please try again.';
      })
      .then(function () {
        button.disabled = false;
      });
  }

  var pendingKey = null;
  function idempotencyKey() {
    // One key per attempt at a given form state: kept across retries of the
    // same submit, regenerated once a submission succeeds.
    if (!pendingKey) {
      pendingKey =
        (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
        String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    }
    return pendingKey;
  }

  function boot() {
    fetch(apiBase + '/api/public/widgets/' + encodeURIComponent(widgetId) + '/config', {
      mode: 'cors',
      credentials: 'omit'
    })
      .then(function (response) {
        if (!response.ok) throw new Error('config request failed with ' + response.status);
        return response.json();
      })
      .then(function (config) {
        pendingKey = null;
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function () {
            render(config);
          });
        } else {
          render(config);
        }
      })
      .catch(function (error) {
        // A widget that cannot load must stay invisible rather than break the
        // customer's page.
        console.error('[flyrank] could not load widget ' + widgetId + ':', error.message);
      });
  }

  boot();
})();
