(function () {
  var STATUS_STYLE = {
    good: { icon: '✓', tone: 'good', label: 'Good' },
    warning: { icon: '!', tone: 'warn', label: 'Needs Work' },
    bad: { icon: '✕', tone: 'bad', label: 'Failing' },
    // Used for checks we can't verify automatically from a domain alone
    // (e.g. Google Reviews) — a neutral state rather than a guess.
    unknown: { icon: '–', tone: 'unknown', label: 'Not Checked' },
  };

  var CATEGORY_STATUS_KEY = {
    hasWebsite: 'hasWebsiteStatus',
    mobile: 'mobileStatus',
    speed: 'speedStatus',
    reviews: 'reviewsStatus',
    ssl: 'sslStatus',
    social: 'socialStatus',
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
    var gradeCircle = document.getElementById('gradeCircle');
    gradeCircle.className = 'grade-circle grade--' + grade.tone;

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
