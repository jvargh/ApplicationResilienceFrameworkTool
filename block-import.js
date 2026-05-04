/**
 * block-import.js — Block Diagram → Multi-Sequence Import for FMA Framework
 *
 * Extracts MULTIPLE sequence diagrams from a block/data-flow diagram image using
 * vision AI, renders a preview grid, and passes kept diagrams through
 * SeqImport.parse() → classify() → populate().
 *
 * Exposed as window.BlockImport:
 *   showImportUI()         → void (opens modal)
 *   _switchTab(tab)        → void
 *   _saveLLMSettings()     → void
 *   _analyzeImage()        → void
 *   _handleFileUpload(el)  → void
 *   _toggleCard(id)        → void
 *   _selectAll(kept)       → void
 *   _importSelected()      → void
 */
(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────────
  var _mermaidLoaded = false;
  var _mermaidQueue = [];
  var _currentScenarios = []; // {id, title, mermaid, kept: true}
  var _lastImageDataUrl = null;
  var _entraTokenCache = { token: null, expiresAt: 0 };

  // ── Vision AI system prompt ───────────────────────────────────
  var BLOCK_SYSTEM_PROMPT =
    'You are an expert enterprise architecture analyst.\n\n' +
    '⚠️ CRITICAL OUTPUT RULE: Complete ALL 7 phases and 21 steps INTERNALLY as silent reasoning. Do NOT output any intermediate phase data, numbered lists, entity tables, arrow arrays, or phase-by-phase analysis. Your ONLY output is the final JSON object described at the end of this prompt. If you output anything other than the required JSON object, your response will be rejected.\n\n' +
    '⚠️ FIELD NAME RULE: In the output JSON, each scenario MUST use exactly these field names: "title" (string, the scenario name) and "mermaid" (string, the full Mermaid sequenceDiagram code). Do NOT use "scenario_name", "steps", "diagram", "sequence", or any other names. Example: {"id":"s1","title":"User Initiation","mermaid":"sequenceDiagram\\n  Alice->>Bob: Hello"}\n\n' +
    'Analyze the provided block diagram or data-flow diagram image using the following 7-phase, 21-step extraction algorithm. Your output must be grounded exclusively in what is visible in the image — never invent terminology, labels, or step names.\n\n' +

    '## PHASE 1 — Parse structural primitives\n\n' +

    'Step 1 — Detect ALL visible entities. For each entity record: id, label_exact, type (External Entity / Process / Data Store / Annotation), x_position, y_position, shape_type, confidence. External entities are typically rectangular or orange boxes. Processes are typically circular or rounded blue nodes. Data stores are horizontal database-like markers. Annotations are note/sticky boxes (not participants unless explicitly used as active nodes).\n\n' +

    'Step 2 — Normalize layout left-to-right WITHOUT renaming. Compute lane_order_left_to_right and clusters_by_proximity from spatial coordinates. Do not alter any label during this step.\n\n' +

    'Step 3 — Detect ALL arrows and connectors. For each edge record: source_entity_id, target_entity_id, label_exact, step_number_exact, direction_confidence, text_confidence, path_geometry.\n\n' +

    'Step 4 — Associate labels to arrows. For each arrow, bind its nearest text fragment and step number. If a label is unclear, preserve the best readable text and mark it uncertain. Store both number and label when they are spatially separate.\n\n' +

    '## PHASE 2 — Build a faithful directed graph\n\n' +

    'Step 5 — Create the directed interaction graph G = (V, E) where V = extracted entities and E = extracted flows. Every edge preserves exact label, exact step number, uncertainty flags, and image coordinates. This graph is the sole source of truth for all subsequent steps.\n\n' +

    'Step 6 — Identify alias groups for repeated logical stores. If the same exact label appears at multiple positions and context strongly indicates the same logical store, create an AliasGroup. Do not merge unless label match is exact or overwhelmingly clear.\n\n' +

    '## PHASE 3 — Extract scenario candidates\n\n' +

    'Step 7 — MANDATORY PRE-ENUMERATION BEFORE ANY TRACING. You MUST complete these two pre-enumeration lists before tracing any paths:\n' +
    '\n' +
    '  PRE-ENUM A — LIST ALL NAMED SUBPROCESSES:\n' +
    '  Scan the entire diagram and write down every distinctly-labeled process box, subprocess box, engine, service, or named step. Include: any box with a name that implies computation, transformation, storage, or routing. Each item in this list AUTOMATICALLY becomes a mandatory scenario seed. Do not skip any labeled box.\n' +
    '  Example output: ["Content Ingestion", "OBIE Engine", "Conclude", "Transform AI", "Data Ingestion", "Project Management"]\n' +
    '\n' +
    '  PRE-ENUM B — LIST ALL NAMED INITIATORS:\n' +
    '  Scan the entire diagram and write down every actor, user, external system, or team box that initiates or sends data. Each initiator AUTOMATICALLY becomes a mandatory scenario seed.\n' +
    '  Example output: ["User", "DCA OPM", "Client/Project Team"]\n' +
    '\n' +
    '  RULE: Your minimum scenario count = len(PRE-ENUM A) + len(PRE-ENUM B) - (shared seeds that are the same entity) + 1 (for consolidated end-to-end).\n' +
    '  If any item from PRE-ENUM A or PRE-ENUM B does not appear as the CENTRAL ACTOR in at least one scenario, you have missed a scenario.\n' +
    '\n' +
    '  Now apply the FOUR MANDATORY SPLIT AXES:\n' +
    '  AXIS 1 — INITIATOR AXIS: Every distinct initiating actor or system from PRE-ENUM B must anchor its own scenario.\n' +
    '  AXIS 2 — NAMED SUBPROCESS AXIS: Every item from PRE-ENUM A must have a scenario where IT is the central actor — the process the scenario is named after and built around. Even if it receives input from a prior scenario, it still gets its own scenario.\n' +
    '  AXIS 3 — OUTGOING BRANCH AXIS: Every node with 2+ outgoing arrows going to materially different targets must be a branch point — each branch is a separate scenario.\n' +
    '  AXIS 4 — DATA TYPE AXIS: If a shared node receives or sends materially different data types to different consumers, each data type path is a separate scenario.\n\n'

    'Step 8 — Trace all forward paths via depth-first traversal from each root. For each root identified across all four axes, trace its full downstream path. Record: ordered participants, ordered steps (by number if present), start node, end node, purpose from visible labels. Stop at terminal sinks or named branch points.\n\n' +

    'Step 9 — MANDATORY SCENARIO COUNT ENFORCEMENT. Before proceeding to Phase 4, verify:\n' +
    '  COUNT how many items are in PRE-ENUM A (named subprocesses).\n' +
    '  COUNT how many items are in PRE-ENUM B (named initiators).\n' +
    '  Your scenario count MUST be at least: (PRE-ENUM A count) + (unique initiators not already covered) + 1 for consolidated.\n' +
    '  Additionally: if arrows > 6 AND named nodes > 5, expect at least 5 scenarios minimum.\n' +
    '  If your current candidate count is below the pre-enumeration minimum, identify which PRE-ENUM A item has no dedicated scenario and add it NOW.\n' +
    '  DO NOT proceed to Phase 4 until every PRE-ENUM A and PRE-ENUM B item is the central actor of at least one scenario.\n\n' +

    'Step 10 — Detect reusable subflows. Mark a subflow as reusable if it has 2 or more directed steps, can stand alone logically, and appears in multiple larger paths. These become independent sequence diagrams.\n\n'+

    '## PHASE 4 — Score and consolidate\n\n' +

    'Step 11 — Score each candidate scenario: ScenarioScore = 0.30 × end_to_end_completeness + 0.20 × unique_start_or_end + 0.20 × branch_distinctness + 0.15 × label_coherence + 0.15 × visual_confidence. Keep all high- and medium-confidence scenarios. Discard only trivial one-edge fragments unless architecturally important.\n\n' +

    'Step 12 — Merge ONLY when: candidates have identical participants AND differ by a very small alternate step AND merging improves readability. DEFAULT: prefer multiple smaller sequence diagrams over one giant merged diagram.\n\n' +

    'Step 13 — Assign titles that describe PURPOSE, not just endpoints. Derive the title from: the main process or transformation shown (e.g., "OBIE processing and transformation"), the business event represented (e.g., "Project initiation and metadata setup"), or the data lifecycle stage (e.g., "Content rules ingestion", "Analytics and downstream distribution"). A title like "SystemA to SystemB" is WRONG — it is an endpoint pair, not a purpose. Titles must describe WHAT HAPPENS in the flow, not just who is involved.\n\n' +

    '## PHASE 5 — Generate sequence diagrams\n\n' +

    'Step 14 — Per scenario, order participants left-to-right according to original image x-coordinates. Remove duplicates. Preserve exact labels.\n\n' +

    'Step 15 — Order messages by step number. Compound ordering: 5a before 5b; 7 before 7.1 before 7.11. Use geometric progression along the path when step numbers are absent. Preserve mixed textual numbering exactly in output.\n\n' +

    'Step 16 — Include notes and annotations ONLY if they appear explicitly in the image tied to a step. Use exact text. Do not add synthetic notes.\n\n' +

    'Step 17 — Generate ONE Mermaid sequenceDiagram per scenario. Do NOT collapse all scenarios into one diagram by default.\n\n' +

    '## PHASE 6 — Uncertainty handling\n\n' +

    'Step 18 — Flag ambiguity when: text is blurry, arrows overlap, arrowhead direction is uncertain, duplicated stores have unclear equivalence, labels are too close to multiple arrows, or shapes are cropped or low-resolution.\n\n' +

    'Step 19 — In output, use the best readable label. Document uncertainty in the ambiguities[] array. Never silently rewrite an unclear label with a generic substitute.\n\n' +

    '## PHASE 7 — Quality checks\n\n' +

    'Step 20 — MANDATORY PRE-OUTPUT CHECKLIST. You MUST answer ALL of these before writing the JSON. If any answer is "no", fix it before outputting:\n' +
    '  [ ] Have I completed PRE-ENUM A (all named subprocess boxes listed) and PRE-ENUM B (all named initiators listed)?\n' +
    '  [ ] Does every item from PRE-ENUM A appear as the central actor in at least one scenario?\n' +
    '  [ ] Have I produced a separate scenario for EACH distinct named initiator?\n' +
    '  [ ] Have I produced a separate scenario for EACH distinctly named subprocess (e.g. named engines, named steps, named transformation processes visible in the diagram)?\n' +
    '  [ ] Have I produced a separate scenario for EACH branch point where one node fans out to 2+ different targets?\n' +
    '  [ ] Have I produced a DEDICATED scenario for every hub/sharing/distribution node that fans to 3+ consumers — NOT merged with conclude or other steps?\n' +
    '  [ ] Have I produced the consolidated end-to-end scenario as the final entry?\n' +
    '  [ ] Does my scenario count meet the minimum from Step 9 enforcement?\n' +
    '  [ ] Is every visible arrow accounted for in at least one scenario?\n' +
    '  [ ] Does every title describe WHAT HAPPENS (not just who is connected)?\n\n' +

    'Step 21 — REQUIRED: Produce one consolidated end-to-end diagram as the FINAL scenario in the JSON array. Title it using the pattern "End-to-end [main purpose visible in diagram]". This diagram includes all major participants and the key flow steps across all stages. It is NOT a substitute for the individual scenario diagrams — it is an additional synthesis view.\n\n' +

    '## Decision rules\n\n' +

    '- Multiple independent paths → multiple sequence diagrams\n' +
    '- One node fans to distinct targets → separate scenarios (unless trivially small variants)\n' +
    '- Multiple sources into one process for the same business event → one scenario is acceptable\n' +
    '- Store feeds multiple downstream systems for different purposes → separate scenario per downstream use\n' +
    '- CRITICAL: Any intermediate hub/sharing/distribution/analytics node that fans out to 3 or more distinct downstream consumers MUST become its own dedicated scenario. Title it around the distribution or sharing purpose. Do NOT collapse it into a preceding or concluding scenario.\n' +
    '- CRITICAL: "Conclude" or terminal process nodes are SEPARATE from any upstream distribution hub. If a diagram has both a distribution hub AND a conclude/close node, these are two distinct scenarios.\n' +
    '- Never invent missing step names\n' +
    '- Never replace an unreadable label with a generic term\n' +
    '- Prefer faithful decomposition over aesthetic simplification\n' +
    '- If the diagram has more than 8 arrows total, expect at least 5 distinct scenarios\n' +
    '- If the diagram has a node that fans to 5+ targets, expect at least 6 distinct scenarios\n' +
    '- The consolidated end-to-end diagram (Step 21) MUST always be included as the final scenario when the diagram shows a complex multi-stage flow\n\n'+

    '## Required JSON output — exact schema, no field name changes\n\n' +

    'Return ONLY this JSON object, no markdown fencing, no explanation:\n' +
    '{\n' +
    '  "scenarios": [\n' +
    '    {\n' +
    '      "id": "scenario-1",\n' +
    '      "title": "Purpose-driven title from visible labels",\n' +
    '      "trigger": "What initiates this flow (from visible labels)",\n' +
    '      "outcome": "End result or terminal entity (from visible labels)",\n' +
    '      "participants": ["ExactName1", "ExactName2"],\n' +
    '      "summary": ["Key point about what this flow does", "Another key observation grounded in visible labels"],\n' +
    '      "mermaid": "sequenceDiagram\\n    participant ExactName1\\n    ExactName1->>ExactName2: exact step label"\n'+
    '    }\n' +
    '  ],\n' +
    '  "ambiguities": [\n' +
    '    {\n' +
    '      "target": "edge or entity id",\n' +
    '      "best_reading": "closest readable text",\n' +
    '      "reason": "why this is uncertain",\n' +
    '      "structural_impact": "low|medium|high"\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  var BLOCK_USER_PROMPT = 'Analyze this block diagram image and extract all possible sequence diagrams following the 21-step algorithm. Return only the JSON.';

  // ── LLM Config ───────────────────────────────────────────────
  // API key in sessionStorage (key: fma_bi_apikey); all other config in localStorage

  function _getLLMConfig() {
    return {
      apiKey: sessionStorage.getItem('fma_bi_apikey') || '',
      provider: localStorage.getItem('fma_llm_provider') || 'foundry',
      foundryEndpoint: localStorage.getItem('fma_llm_foundry_endpoint') || '',
      foundryModel: localStorage.getItem('fma_llm_foundry_model') || '',
      azureEndpoint: localStorage.getItem('fma_llm_azure_endpoint') || '',
      foundryAuthMethod: localStorage.getItem('fma_llm_foundry_auth_method') || 'token',
      foundryClientId: localStorage.getItem('fma_llm_foundry_client_id') || '',
      foundryTenantId: localStorage.getItem('fma_llm_foundry_tenant_id') || '',
      foundryClientSecret: localStorage.getItem('fma_llm_foundry_client_secret') || '',
      foundryBearerToken: localStorage.getItem('fma_llm_foundry_bearer_token') || ''
    };
  }

  function _saveLLMConfig(apiKey, provider) {
    sessionStorage.setItem('fma_bi_apikey', apiKey);
    localStorage.setItem('fma_llm_provider', provider);
  }

  function _saveLLMSettings() {
    var keyEl = document.getElementById('bi-llm-apikey');
    var provEl = document.getElementById('bi-llm-provider');
    var epEl = document.getElementById('bi-llm-azure-url');
    if (keyEl && provEl) {
      _saveLLMConfig(keyEl.value.trim(), provEl.value);
    }
    if (epEl) {
      localStorage.setItem('fma_llm_azure_endpoint', epEl.value.trim());
    }
    var foundryUrl = document.getElementById('bi-llm-foundry-url');
    var foundryModel = document.getElementById('bi-llm-foundry-model');
    var foundryAuthMethod = document.getElementById('bi-llm-foundry-auth-method');
    var foundryBearerToken = document.getElementById('bi-llm-foundry-bearer-token');
    if (foundryUrl) localStorage.setItem('fma_llm_foundry_endpoint', foundryUrl.value.trim());
    if (foundryModel) localStorage.setItem('fma_llm_foundry_model', foundryModel.value);
    if (foundryAuthMethod) localStorage.setItem('fma_llm_foundry_auth_method', foundryAuthMethod.value);
    if (foundryBearerToken) localStorage.setItem('fma_llm_foundry_bearer_token', foundryBearerToken.value.trim());
    var foundryClientId = document.getElementById('bi-llm-foundry-client-id');
    var foundryTenantId = document.getElementById('bi-llm-foundry-tenant-id');
    var foundrySecret = document.getElementById('bi-llm-foundry-client-secret');
    if (foundryClientId) localStorage.setItem('fma_llm_foundry_client_id', foundryClientId.value.trim());
    if (foundryTenantId) localStorage.setItem('fma_llm_foundry_tenant_id', foundryTenantId.value.trim());
    if (foundrySecret) localStorage.setItem('fma_llm_foundry_client_secret', foundrySecret.value.trim());

    // Toggle field visibility based on provider
    var provider = provEl ? provEl.value : 'foundry';
    var foundryFields = document.getElementById('bi-llm-foundry-fields');
    var foundryHelp = document.getElementById('bi-llm-foundry-help');
    var azureDiv = document.getElementById('bi-llm-azure-endpoint');
    var apiKeyWrap = document.getElementById('bi-llm-apikey-wrap');
    if (foundryFields) foundryFields.style.display = provider === 'foundry' ? 'block' : 'none';
    if (foundryHelp) foundryHelp.style.display = provider === 'foundry' ? 'block' : 'none';
    if (azureDiv) azureDiv.style.display = provider === 'azure' ? 'block' : 'none';
    if (apiKeyWrap) apiKeyWrap.style.display = provider === 'foundry' ? 'none' : 'block';

    // Re-evaluate Analyze button if an image is already loaded
    if (_lastImageDataUrl) {
      var btn = document.getElementById('bi-analyze-btn');
      if (btn) {
        var cfg = _getLLMConfig();
        var hasCreds = _hasValidCreds(cfg);
        btn.disabled = !hasCreds;
        btn.title = hasCreds ? 'Analyze the data flow diagram' : 'Configure AI Vision Settings first';
      }
    }
  }

  function _toggleFoundryAuth() {
    var authMethod = document.getElementById('bi-llm-foundry-auth-method');
    var tokenFields = document.getElementById('bi-llm-foundry-token-fields');
    var entraFields = document.getElementById('bi-llm-foundry-entra-fields');
    if (!authMethod) return;
    var isToken = authMethod.value === 'token';
    if (tokenFields) tokenFields.style.display = isToken ? 'block' : 'none';
    if (entraFields) entraFields.style.display = isToken ? 'none' : 'flex';
  }

  // ── Entra ID token acquisition ────────────────────────────────

  async function _getEntraToken(tenantId, clientId, clientSecret) {
    if (_entraTokenCache.token && Date.now() < _entraTokenCache.expiresAt - 60000) {
      return _entraTokenCache.token;
    }
    var tokenUrl = 'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token';
    var params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('scope', 'https://cognitiveservices.azure.com/.default');
    params.append('grant_type', 'client_credentials');
    var resp;
    try {
      resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
    } catch (netErr) {
      throw new Error('Network error acquiring Entra token: ' + netErr.message);
    }
    if (!resp.ok) {
      var errText = await resp.text();
      throw new Error('Entra ID token request failed (' + resp.status + '): ' + errText);
    }
    var data = await resp.json();
    _entraTokenCache.token = data.access_token;
    _entraTokenCache.expiresAt = Date.now() + (data.expires_in * 1000);
    return data.access_token;
  }

  // ── Status helpers ────────────────────────────────────────────

  function _showStatus(msg, type) {
    var el = document.getElementById('bi-status');
    if (!el) return;
    var colors = { red: 'var(--red,#e74c3c)', green: 'var(--green,#2ecc71)', amber: '#f39c12', blue: 'var(--accent)' };
    el.style.display = 'block';
    el.style.background = 'rgba(0,0,0,.12)';
    el.style.border = '1px solid ' + (colors[type] || colors.blue);
    el.style.color = colors[type] || 'var(--text)';
    el.style.position = 'relative';
    el.innerHTML =
      '<button onclick="BlockImport._clearStatus()" title="Dismiss" ' +
      'style="position:absolute;top:4px;right:6px;background:none;border:none;cursor:pointer;' +
      'font-size:1rem;color:' + (colors[type] || 'var(--text)') + ';line-height:1;padding:0">✕</button>' +
      '<span style="display:block;padding-right:20px">' + msg + '</span>';
  }

  function _clearStatus() {
    var el = document.getElementById('bi-status');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  function _setProgress(msg, pct) {
    var el = document.getElementById('bi-progress');
    var status = document.getElementById('bi-progress-status');
    var bar = document.getElementById('bi-progress-bar');
    if (!el) return;
    el.style.display = pct > 0 || msg ? 'block' : 'none';
    if (status) status.textContent = msg;
    if (bar) bar.style.width = pct + '%';
  }

  // ── Mermaid lazy loader ───────────────────────────────────────

  function _ensureMermaid(cb) {
    if (_mermaidLoaded) { cb(); return; }
    _mermaidQueue.push(cb);
    if (_mermaidQueue.length > 1) return; // already loading
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
    script.onload = function () {
      var theme = (document.documentElement.getAttribute('data-theme') === 'light') ? 'default' : 'dark';
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme });
      _mermaidLoaded = true;
      _mermaidQueue.forEach(function (fn) { try { fn(); } catch (e) { console.warn('BlockImport mermaid queue error', e); } });
      _mermaidQueue = [];
    };
    script.onerror = function () {
      _showStatus('❌ Failed to load Mermaid.js from CDN. Check your connection.', 'red');
    };
    document.head.appendChild(script);
  }

  // ── Scenario grid rendering ───────────────────────────────────

  function _renderScenarioGrid(scenarios) {
    _currentScenarios = scenarios.map(function (s, i) {
      // Normalise: handle alternate field names the model may use
      var title  = s.title || s.name || s.scenario_name || s.scenario_title || s.label || ('Scenario ' + (i + 1));
      var id     = s.id    || ('scenario-' + (i + 1));
      var mermaid = s.mermaid || s.diagram || s.sequence_diagram || s.sequenceDiagram ||
                    s.mermaid_code || s.mermaid_diagram || s.code || s.content ||
                    s.swimlane_diagram || s.sequence || s.sequence_code || s.diagram_code ||
                    s.steps || '';
      // Fix double-escaped newlines that the model sometimes emits (\\n → \n)
      mermaid = mermaid.replace(/\\n/g, '\n');
      return { id: id, title: title, mermaid: mermaid, summary: s.summary || [], kept: true };
    });

    var grid = document.getElementById('bi-grid-container');
    var dropZone = document.getElementById('bi-file-dropzone');
    var imgZone = document.getElementById('bi-img-zone');
    if (dropZone) dropZone.style.display = 'none';
    if (imgZone) imgZone.style.display = 'none';
    if (!grid) return;

    grid.style.display = 'block';
    grid.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<span style="font-size:.82rem;color:var(--text2)">' + scenarios.length + ' scenario' + (scenarios.length !== 1 ? 's' : '') + ' found</span>' +
      '<div style="display:flex;gap:12px">' +
      '<a href="#" onclick="BlockImport._selectAll(true);return false;" style="font-size:.78rem;color:var(--accent)">Select All</a>' +
      '<a href="#" onclick="BlockImport._selectAll(false);return false;" style="font-size:.78rem;color:var(--text3)">Deselect All</a>' +
      '</div>' +
      '</div>' +
      '<div id="bi-card-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">' +
      _currentScenarios.map(function (sc) { return _buildCardHtml(sc); }).join('') +
      '</div>';

    _updateImportButton();
    _setProgress('', 0);

    // Render Mermaid SVGs
    _ensureMermaid(function () {
      _currentScenarios.forEach(function (sc) {
        _renderCardMermaid(sc.id);
      });
    });
  }

  function _buildCardHtml(sc) {
    var kept = sc.kept !== false;
    return '<div id="bi-card-' + sc.id + '" style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:opacity .2s;opacity:' + (kept ? '1' : '0.4') + '">' +
      '<div style="padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">' +
      '<span id="bi-card-title-' + sc.id + '" style="font-size:.85rem;font-weight:600;color:' + (kept ? 'var(--text)' : 'var(--text3)') + ';flex:1;' + (kept ? '' : 'text-decoration:line-through;') + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(sc.title) + '</span>' +
      '<button onclick="BlockImport._renameCard(\'' + sc.id + '\')" title="Rename scenario" ' +
      'style="padding:3px 7px;font-size:.75rem;border:none;border-radius:var(--radius);cursor:pointer;' +
      'background:var(--bg3);color:var(--text2);white-space:nowrap;flex-shrink:0">✏️</button>' +
      '<button onclick="BlockImport._zoomCard(\'' + sc.id + '\')" title="Zoom diagram" ' +
      'style="padding:3px 7px;font-size:.75rem;border:none;border-radius:var(--radius);cursor:pointer;' +
      'background:var(--bg3);color:var(--text2);white-space:nowrap;flex-shrink:0">🔍</button>' +
      '<button onclick="BlockImport._toggleCard(\'' + sc.id + '\')" id="bi-toggle-' + sc.id + '" '+
      'style="padding:3px 10px;font-size:.75rem;border:none;border-radius:var(--radius);cursor:pointer;white-space:nowrap;flex-shrink:0;' +
      (kept ? 'background:rgba(231,76,60,.15);color:rgba(231,76,60,.7);' : 'background:rgba(46,204,113,.2);color:#2ecc71;') + '">' +
      (kept ? '✗ Discard' : '✓ Keep') +
      '</button>' +
      '</div>' +
      (sc.summary && sc.summary.length ? '<ul class="bi-card-summary">' + sc.summary.map(function(s) { return '<li>' + _esc(s) + '</li>'; }).join('') + '</ul>' : '') +
      '<div id="bi-card-svg-' + sc.id + '" style="padding:12px;min-height:80px;background:var(--bg);overflow:auto;font-size:11px">'+
      '<span style="color:var(--text3);font-size:.75rem">⏳ Rendering…</span>' +
      '</div>' +
      '</div>';
  }

  function _renameCard(id) {
    var sc = _currentScenarios.find(function (s) { return s.id === id; });
    var titleEl = document.getElementById('bi-card-title-' + id);
    if (!sc || !titleEl) return;

    // Already in edit mode
    if (titleEl.querySelector('input')) return;

    var currentTitle = sc.title;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.style.cssText =
      'flex:1;width:100%;font-size:.85rem;font-weight:600;padding:1px 4px;' +
      'background:var(--bg);color:var(--text);border:1px solid var(--accent);' +
      'border-radius:var(--radius);outline:none;min-width:0';

    function commit() {
      var newTitle = input.value.trim();
      if (!newTitle) newTitle = currentTitle; // revert if blank
      sc.title = newTitle;
      titleEl.textContent = newTitle;
      // Also update the zoom overlay title if it's open
      var overlayTitle = document.querySelector('#bi-zoom-overlay span[data-zoom-id="' + id + '"]');
      if (overlayTitle) overlayTitle.textContent = newTitle;
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });

    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();
  }

  function _renderCardMermaid(id) {
    var sc = _currentScenarios.find(function (s) { return s.id === id; });
    var container = document.getElementById('bi-card-svg-' + id);
    if (!sc || !container) return;

    var code = (sc.mermaid || '').trim();
    if (!code) {
      container.innerHTML = '<pre style="font-size:10px;color:var(--text2);padding:8px;margin:0">(no diagram code — see debug info above)</pre>';
      return;
    }
    if (!/^sequenceDiagram/i.test(code)) code = 'sequenceDiagram\n' + code;

    var uid = 'bi-mmd-' + id + '-' + Date.now();
    mermaid.render(uid, code).then(function (result) {
      container.innerHTML = result.svg;
      // Scale SVG to fit card
      var svg = container.querySelector('svg');
      if (svg) {
        svg.style.maxWidth = '100%';
        svg.style.height = 'auto';
      }
    }).catch(function (err) {
      container.innerHTML =
        '<div style="display:flex;gap:6px;align-items:flex-start">' +
        '<span title="Mermaid render error" style="font-size:1.1rem">⚠️</span>' +
        '<pre style="font-size:10px;color:var(--text2);white-space:pre-wrap;word-break:break-all;flex:1;margin:0">' + _esc(code) + '</pre>' +
        '</div>';
    });
  }

  function _zoomCard(id) {
    var sc = _currentScenarios.find(function (s) { return s.id === id; });
    if (!sc) return;

    var overlay = document.createElement('div');
    overlay.id = 'bi-zoom-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:flex-start;' +
      'padding:20px;overflow:auto';

    // Set flag to block global ESC handler
    window._zoomOverlayOpen = true;

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        window._zoomOverlayOpen = false;
        document.body.removeChild(overlay);
      }
    });

    // Close on ESC key (without bubbling to import pane)
    var escHandler = function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        window._zoomOverlayOpen = false;
        document.removeEventListener('keydown', escHandler);
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      }
    };
    document.addEventListener('keydown', escHandler);

    var box = document.createElement('div');
    box.style.cssText =
      'background:var(--bg);border-radius:var(--radius);max-width:1100px;width:100%;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.6);overflow:hidden';

    var hdr = document.createElement('div');
    hdr.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;' +
      'border-bottom:1px solid var(--border);background:var(--bg2)';
    hdr.innerHTML =
      '<span data-zoom-id="' + sc.id + '" style="font-size:.92rem;font-weight:600;color:var(--text)">' + _esc(sc.title) + '</span>' +
      '<button onclick="window._zoomOverlayOpen=false;document.body.removeChild(document.getElementById(\'bi-zoom-overlay\'))" ' +
      'style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:var(--text2);padding:0">✕</button>';

    var svgBox = document.createElement('div');
    svgBox.style.cssText = 'padding:20px;overflow:auto;min-height:300px;background:var(--bg)';
    svgBox.innerHTML = '<span style="color:var(--text3);font-size:.8rem">⏳ Rendering…</span>';

    var codeToggle = document.createElement('div');
    codeToggle.style.cssText = 'padding:0 20px 16px';
    codeToggle.innerHTML =
      '<details style="font-size:.78rem;color:var(--text3)">' +
      '<summary style="cursor:pointer">View Mermaid source</summary>' +
      '<pre style="margin-top:8px;padding:10px;background:var(--bg2);border:1px solid var(--border);' +
      'border-radius:var(--radius);white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;font-size:11px">' +
      _esc(sc.mermaid) + '</pre></details>';

    box.appendChild(hdr);
    box.appendChild(svgBox);
    box.appendChild(codeToggle);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var code = (sc.mermaid || '').trim();
    if (!code) {
      svgBox.innerHTML = '<p style="color:var(--text2)">(no diagram code returned for this scenario)</p>';
    } else {
      if (!/^sequenceDiagram/i.test(code)) code = 'sequenceDiagram\n' + code;
      var uid = 'bi-zoom-mmd-' + id + '-' + Date.now();
      _ensureMermaid(function () {
        mermaid.render(uid, code).then(function (result) {
          svgBox.innerHTML = result.svg;
          var svg = svgBox.querySelector('svg');
          if (svg) {
            svg.style.maxWidth = '100%';
            svg.style.height = 'auto';
            svg.style.width = '100%';
          }
        }).catch(function (err) {
          svgBox.innerHTML =
            '<pre style="font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--text2)">' +
            _esc(code) + '</pre>';
        });
      });
    }
  }

  function _toggleCard(id) {
    var sc = _currentScenarios.find(function (s) { return s.id === id; });
    if (!sc) return;
    sc.kept = !sc.kept;

    var card = document.getElementById('bi-card-' + id);
    var btn = document.getElementById('bi-toggle-' + id);
    var title = document.getElementById('bi-card-title-' + id);

    if (card) card.style.opacity = sc.kept ? '1' : '0.4';
    if (title) {
      title.style.textDecoration = sc.kept ? '' : 'line-through';
      title.style.color = sc.kept ? 'var(--text)' : 'var(--text3)';
    }
    if (btn) {
      btn.textContent = sc.kept ? '✗ Discard' : '✓ Keep';
      btn.style.background = sc.kept ? 'rgba(231,76,60,.15)' : 'rgba(46,204,113,.2)';
      btn.style.color = sc.kept ? 'rgba(231,76,60,.7)' : '#2ecc71';
    }
    _updateImportButton();
  }

  function _selectAll(kept) {
    _currentScenarios.forEach(function (sc) {
      sc.kept = kept;
      var card = document.getElementById('bi-card-' + sc.id);
      var btn = document.getElementById('bi-toggle-' + sc.id);
      var title = document.getElementById('bi-card-title-' + sc.id);
      if (card) card.style.opacity = kept ? '1' : '0.4';
      if (title) {
        title.style.textDecoration = kept ? '' : 'line-through';
        title.style.color = kept ? 'var(--text)' : 'var(--text3)';
      }
      if (btn) {
        btn.textContent = kept ? '✗ Discard' : '✓ Keep';
        btn.style.background = kept ? 'rgba(231,76,60,.15)' : 'rgba(46,204,113,.2)';
        btn.style.color = kept ? 'rgba(231,76,60,.7)' : '#2ecc71';
      }
    });
    _updateImportButton();
  }

  function _updateImportButton() {
    var keptCount = _currentScenarios.filter(function (s) { return s.kept; }).length;
    var total = _currentScenarios.length;
    var btn = document.getElementById('bi-import-btn');
    if (!btn) return;
    if (keptCount === 0) {
      btn.disabled = true;
      btn.textContent = '📊 Import Selected (0)';
    } else {
      btn.disabled = false;
      btn.textContent = '📊 Import Selected (' + keptCount + ' of ' + total + ')';
    }
  }

  // ── Import flow ───────────────────────────────────────────────

  function _importSelected() {
    if (typeof SeqImport === 'undefined') {
      _showStatus('❌ SeqImport module not found — ensure seq-import.js is loaded', 'red');
      return;
    }

    var kept = _currentScenarios.filter(function (s) { return s.kept; });
    if (kept.length === 0) {
      _showStatus('⚠️ Select at least one scenario to import', 'amber');
      return;
    }

    // Validate workload name — required, minimum 3 characters
    var wnEl = document.getElementById('bi-workload-name');
    var wnVal = wnEl ? wnEl.value.trim() : '';
    if (!wnVal || wnVal.length < 3) {
      if (wnEl) {
        wnEl.style.borderColor = 'var(--danger, #e74c3c)';
        wnEl.focus();
        wnEl.addEventListener('input', function clearErr() {
          wnEl.style.borderColor = '';
          wnEl.removeEventListener('input', clearErr);
        });
      }
      _showStatus('⚠️ Enter a Workload Name (at least 3 characters) before importing', 'amber');
      return;
    }
    if (typeof S !== 'undefined') {
      S.wn = wnVal;
      if (typeof sv === 'function') sv();
      // Update header and overview input immediately — rIntro() won't re-run until navigation
      var wnHdr = document.getElementById('wn-hdr');
      if (wnHdr) wnHdr.textContent = '— ' + wnVal;
      // If overview input is currently in the DOM, sync its value too
      var overviewInput = document.querySelector('#mc input[onchange*="S.wn"]');
      if (overviewInput) overviewInput.value = wnVal;
    }

    // Concatenate mermaid blocks— inject `title` directive so seq-import derives
    // workflow names from the scenario title, not from participant labels.
    var combined = kept.map(function (sc) {
      var code = sc.mermaid.trim();
      if (!/^sequenceDiagram/i.test(code)) code = 'sequenceDiagram\n' + code;
      // Insert title on the line immediately after `sequenceDiagram`
      if (sc.title && !/^\s*title\s+/im.test(code)) {
        code = code.replace(/^(sequenceDiagram[^\n]*)/i, '$1\ntitle ' + sc.title);
      }
      return code;
    }).join('\n\n');

    try {
      var parsed = SeqImport.parse(combined);
      var system = SeqImport.classify(parsed);
      SeqImport.populate(system);
    } catch (e) {
      _showStatus('❌ Import failed: ' + e.message, 'red');
      return;
    }

    // Close modal and show toast
    window._importModalOpen = false;
    if (typeof HM === 'function') HM();
    window._importUILocked = false;

    setTimeout(function () {
      if (typeof SM === 'function') {
        SM('✅ Import Complete',
          '<p>✅ Imported ' + kept.length + ' sequence diagram' + (kept.length !== 1 ? 's' : '') + ' → all phases populated.</p>' +
          '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="HM()">OK</button></div>');
      }
    }, 200);
  }

  // ── File upload (Tab 1) ───────────────────────────────────────

  function _handleFileUpload(input) {
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var text = e.target.result || '';
      _parseMmdFile(text);
    };
    reader.readAsText(file);
  }

  function _parseMmdFile(text) {
    // Use SeqImport's robust splitter if available (handles fenced blocks, prose, multi-block .md)
    var blocks = [];
    if (typeof SeqImport !== 'undefined' && typeof SeqImport.parse === 'function') {
      var parsed = SeqImport.parse(text);
      blocks = parsed.map(function (d) { return d.raw || d.mermaidText || d.text || ''; }).filter(Boolean);
    }

    // Fallback: replicate seq-import.js splitDiagramBlocks logic
    if (blocks.length === 0) {
      var fenceRegex = /```(?:mermaid)?\s*\n([\s\S]*?)```/gi;
      var fenceMatch;
      var fenced = [];
      while ((fenceMatch = fenceRegex.exec(text)) !== null) {
        var content = fenceMatch[1].trim();
        if (/^\s*sequenceDiagram/im.test(content)) fenced.push(content);
      }
      if (fenced.length > 0) {
        blocks = fenced;
      } else {
        // Bare sequenceDiagram blocks — split on keyword boundary
        var lines = text.split('\n');
        var current = [];
        var inDiagram = false;
        for (var li = 0; li < lines.length; li++) {
          if (/^\s*sequenceDiagram\s*$/i.test(lines[li])) {
            if (inDiagram && current.length > 0) blocks.push(current.join('\n'));
            current = [lines[li]];
            inDiagram = true;
          } else if (inDiagram) {
            current.push(lines[li]);
          }
        }
        if (inDiagram && current.length > 0) blocks.push(current.join('\n'));
      }
    }

    if (blocks.length === 0) {
      _showStatus('❌ No sequenceDiagram blocks found in this file.', 'red');
      return;
    }

    var scenarios = blocks.map(function (block, i) {
      block = block.trim();
      if (!/^sequenceDiagram/i.test(block)) block = 'sequenceDiagram\n' + block;
      var titleMatch = block.match(/^\s*title\s+(.+)$/mi);
      var title = titleMatch ? titleMatch[1].trim() : 'Diagram ' + (i + 1);
      return { id: 'file-' + i, title: title, mermaid: block };
    });

    _renderScenarioGrid(scenarios);
  }

  // ── Vision AI analysis (Tab 2) ────────────────────────────────

  function _handleImageSelect(input) {
    var file = input.files[0];
    if (!file) return;
    if (!/\.(jpe?g|png)$/i.test(file.name)) {
      _showStatus('❌ Please upload a .jpg, .jpeg, or .png image file.', 'red');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      _lastImageDataUrl = e.target.result;
      var preview = document.getElementById('bi-img-preview');
      if (preview) {
        preview.innerHTML = '<img src="' + e.target.result + '" alt="Uploaded diagram" style="max-width:100%;max-height:200px;border-radius:var(--radius);object-fit:contain" />';
      }
      // Enable analyze button
      var btn = document.getElementById('bi-analyze-btn');
      if (btn) {
        var cfg = _getLLMConfig();
        var hasCreds = _hasValidCreds(cfg);
        btn.disabled = !hasCreds;
        btn.title = hasCreds ? 'Analyze the data flow diagram' : 'Configure AI Vision Settings first';
      }
    };
    reader.readAsDataURL(file);
  }

  function _hasValidCreds(cfg) {
    if (cfg.provider === 'foundry') {
      return cfg.foundryAuthMethod === 'token'
        ? cfg.foundryBearerToken.length > 0
        : (cfg.foundryClientId.length > 0 && cfg.foundryTenantId.length > 0 && cfg.foundryClientSecret.length > 0);
    }
    return cfg.apiKey.length > 0;
  }

  // GPT-5, o1, o3, and reasoning models use max_completion_tokens; classic models use max_tokens
  function _maxTokensParam(modelName, value) {
    var usesCompletion = /gpt-5|o1|o3|o4|reasoning/i.test(modelName || '');
    return usesCompletion ? { max_completion_tokens: value } : { max_tokens: value };
  }

  async function _testFoundryConnection() {
    var cfg = _getLLMConfig();
    var foundryEndpoint = cfg.foundryEndpoint.replace(/\/+$/, '');
    var baseMatch = foundryEndpoint.match(/^(https?:\/\/[^\/]+)/);
    if (baseMatch) foundryEndpoint = baseMatch[1];
    if (!foundryEndpoint) {
      _showStatus('❌ Set a Foundry Endpoint first.', 'red');
      return;
    }
    var deployModel = cfg.foundryModel || 'gpt-4o';
    var testUrl = foundryEndpoint + '/openai/deployments/' + deployModel + '/chat/completions?api-version=2024-04-01-preview';

    var token;
    if (cfg.foundryAuthMethod === 'token') {
      token = cfg.foundryBearerToken;
      if (!token) {
        _showStatus('❌ Paste a Bearer Token first.', 'red');
        return;
      }
    } else {
      if (!cfg.foundryClientId || !cfg.foundryTenantId || !cfg.foundryClientSecret) {
        _showStatus('❌ Fill in all Entra ID credential fields first.', 'red');
        return;
      }
      try {
        _showStatus('🔄 Acquiring Entra ID token...', 'blue');
        token = await _getEntraToken(cfg.foundryTenantId, cfg.foundryClientId, cfg.foundryClientSecret);
      } catch (e) {
        _showStatus('❌ Entra ID token failed: ' + e.message, 'red');
        return;
      }
    }

    _showStatus('🔄 Testing connection to ' + deployModel + '...', 'blue');
    try {
      var resp = await fetch(testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(Object.assign({
          model: deployModel,
          messages: [{ role: 'user', content: 'Say "Hello" in one word.' }]
        }, _maxTokensParam(deployModel, 10)))
      });
      if (!resp.ok) {
        var errText = await resp.text();
        _showStatus('❌ API error (' + resp.status + '): ' + errText.substring(0, 200), 'red');
        return;
      }
      var data = await resp.json();
      var reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '(no content)';
      var model = data.model || deployModel;
      _showStatus('✅ Connected! Model: ' + model + ' — Response: "' + reply.trim() + '"', 'green');
    } catch (netErr) {
      _showStatus('❌ Network error: ' + netErr.message + (netErr.message.includes('fetch') ? ' — Token may be expired, generate a new one.' : ''), 'red');
    }
  }

  // Attempt to recover usable scenarios from a truncated JSON string.
  // Extracts all complete scenario objects (those with at least id, title, mermaid) by
  // scanning for closing braces and retrying JSON.parse on substrings.
  function _tryRepairJson(raw) {
    // Strategy 1: close open arrays/objects and try again
    function closeOpen(s) {
      var opens = 0, closes = 0;
      for (var i = 0; i < s.length; i++) {
        if (s[i] === '{' || s[i] === '[') opens++;
        else if (s[i] === '}' || s[i] === ']') closes++;
      }
      // Trim trailing comma + whitespace before we add closers
      s = s.replace(/,\s*$/, '');
      var need = opens - closes;
      for (var j = 0; j < need; j++) s += '}';
      return s;
    }

    try { return JSON.parse(closeOpen(raw)); } catch(e) {}

    // Strategy 2: extract individual complete scenario blobs with regex
    var scenarios = [];
    var scenarioRegex = /\{[^{}]*"id"\s*:[^{}]*"title"\s*:[^{}]*"mermaid"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;
    var m;
    while ((m = scenarioRegex.exec(raw)) !== null) {
      try {
        var s = JSON.parse(m[0]);
        if (s.id && s.title && s.mermaid) scenarios.push(s);
      } catch(e) {}
    }
    if (scenarios.length > 0) return { scenarios: scenarios, ambiguities: [] };

    // Strategy 3: find last complete scenario object ending with `}` before truncation
    var scenariosStart = raw.indexOf('"scenarios"');
    if (scenariosStart === -1) return null;
    var arrStart = raw.indexOf('[', scenariosStart);
    if (arrStart === -1) return null;
    // Walk backward from end of string to find last `},` or `}` that closes a scenario
    var cursor = raw.length - 1;
    while (cursor > arrStart) {
      if (raw[cursor] === '}') {
        var candidate = '{"scenarios":' + raw.substring(arrStart, cursor + 1) + '],"ambiguities":[]}';
        try {
          var obj = JSON.parse(candidate);
          if (obj.scenarios && obj.scenarios.length > 0) return obj;
        } catch(e) {}
      }
      cursor--;
    }
    return null;
  }

  async function _analyzeImage() {
    if (!_lastImageDataUrl) {
      _showStatus('⚠️ Upload an image first.', 'amber');
      return;
    }
    var cfg = _getLLMConfig();
    if (!_hasValidCreds(cfg)) {
      _showStatus('❌ Configure AI Vision Settings before analyzing.', 'red');
      return;
    }

    var base64Data = _lastImageDataUrl.split(',')[1];
    var mimeMatch = _lastImageDataUrl.match(/^data:(image\/[a-z]+);/);
    var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    var btn = document.getElementById('bi-analyze-btn');
    if (btn) { btn.disabled = true; btn.textContent = '🔄 Analyzing…'; }

    _setProgress('🔄 Sending image to AI vision API…', 20);

    var url, headers, body;

    try {
      if (cfg.provider === 'foundry') {
        var foundryEndpoint = cfg.foundryEndpoint.replace(/\/+$/, '');
        var baseMatch = foundryEndpoint.match(/^(https?:\/\/[^\/]+)/);
        if (baseMatch) foundryEndpoint = baseMatch[1];
        if (!foundryEndpoint) throw new Error('Missing Foundry endpoint. Set it in AI Vision Settings.');

        var deployModel = cfg.foundryModel || 'gpt-4o';
        url = foundryEndpoint + '/openai/deployments/' + deployModel + '/chat/completions?api-version=2024-02-01';

        var token;
        if (cfg.foundryAuthMethod === 'token') {
          token = cfg.foundryBearerToken;
          if (!token) throw new Error('Missing Bearer Token. Paste a token in AI Vision Settings.');
        } else {
          _setProgress('🔄 Acquiring Entra ID token…', 10);
          token = await _getEntraToken(cfg.foundryTenantId, cfg.foundryClientId, cfg.foundryClientSecret);
        }

        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
        body = JSON.stringify(Object.assign({
          model: deployModel,
          messages: [
            { role: 'system', content: BLOCK_SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: BLOCK_USER_PROMPT },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data, detail: 'high' } }
            ]}
          ]
        }, _maxTokensParam(deployModel, 16000)));

      } else if (cfg.provider === 'azure') {
        var azureEndpoint = cfg.azureEndpoint;
        if (!azureEndpoint) throw new Error('Azure OpenAI endpoint not configured. Set it in AI Vision Settings.');
        url = azureEndpoint;
        headers = { 'Content-Type': 'application/json', 'api-key': cfg.apiKey };
        body = JSON.stringify(Object.assign({
          messages: [
            { role: 'system', content: BLOCK_SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: BLOCK_USER_PROMPT },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data, detail: 'high' } }
            ]}
          ]
        }, _maxTokensParam(cfg.azureModel || '', 16000)));

      } else {
        url = 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
        body = JSON.stringify(Object.assign({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: BLOCK_SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: BLOCK_USER_PROMPT },
              { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data, detail: 'high' } }
            ]}
          ]
        }, _maxTokensParam('gpt-4o', 16000)));
      }
    } catch (setupErr) {
      _showStatus('❌ ' + setupErr.message, 'red');
      _setProgress('', 0);
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Analyze Diagram'; }
      return;
    }

    // Timeout wrapper (120s — large JSON responses need extra time)
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, 120000);

    _setProgress('🔄 Waiting for AI response (this may take 15–30 seconds)…', 40);

    fetch(url, { method: 'POST', headers: headers, body: body, signal: controller.signal })
      .then(function (resp) {
        clearTimeout(timeoutId);
        _setProgress('🔄 Processing AI response…', 80);
        if (!resp.ok) {
          return resp.text().then(function (errText) {
            var msg = 'API error ' + resp.status;
            try { msg = JSON.parse(errText).error.message || msg; } catch (e) {}
            throw new Error(msg);
          });
        }
        return resp.json();
      })
      .then(function (data) {
        var content = '';
        if (data.choices && data.choices[0] && data.choices[0].message) {
          content = data.choices[0].message.content || '';
        }
        if (!content) throw new Error('Empty response from AI vision API');

        _setProgress('🔄 Parsing scenarios…', 90);

        // Strip markdown fencing if present
        var jsonText = content.trim();
        var fenced = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (fenced) jsonText = fenced[1].trim();

        var parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch (jsonErr) {
          // Attempt to repair truncated JSON by salvaging complete scenario objects
          parsed = _tryRepairJson(jsonText);
          if (!parsed) {
            _setProgress('', 0);
            _showStatus(
              '❌ Could not parse AI response as JSON. Raw response:<br>' +
              '<pre style="max-height:160px;overflow:auto;font-size:11px;margin-top:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius)">' +
              _esc(content) + '</pre>',
              'red'
            );
            if (btn) { btn.disabled = false; btn.textContent = '🔍 Analyze Diagram'; }
            return;
          }
          _showStatus('⚠️ Response was truncated — recovered ' + parsed.scenarios.length + ' scenario(s) from partial JSON.', 'amber');
        }

        // If model returned a bare array, wrap it
        if (Array.isArray(parsed)) {
          parsed = { scenarios: parsed, ambiguities: [] };
        }

        // Deep-scan fallback: model sometimes wraps scenarios inside a nested phase key
        if (!parsed.scenarios || !Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0) {
          var found = null;
          (function scan(obj) {
            if (found || typeof obj !== 'object' || obj === null) return;
            if (Array.isArray(obj)) { obj.forEach(scan); return; }
            if (Array.isArray(obj.scenarios) && obj.scenarios.length > 0) { found = obj.scenarios; return; }
            Object.values(obj).forEach(scan);
          })(parsed);
          if (found) {
            parsed = { scenarios: found, ambiguities: parsed.ambiguities || [] };
            _showStatus('⚠️ Extracted scenarios from nested AI response structure.', 'amber');
          } else {
            throw new Error('No scenarios found in AI response. Try a clearer image or different model.');
          }
        }

        _setProgress('✅ Found ' + parsed.scenarios.length + ' scenario(s)', 100);

        _renderScenarioGrid(parsed.scenarios);
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Analyze Diagram'; }
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        _setProgress('', 0);
        var msg = err.name === 'AbortError'
          ? 'Request timed out. Try a smaller image or different model.'
          : err.message;
        _showStatus('❌ ' + msg, 'red');
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Analyze Diagram'; }
      });
  }

  // ── Tab switching ─────────────────────────────────────────────

  function _switchTab(tab) {
    var tabs = document.querySelectorAll('.bi-tab');
    var panels = document.querySelectorAll('.bi-tab-panel');
    tabs.forEach(function (t, i) {
      t.classList.toggle('active', (tab === 'file' && i === 0) || (tab === 'image' && i === 1));
    });
    panels.forEach(function (p) {
      p.classList.toggle('active', p.id === 'bi-tab-' + tab);
    });
    // Modal width stays consistent across both tabs
    var modal = document.getElementById('modal-c');
    if (modal) modal.classList.add('modal-wide');
  }

  // ── Utility ───────────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── showImportUI ──────────────────────────────────────────────

  function showImportUI() {
    if (typeof SM !== 'function') {
      alert('FMA Framework app not loaded');
      return;
    }

    // Reset state
    _currentScenarios = [];
    _lastImageDataUrl = null;

    var llmCfg = _getLLMConfig();
    var hasKey = _hasValidCreds(llmCfg);
    var currentWorkloadName = (typeof S !== 'undefined' && S.wn) ? S.wn : '';

    window._importUILocked = true;

    var html =
      '<div style="display:flex;flex-direction:column;gap:12px;">' +

      // Close button
      '<div style="display:flex;justify-content:flex-end;margin:-8px -8px 0 0">' +
      '<button onclick="window._importModalOpen=false;window._importUILocked=false;HM();" style="background:none;border:none;color:var(--text2);font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1" title="Close">✕</button>' +
      '</div>' +

      // Workload Name
      '<div style="background:rgba(78,205,196,.08);padding:12px;border-radius:var(--radius);border-left:3px solid var(--accent)">' +
      '<label style="font-size:.82rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px">🏗️ Workload Name <span style="color:var(--danger,#e74c3c)">*</span></label>' +
      '<input type="text" id="bi-workload-name" value="' + _esc(currentWorkloadName) + '" ' +
      'placeholder="e.g., Cortex Data Platform" required ' +
      'oninput="BlockImport._onWnInput()" ' +
      'style="width:100%;padding:8px 12px;font-size:.9rem;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:var(--radius)">' +
      '<span id="bi-wn-error" style="display:none;color:#e55;font-size:12px;margin-left:8px;">⚠ Enter a workload name first</span>' +
      '<p style="font-size:.72rem;color:var(--text3);margin:6px 0 0 0">Required. Used as the application name on the Overview page.</p>'+
      '</div>' +

      // Tabs
      '<div class="seq-tabs">' +
      '<div class="seq-tab bi-tab active" onclick="BlockImport._switchTab(\'file\')">📁 Upload File</div>' +
      '<div class="seq-tab bi-tab" onclick="BlockImport._switchTab(\'image\')">🖼️ Upload Image</div>' +
      '</div>' +

      // ── Tab 1: File ──
      '<div id="bi-tab-file" class="seq-tab-panel bi-tab-panel active">' +
      '<p style="color:var(--text2);font-size:.82rem;margin-bottom:12px">Upload a Mermaid file (.mmd, .mermaid, .md, .txt) containing one or more sequence diagrams.</p>' +
      '<div id="bi-file-dropzone" style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 16px;border:2px dashed var(--border);border-radius:var(--radius);cursor:pointer;user-select:none" onclick="if(BlockImport._checkWorkloadName()) document.getElementById(\'bi-file-input\').click()">' +
      '<span style="font-size:2rem">📁</span>' +
      '<span style="font-size:.85rem;font-weight:600;color:var(--text)">Click to select a .mmd file</span>' +
      '<span style="font-size:.72rem;color:var(--text3)">Supports .mmd, .mermaid, .md, .txt</span>' +
      '</div>' +
      '<input type="file" id="bi-file-input" accept=".md,.mermaid,.mmd,.txt" style="display:none" onchange="BlockImport._handleFileUpload(this)">' +
      '</div>' +

      // ── Tab 2: Image ──
      '<div id="bi-tab-image" class="seq-tab-panel bi-tab-panel">' +

      // AI Vision Settings collapsible
      '<details id="bi-llm-settings" ' + (hasKey ? '' : 'open') + ' style="margin-bottom:10px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:10px">' +
      '<summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--text2)">⚙️ AI Vision Settings</summary>' +
      '<div style="margin-top:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:0 0 160px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Provider</label>' +
      '<select id="bi-llm-provider" onchange="BlockImport._saveLLMSettings()" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="foundry"' + (llmCfg.provider === 'foundry' ? ' selected' : '') + '>Azure Foundry (recommended)</option>' +
      '<option value="openai"' + (llmCfg.provider === 'openai' ? ' selected' : '') + '>OpenAI (GPT-4o)</option>' +
      '<option value="azure"' + (llmCfg.provider === 'azure' ? ' selected' : '') + '>Azure OpenAI</option>' +
      '</select>' +
      '</div>' +
      '<div id="bi-llm-apikey-wrap" style="flex:1;min-width:200px;display:' + (llmCfg.provider === 'foundry' ? 'none' : 'block') + '">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">API Key</label>' +
      '<input type="password" id="bi-llm-apikey" value="' + _esc(llmCfg.apiKey) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="sk-... or Azure key" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div id="bi-llm-azure-endpoint" style="flex:1;min-width:200px;display:' + (llmCfg.provider === 'azure' ? 'block' : 'none') + '">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Azure Endpoint</label>' +
      '<input type="text" id="bi-llm-azure-url" value="' + _esc(llmCfg.azureEndpoint) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="https://YOUR.openai.azure.com/openai/deployments/YOUR-DEPLOY/chat/completions?api-version=2024-02-01" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '</div>' +

      // Foundry-specific fields
      '<div id="bi-llm-foundry-fields" style="display:' + (llmCfg.provider === 'foundry' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:1;min-width:250px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Foundry Endpoint</label>' +
      '<input type="text" id="bi-llm-foundry-url" value="' + _esc(llmCfg.foundryEndpoint) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="https://your-resource.cognitiveservices.azure.com" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<p style="font-size:.62rem;color:var(--text3);margin:3px 0 0 0">Base URL only — do not include /openai/deployments/…</p>' +
      '</div>' +
      '<div style="flex:0 0 200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Model</label>' +
      '<select id="bi-llm-foundry-model" onchange="BlockImport._saveLLMSettings()" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="gpt-4o"' + (llmCfg.foundryModel === 'gpt-4o' ? ' selected' : '') + '>GPT-4o (recommended)</option>' +
      '<option value="gpt-4o-mini"' + (llmCfg.foundryModel === 'gpt-4o-mini' ? ' selected' : '') + '>GPT-4o Mini (faster)</option>' +
      '<option value="gpt-5-mini"' + (llmCfg.foundryModel === 'gpt-5-mini' ? ' selected' : '') + '>GPT-5 Mini</option>' +
      '<option value="gpt-5"' + (llmCfg.foundryModel === 'gpt-5' ? ' selected' : '') + '>GPT-5 (highest quality)</option>' +
      '<option value="Phi-4-multimodal-instruct"' + (llmCfg.foundryModel === 'Phi-4-multimodal-instruct' ? ' selected' : '') + '>Phi-4 Multimodal (Microsoft)</option>' +
      '</select>' +
      '</div>' +
      '<div style="flex:0 0 180px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Auth Method</label>' +
      '<select id="bi-llm-foundry-auth-method" onchange="BlockImport._saveLLMSettings();BlockImport._toggleFoundryAuth();" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="token"' + (llmCfg.foundryAuthMethod === 'token' ? ' selected' : '') + '>Bearer Token (recommended)</option>' +
      '<option value="entra"' + (llmCfg.foundryAuthMethod === 'entra' ? ' selected' : '') + '>Entra ID (Service Principal)</option>' +
      '</select>' +
      '</div>' +
      '</div>' +
      // Bearer Token fields
      '<div id="bi-llm-foundry-token-fields" style="display:' + (llmCfg.foundryAuthMethod === 'token' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<div style="display:flex;gap:8px;align-items:flex-end">' +
      '<div style="flex:1">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Bearer Token</label>' +
      '<input type="password" id="bi-llm-foundry-bearer-token" value="' + _esc(llmCfg.foundryBearerToken) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="Paste your Azure AD bearer token here" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<button onclick="BlockImport._testFoundryConnection()" style="padding:5px 12px;font-size:.78rem;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;white-space:nowrap">🔗 Test</button>' +
      '</div>' +
      '<details style="margin-top:6px">' +
      '<summary style="cursor:pointer;font-size:.68rem;color:var(--accent)">📋 How to get a bearer token</summary>' +
      '<div style="margin-top:4px;padding:8px;background:rgba(0,0,0,.15);border-radius:var(--radius);font-size:.65rem;font-family:\'Space Mono\',monospace;color:var(--text2);white-space:pre-wrap;line-height:1.5;user-select:all">' +
      '# PowerShell — run this and paste the result above\n' +
      '$body = @{\n' +
      '  client_id     = "YOUR_CLIENT_ID"\n' +
      '  client_secret = "YOUR_CLIENT_SECRET"\n' +
      '  scope         = "https://cognitiveservices.azure.com/.default"\n' +
      '  grant_type    = "client_credentials"\n' +
      '}\n' +
      '$r = Invoke-RestMethod `\n' +
      '  -Uri "https://login.microsoftonline.com/YOUR_TENANT_ID/oauth2/v2.0/token" `\n' +
      '  -Method POST -Body $body\n' +
      '$r.access_token | Set-Clipboard\n' +
      'Write-Host "Token copied to clipboard (valid ~1hr)"' +
      '</div>' +
      '<p style="font-size:.62rem;color:var(--text3);margin:4px 0 0 0">⏱️ Tokens are valid for ~1 hour.</p>' +
      '</details>' +
      '</div>' +
      // Entra ID fields
      '<div id="bi-llm-foundry-entra-fields" style="display:' + (llmCfg.foundryAuthMethod === 'entra' ? 'flex' : 'none') + ';gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Client ID</label>' +
      '<input type="text" id="bi-llm-foundry-client-id" value="' + _esc(llmCfg.foundryClientId) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Tenant ID</label>' +
      '<input type="text" id="bi-llm-foundry-tenant-id" value="' + _esc(llmCfg.foundryTenantId) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Client Secret</label>' +
      '<input type="password" id="bi-llm-foundry-client-secret" value="' + _esc(llmCfg.foundryClientSecret) + '" onchange="BlockImport._saveLLMSettings()" ' +
      'placeholder="Service principal secret" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<p style="font-size:.62rem;color:var(--text3);width:100%;margin:0">⚠️ Entra ID client_credentials may be blocked by browser CORS. Use Bearer Token if you get network errors.</p>' +
      '</div>' +
      '</div>' +
      '<div id="bi-llm-foundry-help" style="display:' + (llmCfg.provider === 'foundry' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<p style="font-size:.68rem;color:var(--text3);margin:0"><strong>Setup:</strong> Grant "Cognitive Services OpenAI User" role to a Service Principal → get a bearer token (recommended) or enter SP credentials.</p>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">' +
      '<p style="font-size:.68rem;color:var(--text3);margin:0">🔒 API key stored in sessionStorage — cleared when you close the browser tab.</p>' +
      '</div>' +
      '</details>' +

      // Image upload + analyze area
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px">' +
      // Left: image drop zone + preview
      '<div>' +
      '<div id="bi-img-zone">' +
      '<div id="bi-img-preview" onclick="if(BlockImport._checkWorkloadName()) document.getElementById(\'bi-img-input\').click()" ' +
      'style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;border:2px dashed var(--border);border-radius:var(--radius);cursor:pointer;user-select:none;min-height:120px;text-align:center">' +
      '<span style="font-size:2rem">📷</span>' +
      '<span style="font-size:.82rem;color:var(--text)">Click to upload or drag &amp; drop</span>' +
      '<small style="color:var(--text3)">.jpg, .jpeg, .png</small>' +
      '</div>' +
      '<input type="file" id="bi-img-input" accept=".jpg,.jpeg,.png" style="display:none" onchange="BlockImport._handleImageSelect(this)">' +
      '</div>' +
      '</div>' +
      // Right: analyze button + status
      '<div style="display:flex;flex-direction:column;gap:10px;justify-content:center">' +
      '<button id="bi-analyze-btn" onclick="BlockImport._analyzeImage()" disabled ' +
      'style="padding:10px 16px;font-size:.88rem;background:var(--accent);color:var(--bg);border:none;border-radius:var(--radius);cursor:pointer;font-weight:600" ' +
      'title="Upload an image and configure settings first">' +
      '🔍 Analyze Diagram' +
      '</button>' +
      '<p style="font-size:.75rem;color:var(--text3);margin:0">Upload an image, then click Analyze. The AI will extract all distinct sequence flows from the data flow diagram.</p>' +
      '</div>' +
      '</div>' +

      // Progress bar
      '<div id="bi-progress" style="display:none;margin-top:10px">' +
      '<span id="bi-progress-status" style="font-size:.78rem;color:var(--text2)"></span>' +
      '<div style="height:4px;background:var(--bg3);border-radius:2px;margin-top:4px"><div id="bi-progress-bar" style="height:4px;background:var(--accent);border-radius:2px;width:0;transition:width .3s"></div></div>' +
      '</div>' +

      '</div>' + // close bi-tab-image

      // Scenario grid (shared — shown after file load or AI analysis)
      '<div id="bi-grid-container" style="display:none"></div>' +

      // Status
      '<div id="bi-status" style="display:none;padding:10px;border-radius:var(--radius);font-size:.85rem;margin-top:4px"></div>' +

      // Bottom buttons
      '<div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--border);margin-top:4px">' +
      '<button class="btn btn-secondary btn-sm" onclick="window._importModalOpen=false;window._importUILocked=false;HM()">Cancel</button>' +
      '<button id="bi-import-btn" class="btn btn-primary btn-sm" onclick="BlockImport._importSelected()" disabled>' +
      '📊 Import Selected (0)' +
      '</button>' +
      '</div>' +

      '</div>'; // close outer flex container

    SM('📊 Import Data Flows', html);
    window._importModalOpen = true;

    // Inject card-summary styles once
    if (!document.getElementById('bi-card-summary-style')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'bi-card-summary-style';
      styleEl.textContent = '.bi-card-summary{margin:6px 0 0 0;padding:4px 12px 6px 28px;font-size:11px;color:#9ca3af;list-style:disc}.bi-card-summary li{margin-bottom:2px}';
      document.head.appendChild(styleEl);
    }

    var modal = document.getElementById('modal-c');
    if (modal) modal.classList.add('modal-wide');

    // Set up drag-and-drop on image preview
    setTimeout(function () {
      var preview = document.getElementById('bi-img-preview');
      if (preview) {
        preview.addEventListener('dragover', function (e) {
          e.preventDefault();
          preview.style.borderColor = 'var(--accent)';
        });
        preview.addEventListener('dragleave', function () {
          preview.style.borderColor = '';
        });
        preview.addEventListener('drop', function (e) {
          e.preventDefault();
          preview.style.borderColor = '';
          var file = e.dataTransfer.files[0];
          if (file && /\.(jpe?g|png)$/i.test(file.name)) {
            // Simulate input change
            var fakeInput = { files: [file] };
            _handleImageSelect(fakeInput);
          }
        });
      }
      // Set up drag-and-drop on file drop zone
      var fileZone = document.getElementById('bi-file-dropzone');
      if (fileZone) {
        fileZone.addEventListener('dragover', function (e) {
          e.preventDefault();
          fileZone.style.borderColor = 'var(--accent)';
        });
        fileZone.addEventListener('dragleave', function () {
          fileZone.style.borderColor = '';
        });
        fileZone.addEventListener('drop', function (e) {
          e.preventDefault();
          fileZone.style.borderColor = '';
          var file = e.dataTransfer.files[0];
          if (file) {
            var reader = new FileReader();
            reader.onload = function (ev) { _parseMmdFile(ev.target.result || ''); };
            reader.readAsText(file);
          }
        });
      }
      // Call _onWnInput once to set initial locked/unlocked state
      BlockImport._onWnInput();
    }, 100);
  }

  // ── Public API ────────────────────────────────────────────────

  window.BlockImport = {
    showImportUI: showImportUI,
    _switchTab: _switchTab,
    _saveLLMSettings: _saveLLMSettings,
    _toggleFoundryAuth: _toggleFoundryAuth,
    _testFoundryConnection: _testFoundryConnection,
    _handleFileUpload: _handleFileUpload,
    _handleImageSelect: _handleImageSelect,
    _analyzeImage: _analyzeImage,
    _importSelected: _importSelected,
    _checkWorkloadName: function() {
      var wn = (document.getElementById('bi-workload-name') || {}).value || '';
      if (wn.trim().length < 3) {
        var msg = document.getElementById('bi-wn-error');
        if (msg) {
          msg.style.display = 'inline';
          setTimeout(function() { msg.style.display = 'none'; }, 2500);
        }
        return false;
      }
      return true;
    },
    _onWnInput: function() {
      var wn = (document.getElementById('bi-workload-name') || {}).value || '';
      var locked = wn.trim().length < 3;
      ['bi-file-dropzone', 'bi-img-preview'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) {
          el.style.opacity = locked ? '0.45' : '1';
          el.style.cursor = locked ? 'not-allowed' : 'pointer';
        }
      });
      ['bi-file-input', 'bi-img-input'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.disabled = locked;
      });
    },
    _toggleCard: _toggleCard,
    _zoomCard: _zoomCard,
    _renameCard: _renameCard,
    _clearStatus: _clearStatus,
    _selectAll: _selectAll
  };

})();

