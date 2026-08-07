(function () {
  var lastRenderedData = null;

  var STATUS_STYLE = {
    good: { icon: '✓', tone: 'good', label: 'Good' },
    warning: { icon: '!', tone: 'warn', label: 'Needs Work' },
    bad: { icon: '✕', tone: 'bad', label: 'Failing' },
  };

  var CATEGORY_STATUS_KEY = {
    hasWebsite: 'hasWebsiteStatus',
    mobile: 'mobileStatus',
    speed: 'speedStatus',
    ssl: 'sslStatus',
    social: 'socialStatus',
  };

  // Shared business-priority order for both "What This Is Costing You"
  // and "What To Fix First" — same underlying issues, different framing
  // (impact vs. action). Not the checklist's display order.
  var ISSUE_ORDER = ['hasWebsite', 'ssl', 'mobile', 'speed', 'social'];

  // tipWarn falls back to tipBad (and vice versa) since curated reports
  // can set either status even where the live checker only ever produces
  // one of the two.
  var FIX_META = {
    hasWebsite: {
      label: 'Get your site working',
      tipBad: "Right now visitors hit a dead end — that alone is likely costing you customers every day.",
    },
    ssl: {
      label: 'Turn on HTTPS',
      tipBad: 'Browsers flag your site as "Not Secure" without it, which scares visitors off before they read a word.',
    },
    mobile: {
      label: 'Fix your mobile layout',
      tipBad: 'Most visitors are on their phone — a broken mobile layout loses them in seconds.',
      tipWarn: 'Double-check your mobile layout on an actual phone — something about it may not be resizing right.',
    },
    speed: {
      label: 'Speed up your site',
      tipBad: 'Slow pages lose visitors before they even finish loading.',
      tipWarn: 'Trim your load time where you can — a couple of seconds is often the difference.',
    },
    social: {
      label: 'Link your social profiles',
      tipBad: "Make it easy for visitors to find you on social — right now there's no link from your site.",
    },
  };

  var IMPACT_META = {
    hasWebsite: {
      tipBad: "Visitors hit a dead end and just move on to the next search result — with no way to reach you at all.",
    },
    ssl: {
      tipBad: 'A "Not Secure" warning sends visitors straight to a competitor\'s site — no message, no phone call.',
    },
    mobile: {
      tipBad: 'Most people find local businesses by searching on their phone. If the site is hard to use there, they call the next name on the list.',
      tipWarn: "Some visitors on their phone are seeing a layout that doesn't quite work — a quiet leak, not a dramatic one.",
    },
    speed: {
      tipBad: 'Every extra second of load time pushes more visitors to leave before they even see what you offer.',
      tipWarn: 'A slow-loading page loses a share of visitors before it finishes — often without you ever knowing.',
    },
    social: {
      tipBad: "Visitors who'd follow or message you on social have no way to find those profiles from the site.",
    },
  };

  // Ranks whatever's bad/warning (bad first) into up to `limit` issues,
  // shared by the cost list and the fix list so they tell a consistent
  // story about the same underlying findings.
  function rankIssues(data, limit) {
    var bad = [];
    var warn = [];
    ISSUE_ORDER.forEach(function (key) {
      var status = data[CATEGORY_STATUS_KEY[key]];
      if (status === 'bad') bad.push(key);
      else if (status === 'warning') warn.push(key);
    });
    return bad.concat(warn).slice(0, limit);
  }

  function tipFor(meta, data, key) {
    var status = data[CATEGORY_STATUS_KEY[key]];
    return status === 'bad' ? (meta.tipBad || meta.tipWarn) : (meta.tipWarn || meta.tipBad);
  }

  function statusStyle(status) {
    return STATUS_STYLE[status] || STATUS_STYLE.warning;
  }

  // Score -> letter grade + color tier. 90+/80+ share the "good" tier,
  // 70+/60+ share "warn", anything below 60 is "bad".
  function gradeFromScore(score) {
    var s = Number(score) || 0;
    if (s >= 90) return { letter: 'A', tone: 'good' };
    if (s >= 80) return { letter: 'B', tone: 'good' };
    if (s >= 70) return { letter: 'C', tone: 'warn' };
    if (s >= 60) return { letter: 'D', tone: 'warn' };
    return { letter: 'F', tone: 'bad' };
  }

  function render(data) {
    data = data || {};
    lastRenderedData = data;
    resetContactSection();

    document.getElementById('businessName').textContent = data.businessName || 'Greenline Landscaping';
    document.getElementById('town').textContent = data.town || 'Millbrook, NY';
    document.getElementById('preparedDate').textContent = data.preparedDate || 'August 6, 2026';

    var score = data.overallScore != null ? data.overallScore : 54;
    document.getElementById('overallScore').textContent = score;

    var grade = gradeFromScore(score);
    document.getElementById('gradeLetter').textContent = grade.letter;
    var ringColorVar = { good: '--good-ring', warn: '--warn-ring', bad: '--bad-ring' }[grade.tone];
    var deg = Math.max(0, Math.min(360, Math.round((score / 100) * 360)));
    var gradeRing = document.getElementById('gradeRing');
    gradeRing.style.background =
      'conic-gradient(var(' + ringColorVar + ') ' + deg + 'deg, rgba(255,255,255,.16) ' + deg + 'deg 360deg)';

    var descriptions = data.descriptions || {};

    Object.keys(CATEGORY_STATUS_KEY).forEach(function (key) {
      var row = document.querySelector('.check-row[data-key="' + key + '"]');
      if (!row) return;
      var status = data[CATEGORY_STATUS_KEY[key]] || 'warning';
      var style = statusStyle(status);

      var dot = row.querySelector('.dot');
      dot.className = 'dot dot--' + style.tone;
      dot.querySelector('.dot-icon').textContent = style.icon;

      var pill = row.querySelector('.pill');
      pill.className = 'pill pill--' + style.tone;
      pill.textContent = style.label;

      if (descriptions[key]) {
        row.querySelector('.check-desc').textContent = descriptions[key];
      }
    });

    buildCostList(data);
    buildFixList(data);
  }

  function buildCostList(data) {
    var list = document.getElementById('costList');
    if (!list) return;

    var ranked = rankIssues(data, 3);
    list.innerHTML = '';

    if (!ranked.length) {
      var clear = document.createElement('div');
      clear.className = 'cost-row cost-row--clear';
      clear.textContent = "Nothing here is actively costing you customers right now — the fundamentals are solid. A stronger site is about growth from here, not damage control.";
      list.appendChild(clear);
      return;
    }

    ranked.forEach(function (key, i) {
      var meta = IMPACT_META[key];
      if (!meta) return;

      var row = document.createElement('div');
      row.className = 'cost-row';

      var num = document.createElement('span');
      num.className = 'cost-num';
      num.textContent = i + 1 < 10 ? '0' + (i + 1) : String(i + 1);

      var p = document.createElement('p');
      p.textContent = tipFor(meta, data, key);

      row.appendChild(num);
      row.appendChild(p);
      list.appendChild(row);
    });
  }

  function buildFixList(data) {
    var list = document.getElementById('fixList');
    if (!list) return;

    var ranked = rankIssues(data, 3);
    list.innerHTML = '';

    if (!ranked.length) {
      var clear = document.createElement('li');
      clear.className = 'fix-row fix-row--clear';
      clear.textContent = "Nothing urgent here — the basics are covered. A redesign can still sharpen things up.";
      list.appendChild(clear);
      return;
    }

    ranked.forEach(function (key, i) {
      var meta = FIX_META[key];
      if (!meta) return;

      var li = document.createElement('li');
      li.className = 'fix-row';

      var num = document.createElement('span');
      num.className = 'fix-num';
      num.textContent = String(i + 1);

      var text = document.createElement('span');
      text.className = 'fix-text';
      var strong = document.createElement('strong');
      strong.textContent = meta.label;
      text.appendChild(strong);
      text.appendChild(document.createTextNode(' — ' + tipFor(meta, data, key)));

      li.appendChild(num);
      li.appendChild(text);
      list.appendChild(li);
    });
  }

  // --- Contact form --------------------------------------------------
  function resetContactSection() {
    var form = document.getElementById('contactForm');
    if (!form) return;
    form.hidden = false;
    form.reset();
    var thanks = document.getElementById('contactThanks');
    if (thanks) thanks.remove();
    var statusMsg = document.getElementById('contactStatusMsg');
    if (statusMsg) { statusMsg.hidden = true; statusMsg.textContent = ''; }
  }

  function initContactForm() {
    var form = document.getElementById('contactForm');
    if (!form) return;

    var statusMsg = document.getElementById('contactStatusMsg');
    var submitBtn = document.getElementById('contactSubmit');

    function setStatus(text, isError) {
      if (!text) { statusMsg.hidden = true; statusMsg.textContent = ''; return; }
      statusMsg.hidden = false;
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg' + (isError ? ' status-msg--error' : '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var name = String(fd.get('name') || '').trim();
      var data = lastRenderedData || {};

      var payload = {
        name: name,
        email: fd.get('email'),
        phone: fd.get('phone'),
        message: fd.get('message'),
        company: fd.get('company'), // honeypot
        businessName: data.businessName || '',
        domain: data.domain || data.town || '',
        overallScore: data.overallScore != null ? data.overallScore : null,
      };

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      setStatus(null);

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return res.json(); })
        .then(function (result) {
          if (!result.ok) {
            setStatus(result.message || 'Something went wrong — try again.', true);
            return;
          }
          form.hidden = true;
          var thanks = document.createElement('p');
          thanks.id = 'contactThanks';
          thanks.className = 'contact-thanks';
          thanks.textContent = 'Thanks' + (name ? ', ' + name : '') + "! We'll be in touch soon.";
          form.parentNode.appendChild(thanks);
        })
        .catch(function () {
          setStatus('Something went wrong sending that — try again in a moment.', true);
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send My Info →';
        });
    });
  }

  // --- Interactive domain checker (index.html) ---------------------------
  function normalizeDomainInput(raw) {
    var v = (raw || '').trim();
    v = v.replace(/^https?:\/\//i, '');
    v = v.split('/')[0];
    return v;
  }

  function initChecker() {
    var form = document.getElementById('checkForm');
    if (!form) return;

    var input = document.getElementById('domainInput');
    var btn = document.getElementById('checkBtn');
    var statusMsg = document.getElementById('statusMsg');
    var report = document.getElementById('report');

    function setStatus(text, isError) {
      if (!text) {
        statusMsg.hidden = true;
        statusMsg.textContent = '';
        return;
      }
      statusMsg.hidden = false;
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg' + (isError ? ' status-msg--error' : '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var domain = normalizeDomainInput(input.value);
      if (!domain) return;

      btn.disabled = true;
      btn.textContent = 'Checking…';
      report.hidden = true;
      setStatus('Running a full site check — this can take up to 20 seconds…', false);

      fetch('/api/analyze?domain=' + encodeURIComponent(domain))
        .then(function (res) { return res.json(); })
        .then(function (result) {
          if (!result.ok) {
            setStatus(result.message || "We couldn't check that site. Try again.", true);
            return;
          }
          setStatus(null);
          render(result);
          report.hidden = false;
          report.scrollIntoView({ behavior: 'smooth', block: 'start' });
        })
        .catch(function () {
          setStatus("Something went wrong checking that site. Try again in a moment.", true);
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Check My Website';
        });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Static/generated report pages (reports/<slug>.html, or a local
    // preview) supply data as window.reportData and render immediately.
    if (window.reportData) render(window.reportData);
    // index.html has no reportData — it's the live checker instead.
    initChecker();
    initContactForm();
  });
})();
