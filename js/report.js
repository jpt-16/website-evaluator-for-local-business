(function () {
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

  // "What To Fix First" — business-priority order (not the checklist's
  // display order) and the copy for each. tipWarn falls back to tipBad
  // (and vice versa) since curated reports can set either status even
  // where the live checker only ever produces one of the two.
  var FIX_ORDER = ['hasWebsite', 'ssl', 'mobile', 'speed', 'social'];
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

    buildFixList(data);
  }

  function buildFixList(data) {
    var list = document.getElementById('fixList');
    if (!list) return;

    var bad = [];
    var warn = [];
    FIX_ORDER.forEach(function (key) {
      var status = data[CATEGORY_STATUS_KEY[key]];
      if (status === 'bad') bad.push(key);
      else if (status === 'warning') warn.push(key);
    });
    var ranked = bad.concat(warn).slice(0, 3);

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
      var status = data[CATEGORY_STATUS_KEY[key]];
      var tip = status === 'bad' ? (meta.tipBad || meta.tipWarn) : (meta.tipWarn || meta.tipBad);

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
      text.appendChild(document.createTextNode(' — ' + tip));

      li.appendChild(num);
      li.appendChild(text);
      list.appendChild(li);
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
  });
})();
