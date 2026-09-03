(function () {
  var lastRenderedData = null;

  // Vercel Web Analytics custom events — window.va is stubbed inline in
  // <head> (queues calls until the real script loads), so this is safe to
  // call immediately. No-ops entirely if Web Analytics isn't enabled on
  // the Vercel project.
  function track(name, props) {
    if (typeof window.va !== 'function') return;
    window.va('event', { name: name, data: props || undefined });
  }

  var STATUS_STYLE = {
    good: { icon: '✓', tone: 'good', label: 'Good' },
    warning: { icon: '!', tone: 'warn', label: 'Needs Work' },
    bad: { icon: '✕', tone: 'bad', label: 'Failing' },
    // Distinct from "warning" — this means we couldn't verify it, not
    // that we checked and it came back mediocre. Currently only used by
    // Accessibility/SEO when PageSpeed Insights itself fails.
    unknown: { icon: '–', tone: 'unknown', label: 'Not Verified' },
  };

  var CATEGORY_STATUS_KEY = {
    hasWebsite: 'hasWebsiteStatus',
    mobile: 'mobileStatus',
    speed: 'speedStatus',
    ssl: 'sslStatus',
    social: 'socialStatus',
    accessibility: 'accessibilityStatus',
    seo: 'seoStatus',
    freshness: 'freshnessStatus',
    contact: 'contactStatus',
    design: 'designStatus',
    privacy: 'privacyStatus',
    reviews: 'reviewsStatus',
    crawlability: 'crawlabilityStatus',
  };

  // Shared business-priority order for both "What This Is Costing You"
  // and "What To Fix First" — same underlying issues, different framing
  // (impact vs. action). Not the checklist's display order.
  var ISSUE_ORDER = ['hasWebsite', 'ssl', 'mobile', 'contact', 'design', 'speed', 'accessibility', 'seo', 'crawlability', 'reviews', 'freshness', 'privacy', 'social'];

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
    contact: {
      label: 'Add a tap-to-call number',
      tipBad: "There's no phone number on the site at all — add one so visitors don't have to hunt for it.",
      tipWarn: 'Turn your phone number into a tap-to-call link — right now visitors have to copy and dial it manually.',
    },
    speed: {
      label: 'Speed up your site',
      tipBad: 'Slow pages lose visitors before they even finish loading.',
      tipWarn: 'Trim your load time where you can — a couple of seconds is often the difference.',
    },
    accessibility: {
      label: 'Fix accessibility gaps',
      tipBad: 'Some visitors using screen readers or assistive tech may not be able to use the site at all.',
      tipWarn: 'A few accessibility basics could use attention before they turn into a bigger issue.',
    },
    seo: {
      label: 'Shore up SEO basics',
      tipBad: "Basic SEO fundamentals are missing, making it harder for Google to find and rank the site.",
      tipWarn: 'A few SEO fundamentals are incomplete — worth tightening up.',
    },
    freshness: {
      label: 'Refresh the site',
      tipBad: "The footer still shows an old copyright year — a quiet signal to visitors that it hasn't been touched in a while.",
      tipWarn: "The copyright year is a little behind — a small, easy fix.",
    },
    social: {
      label: 'Link your social profiles',
      tipBad: "Make it easy for visitors to find you on social — right now there's no link from your site.",
    },
    design: {
      label: 'Modernize the look',
      tipBad: "The site reads as old and generic at a glance — that's often enough for a visitor to bounce before reading a word.",
      tipWarn: 'A few dated touches are holding the design back from feeling current.',
    },
    crawlability: {
      label: 'Add a sitemap and robots.txt',
      tipBad: "Google can't efficiently find your pages without these — an easy, one-time fix.",
      tipWarn: "You're missing one of robots.txt or sitemap.xml — worth adding the other.",
    },
    reviews: {
      label: 'Show off your reviews',
      tipBad: 'Add a testimonials section or review stars — social proof is one of the strongest things you can put in front of a new visitor.',
    },
    privacy: {
      label: 'Add a privacy policy',
      tipBad: "There's no privacy policy or terms link anywhere on the site — a quick, low-effort trust signal to add.",
      tipWarn: 'Label your terms/privacy link clearly — right now it may not be obvious what it covers.',
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
    contact: {
      tipBad: 'Visitors have no fast way to reach you — some will just move on rather than hunt for contact info.',
      tipWarn: 'Visitors on their phone have to copy and dial your number manually instead of tapping to call.',
    },
    speed: {
      tipBad: 'Every extra second of load time pushes more visitors to leave before they even see what you offer.',
      tipWarn: 'A slow-loading page loses a share of visitors before it finishes — often without you ever knowing.',
    },
    accessibility: {
      tipBad: 'Visitors using screen readers or assistive tech may not be able to use parts of the site at all.',
      tipWarn: 'Some visitors using assistive tech may have a rougher experience than they should.',
    },
    seo: {
      tipBad: "You're harder to find in Google search results than you should be — that's fewer people finding you at all.",
      tipWarn: "A few SEO gaps mean you're not showing up in search quite as well as you could.",
    },
    freshness: {
      tipBad: 'A stale copyright year is a small thing that makes people quietly wonder if the business is still around.',
      tipWarn: 'Nothing dramatic, but a slightly dated footer plants a small seed of doubt.',
    },
    social: {
      tipBad: "Visitors who'd follow or message you on social have no way to find those profiles from the site.",
    },
    design: {
      tipBad: "A dated-looking site quietly signals 'this business hasn't kept up' — even if the work itself is great.",
      tipWarn: "It's not glaring, but a slightly dated look is a small trust tax on every visitor who lands on it.",
    },
    crawlability: {
      tipBad: "Pages Google can't find are pages that never show up in search — no matter how good they are.",
      tipWarn: "Some pages may be slower to get discovered by Google than they should be.",
    },
    reviews: {
      tipBad: "New visitors have nothing to reassure them that real customers have had a good experience — that's a real hesitation point.",
    },
    privacy: {
      tipBad: "A missing privacy policy is a small but real red flag for visitors (and required in some places for ad/analytics tools).",
      tipWarn: "An unclear terms/privacy link leaves visitors unsure what's actually being collected or agreed to.",
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
    var locationSuffix = document.getElementById('locationSuffix');
    if (locationSuffix) locationSuffix.textContent = data.location ? ' · ' + data.location : '';
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

    // FormSubmit has to be called from the browser, not from our own
    // server — it identifies/activates a destination inbox by the
    // Origin/Referer of the request, which a server-to-server call from
    // Vercel doesn't have. Calling it server-side makes submissions
    // silently vanish (no activation email, nothing).
    var FORMSUBMIT_ENDPOINT = 'https://formsubmit.co/ajax/jptwohig16@gmail.com';

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var name = String(fd.get('name') || '').trim();
      var email = String(fd.get('email') || '').trim();
      var phone = String(fd.get('phone') || '').trim();
      var message = String(fd.get('message') || '').trim();
      var company = String(fd.get('company') || '').trim(); // honeypot
      var data = lastRenderedData || {};
      var businessName = data.businessName || '';
      var domain = data.domain || data.town || '';
      var overallScore = data.overallScore != null ? data.overallScore : null;

      function showThanks() {
        form.hidden = true;
        var thanks = document.createElement('p');
        thanks.id = 'contactThanks';
        thanks.className = 'contact-thanks';
        thanks.textContent = 'Thanks' + (name ? ', ' + name : '') + "! We'll be in touch soon.";
        form.parentNode.appendChild(thanks);
      }

      // Bots fill the hidden honeypot field; pretend success and send nothing.
      if (company) {
        showThanks();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
      setStatus(null);

      // Fire-and-forget server-side log so a lead is never lost even if
      // FormSubmit itself is slow/down — doesn't gate the UI on it.
      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, phone: phone, message: message, businessName: businessName, domain: domain, overallScore: overallScore }),
      }).catch(function () {});

      fetch(FORMSUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: 'New mockup request' + (businessName ? ' — ' + businessName : ''),
          _template: 'table',
          _captcha: 'false',
          _replyto: email,
          Name: name,
          Email: email,
          Phone: phone || '(not provided)',
          Business: businessName || '(not provided)',
          'Site checked': domain || '(not provided)',
          Score: overallScore != null ? overallScore + '/100' : '(not available)',
          Message: message || '(no message)',
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('FormSubmit error ' + res.status);
          track('contact_submitted', { businessName: businessName, domain: domain });
          showThanks();
        })
        .catch(function () {
          setStatus("Something went wrong sending that — try again, or email us directly.", true);
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send My Info →';
        });
    });
  }

  // --- Shareable report links (index.html only) ---------------------------
  // No backend involved — the whole result snapshot is base64url-encoded
  // into the URL fragment, so reopening the link re-renders the exact
  // report rather than re-running a fresh (and possibly different) check.
  function encodeReportData(data) {
    var json = JSON.stringify(data);
    var b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeReportData(encoded) {
    try {
      var b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var json = decodeURIComponent(escape(atob(b64)));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function updateShareLink(data) {
    var url = location.origin + location.pathname + '#r=' + encodeReportData(data);
    history.replaceState(null, '', url);
    return url;
  }

  function initShareButton() {
    var btn = document.getElementById('shareBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(location.href).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = original; }, 1800);
      });
    });
  }

  // Present on both index.html and report-template.html — uses the
  // existing print stylesheet (letter-sized, checker chrome hidden) via
  // the browser's own "Save as PDF" print destination, no library needed.
  function initPdfButton() {
    var btn = document.getElementById('pdfBtn');
    if (!btn) return;
    btn.addEventListener('click', function () { window.print(); });
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

    // Reopen a shared link (#r=...) with the exact snapshot it captured,
    // instead of showing the empty checker state.
    if (location.hash.indexOf('#r=') === 0) {
      var shared = decodeReportData(location.hash.slice(3));
      if (shared) {
        render(shared);
        report.hidden = false;
      }
    }

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
      setStatus('Running a full site check — this can take up to 30 seconds…', false);
      track('check_started', { domain: domain });

      fetch('/api/analyze?domain=' + encodeURIComponent(domain))
        .then(function (res) { return res.json(); })
        .then(function (result) {
          if (!result.ok) {
            setStatus(result.message || "We couldn't check that site. Try again.", true);
            track('check_failed', { domain: domain, reason: result.message || 'unknown' });
            return;
          }
          setStatus(null);
          render(result);
          updateShareLink(result);
          report.hidden = false;
          report.scrollIntoView({ behavior: 'smooth', block: 'start' });
          track('check_completed', { domain: domain, score: result.overallScore });
        })
        .catch(function () {
          setStatus("Something went wrong checking that site. Try again in a moment.", true);
          track('check_failed', { domain: domain, reason: 'network_error' });
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
    initShareButton();
    initPdfButton();
  });
})();
