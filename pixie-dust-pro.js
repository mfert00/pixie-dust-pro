/**
 * Pixie Dust Pro — Disney Trip Planner Bookmarklet
 * ─────────────────────────────────────────────────
 * Run this on: https://disneyworld.disney.go.com/vas/
 * while logged in to your Disney account.
 *
 * HOW IT WORKS:
 *  1. Reads the Disney access token Disney already stored in your browser
 *  2. Uses that token to call Disney's own LL availability API
 *  3. Injects a full trip-planning overlay on top of the page
 *
 * PRIVACY: Your token never leaves Disney's servers.
 * Everything runs locally in your browser.
 *
 * ⚠️  Unofficial. Use at your own risk. Disney can change
 *     their APIs at any time, which may break this tool.
 */

(function () {
  'use strict';

  // ─── PREVENT DOUBLE-INJECTION ──────────────────────────────────────────────
  if (document.getElementById('pdp-overlay')) {
    document.getElementById('pdp-overlay').style.display = 'flex';
    return;
  }

  // ─── CONSTANTS ─────────────────────────────────────────────────────────────
  const WDW_RESORT_ID = '80007798';
  const PARK_IDS = {
    MK: '80007944',
    EP: '80007838',
    HS: '80007998',
    AK: '80007823',
  };

  const PARK_NAMES = {
    [PARK_IDS.MK]: 'Magic Kingdom',
    [PARK_IDS.EP]: 'EPCOT',
    [PARK_IDS.HS]: 'Hollywood Studios',
    [PARK_IDS.AK]: 'Animal Kingdom',
  };

  // ThemeParks.wiki entity IDs for public wait time data (no auth needed)
  const THEMEPARKS_PARK_IDS = {
    MK: '75ea578a-adc8-4116-a54d-dccb60765ef0',
    EP: '47f90d2c-e191-4239-a466-5892ef59a88b',
    HS: '288747d1-8b4f-4a64-867e-ea7c9b27bad8',
    AK: '1c84a229-8862-4648-9c71-378dabb176a7',
  };

  // ─── TOKEN EXTRACTION ──────────────────────────────────────────────────────
  // Disney stores auth data in localStorage after login.
  // These are the known keys used by the WDW web app.
  function getDisneyAuthData() {
    const candidates = [
      // Primary key used by the VAS / LL web app
      'com.disney.disneyid.siteId_WDW-disneyworld.disney.go.com',
      // Fallback keys from older app versions
      'disneyid_access_token',
      'access_token',
    ];

    // Try each candidate key
    for (const key of candidates) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.access_token || parsed.token)) {
          return {
            token: parsed.access_token || parsed.token,
            swid: parsed.swid || parsed.sub || null,
            source: key,
          };
        }
      } catch (e) {
        // continue trying
      }
    }

    // Scan all localStorage keys for Disney token patterns
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.includes('disney') && !key.includes('disneyid')) continue;
      try {
        const raw = localStorage.getItem(key);
        const parsed = JSON.parse(raw);
        if (parsed && parsed.access_token) {
          return {
            token: parsed.access_token,
            swid: parsed.swid || null,
            source: key,
          };
        }
      } catch (e) {
        // skip unparseable
      }
    }

    // Also check cookies as a fallback
    const cookieToken = getCookieValue('access_token') || getCookieValue('DISNEYID');
    if (cookieToken) {
      return { token: cookieToken, swid: null, source: 'cookie' };
    }

    return null;
  }

  function getCookieValue(name) {
    const match = document.cookie.match(new RegExp('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  // ─── DISNEY API CALLS ──────────────────────────────────────────────────────
  async function fetchLLExperiences(token, swid, parkId) {
    // Disney's Lightning Lane availability endpoint
    // Same endpoint BG1 uses for LLMP data
    const url = `https://disneyworld.disney.go.com/api/wdpro/facility-service/theme-parks/${parkId}/experiences`;

    const headers = {
      'Authorization': `BEARER ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-App-Id': 'WDW-MDX-ANDROID-3.4.1',
    };

    if (swid) {
      headers['X-Guest-Id'] = swid;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`LL API ${res.status}`);
    return res.json();
  }

  // ThemeParks.wiki — FREE public API, no auth needed
  // Returns live wait times for any park
  async function fetchWaitTimes(parkWikiId) {
    const url = `https://api.themeparks.wiki/v1/entity/${parkWikiId}/live`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ThemeParks.wiki ${res.status}`);
    return res.json();
  }

  async function fetchParkSchedule(parkWikiId) {
    const url = `https://api.themeparks.wiki/v1/entity/${parkWikiId}/schedule`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Schedule API ${res.status}`);
    return res.json();
  }

  // ─── DATA NORMALIZATION ────────────────────────────────────────────────────
  function normalizeLLData(rawData) {
    if (!rawData || !rawData.entries) return [];
    return rawData.entries
      .filter(e => e.llEntitlement && e.llEntitlement.available)
      .map(e => ({
        id: e.id,
        name: e.name,
        nextAvailableTime: e.llEntitlement?.nextAvailableTime || null,
        waitTime: e.waitTime?.postedWaitMinutes || 0,
        llType: e.llEntitlement?.type || 'LLMP',
        priority: getPriority(e.name),
      }))
      .sort((a, b) => b.priority - a.priority);
  }

  function normalizeWaitData(rawData) {
    if (!rawData || !rawData.liveData) return [];
    return rawData.liveData
      .filter(e => e.entityType === 'ATTRACTION' && e.queue?.STANDBY)
      .map(e => ({
        id: e.id,
        name: e.name,
        waitMinutes: e.queue.STANDBY.waitTime || 0,
        status: e.status,
        llAvailable: e.queue?.RETURN_TIME?.state === 'AVAILABLE',
        nextLLTime: e.queue?.RETURN_TIME?.returnStart || null,
      }))
      .sort((a, b) => b.waitMinutes - a.waitMinutes);
  }

  // Rough priority scoring for headline attractions
  const HIGH_PRIORITY = [
    'tron', 'tiana', 'guardians', 'rise of the resistance',
    'slinky', 'flight of passage', 'space mountain',
    'seven dwarfs', 'remy', 'radiator springs',
  ];

  function getPriority(name) {
    const lower = name.toLowerCase();
    return HIGH_PRIORITY.some(h => lower.includes(h)) ? 10 : 1;
  }

  function formatTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ─── UI STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'pdp-styles';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=DM+Sans:wght@300;400;500;600&display=swap');

      #pdp-overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(8,16,32,0.97);
        display: flex; flex-direction: column;
        font-family: 'DM Sans', sans-serif;
        color: #F8F5EE;
        overflow: hidden;
      }

      #pdp-overlay * { box-sizing: border-box; margin: 0; padding: 0; }

      /* Header */
      #pdp-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px;
        border-bottom: 1px solid rgba(240,180,41,0.2);
        background: rgba(10,22,40,0.98);
        flex-shrink: 0;
      }

      #pdp-logo {
        display: flex; align-items: center; gap: 12px;
      }

      #pdp-logo-icon {
        width: 36px; height: 36px; border-radius: 50%;
        background: linear-gradient(135deg, #F0B429, #E8860A);
        display: flex; align-items: center; justify-content: center;
        font-size: 18px;
        box-shadow: 0 0 16px rgba(240,180,41,0.4);
        animation: pdp-pulse 3s ease-in-out infinite;
      }

      @keyframes pdp-pulse {
        0%,100% { box-shadow: 0 0 16px rgba(240,180,41,0.4); }
        50% { box-shadow: 0 0 28px rgba(240,180,41,0.7); }
      }

      #pdp-logo h1 {
        font-family: 'Playfair Display', serif;
        font-size: 18px; font-weight: 900; color: #F0B429;
      }

      #pdp-logo p { font-size: 10px; color: #8A99B3; letter-spacing: 2px; text-transform: uppercase; }

      #pdp-close {
        width: 34px; height: 34px; border-radius: 8px;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        color: #8A99B3; font-size: 18px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.2s;
      }

      #pdp-close:hover { background: rgba(255,107,138,0.15); color: #FF6B8A; border-color: rgba(255,107,138,0.3); }

      /* Tabs */
      #pdp-tabs {
        display: flex; gap: 2px; padding: 0 24px;
        border-bottom: 1px solid rgba(240,180,41,0.15);
        background: rgba(10,22,40,0.95);
        flex-shrink: 0; overflow-x: auto;
      }

      #pdp-tabs::-webkit-scrollbar { display: none; }

      .pdp-tab {
        padding: 10px 16px 12px;
        font-size: 12px; font-weight: 500; color: #8A99B3;
        cursor: pointer; border-bottom: 2px solid transparent;
        white-space: nowrap; transition: all 0.2s;
        display: flex; align-items: center; gap: 6px;
      }

      .pdp-tab:hover { color: #F8F5EE; }
      .pdp-tab.active { color: #F0B429; border-bottom-color: #F0B429; }

      /* Content */
      #pdp-content {
        flex: 1; overflow-y: auto; padding: 20px 24px;
      }

      #pdp-content::-webkit-scrollbar { width: 4px; }
      #pdp-content::-webkit-scrollbar-thumb { background: rgba(240,180,41,0.2); border-radius: 2px; }

      .pdp-panel { display: none; animation: pdp-in 0.25s ease; }
      .pdp-panel.active { display: block; }

      @keyframes pdp-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Section title */
      .pdp-section-title {
        font-family: 'Playfair Display', serif;
        font-size: 22px; font-weight: 700; color: #F8F5EE; margin-bottom: 4px;
      }

      .pdp-section-title span { color: #F0B429; }
      .pdp-section-sub { font-size: 12px; color: #8A99B3; margin-bottom: 18px; }

      /* Status bar */
      #pdp-status {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-radius: 8px;
        font-size: 12px; margin-bottom: 16px;
        border: 1px solid;
      }

      #pdp-status.loading {
        background: rgba(167,139,250,0.08);
        border-color: rgba(167,139,250,0.2);
        color: #A78BFA;
      }

      #pdp-status.success {
        background: rgba(0,201,177,0.08);
        border-color: rgba(0,201,177,0.2);
        color: #00C9B1;
      }

      #pdp-status.error {
        background: rgba(255,107,138,0.08);
        border-color: rgba(255,107,138,0.2);
        color: #FF6B8A;
      }

      #pdp-status.warn {
        background: rgba(240,180,41,0.08);
        border-color: rgba(240,180,41,0.2);
        color: #F0B429;
      }

      .pdp-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: currentColor; flex-shrink: 0;
      }

      .pdp-dot.pulse { animation: pdp-blink 1.5s ease-in-out infinite; }

      @keyframes pdp-blink {
        0%,100% { opacity: 1; } 50% { opacity: 0.2; }
      }

      /* LL Table */
      .pdp-ll-table { display: flex; flex-direction: column; gap: 8px; }

      .pdp-ll-header {
        display: grid;
        grid-template-columns: 1fr 90px 110px 80px;
        gap: 8px; padding: 6px 14px;
        font-size: 10px; color: #8A99B3;
        text-transform: uppercase; letter-spacing: 1px;
      }

      .pdp-ll-row {
        display: grid;
        grid-template-columns: 1fr 90px 110px 80px;
        gap: 8px; padding: 12px 14px;
        background: rgba(20,34,64,0.8);
        border: 1px solid rgba(240,180,41,0.12);
        border-radius: 10px; align-items: center;
        transition: border-color 0.2s;
      }

      .pdp-ll-row:hover { border-color: rgba(240,180,41,0.28); }
      .pdp-ll-row.priority { border-color: rgba(240,180,41,0.3); }
      .pdp-ll-row.unavail { opacity: 0.5; }

      .pdp-attr-name { font-size: 13px; font-weight: 500; color: #F8F5EE; }
      .pdp-attr-sub { font-size: 10px; color: #8A99B3; margin-top: 2px; }

      .pdp-wait { font-size: 13px; font-weight: 600; text-align: center; }
      .pdp-wait.low { color: #00C9B1; }
      .pdp-wait.med { color: #F0B429; }
      .pdp-wait.high { color: #FF6B8A; }
      .pdp-wait.none { color: #8A99B3; font-size: 11px; font-weight: 400; }

      .pdp-ll-time { font-size: 13px; font-weight: 600; color: #F8F5EE; text-align: center; }
      .pdp-ll-time.none { color: #8A99B3; font-size: 11px; font-weight: 400; }

      .pdp-priority-badge {
        font-size: 10px; font-weight: 700; color: #F0B429;
        background: rgba(240,180,41,0.1);
        padding: 3px 8px; border-radius: 20px;
        display: inline-flex; align-items: center; gap: 3px;
      }

      /* Park selector */
      .pdp-park-selector {
        display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;
      }

      .pdp-park-btn {
        padding: 8px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04); color: #8A99B3;
        transition: all 0.2s;
      }

      .pdp-park-btn:hover { color: #F8F5EE; border-color: rgba(255,255,255,0.2); }

      .pdp-park-btn.active-mk { background: rgba(0,201,177,0.12); color: #00C9B1; border-color: rgba(0,201,177,0.3); }
      .pdp-park-btn.active-ep { background: rgba(167,139,250,0.12); color: #A78BFA; border-color: rgba(167,139,250,0.3); }
      .pdp-park-btn.active-hs { background: rgba(255,107,138,0.12); color: #FF6B8A; border-color: rgba(255,107,138,0.3); }
      .pdp-park-btn.active-ak { background: rgba(240,180,41,0.12); color: #F0B429; border-color: rgba(240,180,41,0.3); }

      /* Tips box */
      .pdp-tip {
        background: rgba(0,201,177,0.07);
        border: 1px solid rgba(0,201,177,0.2);
        border-radius: 10px; padding: 14px 16px;
        font-size: 12px; color: #8A99B3; line-height: 1.6;
        margin-top: 16px;
      }

      .pdp-tip strong { color: #00C9B1; }

      /* Auth prompt */
      .pdp-auth-prompt {
        background: rgba(240,180,41,0.07);
        border: 1px solid rgba(240,180,41,0.25);
        border-radius: 12px; padding: 20px;
        text-align: center; margin-top: 8px;
      }

      .pdp-auth-prompt p { font-size: 13px; color: #8A99B3; line-height: 1.6; margin-bottom: 14px; }
      .pdp-auth-prompt p strong { color: #F8F5EE; }

      .pdp-btn {
        padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 600;
        cursor: pointer; border: none; transition: all 0.2s; letter-spacing: 0.3px;
      }

      .pdp-btn-gold {
        background: linear-gradient(135deg, #F0B429, #E8860A);
        color: #0A1628;
      }

      .pdp-btn-gold:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(240,180,41,0.4); }

      /* Reload spinner */
      .pdp-spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid currentColor; border-top-color: transparent;
        border-radius: 50%; animation: pdp-spin 0.8s linear infinite;
        vertical-align: middle; margin-right: 6px;
      }

      @keyframes pdp-spin { to { transform: rotate(360deg); } }

      /* Wait colors utility */
      .c-teal { color: #00C9B1; }
      .c-gold { color: #F0B429; }
      .c-rose { color: #FF6B8A; }
      .c-muted { color: #8A99B3; }

      /* Responsive */
      @media (max-width: 600px) {
        .pdp-ll-header, .pdp-ll-row {
          grid-template-columns: 1fr 70px;
        }
        .pdp-ll-header > :nth-child(3),
        .pdp-ll-row > :nth-child(3),
        .pdp-ll-header > :nth-child(4),
        .pdp-ll-row > :nth-child(4) { display: none; }
        #pdp-content { padding: 14px 16px; }
        #pdp-header { padding: 12px 16px; }
        #pdp-tabs { padding: 0 16px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── BUILD OVERLAY HTML ───────────────────────────────────────────────────
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'pdp-overlay';
    overlay.innerHTML = `
      <div id="pdp-header">
        <div id="pdp-logo">
          <div id="pdp-logo-icon">✦</div>
          <div>
            <h1>Pixie Dust Pro</h1>
            <p>Disney Trip Intelligence</p>
          </div>
        </div>
        <button id="pdp-close" title="Close">✕</button>
      </div>

      <nav id="pdp-tabs">
        <div class="pdp-tab active" data-tab="ll">⚡ Lightning Lane</div>
        <div class="pdp-tab" data-tab="waits">⏱ Wait Times</div>
        <div class="pdp-tab" data-tab="strategy">🗺 Strategy</div>
        <div class="pdp-tab" data-tab="dining">🍽 Dining</div>
      </nav>

      <div id="pdp-content">

        <!-- LIGHTNING LANE TAB -->
        <div class="pdp-panel active" id="pdp-panel-ll">
          <div class="pdp-section-title">Lightning Lane <span>Availability</span></div>
          <div class="pdp-section-sub">Live data from your Disney session</div>

          <div id="pdp-status" class="loading">
            <div class="pdp-dot pulse"></div>
            <span>Connecting to Disney's LL service…</span>
          </div>

          <div class="pdp-park-selector" id="pdp-park-selector">
            <button class="pdp-park-btn" data-park="MK" data-active="active-mk">🏰 Magic Kingdom</button>
            <button class="pdp-park-btn" data-park="EP" data-active="active-ep">🌐 EPCOT</button>
            <button class="pdp-park-btn" data-park="HS" data-active="active-hs">🎬 Hollywood Studios</button>
            <button class="pdp-park-btn" data-park="AK" data-active="active-ak">🦁 Animal Kingdom</button>
          </div>

          <div id="pdp-ll-content">
            <!-- Populated by JS -->
          </div>

          <div class="pdp-tip">
            <strong>Strategy:</strong> Book your highest-priority LL the instant your booking window opens.
            Once you scan in, immediately book the next one. On high crowd days, Tron, TIANA's, and
            Guardians sell out within the first hour.
          </div>
        </div>

        <!-- WAIT TIMES TAB -->
        <div class="pdp-panel" id="pdp-panel-waits">
          <div class="pdp-section-title">Live <span>Wait Times</span></div>
          <div class="pdp-section-sub">Via ThemeParks.wiki public API — updates every 5 min</div>

          <div class="pdp-park-selector" id="pdp-wait-park-selector">
            <button class="pdp-park-btn" data-park="MK" data-active="active-mk">🏰 Magic Kingdom</button>
            <button class="pdp-park-btn" data-park="EP" data-active="active-ep">🌐 EPCOT</button>
            <button class="pdp-park-btn" data-park="HS" data-active="active-hs">🎬 Hollywood Studios</button>
            <button class="pdp-park-btn" data-park="AK" data-active="active-ak">🦁 Animal Kingdom</button>
          </div>

          <div id="pdp-wait-content">
            <div id="pdp-status-wait" class="pdp-wait-status" style="padding:10px 14px;border-radius:8px;background:rgba(167,139,250,0.07);border:1px solid rgba(167,139,250,0.2);font-size:12px;color:#A78BFA;margin-bottom:12px;">
              <span class="pdp-spinner"></span> Loading wait times…
            </div>
          </div>

          <div class="pdp-tip">
            <strong>Best time to ride standby:</strong> First 45 minutes after park open, and the last
            30–60 minutes before close. Midday is almost always the worst time for standby lines.
          </div>
        </div>

        <!-- STRATEGY TAB -->
        <div class="pdp-panel" id="pdp-panel-strategy">
          <div class="pdp-section-title">First-Timer <span>Strategy</span></div>
          <div class="pdp-section-sub">Your daily game plan for an incredible trip</div>

          <div style="display:flex;flex-direction:column;gap:12px;">
            ${strategyItems().map(s => `
              <div style="background:rgba(20,34,64,0.8);border:1px solid rgba(240,180,41,0.12);border-radius:10px;padding:14px 16px;">
                <div style="font-size:14px;font-weight:600;color:#F8F5EE;margin-bottom:6px;">${s.icon} ${s.title}</div>
                <div style="font-size:12px;color:#8A99B3;line-height:1.6;">${s.body}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- DINING TAB -->
        <div class="pdp-panel" id="pdp-panel-dining">
          <div class="pdp-section-title">Must-Try <span>Dining</span></div>
          <div class="pdp-section-sub">Book 60 days out at 6am ET — these fill up immediately</div>

          <div style="display:flex;flex-direction:column;gap:10px;">
            ${diningItems().map(r => `
              <div style="background:rgba(20,34,64,0.8);border:1px solid rgba(240,180,41,0.12);border-radius:10px;padding:14px 16px;display:flex;align-items:flex-start;gap:14px;">
                <div style="font-size:24px;flex-shrink:0;">${r.icon}</div>
                <div>
                  <div style="font-size:13px;font-weight:600;color:#F8F5EE;">${r.name}</div>
                  <div style="font-size:10px;color:#8A99B3;text-transform:uppercase;letter-spacing:1px;margin:2px 0 6px;">${r.location} · ${r.type}</div>
                  <div style="font-size:12px;color:#8A99B3;line-height:1.5;">${r.tip}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

      </div>
    `;
    document.body.appendChild(overlay);
  }

  // ─── STATIC DATA ──────────────────────────────────────────────────────────
  function strategyItems() {
    return [
      {
        icon: '🌅',
        title: 'Rope Drop (Every Day)',
        body: 'Arrive at the park gate 30 minutes before official open. The first 45 minutes is the best time of day — waits are a fraction of midday levels. On-site guests get 30-min Early Entry, which compounds this advantage significantly.'
      },
      {
        icon: '⚡',
        title: 'Lightning Lane Booking Window',
        body: 'On-site hotel guests can book LLMP starting at <strong style="color:#F0B429">7am, 3 days before your visit</strong>. Off-site guests book same-day at park open. Book your #1 priority first (Tron, TIANA\'s, Guardians, Rise of the Resistance). As soon as you tap into your LL, book the next one immediately.'
      },
      {
        icon: '🏨',
        title: 'Hotel Early Entry = Free Rides',
        body: 'Every Disney on-site hotel (including Value resorts like Pop Century) gets 30 minutes of Early Theme Park Entry daily. Use this time at Magic Kingdom for Tron and TIANA\'s, at EPCOT for Guardians, at Hollywood Studios for Slinky Dog, and at Animal Kingdom for Flight of Passage.'
      },
      {
        icon: '🔁',
        title: 'When to Park Hop',
        body: 'Park hopping is allowed after 2pm. Best strategy: spend your morning and early afternoon at your primary park with LL bookings, then hop in the late afternoon when crowds peak at your first park. Best hops: EPCOT → Hollywood Studios for dinner, Magic Kingdom → EPCOT for World Showcase in the evening.'
      },
      {
        icon: '🌙',
        title: 'Extended Evening Hours (Deluxe Guests)',
        body: 'Guests staying at Deluxe and Deluxe Villa resorts get access to Extended Evening Hours — typically 2–3 extra hours at Magic Kingdom or EPCOT after the park closes to regular guests. This is one of the best perks for riding Tron with virtually no wait.'
      },
      {
        icon: '🍽',
        title: 'Dining Reservation Strategy',
        body: 'Reservations open exactly 60 days before your arrival date at 6am Eastern. Set an alarm. Be Our Guest, Space 220, \'Ohana, and Topolino\'s fill within minutes. If you miss a reservation, check the My Disney Experience app at 6am on the day-of — cancellations frequently appear.'
      },
    ];
  }

  function diningItems() {
    return [
      { icon: '🏰', name: 'Be Our Guest', location: 'Magic Kingdom', type: 'Table Service', tip: 'Dine inside Beast\'s enchanted castle. French-inspired menu, stunning ballroom. Reserve 60 days out — one of the hardest reservations on property.' },
      { icon: '🚀', name: 'Space 220', location: 'EPCOT', type: 'Signature', tip: 'Elevator to a "space station" 220 miles above Earth. Stunning Earth views, immersive theming. The most unique dining experience at WDW.' },
      { icon: '🌺', name: '\'Ohana', location: 'Polynesian Resort', type: 'Table Service', tip: 'All-you-care-to-enjoy family feast with fireworks views from Seven Seas Lagoon. Character breakfast available. Book the minute your 60-day window opens.' },
      { icon: '🎨', name: 'Topolino\'s Terrace', location: 'Riviera Resort', type: 'Signature', tip: 'Rooftop character breakfast with Mickey, Minnie, Donald, and Daisy. Best character meal on property, incredible panoramic views.' },
      { icon: '🌿', name: 'Satuli Canteen', location: 'Animal Kingdom', type: 'Quick Service', tip: 'Best quick-service in any Disney park. Pandora-themed, hearty bowls. No reservation needed — just walk up. Don\'t skip the Pongu Pongu drink next door.' },
      { icon: '🍺', name: 'Oga\'s Cantina', location: 'Hollywood Studios', type: 'Bar / Lounge', tip: 'The only true bar inside Walt Disney World. Standing room only, creative Star Wars cocktails and mocktails. Book a time slot — walk-up rarely possible.' },
    ];
  }

  // ─── RENDER LL DATA ───────────────────────────────────────────────────────
  function renderLLTable(attractions, container) {
    if (!attractions || attractions.length === 0) {
      container.innerHTML = `
        <div style="padding:20px;text-align:center;color:#8A99B3;font-size:13px;">
          No Lightning Lane availability data found for this park right now.<br>
          <span style="font-size:11px;margin-top:6px;display:block;">LL may not be available yet today, or all slots may be booked.</span>
        </div>`;
      return;
    }

    const rows = attractions.map(a => {
      const waitClass = a.waitTime >= 75 ? 'high' : a.waitTime >= 45 ? 'med' : 'low';
      const llTime = formatTime(a.nextAvailableTime);
      const isPriority = a.priority >= 10;
      const isUnavail = !llTime;

      return `
        <div class="pdp-ll-row${isPriority ? ' priority' : ''}${isUnavail ? ' unavail' : ''}">
          <div>
            <div class="pdp-attr-name">${a.name}</div>
            <div class="pdp-attr-sub">${a.llType}</div>
          </div>
          <div class="pdp-wait ${a.waitTime ? waitClass : 'none'}">${a.waitTime ? a.waitTime + ' min' : '—'}</div>
          <div class="pdp-ll-time ${llTime ? '' : 'none'}">${llTime || 'Unavailable'}</div>
          <div>${isPriority ? '<span class="pdp-priority-badge">⭐ Book 1st</span>' : '<span style="color:#8A99B3;font-size:11px;">—</span>'}</div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="pdp-ll-table">
        <div class="pdp-ll-header">
          <div>Attraction</div>
          <div style="text-align:center">Standby</div>
          <div style="text-align:center">Next LL Time</div>
          <div>Priority</div>
        </div>
        ${rows}
      </div>`;
  }

  // ─── RENDER WAIT TIMES ─────────────────────────────────────────────────────
  function renderWaitTable(attractions, container) {
    if (!attractions || attractions.length === 0) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:#8A99B3;font-size:13px;">No wait time data available right now.</div>`;
      return;
    }

    const rows = attractions.slice(0, 20).map(a => {
      const waitClass = a.waitMinutes >= 75 ? 'high' : a.waitMinutes >= 45 ? 'med' : 'low';
      return `
        <div class="pdp-ll-row">
          <div>
            <div class="pdp-attr-name">${a.name}</div>
            <div class="pdp-attr-sub" style="color:${a.status === 'OPERATING' ? '#00C9B1' : '#FF6B8A'}">${a.status}</div>
          </div>
          <div class="pdp-wait ${a.waitMinutes ? waitClass : 'none'}">${a.waitMinutes ? a.waitMinutes + ' min' : '—'}</div>
          <div class="pdp-ll-time ${a.nextLLTime ? '' : 'none'}">${a.nextLLTime ? formatTime(a.nextLLTime) : (a.llAvailable ? 'Available' : 'None')}</div>
          <div></div>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="pdp-ll-table">
        <div class="pdp-ll-header">
          <div>Attraction</div>
          <div style="text-align:center">Wait</div>
          <div style="text-align:center">LL Return</div>
          <div></div>
        </div>
        ${rows}
      </div>`;
  }

  // ─── MAIN CONTROLLER ──────────────────────────────────────────────────────
  const state = {
    authData: null,
    selectedLLPark: 'MK',
    selectedWaitPark: 'MK',
    llCache: {},
    waitCache: {},
  };

  function setStatus(msg, type = 'loading', elementId = 'pdp-status') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.className = elementId === 'pdp-status' ? `loading` : '';
    el.className += ` ${type}`;
    // For status bar
    if (elementId === 'pdp-status') {
      const spin = type === 'loading' ? '<span class="pdp-spinner"></span>' : '';
      const dot = type !== 'loading' ? `<div class="pdp-dot ${type === 'success' ? 'pulse' : ''}"></div>` : '';
      el.innerHTML = `${spin}${dot}<span>${msg}</span>`;
    } else {
      el.innerHTML = `<span class="${type === 'loading' ? 'pdp-spinner' : ''}"></span>${msg}`;
    }
  }

  async function loadLLData(parkKey) {
    const content = document.getElementById('pdp-ll-content');
    content.innerHTML = `<div style="padding:16px 14px;font-size:12px;color:#A78BFA;display:flex;align-items:center;gap:8px;"><span class="pdp-spinner" style="border-color:#A78BFA;border-top-color:transparent;"></span> Loading Lightning Lane data…</div>`;

    // Try authenticated Disney API first
    if (state.authData) {
      try {
        const raw = await fetchLLExperiences(state.authData.token, state.authData.swid, PARK_IDS[parkKey]);
        const attractions = normalizeLLData(raw);
        state.llCache[parkKey] = attractions;
        renderLLTable(attractions, content);
        setStatus(`Live LL data loaded — ${PARK_NAMES[PARK_IDS[parkKey]]} · Updated ${new Date().toLocaleTimeString()}`, 'success');
        return;
      } catch (err) {
        console.warn('[PDP] LL API failed, falling back to ThemeParks.wiki:', err.message);
      }
    }

    // Fallback: ThemeParks.wiki (no auth needed, but LL data is limited)
    try {
      const wikiId = THEMEPARKS_PARK_IDS[parkKey];
      const raw = await fetchWaitTimes(wikiId);
      // ThemeParks.wiki includes LL return times in its live data
      const attractions = normalizeWaitData(raw).filter(a => a.llAvailable || a.nextLLTime);
      state.llCache[parkKey] = attractions;
      if (attractions.length > 0) {
        renderLLTable(attractions.map(a => ({
          name: a.name,
          nextAvailableTime: a.nextLLTime,
          waitTime: a.waitMinutes,
          llType: 'LLMP',
          priority: getPriority(a.name),
        })), content);
        setStatus(`LL data via ThemeParks.wiki (limited) · ${PARK_NAMES[PARK_IDS[parkKey]]}`, 'warn');
      } else {
        showAuthPrompt(content);
        setStatus('Log in to Disney to see full LL availability', 'warn');
      }
    } catch (err) {
      showAuthPrompt(content);
      setStatus('Could not load LL data — check your connection', 'error');
    }
  }

  async function loadWaitData(parkKey) {
    const content = document.getElementById('pdp-wait-content');
    content.innerHTML = `<div style="padding:12px 14px;border-radius:8px;background:rgba(167,139,250,0.07);border:1px solid rgba(167,139,250,0.2);font-size:12px;color:#A78BFA;display:flex;align-items:center;gap:8px;margin-bottom:12px;"><span class="pdp-spinner" style="border-color:#A78BFA;border-top-color:transparent;"></span> Loading live wait times…</div>`;

    try {
      const wikiId = THEMEPARKS_PARK_IDS[parkKey];
      const raw = await fetchWaitTimes(wikiId);
      const attractions = normalizeWaitData(raw);
      state.waitCache[parkKey] = attractions;
      renderWaitTable(attractions, content);
    } catch (err) {
      content.innerHTML = `<div style="padding:16px;text-align:center;color:#FF6B8A;font-size:12px;">Could not load wait times. Check your internet connection.</div>`;
    }
  }

  function showAuthPrompt(container) {
    container.innerHTML = `
      <div class="pdp-auth-prompt">
        <p>
          <strong>Disney login required for live LL data.</strong><br>
          You need to be logged in to your Disney account on this page
          for full Lightning Lane availability. The bookmarklet reads your
          session token — your password is never seen or stored.
        </p>
        <a href="https://disneyworld.disney.go.com/vas/" style="text-decoration:none;">
          <button class="pdp-btn pdp-btn-gold">Go to Lightning Lane Page →</button>
        </a>
      </div>`;
  }

  // ─── WIRE UP TABS ──────────────────────────────────────────────────────────
  function wireUpTabs() {
    document.querySelectorAll('.pdp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.pdp-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.pdp-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panelId = `pdp-panel-${tab.dataset.tab}`;
        document.getElementById(panelId).classList.add('active');

        // Load data on first visit to tab
        if (tab.dataset.tab === 'waits' && !state.waitCache[state.selectedWaitPark]) {
          loadWaitData(state.selectedWaitPark);
        }
      });
    });

    // LL park selector
    document.querySelectorAll('#pdp-park-selector .pdp-park-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pdp-park-selector .pdp-park-btn').forEach(b => {
          b.className = 'pdp-park-btn';
        });
        btn.classList.add(btn.dataset.active);
        state.selectedLLPark = btn.dataset.park;
        loadLLData(btn.dataset.park);
      });
    });

    // Wait time park selector
    document.querySelectorAll('#pdp-wait-park-selector .pdp-park-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#pdp-wait-park-selector .pdp-park-btn').forEach(b => {
          b.className = 'pdp-park-btn';
        });
        btn.classList.add(btn.dataset.active);
        state.selectedWaitPark = btn.dataset.park;
        loadWaitData(btn.dataset.park);
      });
    });

    // Activate default park button
    const defaultLLBtn = document.querySelector('#pdp-park-selector .pdp-park-btn[data-park="MK"]');
    if (defaultLLBtn) defaultLLBtn.classList.add('active-mk');

    const defaultWaitBtn = document.querySelector('#pdp-wait-park-selector .pdp-park-btn[data-park="MK"]');
    if (defaultWaitBtn) defaultWaitBtn.classList.add('active-mk');

    // Close button
    document.getElementById('pdp-close').addEventListener('click', () => {
      document.getElementById('pdp-overlay').style.display = 'none';
    });
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  async function init() {
    injectStyles();
    buildOverlay();
    wireUpTabs();

    // Try to get auth token
    state.authData = getDisneyAuthData();

    if (state.authData) {
      setStatus(`Connected · Token found via ${state.authData.source}`, 'success');
    } else {
      setStatus('No Disney session found — showing public data only', 'warn');
    }

    // Load initial LL data
    await loadLLData('MK');
  }

  // ─── KICK IT OFF ──────────────────────────────────────────────────────────
  init().catch(err => {
    console.error('[Pixie Dust Pro] Init error:', err);
  });

})();
