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
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    render(window.reportData);
  });
})();
