(() => {
  const byId = (id) => document.getElementById(id);
  const formatNumber = (value) => Number(value || 0).toLocaleString('sv-SE');
  const formatPercent = (metric) => metric?.available && metric.percentage !== null ? `${metric.percentage.toLocaleString('sv-SE')} %` : 'Ej tillgängligt';
  const formatDateTime = (value) => value ? new Date(value).toLocaleString('sv-SE') : 'Aldrig';

  function stockholmDate(offsetDays = 0) {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const today = formatter.format(new Date());
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  function cell(text, header = false) {
    const element = document.createElement(header ? 'th' : 'td');
    element.textContent = text;
    return element;
  }

  function renderRows(target, rows) {
    target.replaceChildren();
    const table = document.createElement('table');
    table.className = 'analytics-table';
    const head = document.createElement('tr');
    head.append(cell('Kategori', true), cell('Sessioner · andel', true));
    table.append(head);
    if (!rows.length) {
      const row = document.createElement('tr');
      const empty = cell('Ingen tillgänglig data');
      empty.colSpan = 2;
      row.append(empty);
      table.append(row);
    }
    rows.forEach((item) => {
      const row = document.createElement('tr');
      row.append(cell(item.name), cell(`${formatNumber(item.sessions)} · ${item.share.toLocaleString('sv-SE')} %`));
      table.append(row);
    });
    target.append(table);
  }

  function addDefinition(list, term, description) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = description;
    list.append(dt, dd);
  }

  function renderIssues(target, issues) {
    target.replaceChildren();
    issues.forEach((issue) => {
      const article = document.createElement('article');
      article.className = 'analytics-issue';
      article.dataset.status = issue.status === 'Bekräftat problem' ? 'confirmed'
        : issue.status === 'Trolig hypotes' ? 'hypothesis' : 'weak';
      const title = document.createElement('h4');
      title.textContent = issue.title;
      const status = document.createElement('strong');
      status.textContent = issue.status;
      const list = document.createElement('dl');
      addDefinition(list, 'Data', issue.data);
      addDefinition(list, 'Omfattning', issue.scope);
      addDefinition(list, 'Målgrupp', issue.audience);
      addDefinition(list, 'Berörd kod', issue.code);
      addDefinition(list, 'Möjlig orsak', issue.possibleCause);
      addDefinition(list, 'Åtgärd', issue.recommendation);
      addDefinition(list, 'Primärt mått', issue.primaryMetric);
      addDefinition(list, 'Sekundärt mått', issue.secondaryMetric);
      addDefinition(list, 'Risk', issue.risk);
      article.append(title, status, list);
      target.append(article);
    });
  }

  function setMetric(id, value, detail) {
    byId(id).textContent = value;
    byId(`${id}Detail`).textContent = detail;
  }

  window.bergaAdminAnalytics = {
    init({ supabase, endpoint, anonKey }) {
      let loading = false;
      const startInput = byId('analyticsStart');
      const endInput = byId('analyticsEnd');
      const status = byId('analyticsStatus');

      function setStatus(message, state = '') {
        status.textContent = message;
        status.dataset.state = state;
      }

      function setPreset(days) {
        endInput.value = stockholmDate(0);
        startInput.value = stockholmDate(-(days - 1));
        document.querySelectorAll('[data-analytics-days]').forEach((button) => {
          button.setAttribute('aria-pressed', String(Number(button.dataset.analyticsDays) === days));
        });
      }

      async function request(action = 'report') {
        if (loading) return;
        loading = true;
        setStatus(action === 'refresh' ? 'Uppdaterar från Clarity…' : 'Hämtar sparad analys…');
        try {
          const { data } = await supabase.auth.getSession();
          if (!data.session?.access_token) throw new Error('Adminsession saknas.');
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${data.session.access_token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action, start: startInput.value, end: endInput.value })
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Analysen kunde inte hämtas.');
          if (action === 'test') {
            setStatus(`${body.testData ? 'Testdata · ' : ''}API-test klart: ${body.rowCount} rader, ${body.metricCount} mätvärden, ${body.periodStart}–${body.periodEnd}. Token visas inte.`, 'success');
            return;
          }
          const report = body.report;
          setMetric('analyticsSessions', formatNumber(report.overview.sessions), `${report.period.snapshotDays} dagliga snapshots`);
          setMetric('analyticsUsers', formatNumber(report.overview.users), 'Summa dagliga unika; ej deduplicerad över dagar');
          setMetric('analyticsMobile', formatPercent(report.overview.mobileShare), `${formatNumber(report.overview.mobileShare.numerator)} / ${formatNumber(report.overview.mobileShare.denominator)}`);
          setMetric('analyticsBookings', 'Ej tillgängligt', 'Custom events exporteras inte av API:t');
          setMetric('analyticsConversion', 'Ej tillgängligt', 'Täljare saknas i officiellt API');
          setMetric('analyticsErrors', 'Ej tillgängligt', 'Eventfunnel saknas i exporten');
          renderRows(byId('analyticsSources'), report.sources);
          renderRows(byId('analyticsDevices'), report.devices);
          renderIssues(byId('analyticsIssues'), report.issues);
          const limitations = byId('analyticsLimitations');
          limitations.replaceChildren(...report.limitations.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
          }));
          byId('analyticsFreshness').textContent = `Senaste hämtning: ${formatDateTime(report.status.latestFetch)}. ${report.status.apiWindowNote}`;
          setStatus(report.status.state === 'empty'
            ? 'Ingen snapshot finns för perioden ännu.'
            : `${body.testData ? 'Testdata · använd inte för beslut. ' : ''}Analysen är uppdaterad.`,
          report.status.state === 'empty' ? '' : 'success');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Analysen kunde inte hämtas.', 'error');
        } finally {
          loading = false;
        }
      }

      document.querySelectorAll('[data-analytics-days]').forEach((button) => {
        button.addEventListener('click', () => { setPreset(Number(button.dataset.analyticsDays)); request(); });
      });
      byId('analyticsApply').addEventListener('click', () => request());
      byId('analyticsRefresh').addEventListener('click', () => request('refresh'));
      byId('analyticsTest').addEventListener('click', () => request('test'));
      setPreset(7);
      return { load: () => request(), refresh: () => request('refresh') };
    }
  };
})();
