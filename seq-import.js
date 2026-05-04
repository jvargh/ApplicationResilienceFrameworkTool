/**
 * seq-import.js — Mermaid Sequence Diagram Auto-Population for FMA Framework
 *
 * Parses one or more Mermaid sequenceDiagram blocks, classifies workflows/components,
 * and auto-populates all 8 phases of the FMA framework UI.
 *
 * Exposed as window.SeqImport with the following API:
 *   parse(text)            → ParsedDiagram[]
 *   classify(diagrams)     → ClassifiedSystem
 *   populate(system)       → void (writes to global S)
 *   toMarkdown(system)     → string
 *   showImportUI()         → void (opens modal)
 *   run()                  → void (parse + classify + populate)
 *   runAndExportMD()       → void (parse + classify + markdown download)
 */
(function () {
  'use strict';

  // Node.js compatibility — define window as global
  if (typeof window === 'undefined') {
    global.window = global;
  }

  var _SEQ_IMPORT_VERSION = '3.3.0'; // Visible in import modal for cache verification

  // Inject a title directive into mermaid text from a source filename (if no title exists)
  function _injectTitleFromFilename(mermaidText, filename) {
    if (!filename || /^\s*title\s+/m.test(mermaidText)) return mermaidText;
    var title = filename
      .replace(/\.(mmd|mermaid|md|txt|jpg|jpeg|png)$/i, '')
      .replace(/^\d+[a-z]*(?:[_\-]\d+[a-z]*)*[_\-]/, '')
      .replace(/[_\-]/g, ' ')
      .trim();
    if (title.length < 3) return mermaidText;
    return mermaidText.replace(
      /^(\s*sequenceDiagram\s*)$/m,
      '$1\n    title ' + title
    );
  }

  // ============================================================
  // 1. AZURE SERVICE DETECTION
  // ============================================================

  const AZURE_SERVICE_MAP = {
    'azure databricks': { name: 'Azure Databricks', category: 'Platform Component' },
    'azure key vault': { name: 'Azure Key Vault', category: 'Platform Component' },
    'azure service bus': { name: 'Azure Service Bus', category: 'Platform Component' },
    'azure event hubs': { name: 'Azure Event Hubs', category: 'Platform Component' },
    'azure functions': { name: 'Azure Functions', category: 'Application Component' },
    'azure sql': { name: 'Azure SQL Database', category: 'Platform Component' },
    'azure sql database': { name: 'Azure SQL Database', category: 'Platform Component' },
    'azure cosmos db': { name: 'Azure Cosmos DB', category: 'Platform Component' },
    'cosmos db': { name: 'Azure Cosmos DB', category: 'Platform Component' },
    'cosmosdb': { name: 'Azure Cosmos DB', category: 'Platform Component' },
    'adls': { name: 'Azure Data Lake Storage', category: 'Platform Component' },
    'aks': { name: 'Azure Kubernetes Service', category: 'Platform Component' },
    'api management': { name: 'Azure API Management', category: 'Application Component' },
    'application gateway': { name: 'Azure Application Gateway', category: 'Platform Component' },
    'azure monitor': { name: 'Azure Monitor', category: 'Platform Component' },
    'azure logic apps': { name: 'Azure Logic Apps', category: 'Application Component' },
    'azure data factory': { name: 'Azure Data Factory', category: 'Platform Component' },
    'azure entra id': { name: 'Azure Entra ID', category: 'Platform Component' },
    'azure data lake storage': { name: 'Azure Data Lake Storage', category: 'Platform Component' },
    'azure data lake': { name: 'Azure Data Lake Storage', category: 'Platform Component' },
    'azure datalake': { name: 'Azure Data Lake Storage', category: 'Platform Component' },
    'azure datablake': { name: 'Azure Data Lake Storage', category: 'Platform Component' },
    'azure kubernetes service': { name: 'Azure Kubernetes Service', category: 'Platform Component' },
    'azure api management': { name: 'Azure API Management', category: 'Application Component' },
    'azure application gateway': { name: 'Azure Application Gateway', category: 'Platform Component' },
  };

  const AZURE_PATTERNS = [
    { pattern: /databricks/i, service: 'Azure Databricks' },
    { pattern: /cosmos/i, service: 'Azure Cosmos DB' },
    { pattern: /\bADLS\b/i, service: 'Azure Data Lake Storage' },
    { pattern: /data\s*b?lake/i, service: 'Azure Data Lake Storage' },
    { pattern: /key\s*vault/i, service: 'Azure Key Vault' },
    { pattern: /service\s*bus/i, service: 'Azure Service Bus' },
    { pattern: /event\s*hub/i, service: 'Azure Event Hubs' },
    { pattern: /\bAKS\b/, service: 'Azure Kubernetes Service' },
    { pattern: /azure\s*sql/i, service: 'Azure SQL Database' },
    { pattern: /\bspark\b/i, service: 'Azure Databricks' },
  ];

  function detectAzureService(label) {
    // Normalize but KEEP parenthesized content — Azure names often live inside parens
    // e.g. "Landing Zone (ADLS)", "Application Metadata Store (Cosmos/Azure SQL)"
    const lower = label.toLowerCase().replace(/<br\s*\/?>/gi, ' ').trim();
    // Also check with parens stripped for the map lookup
    const lowerNoParens = lower.replace(/\(.*?\)/g, ' ').trim();

    // First: check the full label (including parens content) against the map
    for (const key in AZURE_SERVICE_MAP) {
      if (lower.includes(key)) {
        return { ...AZURE_SERVICE_MAP[key], confidence: 'explicit' };
      }
    }
    // Second: check stripped version against the map
    for (const key in AZURE_SERVICE_MAP) {
      if (lowerNoParens.includes(key)) {
        return { ...AZURE_SERVICE_MAP[key], confidence: 'explicit' };
      }
    }
    // Third: check patterns against the FULL label (including parens)
    for (const p of AZURE_PATTERNS) {
      if (p.pattern.test(label)) {
        return { name: p.service, category: 'Platform Component', confidence: 'inferred' };
      }
    }
    return null;
  }

  // Detect ALL Azure services in a label (handles multi-service labels like "Cosmos/Azure SQL")
  function detectAllAzureServices(label) {
    const results = [];
    const lower = label.toLowerCase().replace(/<br\s*\/?>/gi, ' ').trim();
    for (const key in AZURE_SERVICE_MAP) {
      if (lower.includes(key) && !results.find(r => r.name === AZURE_SERVICE_MAP[key].name)) {
        results.push({ ...AZURE_SERVICE_MAP[key], confidence: 'explicit' });
      }
    }
    for (const p of AZURE_PATTERNS) {
      if (p.pattern.test(label) && !results.find(r => r.name === p.service)) {
        results.push({ name: p.service, category: 'Platform Component', confidence: 'inferred' });
      }
    }
    return results;
  }

  // ============================================================
  // 2. COMPONENT CATEGORY HEURISTICS
  // ============================================================

  const CATEGORY_RULES = [
    { test: (label) => /^(user|admin|customer|external|scheduler|operator)\b/i.test(label.replace(/[^a-zA-Z0-9\s]/g, '')), category: 'User/External Actor' },
    { test: (label) => detectAzureService(label) !== null, category: 'Azure Service' },
    { test: (label) => /\b(queue|bus|cache|database|db|storage|blob|lake|vault|gateway|load.?balancer|dns|cdn|firewall)\b/i.test(label), category: 'Platform Component' },
    { test: (label) => /\b(api|service|svc|engine|processor|handler|controller|module|manager|worker|agent)\b/i.test(label), category: 'Application Component' },
    { test: () => true, category: 'Application Component' },
  ];

  function classifyParticipant(label, type) {
    if (type === 'actor') return 'User/External Actor';
    const clean = label.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
    for (const rule of CATEGORY_RULES) {
      if (rule.test(clean)) return rule.category;
    }
    return 'Application Component';
  }

  // ============================================================
  // 3. PARSER
  // ============================================================

  const ARROW_PATTERNS = [
    { regex: /^(.+?)\s*->>>\+?\s*(.+?)\s*:\s*(.*)$/, type: 'sync' },
    { regex: /^(.+?)\s*-->>-?\s*(.+?)\s*:\s*(.*)$/, type: 'async' },
    { regex: /^(.+?)\s*->>\+?\s*(.+?)\s*:\s*(.*)$/, type: 'sync' },
    { regex: /^(.+?)\s*-->-?\s*(.+?)\s*:\s*(.*)$/, type: 'reply' },
    { regex: /^(.+?)\s*->-?\s*(.+?)\s*:\s*(.*)$/, type: 'solid' },
  ];

  function cleanLabel(raw) {
    return raw.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Split input text into individual sequenceDiagram blocks.
   * Handles ```mermaid fences and bare sequenceDiagram keywords.
   */
  function splitDiagramBlocks(text) {
    if (!text || !text.trim()) return [];
    const blocks = [];
    const fenceRegex = /```(?:mermaid)?\s*\n([\s\S]*?)```/gi;
    let match;
    const fenced = [];

    while ((match = fenceRegex.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.match(/^\s*sequenceDiagram/im)) {
        fenced.push(content);
      }
    }

    if (fenced.length > 0) return fenced;

    // No fences — split on bare sequenceDiagram keyword
    const lines = text.split('\n');
    let current = [];
    let inDiagram = false;

    for (const line of lines) {
      if (/^\s*sequenceDiagram\s*$/i.test(line)) {
        if (inDiagram && current.length > 0) {
          blocks.push(current.join('\n'));
        }
        current = [line];
        inDiagram = true;
      } else if (inDiagram) {
        current.push(line);
      }
    }
    if (inDiagram && current.length > 0) {
      blocks.push(current.join('\n'));
    }

    return blocks;
  }

  /**
   * Parse a single sequenceDiagram block into structured data.
   */
  function parseSingleDiagram(diagramText, index) {
    const lines = diagramText.split('\n');
    const participants = [];
    const interactions = [];
    const blocks = [];
    const notes = [];
    let title = '';
    let seqNum = 0;
    const blockStack = [];
    let blockIdCounter = 0;
    const participantMap = {};

    function ensureParticipant(alias) {
      const trimmed = alias.trim();
      if (!participantMap[trimmed]) {
        participantMap[trimmed] = { alias: trimmed, label: trimmed, rawLabel: trimmed, type: 'participant' };
        participants.push(participantMap[trimmed]);
      }
      return trimmed;
    }

    for (let rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^\s*sequenceDiagram\s*$/i.test(line)) continue;
      if (/^\s*autonumber\s*$/i.test(line)) continue;
      if (/^\s*(activate|deactivate)\s+/i.test(line)) continue;
      if (/^\s*rect\s+/i.test(line)) continue;

      // Title
      const titleMatch = line.match(/^\s*title\s+(.+)$/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
        continue;
      }

      // Participant / Actor
      const partMatch = line.match(/^\s*(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i);
      if (partMatch) {
        const type = partMatch[1].toLowerCase();
        const alias = partMatch[2].trim();
        const rawLabel = partMatch[3] ? partMatch[3].trim() : alias;
        const label = cleanLabel(rawLabel);
        participantMap[alias] = { alias, label, rawLabel, type };
        participants.push(participantMap[alias]);
        continue;
      }

      // Note
      const noteMatch = line.match(/^\s*Note\s+(over|left of|right of)\s+([^:]+):\s*(.+)$/i);
      if (noteMatch) {
        const position = noteMatch[1].toLowerCase();
        const partList = noteMatch[2].split(',').map(p => p.trim());
        const text = noteMatch[3].replace(/<br\s*\/?>/gi, '\n').trim();
        partList.forEach(p => ensureParticipant(p));
        notes.push({ text, position, participants: partList });
        continue;
      }

      // Alt/Opt/Loop
      const blockMatch = line.match(/^\s*(alt|opt|loop)\s+(.*)$/i);
      if (blockMatch) {
        const block = {
          id: 'blk_' + (blockIdCounter++),
          type: blockMatch[1].toLowerCase(),
          condition: blockMatch[2].trim(),
          branches: [blockMatch[2].trim()],
          interactions: [],
        };
        blocks.push(block);
        blockStack.push(block);
        continue;
      }

      // Else (alt branch)
      const elseMatch = line.match(/^\s*else\s*(.*)$/i);
      if (elseMatch && blockStack.length > 0) {
        const top = blockStack[blockStack.length - 1];
        if (top.type === 'alt') {
          top.branches.push(elseMatch[1].trim() || 'else');
        }
        continue;
      }

      // End
      if (/^\s*end\s*$/i.test(line)) {
        blockStack.pop();
        continue;
      }

      // Interactions (arrows)
      let matched = false;
      for (const ap of ARROW_PATTERNS) {
        const m = line.match(ap.regex);
        if (m) {
          const from = ensureParticipant(m[1].replace(/[+-]/g, '').trim());
          const to = ensureParticipant(m[2].replace(/[+-]/g, '').trim());
          const label = m[3].trim();
          const parentBlock = blockStack.length > 0 ? blockStack[blockStack.length - 1].id : null;
          const interaction = { from, to, label, arrowType: ap.type, sequenceNum: seqNum++, parentBlock };
          interactions.push(interaction);
          if (parentBlock) {
            const blk = blocks.find(b => b.id === parentBlock);
            if (blk) blk.interactions.push(interaction);
          }
          matched = true;
          break;
        }
      }
      // Lines we don't recognize are silently ignored
    }

    if (!title) {
      // Try to derive title from first note
      const firstNote = notes.find(n => n.text && n.text.length > 5);
      if (firstNote) {
        title = firstNote.text.split('\n')[0].substring(0, 60);
      } else if (interactions.length > 0) {
        // Derive from the primary action (first interaction label)
        const mainLabel = interactions[0].label.replace(/[^a-zA-Z0-9\s]/g, '').trim();
        if (mainLabel.length >= 3) {
          title = mainLabel.substring(0, 50);
        } else {
          // Derive from participant names
          const names = participants.filter(p => p.label && p.label.length > 1).map(p => p.label).slice(0, 3);
          title = names.length > 0 ? names.join(' to ') : 'workflow_' + (index + 1);
        }
      } else {
        // Derive from participant names
        const names = participants.filter(p => p.label && p.label.length > 1).map(p => p.label).slice(0, 3);
        title = names.length > 0 ? names.join(' to ') : 'workflow_' + (index + 1);
      }
    }

    return {
      title,
      participants,
      interactions,
      blocks,
      notes,
      rawSource: diagramText,
    };
  }

  /**
   * Parse one or more Mermaid sequenceDiagram blocks from raw text.
   */
  function parse(text) {
    const blocks = splitDiagramBlocks(text);
    return blocks.map((b, i) => parseSingleDiagram(b, i));
  }

  // ============================================================
  // 4. CLASSIFIER
  // ============================================================

  function normalizeEntityName(name) {
    var cleaned = name.replace(/<br\s*\/?>/gi, ' ')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Strip leading numeric prefixes: "1.", "2)", "01 -", "1a.", ordered list markers
    cleaned = cleaned.replace(/^[\d]+[a-z]*[\.\)\-\s]+/i, '').trim();
    // Strip "Step N:", "Item N:" style prefixes
    cleaned = cleaned.replace(/^(step|item|section|part)\s*\d+\s*[:\-\.]\s*/i, '').trim();
    return cleaned;
  }

  /**
   * Validate whether a string is a likely component name vs a workflow title or section header.
   * Component names tend to be short, PascalCase/camelCase, or known service names.
   * Workflow titles tend to be longer descriptive phrases with verbs.
   */
  function isLikelyComponentName(value) {
    if (!value || value.length < 2) return false;
    // Reject if it looks like a workflow title (contains action verbs)
    if (/^(process|manage|handle|execute|run|perform|create|update|delete|ingest|transform)\s/i.test(value)) return false;
    // Reject if it's a section header (all caps with spaces, or "Section X")
    if (/^(section|chapter|phase|step)\s+\d/i.test(value)) return false;
    // Accept if it matches known patterns for component names
    return true;
  }

  // Return the componentMap key for a participant: use Azure canonical name when detected,
  // otherwise fall back to normalizeEntityName.
  function getComponentKey(label, alias) {
    var azure = detectAzureService(label) || (alias && alias !== label ? detectAzureService(alias) : null);
    if (azure) return azure.name;
    return normalizeEntityName(label);
  }

  function classify(diagrams) {
    const componentMap = {};
    const azureServices = [];
    const workflows = [];
    const allInteractions = [];

    // Pass 1: Collect all components across diagrams
    for (const diag of diagrams) {
      for (const p of diag.participants) {
        const compKey = getComponentKey(p.label, p.alias);
        const category = classifyParticipant(p.label, p.type);
        const azure = detectAzureService(p.label) || (p.alias !== p.label ? detectAzureService(p.alias) : null);

        if (!componentMap[compKey]) {
          componentMap[compKey] = {
            id: 'comp_' + Object.keys(componentMap).length,
            normalizedName: compKey,
            rawLabels: [p.rawLabel],
            category: azure ? azure.category : category,
            workflowIds: [],
            failureModes: [],
            healthSignals: [],
          };
        } else {
          if (!componentMap[compKey].rawLabels.includes(p.rawLabel)) {
            componentMap[compKey].rawLabels.push(p.rawLabel);
          }
        }

        // Track Azure services — use detectAllAzureServices to catch multi-service labels
        const allAzureFromLabel = detectAllAzureServices(p.label);
        if (allAzureFromLabel.length === 0 && p.alias !== p.label) {
          detectAllAzureServices(p.alias).forEach(a => {
            if (!allAzureFromLabel.find(x => x.name === a.name)) allAzureFromLabel.push(a);
          });
        }
        for (const az of allAzureFromLabel) {
          if (!azureServices.find(a => a.name === az.name)) {
            azureServices.push({
              id: 'az_' + azureServices.length,
              name: az.name,
              componentId: componentMap[compKey].id,
              confidence: az.confidence,
              workflowIds: [],
            });
          }
        }

        // Replace generic normalizedName with Azure service name(s) when detected
        // When multiple Azure services detected, create separate component entries
        if (allAzureFromLabel.length > 0) {
          var uniqueNames = [];
          for (var ai = 0; ai < allAzureFromLabel.length; ai++) {
            if (uniqueNames.indexOf(allAzureFromLabel[ai].name) === -1) {
              uniqueNames.push(allAzureFromLabel[ai].name);
            }
          }
          // First service keeps the original compKey entry
          componentMap[compKey].normalizedName = uniqueNames[0];
          // Additional services get their own component entries
          for (var ni = 1; ni < uniqueNames.length; ni++) {
            var extraKey = uniqueNames[ni];
            if (!componentMap[extraKey]) {
              componentMap[extraKey] = {
                id: 'comp_' + Object.keys(componentMap).length,
                normalizedName: uniqueNames[ni],
                rawLabels: componentMap[compKey].rawLabels.slice(),
                category: 'Platform Component',
                workflowIds: [],
                failureModes: [],
                healthSignals: [],
              };
            }
          }
        }
      }
    }

    // Pass 2: Build workflows
    for (const diag of diagrams) {
      const wfId = 'wf_' + workflows.length;
      const participantAliases = diag.participants.map(p => p.alias);
      const wfComponents = [];

      // Resolve components for this workflow
      for (const p of diag.participants) {
        const compKey = getComponentKey(p.label, p.alias);
        const comp = componentMap[compKey];
        if (comp) {
          if (!comp.workflowIds.includes(wfId)) comp.workflowIds.push(wfId);
          wfComponents.push(comp);

          // Also register any split-out Azure service components for this participant
          const splitAzure = detectAllAzureServices(p.label);
          if (splitAzure.length === 0 && p.alias !== p.label) {
            detectAllAzureServices(p.alias).forEach(function(a) {
              if (!splitAzure.find(function(x){ return x.name === a.name; })) splitAzure.push(a);
            });
          }
          var splitNames = [];
          for (var si2 = 0; si2 < splitAzure.length; si2++) {
            if (splitNames.indexOf(splitAzure[si2].name) === -1) splitNames.push(splitAzure[si2].name);
          }
          for (var si3 = 1; si3 < splitNames.length; si3++) {
            var extraComp = componentMap[splitNames[si3]];
            if (extraComp) {
              if (!extraComp.workflowIds.includes(wfId)) extraComp.workflowIds.push(wfId);
              if (!wfComponents.includes(extraComp)) wfComponents.push(extraComp);
            }
          }

          // Update Azure service workflow associations
          const azure = detectAzureService(p.label) || (p.alias !== p.label ? detectAzureService(p.alias) : null);
          if (azure) {
            const azSvc = azureServices.find(a => a.name === azure.name);
            if (azSvc && !azSvc.workflowIds.includes(wfId)) {
              azSvc.workflowIds.push(wfId);
            }
          }
        }
      }

      // Classify workflow Q1-Q8
      const classification = classifyWorkflow(diag, wfComponents, diagrams, workflows);

      workflows.push({
        id: wfId,
        name: deriveWorkflowName(diag.title),
        sourceDiagram: diag.title,
        flowType: classification.flowType,
        classification: classification.answers,
        userScore: classification.userScore,
        systemScore: classification.systemScore,
        participantAliases,
        interactions: diag.interactions,
        components: wfComponents,
        notes: [],
      });

      allInteractions.push(...diag.interactions);
    }

    // Attach interactions to components for context-aware failure mode inference
    for (var _di = 0; _di < diagrams.length; _di++) {
      var _diag = diagrams[_di];
      for (var _ii = 0; _ii < _diag.interactions.length; _ii++) {
        var _inter = _diag.interactions[_ii];
        var _fromP = _diag.participants.find(function(p) { return p.alias === _inter.from; });
        var _toP = _diag.participants.find(function(p) { return p.alias === _inter.to; });
        if (_fromP && _toP) {
          var _fromName = getComponentKey(_fromP.label, _fromP.alias);
          var _toName = getComponentKey(_toP.label, _toP.alias);
          var _fromComp = componentMap[_fromName];
          var _toComp = componentMap[_toName];
          if (_fromComp) {
            if (!_fromComp.interactions) _fromComp.interactions = [];
            _fromComp.interactions.push({ direction: 'outbound', neighbor: _toComp ? _toComp.normalizedName : _toName, label: _inter.label });
          }
          if (_toComp) {
            if (!_toComp.interactions) _toComp.interactions = [];
            _toComp.interactions.push({ direction: 'inbound', neighbor: _fromComp ? _fromComp.normalizedName : _fromName, label: _inter.label });
          }
        }
      }
    }

    const components = Object.values(componentMap);

    // Infer failure modes for each component
    for (const comp of components) {
      if (comp.category === 'User/External Actor') continue;
      comp.failureModes = inferFailureModes(comp, azureServices);
      comp.healthSignals = inferHealthSignals(comp, azureServices);
    }

    // Build dependencies
    const dependencies = buildDependencies(allInteractions, diagrams, componentMap);

    return {
      workflows,
      components,
      azureServices,
      dependencies,
      metadata: {
        diagramCount: diagrams.length,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  function deriveWorkflowName(title) {
    // Convert to snake_case action-oriented format
    let name = title
      .replace(/^Untitled\s*/i, '')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim()
      .replace(/\s+/g, '_')
      .toLowerCase();
    if (!name || name.length < 3) {
      name = title.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, '_').toLowerCase();
    }
    // Strip leading numeric prefixes like 2_, 5a_5b_, 03_, 12_
    name = name.replace(/^\d+[a-z]*(?:_\d+[a-z]*)*_/, '');
    // Remove trailing generic suffixes before re-adding
    name = name.replace(/_(workflow|process|flow|pipeline)$/i, '');
    // Append _flow suffix if no action suffix present
    if (name && !/_(flow|process|pipeline|ingestion|processing|setup|management|closeout)$/i.test(name)) {
      name = name + '_flow';
    }
    return name || 'workflow_' + Date.now().toString(36);
  }

  function classifyWorkflow(diagram, components, allDiagrams, existingWorkflows) {
    const hasUser = components.some(c => c.category === 'User/External Actor');
    const userParticipants = diagram.participants.filter(p => {
      const norm = normalizeEntityName(p.label);
      return components.find(c => c.normalizedName === norm && c.category === 'User/External Actor');
    });
    const userAliases = new Set(userParticipants.map(p => p.alias));

    const hasAltBlocks = diagram.blocks.some(b => b.type === 'alt');
    const hasLoopBlocks = diagram.blocks.some(b => b.type === 'loop');
    const hasAsync = diagram.interactions.some(i => i.arrowType === 'async');

    // Count non-user interactions
    const totalInteractions = diagram.interactions.length;
    const userInteractions = diagram.interactions.filter(i => userAliases.has(i.from) || userAliases.has(i.to)).length;
    const backendRatio = totalInteractions > 0 ? (totalInteractions - userInteractions) / totalInteractions : 1;

    // Check if user receives responses
    const userReceivesResponse = diagram.interactions.some(i => userAliases.has(i.to));

    // Check if first message is from a user
    const firstMsg = diagram.interactions[0];
    const firstFromUser = firstMsg ? userAliases.has(firstMsg.from) : false;

    // Check if this workflow outputs to others (cross-diagram check)
    const outputCompNames = new Set();
    const lastInteractions = diagram.interactions.slice(-3);
    lastInteractions.forEach(i => {
      const p = diagram.participants.find(pp => pp.alias === i.to);
      if (p) outputCompNames.add(normalizeEntityName(p.label));
    });
    const disruptsDownstream = allDiagrams.some(d => {
      if (d === diagram) return false;
      return d.participants.some(p => outputCompNames.has(normalizeEntityName(p.label)));
    });

    // Check for storage/db writes
    const hasStorageWrites = diagram.interactions.some(i => {
      const toP = diagram.participants.find(p => p.alias === i.to);
      if (!toP) return false;
      return /\b(storage|db|database|store|cosmos|sql|lake|zone)\b/i.test(toP.label);
    });

    // Q1-Q8 inference
    const answers = {
      q1: hasUser ? 'Yes' : 'No',
      q2: hasUser && userReceivesResponse ? 'Yes' : 'No',
      q3: !hasUser || backendRatio > 0.7 ? 'Yes' : 'No',
      q4: !firstFromUser && components.some(c => c.category === 'Platform Component') ? 'Yes' : 'No',
      q5: hasUser && hasAltBlocks ? 'Yes' : 'No',
      q6: disruptsDownstream ? 'Yes' : 'No',
      q7: hasUser ? 'Yes' : 'No',
      q8: hasLoopBlocks || hasAsync ? 'Yes' : 'No',
    };

    const y = v => v === 'Yes' ? 1 : 0;
    const userScore = y(answers.q1) + y(answers.q2) + y(answers.q5) + y(answers.q7);
    const systemScore = y(answers.q3) + y(answers.q4) + y(answers.q6) + y(answers.q8);
    let flowType;
    if (userScore > systemScore) flowType = 'User Flow';
    else if (systemScore > userScore) flowType = 'System Flow';
    else flowType = 'Review Needed';

    return { answers, userScore, systemScore, flowType };
  }

  // ============================================================
  // 5. INFERENCE ENGINES — FAILURE MODE CATALOGS
  // ============================================================

  // Azure Service Failure Mode Catalog — maps service name patterns to 3 most common failure modes
  // RPV ranges: Critical Azure services 60-100, Infrastructure 40-70
  var AZURE_FM_CATALOG = [
    {
      pattern: /azure sql|sql database|sql db/i,
      modes: [
        { mode: 'connection pool exhaustion', cause: 'application exceeds max concurrent connections under peak load', rpv: 60 },
        { mode: 'query timeout under load', cause: 'long-running queries exceed configured timeout during high concurrency', rpv: 48 },
        { mode: 'deadlock contention', cause: 'competing transactions hold conflicting locks causing circular wait', rpv: 45 },
      ]
    },
    {
      pattern: /cosmos\s*db/i,
      modes: [
        { mode: 'RU throttling (429)', cause: 'request unit consumption exceeds provisioned throughput', rpv: 60 },
        { mode: 'partition hot-spotting', cause: 'skewed partition key causes uneven load distribution on single partition', rpv: 75 },
        { mode: 'cross-partition query timeout', cause: 'fan-out query across all partitions exceeds timeout on large datasets', rpv: 48 },
      ]
    },
    {
      pattern: /data lake|adls|azure data lake/i,
      modes: [
        { mode: 'storage access denied / SAS token expiry', cause: 'RBAC misconfiguration or expired SAS token blocks data access', rpv: 45 },
        { mode: 'throughput throttling', cause: 'exceeds per-account or per-container IOPS/bandwidth limits', rpv: 48 },
        { mode: 'data corruption on write', cause: 'failed multi-part upload or concurrent write conflict corrupts file', rpv: 75 },
      ]
    },
    {
      pattern: /databricks/i,
      modes: [
        { mode: 'cluster startup failure', cause: 'quota limits, region capacity, or init script failure prevents cluster provisioning', rpv: 64 },
        { mode: 'job timeout / OOM', cause: 'Spark job exceeds timeout or driver/executor runs out of memory during large shuffle', rpv: 48 },
        { mode: 'notebook execution failure', cause: 'cell-level failure from library version conflict or missing dependency', rpv: 36 },
      ]
    },
    {
      pattern: /event\s*hub/i,
      modes: [
        { mode: 'message backlog / consumer lag', cause: 'slow consumers fall behind event retention window risking data loss', rpv: 64 },
        { mode: 'partition saturation', cause: 'event hub partition exceeds 1MB/s ingress limit causing producer throttling', rpv: 48 },
        { mode: 'dead-letter overflow', cause: 'unprocessable events accumulate exceeding entity size quota', rpv: 45 },
      ]
    },
    {
      pattern: /service\s*bus/i,
      modes: [
        { mode: 'message backlog / consumer lag', cause: 'consumers cannot keep pace with message arrival rate', rpv: 48 },
        { mode: 'partition saturation', cause: 'namespace hits messaging unit throughput limit', rpv: 45 },
        { mode: 'dead-letter overflow', cause: 'poison messages accumulate in DLQ exceeding entity size quota', rpv: 60 },
      ]
    },
    {
      pattern: /azure\s*function/i,
      modes: [
        { mode: 'cold start latency', cause: 'consumption plan instance takes 1-10s to warm up after idle period', rpv: 36 },
        { mode: 'execution timeout', cause: 'function exceeds configured timeout (5-10min default)', rpv: 48 },
        { mode: 'host scaling failure', cause: 'scale controller cannot provision instances fast enough for burst traffic', rpv: 45 },
      ]
    },
    {
      pattern: /api\s*management|apim/i,
      modes: [
        { mode: 'gateway timeout', cause: 'backend service response exceeds APIM forwarding timeout', rpv: 48 },
        { mode: 'rate limit breach', cause: 'client exceeds configured rate limit policy causing 429 responses', rpv: 36 },
        { mode: 'backend circuit break', cause: 'APIM circuit breaker trips after consecutive backend failures', rpv: 60 },
      ]
    },
    {
      pattern: /key\s*vault/i,
      modes: [
        { mode: 'secret access denied', cause: 'managed identity missing permissions or network rules blocking vault access', rpv: 64 },
        { mode: 'throttling under burst', cause: 'vault throttled at 4000 GET ops/10s during secret retrieval burst', rpv: 45 },
        { mode: 'certificate expiry', cause: 'TLS/SSL certificate not rotated before expiration causing downstream failures', rpv: 80 },
      ]
    },
    {
      pattern: /app\s*insight|application\s*insight|azure\s*monitor/i,
      modes: [
        { mode: 'telemetry ingestion delay', cause: 'high ingestion volume causes lag between event emission and query availability', rpv: 36 },
        { mode: 'sampling data loss', cause: 'adaptive sampling drops telemetry events under high load hiding failures', rpv: 45 },
        { mode: 'alert suppression', cause: 'alert rule misfiring or suppression window masking real incidents', rpv: 48 },
      ]
    },
    {
      pattern: /kubernetes|aks/i,
      modes: [
        { mode: 'pod eviction / OOMKill', cause: 'container exceeds memory limits triggering OOM kill and crash loop backoff', rpv: 60 },
        { mode: 'node pool scaling failure', cause: 'cluster autoscaler blocked by quota, subnet exhaustion, or VM availability', rpv: 64 },
        { mode: 'ingress routing failure', cause: 'ingress controller misconfiguration or cert issue causes 502/503 errors', rpv: 48 },
      ]
    },
    {
      pattern: /redis/i,
      modes: [
        { mode: 'cache eviction under memory pressure', cause: 'maxmemory reached triggers eviction of hot keys', rpv: 48 },
        { mode: 'connection limit exceeded', cause: 'client connections exceed tier limit causing rejection', rpv: 45 },
        { mode: 'failover latency', cause: 'primary-replica failover causes 10-20s connection interruption', rpv: 60 },
      ]
    },
    {
      pattern: /blob\s*storage|azure\s*blob/i,
      modes: [
        { mode: 'access tier transition delay', cause: 'rehydration from Archive tier takes up to 15 hours', rpv: 36 },
        { mode: 'concurrent write conflict', cause: 'multiple writers to same blob without ETag conditioning causes data loss', rpv: 60 },
        { mode: 'geo-replication lag', cause: 'RA-GRS replication delay causes stale reads from secondary region', rpv: 45 },
      ]
    },
    {
      pattern: /active\s*directory|azure\s*ad|entra\b|aad\b|ciam/i,
      modes: [
        { mode: 'token validation failure', cause: 'token issuer mismatch, clock skew, or expired signing key causes auth rejection', rpv: 75 },
        { mode: 'conditional access block', cause: 'policy change blocks legitimate users from compliant devices', rpv: 60 },
        { mode: 'MFA timeout', cause: 'MFA provider latency or unavailability blocks authentication flow', rpv: 48 },
      ]
    },
    {
      pattern: /front\s*door|cdn|content\s*delivery/i,
      modes: [
        { mode: 'origin health probe failure', cause: 'health probe misconfiguration marks healthy origins as down', rpv: 60 },
        { mode: 'SSL certificate mismatch', cause: 'custom domain certificate not matching or expired causing TLS errors', rpv: 64 },
        { mode: 'cache invalidation delay', cause: 'purge propagation delay serves stale content after deployment', rpv: 36 },
      ]
    },
    {
      pattern: /load\s*balancer/i,
      modes: [
        { mode: 'health probe failure', cause: 'probe misconfiguration removes healthy backends from rotation', rpv: 60 },
        { mode: 'SNAT port exhaustion', cause: 'outbound connections exhaust available SNAT ports causing connection failures', rpv: 64 },
        { mode: 'backend pool unavailable', cause: 'all backend instances fail health checks simultaneously', rpv: 75 },
      ]
    },
    {
      pattern: /data\s*factory|adf/i,
      modes: [
        { mode: 'pipeline execution failure', cause: 'activity timeout or integration runtime unavailable', rpv: 48 },
        { mode: 'data movement error', cause: 'copy activity fails from source schema drift or sink throttling', rpv: 45 },
        { mode: 'trigger misfire', cause: 'tumbling window or schedule trigger skips execution window', rpv: 36 },
      ]
    },
    {
      pattern: /app\s*service|web\s*app/i,
      modes: [
        { mode: 'instance health degradation', cause: 'app instance enters unhealthy state with elevated error rate', rpv: 48 },
        { mode: 'deployment slot swap failure', cause: 'slot swap times out or fails health check during warm-up', rpv: 45 },
        { mode: 'platform upgrade disruption', cause: 'underlying platform update causes brief unavailability', rpv: 36 },
      ]
    },
    {
      pattern: /storage\s*account|azure\s*storage/i,
      modes: [
        { mode: 'account throttling', cause: 'exceeds per-account IOPS or egress bandwidth limit', rpv: 48 },
        { mode: 'SAS token expiry', cause: 'shared access signature expires blocking application data access', rpv: 60 },
        { mode: 'firewall rule misconfiguration', cause: 'network rules block legitimate service access', rpv: 45 },
      ]
    },
    {
      pattern: /app.*gateway|application\s*gateway/i,
      modes: [
        { mode: 'WAF false positive', cause: 'web application firewall rule blocks legitimate traffic', rpv: 48 },
        { mode: 'backend health probe failure', cause: 'custom probe path returns non-200 marking backends unhealthy', rpv: 60 },
        { mode: 'SSL offloading error', cause: 'certificate chain incomplete or expired causing TLS handshake failure', rpv: 64 },
      ]
    },
    {
      pattern: /cognitive|ai\s*service|openai|azure\s*ai/i,
      modes: [
        { mode: 'model inference timeout', cause: 'large prompt or high concurrency exceeds API response timeout', rpv: 45 },
        { mode: 'rate limiting (429)', cause: 'tokens-per-minute or requests-per-minute quota exceeded', rpv: 48 },
        { mode: 'content filter block', cause: 'safety filter rejects legitimate content as harmful', rpv: 36 },
      ]
    },
    {
      pattern: /container\s*registry|acr/i,
      modes: [
        { mode: 'image pull failure', cause: 'registry throttling, auth failure, or image tag not found', rpv: 60 },
        { mode: 'geo-replication sync delay', cause: 'image not yet replicated to target region during deployment', rpv: 45 },
        { mode: 'webhook delivery failure', cause: 'registry webhook fails to notify downstream CI/CD pipeline', rpv: 36 },
      ]
    },
    {
      pattern: /virtual\s*network|vnet|private\s*endpoint/i,
      modes: [
        { mode: 'DNS resolution failure', cause: 'private DNS zone misconfiguration prevents name resolution', rpv: 64 },
        { mode: 'NSG rule conflict', cause: 'network security group rules block required traffic flow', rpv: 60 },
        { mode: 'peering connectivity loss', cause: 'VNet peering state changes to disconnected', rpv: 48 },
      ]
    },
    {
      pattern: /log\s*analytics/i,
      modes: [
        { mode: 'query timeout', cause: 'KQL query scans too much data exceeding workspace query limits', rpv: 36 },
        { mode: 'ingestion latency', cause: 'high volume causes delay between log emission and query availability', rpv: 45 },
        { mode: 'data cap reached', cause: 'daily ingestion cap stops log collection mid-day', rpv: 48 },
      ]
    },
    {
      pattern: /signalr|web\s*pubsub/i,
      modes: [
        { mode: 'connection limit reached', cause: 'concurrent WebSocket connections exceed tier limit', rpv: 48 },
        { mode: 'message delivery failure', cause: 'server-to-client message dropped due to client disconnect', rpv: 36 },
        { mode: 'hub scaling delay', cause: 'unit count increase takes minutes during traffic spike', rpv: 45 },
      ]
    },
    {
      pattern: /power\s*bi/i,
      modes: [
        { mode: 'dataset refresh failure', cause: 'data source credentials expired or gateway offline', rpv: 48 },
        { mode: 'report render timeout', cause: 'complex DAX query exceeds rendering timeout on large dataset', rpv: 36 },
        { mode: 'capacity throttling', cause: 'premium capacity saturated causing queued operations', rpv: 45 },
      ]
    },
  ];

  // Application Component Failure Mode Catalog — maps component role patterns to 3 failure modes
  // RPV range: 30-60 for application components
  var APP_FM_CATALOG = [
    {
      pattern: /data\s*process|etl|pipeline|transform|ingest|ingestion/i,
      modes: [
        { mode: 'transformation logic error', cause: 'data mapping or conversion rule produces incorrect output', rpv: 45 },
        { mode: 'data schema mismatch', cause: 'upstream schema change breaks expected column or type mapping', rpv: 48 },
        { mode: 'processing backlog', cause: 'input volume exceeds processing capacity causing queue buildup', rpv: 36 },
      ]
    },
    {
      pattern: /\bapi\b|gateway|endpoint|rest\b|graphql/i,
      modes: [
        { mode: 'request validation failure', cause: 'malformed payload or missing required fields rejected at validation layer', rpv: 36 },
        { mode: 'upstream dependency timeout', cause: 'backend service response time exceeds API timeout threshold', rpv: 48 },
        { mode: 'payload size exceeded', cause: 'request or response body exceeds configured size limit', rpv: 30 },
      ]
    },
    {
      pattern: /auth|security|identity|login|sso|oauth|token/i,
      modes: [
        { mode: 'credential validation failure', cause: 'identity provider returns error or user credentials incorrect', rpv: 60 },
        { mode: 'session expiry race condition', cause: 'concurrent requests during session refresh cause intermittent auth failures', rpv: 45 },
        { mode: 'brute force lockout', cause: 'automated attack triggers account lockout policy affecting legitimate users', rpv: 48 },
      ]
    },
    {
      pattern: /queue|worker|background|job\b|consumer/i,
      modes: [
        { mode: 'message processing failure', cause: 'worker throws unhandled exception on malformed message', rpv: 45 },
        { mode: 'poison message loop', cause: 'unprocessable message repeatedly dequeued and failed without dead-lettering', rpv: 48 },
        { mode: 'worker starvation', cause: 'all worker threads blocked on I/O leaving queue unprocessed', rpv: 36 },
      ]
    },
    {
      pattern: /\bcache\b|caching/i,
      modes: [
        { mode: 'cache stampede', cause: 'cache key expiry triggers simultaneous backend requests from all clients', rpv: 48 },
        { mode: 'stale data served', cause: 'cache TTL too long causes clients to receive outdated information', rpv: 36 },
        { mode: 'eviction under load', cause: 'memory pressure triggers eviction of frequently accessed keys', rpv: 45 },
      ]
    },
    {
      pattern: /client|frontend|ui\b|browser|portal|user\s*interface/i,
      modes: [
        { mode: 'rendering failure on edge browser', cause: 'unsupported CSS/JS feature causes layout break on older browsers', rpv: 30 },
        { mode: 'network timeout on slow connection', cause: 'API call times out on degraded network causing incomplete page load', rpv: 36 },
        { mode: 'state synchronization loss', cause: 'client-side state diverges from server after failed optimistic update', rpv: 45 },
      ]
    },
    {
      pattern: /report|dashboard|visualization|bi\b|insight|sharing/i,
      modes: [
        { mode: 'query timeout on large dataset', cause: 'aggregation query exceeds timeout on unbounded date range', rpv: 36 },
        { mode: 'render failure on complex charts', cause: 'browser memory exhaustion rendering thousands of data points', rpv: 30 },
        { mode: 'data freshness lag', cause: 'dashboard shows stale data due to refresh schedule or cache delay', rpv: 36 },
      ]
    },
    {
      pattern: /staging|intermediate|buffer|landing\s*zone|temp/i,
      modes: [
        { mode: 'buffer overflow', cause: 'incoming data rate exceeds staging area write capacity', rpv: 48 },
        { mode: 'data format mismatch between stages', cause: 'upstream stage outputs format incompatible with downstream expectations', rpv: 45 },
        { mode: 'cleanup race condition', cause: 'cleanup job deletes data still being read by downstream consumer', rpv: 36 },
      ]
    },
    {
      pattern: /integrat|external|connector|adapter|bridge|sync/i,
      modes: [
        { mode: 'connection timeout', cause: 'external system unresponsive or network path blocked', rpv: 48 },
        { mode: 'schema version mismatch', cause: 'external API schema changed without updating integration mapping', rpv: 45 },
        { mode: 'rate limiting by external API', cause: 'external provider enforces request quota causing 429 responses', rpv: 36 },
      ]
    },
    {
      pattern: /project|management|orchestrat|coordinat|planner|scheduler|workflow/i,
      modes: [
        { mode: 'workflow state corruption', cause: 'concurrent state updates cause workflow to enter invalid state', rpv: 48 },
        { mode: 'task dependency deadlock', cause: 'circular task dependencies prevent workflow progression', rpv: 45 },
        { mode: 'notification delivery failure', cause: 'notification service unavailable causing missed status updates', rpv: 30 },
      ]
    },
  ];

  // Decompose a target RPV into im/li/de scores (simplified FMA schema)
  function _rpvToScores(targetRpv, category) {
    var root = Math.cbrt(targetRpv);
    var impact = Math.min(5, Math.max(1, Math.round(root + 0.3)));
    var likelihood = Math.min(5, Math.max(1, Math.round(root)));
    var detectability = Math.min(5, Math.max(1, Math.round(targetRpv / Math.max(1, impact * likelihood))));
    var outageType = (category === 'Platform Component' || category === 'Azure Service') ? 2 : 1;
    return {
      im: impact,
      li: likelihood,
      de: detectability,
      outageType: outageType,
    };
  }

  function inferFailureModes(comp, azureServices) {
    var name = comp.normalizedName.toLowerCase();
    var azureSvc = azureServices.find(function(a) { return a.componentId === comp.id; });
    var baseModes = null;

    // 1. Match against Azure catalog first (for Platform/Azure Service components)
    if (azureSvc || comp.category === 'Azure Service' || comp.category === 'Platform Component') {
      var azSearchText = azureSvc ? azureSvc.name.toLowerCase() : name;
      for (var ci = 0; ci < AZURE_FM_CATALOG.length; ci++) {
        if (AZURE_FM_CATALOG[ci].pattern.test(azSearchText) || AZURE_FM_CATALOG[ci].pattern.test(name)) {
          baseModes = AZURE_FM_CATALOG[ci].modes.map(function(m) { return { mode: m.mode, cause: m.cause, rpv: m.rpv }; });
          break;
        }
      }
    }

    // 2. Match against Application catalog (for Application components)
    if (!baseModes && comp.category === 'Application Component') {
      for (var aj = 0; aj < APP_FM_CATALOG.length; aj++) {
        if (APP_FM_CATALOG[aj].pattern.test(name)) {
          baseModes = APP_FM_CATALOG[aj].modes.map(function(m) { return { mode: m.mode, cause: m.cause, rpv: m.rpv }; });
          break;
        }
      }
    }

    // 3. Cross-catalog fallthrough: try Azure catalog for any unmatched component
    if (!baseModes) {
      for (var ck = 0; ck < AZURE_FM_CATALOG.length; ck++) {
        if (AZURE_FM_CATALOG[ck].pattern.test(name)) {
          baseModes = AZURE_FM_CATALOG[ck].modes.map(function(m) { return { mode: m.mode, cause: m.cause, rpv: m.rpv }; });
          break;
        }
      }
    }

    // 4. Cross-catalog fallthrough: try App catalog for any unmatched component
    if (!baseModes) {
      for (var am = 0; am < APP_FM_CATALOG.length; am++) {
        if (APP_FM_CATALOG[am].pattern.test(name)) {
          baseModes = APP_FM_CATALOG[am].modes.map(function(m) { return { mode: m.mode, cause: m.cause, rpv: m.rpv }; });
          break;
        }
      }
    }

    // 5. Fallback — generic failure modes based on component category
    if (!baseModes) {
      if (comp.category === 'Platform Component' || comp.category === 'Azure Service') {
        baseModes = [
          { mode: 'service availability degradation', cause: comp.normalizedName + ' enters degraded state reducing throughput', rpv: 45 },
          { mode: 'configuration drift', cause: 'infrastructure configuration diverges from desired state after update', rpv: 36 },
          { mode: 'resource quota exhaustion', cause: 'consumption reaches subscription or resource quota limit', rpv: 48 },
        ];
      } else {
        baseModes = [
          { mode: 'unhandled exception', cause: 'unexpected input or state causes application error in ' + comp.normalizedName, rpv: 36 },
          { mode: 'dependency timeout', cause: 'downstream service response exceeds timeout threshold', rpv: 45 },
          { mode: 'data validation failure', cause: 'invalid or malformed data bypasses input validation in ' + comp.normalizedName, rpv: 30 },
        ];
      }
    }

    // 6. Interaction-aware enhancement — enrich failure mode context using neighbors
    var interactions = comp.interactions || [];
    if (interactions.length > 0) {
      var callers = [];
      var callees = [];
      for (var ni = 0; ni < interactions.length; ni++) {
        var inter = interactions[ni];
        if (inter.direction === 'inbound' && callers.indexOf(inter.neighbor) === -1) {
          callers.push(inter.neighbor);
        } else if (inter.direction === 'outbound' && callees.indexOf(inter.neighbor) === -1) {
          callees.push(inter.neighbor);
        }
      }
      for (var ei = 0; ei < baseModes.length; ei++) {
        var bm = baseModes[ei];
        if (callers.length >= 2 && /exhaust|throttl|saturat|overload|limit|pressure|backlog|stampede/i.test(bm.mode)) {
          bm.cause += ' under concurrent access from ' + callers.slice(0, 3).join(', ');
        }
        if (callees.length > 0 && /timeout|failure|error|unavail|corrupt|denied/i.test(bm.mode)) {
          bm.cause += '; impacts downstream ' + callees.slice(0, 2).join(', ');
        }
      }
    }

    // 7. Build exactly 3 failure mode objects in makeFM format for backward compatibility
    var result = [];
    for (var ri = 0; ri < 3 && ri < baseModes.length; ri++) {
      var fm = baseModes[ri];
      var scores = _rpvToScores(fm.rpv, comp.category);
      var fmObj = makeFM(fm.mode, scores.im, scores.li, scores.de,
        scores.outageType, null);
      fmObj.cause = fm.cause;
      fmObj.rpv = fm.rpv;
      fmObj.riskLevel = fm.rpv >= 100 ? 'Critical' : fm.rpv >= 50 ? 'High' : fm.rpv >= 30 ? 'Moderate' : 'Low';
      result.push(fmObj);
    }
    return result;
  }

  function makeFM(mode, im, li, de, outageType, docSource) {
    return {
      id: 'fm_' + Math.random().toString(36).substr(2, 8),
      mode,
      scores: { im, li, de, outageType },
      confidence: 'inferred',
      azureMCPSource: docSource || null,
    };
  }

  function inferHealthSignals(comp, azureServices) {
    const signals = [];
    const azureSvc = azureServices.find(a => a.componentId === comp.id);

    if (azureSvc) {
      switch (azureSvc.name) {
        case 'Azure Databricks':
          signals.push({ metric: 'Job execution time', threshold: '< 30 min', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Job failure rate', threshold: '< 5%', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Cluster utilization', threshold: '< 85%', alertRecommended: false, confidence: 'inferred' });
          break;
        case 'Azure Cosmos DB':
        case 'Azure SQL Database':
          signals.push({ metric: 'Request latency', threshold: '< 100ms', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Request charge (RU)', threshold: '< 80% provisioned', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Availability', threshold: '> 99.9%', alertRecommended: true, confidence: 'inferred' });
          break;
        case 'Azure Service Bus':
          signals.push({ metric: 'Queue depth', threshold: '< 1000', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Dead-letter count', threshold: '< 10', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Message throughput', threshold: '> 100/sec', alertRecommended: false, confidence: 'inferred' });
          break;
        case 'Azure Key Vault':
          signals.push({ metric: 'Secret retrieval latency', threshold: '< 200ms', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Access denied count', threshold: '< 5/hr', alertRecommended: true, confidence: 'inferred' });
          break;
        case 'Azure Data Lake Storage':
          signals.push({ metric: 'Storage access latency', threshold: '< 500ms', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Access error rate', threshold: '< 1%', alertRecommended: true, confidence: 'inferred' });
          break;
        case 'Azure Kubernetes Service':
          signals.push({ metric: 'Pod restart count', threshold: '< 3/hr', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'CPU utilization', threshold: '< 80%', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Memory utilization', threshold: '< 80%', alertRecommended: true, confidence: 'inferred' });
          break;
        default:
          signals.push({ metric: 'Availability', threshold: '> 99.9%', alertRecommended: true, confidence: 'inferred' });
          signals.push({ metric: 'Error rate', threshold: '< 1%', alertRecommended: true, confidence: 'inferred' });
      }
    } else if (comp.category === 'Application Component') {
      signals.push({ metric: 'Latency (p95)', threshold: '< 500ms', alertRecommended: true, confidence: 'inferred' });
      signals.push({ metric: 'Error rate', threshold: '< 1%', alertRecommended: true, confidence: 'inferred' });
      signals.push({ metric: 'Throughput', threshold: 'TBD', alertRecommended: false, confidence: 'inferred' });
    } else if (comp.category === 'Platform Component') {
      signals.push({ metric: 'Availability', threshold: '> 99.9%', alertRecommended: true, confidence: 'inferred' });
      signals.push({ metric: 'Error rate', threshold: '< 1%', alertRecommended: true, confidence: 'inferred' });
    }

    return signals;
  }

  // Mitigation inference map — Azure service-specific mitigations sourced from Well-Architected Framework
  const MITIGATION_MAP = {
    'timeout': { client: 'Retry with exponential backoff', infra: 'Circuit breaker', detection: 'Latency monitoring', recovery: 'Auto-retry, escalate after N failures', testType: 'Chaos' },
    'upstream timeout': { client: 'Set aggressive request timeouts with circuit breaker', infra: 'Upstream health probes, request hedging', detection: 'Dependency latency percentile alerts', recovery: 'Failover to cached response, degrade gracefully', testType: 'Chaos' },
    'authentication failure': { client: 'Token refresh, credential rotation', infra: 'Secret rotation, managed identity', detection: 'Auth failure rate alerts', recovery: 'Re-authenticate, rotate secrets', testType: 'Chaos' },
    'dependency unavailable': { client: 'Graceful degradation, cached response', infra: 'Redundant deployment, failover', detection: 'Health check endpoint', recovery: 'Failover to secondary, queue requests', testType: 'Chaos' },
    'queue backlog': { client: 'Backpressure signaling', infra: 'Auto-scaling consumers', detection: 'Queue depth monitoring', recovery: 'Scale out consumers, dead-letter review', testType: 'Load' },
    'throttling': { client: 'Adaptive rate limiting', infra: 'Auto-scaling, reserved capacity', detection: 'Request rate monitoring', recovery: 'Backoff and retry, scale up', testType: 'Load' },
    'storage access denied': { client: 'Retry, fallback storage', infra: 'IAM policy review, managed identity', detection: 'Access denied log alerts', recovery: 'Re-grant permissions, rotate keys', testType: 'Chaos' },
    'dropped message': { client: 'Idempotent replay', infra: 'Dead-letter queue, retry policy', detection: 'Message count monitoring', recovery: 'Replay from dead-letter, reconcile', testType: 'Chaos' },
    'API failure': { client: 'Retry with backoff, circuit breaker', infra: 'Load balancer health checks', detection: 'HTTP 5xx rate alerts', recovery: 'Restart service, failover', testType: 'Chaos' },
    'malformed payload': { client: 'Input validation, schema enforcement', infra: 'API gateway validation', detection: 'Validation error rate alerts', recovery: 'Reject and log, alert producer', testType: 'Chaos' },
    'compute unavailable': { client: 'Queue work for later processing', infra: 'Auto-scaling, multi-region', detection: 'Resource availability monitoring', recovery: 'Scale out, restart instances', testType: 'Chaos' },
    'job execution failure': { client: 'Retry job submission', infra: 'Job scheduling with retry policy', detection: 'Job status monitoring', recovery: 'Re-submit job, check dependencies', testType: 'Chaos' },
    'missing secret': { client: 'Graceful error handling', infra: 'Secret rotation alerts, backup vault', detection: 'Secret access failure alerts', recovery: 'Restore secret, rotate', testType: 'Chaos' },
    'secret retrieval failure': { client: 'Cache recent secrets locally with TTL', infra: 'Multi-region vault with private endpoints', detection: 'Vault latency + HTTP 429 throttling alerts', recovery: 'Retry with backoff, failover to secondary vault', testType: 'Chaos' },
    'data corruption': { client: 'Checksum validation', infra: 'Backup and versioning, immutable storage', detection: 'Data integrity checks', recovery: 'Restore from backup, reconcile', testType: 'Chaos' },
    'dead-letter overflow': { client: 'Backpressure, rate limiting', infra: 'Increase dead-letter capacity, alerts', detection: 'Dead-letter count monitoring', recovery: 'Process dead-letters, fix root cause', testType: 'Load' },
    'partial outage': { client: 'Graceful degradation', infra: 'Redundancy, failover routing', detection: 'Health endpoint monitoring', recovery: 'Failover to healthy replica', testType: 'Chaos' },
    'pod restart failure': { client: 'Queue requests during restart', infra: 'Pod disruption budgets, anti-affinity', detection: 'Pod restart count alerts', recovery: 'Reschedule pods, investigate OOM/crash', testType: 'Chaos' },
    'full outage': { client: 'Failover to DR site', infra: 'Multi-region deployment', detection: 'Availability monitoring', recovery: 'Activate DR, restore service', testType: 'Chaos' },
    // Azure Cosmos DB-specific mitigations
    'request rate exceeded (429)': { client: 'Implement retry with backoff using Cosmos SDK built-in retry', infra: 'Enable autoscale RU provisioning, optimize partition key', detection: 'Monitor NormalizedRUConsumption metric, alert at 70%', recovery: 'Scale up RU/s, redistribute hot partition workload', testType: 'Load' },
    'partition exhaustion': { client: 'Review partition key design, use synthetic keys if needed', infra: 'Redistribute data across partitions, increase max RU/s', detection: 'Monitor per-partition RU consumption via diagnostics', recovery: 'Migrate to better partition key, split hot partitions', testType: 'Load' },
    'consistency violation': { client: 'Use session consistency token for read-your-writes guarantee', infra: 'Choose bounded staleness or strong consistency for critical reads', detection: 'Monitor replication lag via ConsistentPrefixReadLatency', recovery: 'Retry reads against primary region, verify consistency level', testType: 'Chaos' },
    // Azure SQL-specific mitigations
    'DTU exhaustion': { client: 'Implement connection retry with SqlRetryLogicBaseProvider', infra: 'Scale to higher DTU tier or switch to vCore model, enable auto-pause', detection: 'Monitor DTU percentage metric, alert at 80% sustained', recovery: 'Scale up compute, identify and optimize resource-heavy queries', testType: 'Load' },
    'connection pool saturation': { client: 'Configure connection pool max size, use async/await patterns', infra: 'Enable connection draining, set connection timeout appropriately', detection: 'Monitor blocked_by_firewall and connection_failed events in sys.event_log', recovery: 'Restart connection pool, enable connection resiliency in client driver', testType: 'Load' },
    'geo-replication lag': { client: 'Accept eventual consistency for reads, route critical reads to primary', infra: 'Configure auto-failover groups with grace period', detection: 'Monitor replication_lag_sec metric on secondary databases', recovery: 'Force failover to secondary if primary unreachable, reconcile data', testType: 'Chaos' },
    // Azure Databricks-specific mitigations
    'cluster startup failure': { client: 'Queue jobs for retry when cluster unavailable', infra: 'Use instance pools for faster provisioning, configure auto-scaling pools', detection: 'Monitor cluster creation events and provisioning errors', recovery: 'Switch to alternate region or instance type, check Azure quota', testType: 'Chaos' },
    'job timeout': { client: 'Implement checkpointing for long-running Spark jobs', infra: 'Configure cluster auto-termination, optimize Spark configs (shuffle partitions)', detection: 'Monitor SparkListenerJobEnd events, set job-level timeouts', recovery: 'Restart from last checkpoint, reduce data partition size', testType: 'Load' },
    'notebook execution error': { client: 'Add cell-level error handling with try/except blocks', infra: 'Pin library versions in cluster init scripts, use conda environments', detection: 'Monitor notebook command status via Jobs API', recovery: 'Rollback to last known good library version, re-run failed cells', testType: 'Chaos' },
    // Azure Service Bus-specific mitigations
    'message lock expiry': { client: 'Renew message lock periodically during long processing', infra: 'Configure lock duration > max processing time, use sessions', detection: 'Monitor message redelivery count, alert on DeadLetteredMessages', recovery: 'Increase lock duration, reduce processing time, move to batch processing', testType: 'Load' },
    'queue throttling': { client: 'Implement client-side rate limiting with token bucket', infra: 'Scale to premium tier with more messaging units', detection: 'Monitor ServerBusy errors and throttled requests metric', recovery: 'Add messaging units, implement send-side backoff', testType: 'Load' },
    // Azure Key Vault-specific mitigations
    'certificate expiry': { client: 'Implement certificate refresh before expiry with buffer period', infra: 'Enable Key Vault certificate auto-renewal, configure near-expiry alerts', detection: 'Monitor ExpiringCertificates count, set 30-day expiry alerts', recovery: 'Manually renew certificate, rotate to new certificate version', testType: 'Chaos' },
    'access policy denied': { client: 'Verify managed identity has correct vault permissions at startup', infra: 'Use Azure RBAC instead of access policies, assign least-privilege roles', detection: 'Monitor Key Vault audit logs for Unauthorized events', recovery: 'Grant missing permissions via az keyvault set-policy, restart app', testType: 'Chaos' },
    // Azure Data Lake Storage-specific mitigations
    'node pool scaling failure': { client: 'Implement pod scheduling retries with backoff', infra: 'Pre-provision node pools, set min node count above baseline', detection: 'Monitor cluster-autoscaler pending pod count', recovery: 'Manually scale node pool, check subnet IP space and quota', testType: 'Chaos' },
    // Event Hubs-specific mitigations
    'throughput throttling': { client: 'Batch events, implement send retry with backoff', infra: 'Increase throughput units or use auto-inflate, add partitions', detection: 'Monitor ThrottledRequests and IncomingBytes metrics', recovery: 'Scale up throughput units, redistribute partition load', testType: 'Load' },
    'consumer group lag': { client: 'Use checkpointing with frequent commit intervals', infra: 'Scale out consumer instances, extend event retention period', detection: 'Monitor PartitionCurrentOffset vs EndSequenceNumber delta', recovery: 'Reset consumer offset to latest, add consumer instances', testType: 'Load' },
    // Azure Data Factory-specific mitigations
    'pipeline execution failure': { client: 'Add retry policies on pipeline activities', infra: 'Monitor integration runtime health, use self-hosted IR failover', detection: 'Configure ADF alerts on pipeline failure runs', recovery: 'Rerun failed pipeline from failure point, check linked service connectivity', testType: 'Chaos' },
    'data movement error': { client: 'Enable fault tolerance in copy activities, log skipped rows', infra: 'Add schema drift handling, configure staging for large copies', detection: 'Monitor copy activity rows read vs written discrepancy', recovery: 'Fix schema mapping, rerun copy from last successful batch', testType: 'Chaos' },
    'query timeout': { client: 'Optimize query execution, add pagination', infra: 'Increase query timeout, add read replicas', detection: 'Query duration monitoring, slow query log alerts', recovery: 'Kill long-running queries, failover to read replica', testType: 'Load' },
    'component failure': { client: 'Circuit breaker with fallback response', infra: 'Health probes, auto-restart policies', detection: 'Error rate monitoring, synthetic probes', recovery: 'Restart service, route to healthy instances', testType: 'Chaos' },
    'processing failure': { client: 'Dead-letter failed items for retry, validate input schema', infra: 'Scale processing workers, add input validation layer', detection: 'Processing error rate and queue depth monitoring', recovery: 'Replay from dead-letter, fix transformation logic', testType: 'Chaos' },
    'integration routing failure': { client: 'Fallback routing rules, retry with alternate endpoint', infra: 'Redundant integration paths, load-balanced routing', detection: 'Route failure rate monitoring, message delivery tracking', recovery: 'Reroute to secondary path, flush and replay queued messages', testType: 'Chaos' },
    'data validation failure': { client: 'Schema validation at ingress, reject and notify upstream', infra: 'Data quality rules engine, schema registry', detection: 'Validation rejection rate alerts, data quality dashboards', recovery: 'Quarantine invalid records, notify data producers', testType: 'Chaos' },
    'orchestration failure': { client: 'Implement saga pattern with compensating transactions', infra: 'Durable workflow engine, state checkpointing', detection: 'Workflow step duration and failure rate monitoring', recovery: 'Resume from last checkpoint, rollback partial changes', testType: 'Chaos' },
    'ingestion pipeline failure': { client: 'Buffer incoming data, retry submission with backoff', infra: 'Multi-path ingestion, dead-letter for failed records', detection: 'Ingestion throughput and error rate monitoring', recovery: 'Replay from source, reprocess failed batches', testType: 'Chaos' },
    'completion failure': { client: 'Retry finalization, preserve intermediate state', infra: 'Idempotent completion logic, state machine enforcement', detection: 'Incomplete workflow monitoring, stale state alerts', recovery: 'Re-trigger completion step, manual reconciliation', testType: 'Chaos' },
    'analytics computation failure': { client: 'Cache last-known-good results, show stale data warning', infra: 'Pre-computed aggregates, materialized views', detection: 'Computation duration and error rate monitoring', recovery: 'Recompute from source data, clear cached aggregates', testType: 'Load' },
    'service disruption': { client: 'Circuit breaker with cached fallback response', infra: 'Auto-restart policies, health probe endpoints', detection: 'Availability and error rate monitoring', recovery: 'Restart service, route traffic to healthy instances', testType: 'Chaos' },
    // New catalog-aligned mitigations (v3.3.0)
    'connection pool exhaustion': { client: 'Configure connection pool max size, use async patterns', infra: 'Enable connection draining, set appropriate timeout', detection: 'Monitor active connections vs pool limit', recovery: 'Restart connection pool, scale up database tier', testType: 'Load' },
    'query timeout under load': { client: 'Optimize queries, add query timeout configuration', infra: 'Add read replicas, scale compute tier', detection: 'Slow query log alerts, query duration p99 monitoring', recovery: 'Kill long-running queries, redirect to read replica', testType: 'Load' },
    'deadlock contention': { client: 'Order lock acquisition consistently, use shorter transactions', infra: 'Enable deadlock detection, set lock timeout', detection: 'Monitor deadlock count metric, alert on deadlock events', recovery: 'Kill blocking session, retry transaction', testType: 'Load' },
    'ru throttling (429)': { client: 'Use Cosmos SDK built-in retry with backoff', infra: 'Enable autoscale RU provisioning, optimize partition key', detection: 'Monitor NormalizedRUConsumption, alert at 70%', recovery: 'Scale up RU/s, redistribute hot partition workload', testType: 'Load' },
    'partition hot-spotting': { client: 'Review partition key design, use synthetic keys', infra: 'Redistribute data across partitions, increase max RU/s', detection: 'Monitor per-partition RU consumption', recovery: 'Migrate to better partition key, split hot partitions', testType: 'Load' },
    'cross-partition query timeout': { client: 'Add partition key filter to queries, paginate results', infra: 'Increase RU/s, use materialized views', detection: 'Monitor cross-partition query count and duration', recovery: 'Add composite indexes, refactor query to single-partition', testType: 'Load' },
    'storage access denied / sas token expiry': { client: 'Implement token refresh before expiry', infra: 'Use managed identity instead of SAS, configure RBAC', detection: 'Monitor AuthorizationFailure events', recovery: 'Regenerate SAS token, grant missing RBAC role', testType: 'Chaos' },
    'throughput throttling': { client: 'Implement client-side rate limiting', infra: 'Scale up tier, distribute across accounts', detection: 'Monitor throttled request count', recovery: 'Scale out storage accounts, enable request queuing', testType: 'Load' },
    'data corruption on write': { client: 'Enable checksum validation, use conditional writes', infra: 'Enable versioning, immutable storage policies', detection: 'Data integrity check alerts', recovery: 'Restore from snapshot, reconcile data', testType: 'Chaos' },
    'job timeout / oom': { client: 'Implement checkpointing, reduce batch size', infra: 'Increase driver/executor memory, optimize shuffle', detection: 'Monitor Spark job duration and OOM events', recovery: 'Restart from checkpoint, reduce partition size', testType: 'Load' },
    'notebook execution failure': { client: 'Add cell-level try/except, pin library versions', infra: 'Use conda environments, cluster init scripts', detection: 'Monitor notebook command status via Jobs API', recovery: 'Rollback to known good library version', testType: 'Chaos' },
    'message backlog / consumer lag': { client: 'Scale consumer instances, optimize processing', infra: 'Auto-scale consumers, increase retention period', detection: 'Monitor consumer lag and queue depth', recovery: 'Add consumer instances, reset offset if needed', testType: 'Load' },
    'partition saturation': { client: 'Distribute messages across partitions', infra: 'Add partitions, scale up messaging units', detection: 'Monitor per-partition throughput', recovery: 'Rebalance partition assignment, scale tier', testType: 'Load' },
    'cold start latency': { client: 'Use pre-warmed instances, keep-alive pings', infra: 'Switch to Premium/Dedicated plan, enable always-on', detection: 'Monitor cold start duration and frequency', recovery: 'Pre-warm instances, switch to Premium plan', testType: 'Load' },
    'execution timeout': { client: 'Break work into smaller chunks, use Durable Functions', infra: 'Increase timeout setting, use Premium plan', detection: 'Monitor function execution duration', recovery: 'Retry failed execution, increase timeout limit', testType: 'Load' },
    'host scaling failure': { client: 'Queue excess requests for retry', infra: 'Pre-provision instances, set minimum instance count', detection: 'Monitor scale controller decisions and errors', recovery: 'Manually scale instances, switch to Premium plan', testType: 'Load' },
    'gateway timeout': { client: 'Set appropriate client timeouts, retry with backoff', infra: 'Increase APIM timeout, optimize backend response time', detection: 'Monitor gateway response time and 504 errors', recovery: 'Restart backend, scale backend instances', testType: 'Chaos' },
    'rate limit breach': { client: 'Implement client-side rate limiting, cache responses', infra: 'Increase rate limit policy thresholds, add caching', detection: 'Monitor 429 response rate from APIM', recovery: 'Adjust rate limit policy, whitelist client if legitimate', testType: 'Load' },
    'backend circuit break': { client: 'Implement fallback response, serve cached data', infra: 'Configure circuit breaker thresholds, add redundant backends', detection: 'Monitor circuit breaker state changes', recovery: 'Reset circuit breaker, restore backend health', testType: 'Chaos' },
    'secret access denied': { client: 'Verify managed identity permissions at startup', infra: 'Use RBAC, assign least-privilege roles', detection: 'Monitor Key Vault audit logs for Unauthorized events', recovery: 'Grant missing permissions, restart application', testType: 'Chaos' },
    'throttling under burst': { client: 'Cache secrets locally with TTL, batch requests', infra: 'Multi-region vault, implement secret caching layer', detection: 'Monitor vault HTTP 429 throttling count', recovery: 'Retry with backoff, failover to secondary vault', testType: 'Load' },
    'telemetry ingestion delay': { client: 'Buffer telemetry with local persistent queue', infra: 'Scale ingestion infrastructure, use streaming ingestion', detection: 'Monitor ingestion latency metric', recovery: 'Clear ingestion backlog, verify endpoint connectivity', testType: 'Load' },
    'sampling data loss': { client: 'Configure fixed-rate sampling for critical telemetry', infra: 'Increase daily cap, use ingestion sampling over adaptive', detection: 'Monitor sampled vs total event counts', recovery: 'Reduce sampling rate, switch to fixed-rate sampling', testType: 'Load' },
    'alert suppression': { client: 'Configure redundant alert channels (email + Teams + PagerDuty)', infra: 'Review alert suppression rules, reduce aggregation window', detection: 'Monitor alert rule evaluation failures', recovery: 'Re-enable suppressed alerts, reduce suppression window', testType: 'Chaos' },
    'pod eviction / oomkill': { client: 'Set appropriate resource requests/limits', infra: 'Enable pod disruption budgets, use quality-of-service guaranteed', detection: 'Monitor pod restart count and OOMKilled events', recovery: 'Increase memory limits, optimize application memory usage', testType: 'Chaos' },
    'ingress routing failure': { client: 'Implement client-side retries, health-check endpoints', infra: 'Configure ingress controller redundancy, validate TLS certs', detection: 'Monitor ingress controller 502/503 error rate', recovery: 'Restart ingress controller, verify backend service health', testType: 'Chaos' },
    'cache eviction under memory pressure': { client: 'Handle cache miss gracefully, implement fallback to database', infra: 'Scale cache tier, configure maxmemory-policy', detection: 'Monitor evicted keys count and memory usage', recovery: 'Scale up cache tier, tune TTL and eviction policies', testType: 'Load' },
    'connection limit exceeded': { client: 'Implement connection pooling, use connection multiplexing', infra: 'Scale to higher tier, enable clustering', detection: 'Monitor connected clients count vs limit', recovery: 'Close idle connections, scale cache tier', testType: 'Load' },
    'failover latency': { client: 'Implement retry logic for transient connection errors', infra: 'Use zone-redundant deployment, enable active geo-replication', detection: 'Monitor failover events and connection reset count', recovery: 'Reconnect clients, verify data consistency after failover', testType: 'Chaos' },
    'token validation failure': { client: 'Implement token refresh before expiry, handle clock skew', infra: 'Configure token validation parameters, enable OIDC discovery', detection: 'Monitor authentication failure rate', recovery: 'Force token refresh, update signing key cache', testType: 'Chaos' },
    'conditional access block': { client: 'Provide clear error messaging to users', infra: 'Audit conditional access policies before deployment', detection: 'Monitor blocked sign-in events in Entra logs', recovery: 'Adjust CA policy, grant exception if legitimate', testType: 'Chaos' },
    'mfa timeout': { client: 'Implement MFA retry with fallback authentication method', infra: 'Configure MFA provider redundancy, increase timeout', detection: 'Monitor MFA completion rate and latency', recovery: 'Fallback to alternate MFA method, bypass temporarily for emergency', testType: 'Chaos' },
    'snat port exhaustion': { client: 'Use connection pooling, reduce outbound connection count', infra: 'Configure outbound rules with more SNAT ports, use NAT Gateway', detection: 'Monitor SNAT connection count and failed connections', recovery: 'Recycle connections, add NAT Gateway', testType: 'Load' },
    'health probe failure': { client: 'Implement responsive health endpoints', infra: 'Configure probe interval and threshold correctly', detection: 'Monitor backend health status changes', recovery: 'Fix health probe path, restart unhealthy backends', testType: 'Chaos' },
    'backend pool unavailable': { client: 'Implement retry with failover to alternate region', infra: 'Multi-region deployment, cross-region load balancing', detection: 'Monitor backend pool health percentage', recovery: 'Restore backend instances, failover to secondary region', testType: 'Chaos' },
    'trigger misfire': { client: 'Implement idempotent pipeline design', infra: 'Configure tumbling window retry policy, enable concurrency control', detection: 'Monitor trigger execution history for missed windows', recovery: 'Manually trigger missed runs, backfill data', testType: 'Chaos' },
    // Application component mitigations (v3.3.0)
    'transformation logic error': { client: 'Add unit tests for transformation rules, validate output schema', infra: 'Data quality rules engine, schema validation layer', detection: 'Output data quality score monitoring', recovery: 'Rollback to previous transformation version, reprocess', testType: 'Chaos' },
    'data schema mismatch': { client: 'Implement schema evolution handling, version contracts', infra: 'Schema registry with compatibility checks', detection: 'Schema validation failure rate alerts', recovery: 'Update schema mapping, reprocess failed records', testType: 'Chaos' },
    'processing backlog': { client: 'Implement backpressure signaling, prioritize critical items', infra: 'Auto-scale processing workers, increase batch size', detection: 'Queue depth and processing lag monitoring', recovery: 'Scale out workers, skip non-critical items', testType: 'Load' },
    'request validation failure': { client: 'Implement comprehensive input validation, return clear errors', infra: 'API gateway validation rules, schema enforcement', detection: 'Validation rejection rate alerts', recovery: 'Fix validation rules, notify API consumers', testType: 'Chaos' },
    'upstream dependency timeout': { client: 'Set aggressive timeouts, implement circuit breaker', infra: 'Upstream health probes, request hedging', detection: 'Dependency latency percentile alerts', recovery: 'Failover to cached response, degrade gracefully', testType: 'Chaos' },
    'payload size exceeded': { client: 'Implement chunked upload, validate size before send', infra: 'Configure appropriate size limits, use streaming', detection: 'Monitor 413 response rate', recovery: 'Increase limit if legitimate, implement pagination', testType: 'Chaos' },
    'credential validation failure': { client: 'Implement token refresh, credential rotation', infra: 'Managed identity, secret rotation automation', detection: 'Auth failure rate and pattern alerts', recovery: 'Re-authenticate, rotate credentials', testType: 'Chaos' },
    'session expiry race condition': { client: 'Implement sliding expiration, pre-emptive refresh', infra: 'Distributed session store with atomic operations', detection: 'Monitor concurrent session refresh failures', recovery: 'Force re-authentication, clear stale sessions', testType: 'Chaos' },
    'brute force lockout': { client: 'Implement progressive delays, CAPTCHA after failures', infra: 'IP-based rate limiting, account lockout with self-service unlock', detection: 'Failed login attempt spike alerts', recovery: 'Unlock legitimate accounts, block attacking IPs', testType: 'Chaos' },
    'message processing failure': { client: 'Implement dead-letter queue, idempotent processing', infra: 'Poison message handling with DLQ review', detection: 'Processing error rate and DLQ depth monitoring', recovery: 'Fix processor, replay from dead-letter queue', testType: 'Chaos' },
    'poison message loop': { client: 'Set max delivery count, move to dead-letter after N failures', infra: 'Configure dead-letter queue with alerting', detection: 'Monitor message delivery count and DLQ growth', recovery: 'Remove poison message, fix processing logic', testType: 'Chaos' },
    'worker starvation': { client: 'Implement async I/O, avoid blocking calls in workers', infra: 'Auto-scale workers, separate I/O-bound from CPU-bound', detection: 'Monitor active vs idle worker count', recovery: 'Restart workers, increase concurrency limit', testType: 'Load' },
    'cache stampede': { client: 'Implement cache-aside with jittered TTL', infra: 'Use lock-based cache refresh, stale-while-revalidate', detection: 'Monitor cache miss spike correlation with backend load', recovery: 'Pre-warm cache, implement probabilistic early refresh', testType: 'Load' },
    'stale data served': { client: 'Display data freshness indicator to users', infra: 'Reduce cache TTL, implement cache invalidation events', detection: 'Monitor data age vs freshness SLA', recovery: 'Force cache invalidation, refresh from source', testType: 'Chaos' },
    'eviction under load': { client: 'Handle cache miss gracefully, prioritize hot keys', infra: 'Scale cache memory, configure eviction policy', detection: 'Monitor eviction rate and memory pressure', recovery: 'Scale up cache, reduce working set', testType: 'Load' },
    'buffer overflow': { client: 'Implement backpressure, reject excess input', infra: 'Auto-scale staging capacity, configure overflow handling', detection: 'Monitor staging area utilization', recovery: 'Scale storage, process backlog', testType: 'Load' },
    'data format mismatch between stages': { client: 'Validate data format at stage boundaries', infra: 'Schema validation between pipeline stages', detection: 'Format validation failure alerts', recovery: 'Fix format conversion, reprocess failed records', testType: 'Chaos' },
    'cleanup race condition': { client: 'Use lease/lock before cleanup, coordinate with consumers', infra: 'Implement TTL-based cleanup with safety margin', detection: 'Monitor data access during cleanup windows', recovery: 'Restore deleted data from backup, extend retention', testType: 'Chaos' },
    'connection timeout': { client: 'Set appropriate timeout, retry with backoff', infra: 'Health check external endpoints, configure fallback', detection: 'External dependency latency monitoring', recovery: 'Failover to cached data, retry connection', testType: 'Chaos' },
    'schema version mismatch': { client: 'Implement schema version negotiation', infra: 'Schema registry with backward compatibility checks', detection: 'Monitor schema validation errors', recovery: 'Update integration mapping, reprocess failed records', testType: 'Chaos' },
    'rate limiting by external api': { client: 'Implement request throttling, use caching', infra: 'Request queue with rate limiting, negotiate higher quota', detection: 'Monitor external API 429 response rate', recovery: 'Reduce request rate, use cached responses', testType: 'Load' },
    'workflow state corruption': { client: 'Use saga pattern with compensating transactions', infra: 'Durable workflow engine with state checkpointing', detection: 'Workflow state consistency alerts', recovery: 'Reset workflow to last valid state, replay events', testType: 'Chaos' },
    'task dependency deadlock': { client: 'Implement cycle detection in dependency graph', infra: 'Configure task timeout, deadlock detection', detection: 'Monitor stuck workflows and circular dependencies', recovery: 'Break circular dependency, restart blocked tasks', testType: 'Chaos' },
    'notification delivery failure': { client: 'Implement retry with fallback notification channel', infra: 'Multi-channel notification with dead-letter handling', detection: 'Monitor notification delivery rate', recovery: 'Retry failed notifications, use alternate channel', testType: 'Chaos' },
    // Fallback generic mitigations (v3.3.0)
    'service availability degradation': { client: 'Circuit breaker with fallback response', infra: 'Multi-instance deployment, health probe endpoints', detection: 'Availability and throughput monitoring', recovery: 'Restart degraded instances, scale out', testType: 'Chaos' },
    'configuration drift': { client: 'Validate configuration at startup', infra: 'Infrastructure as Code, configuration auditing', detection: 'Configuration compliance monitoring', recovery: 'Re-apply desired configuration, rollback changes', testType: 'Chaos' },
    'resource quota exhaustion': { client: 'Implement graceful degradation when quota reached', infra: 'Request quota increase, enable auto-scaling', detection: 'Monitor resource consumption vs quota limits', recovery: 'Increase quota, reduce resource consumption', testType: 'Load' },
    'unhandled exception': { client: 'Implement global error handler, structured logging', infra: 'Process isolation, auto-restart on crash', detection: 'Exception rate monitoring, crash dump analysis', recovery: 'Restart process, investigate and fix root cause', testType: 'Chaos' },
    'dependency timeout': { client: 'Set timeouts, circuit breaker with fallback', infra: 'Health probes, request hedging', detection: 'Dependency latency monitoring', recovery: 'Failover to cached response, degrade gracefully', testType: 'Chaos' },
  };

  function inferMitigations(failureMode) {
    const key = failureMode.toLowerCase();
    // Try exact match first, then prefix match (for descriptive failure modes like "timeout — ...")
    if (MITIGATION_MAP[key]) return MITIGATION_MAP[key];
    const prefix = key.split(' — ')[0].split(' - ')[0].trim();
    if (MITIGATION_MAP[prefix]) return MITIGATION_MAP[prefix];
    return {
      client: 'Review Needed',
      infra: 'Review Needed',
      detection: 'Review Needed',
      recovery: 'Review Needed',
      testType: 'Chaos',
    };
  }

  function buildDependencies(interactions, diagrams, componentMap) {
    const deps = [];
    const seen = new Set();
    for (const diag of diagrams) {
      for (const inter of diag.interactions) {
        const fromP = diag.participants.find(p => p.alias === inter.from);
        const toP = diag.participants.find(p => p.alias === inter.to);
        if (fromP && toP) {
          const fromName = normalizeEntityName(fromP.label);
          const toName = normalizeEntityName(toP.label);
          const key = fromName + '→' + toName;
          if (!seen.has(key)) {
            seen.add(key);
            deps.push({ from: fromName, to: toName, type: inter.arrowType });
          }
        }
      }
    }
    return deps;
  }

  // ============================================================
  // 6. PHASE POPULATION LOGIC
  // ============================================================

  function _uid() {
    return typeof uid === 'function' ? uid() : Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function populateP1(system) {
    return {
      wf: system.workflows.map(w => {
        const imp = inferImpact(w);
        const lik = inferLikelihood(w);
        const det = inferDetectability(w);
        const rpv = imp * lik * det;
        const rl = rpv >= 50 ? 'High' : rpv >= 30 ? 'Moderate' : 'Low';
        const fo = rl === 'High' ? 'Critical' : 'Non-Critical';

        return {
          id: _uid(),
          _src: 'auto',
          nm: w.name,
          ft: w.flowType,
          imp: imp,
          lik: lik,
          det: det,
          rpv: rpv,
          rl: rl,
          fo: fo,
          rb: '',
          st: '',
        };
      }),
    };
  }

  function inferImpact(workflow) {
    const downstreamCount = workflow.components.filter(c => c.workflowIds.length > 1).length;
    const hasUser = workflow.components.some(c => c.category === 'User/External Actor');
    let score = 2;
    if (downstreamCount >= 4) score = 4;
    else if (downstreamCount >= 2) score = 3;
    if (hasUser) score = Math.min(5, score + 1);
    if (workflow.components.some(c => c.workflowIds.length >= 3)) score = Math.min(5, score + 1);
    return Math.max(1, Math.min(5, score));
  }

  function inferLikelihood(workflow) {
    let score = 2;
    if (workflow.interactions.some(i => i.arrowType === 'async')) score++;
    if (workflow.components.some(c => c.category === 'User/External Actor')) score++;
    const altCount = workflow.interactions.filter(i => i.parentBlock).length;
    if (altCount > 2) score++;
    return Math.max(1, Math.min(5, score));
  }

  function inferDetectability(workflow) {
    // Default moderate
    return 3;
  }



  function populateP2(system) {
    const fm = [];
    for (const comp of system.components) {
      if (comp.category === 'User/External Actor') continue;
      
      // Determine workflow(s) for this component
      const workflowNames = comp.workflowIds.map(wid => {
        const w = system.workflows.find(ww => ww.id === wid);
        return w ? w.name : null;
      }).filter(Boolean);
      
      // For components in multiple workflows, create one failure mode record per workflow
      if (workflowNames.length === 0) {
        // Fallback: component not mapped to any workflow — add without wf
        for (const mode of comp.failureModes) {
          fm.push({
            id: _uid(),
            _src: 'inferred',
            wf: '',
            ct: comp.category === 'Azure Service' ? 'Platform' : (comp.category === 'Platform Component' ? 'Platform' : 'Application'),
            cn: comp.normalizedName,
            fn: mode.mode,
            im: mode.scores.im, li: mode.scores.li, de: mode.scores.de,
            os: mode.scores.outageType,
            rpv: 0, rl: '',
          });
        }
      } else {
        // Create failure mode records for each workflow the component participates in
        for (const wfName of workflowNames) {
          for (const mode of comp.failureModes) {
            fm.push({
              id: _uid(),
              _src: 'inferred',
              wf: wfName,
              ct: comp.category === 'Azure Service' ? 'Platform' : (comp.category === 'Platform Component' ? 'Platform' : 'Application'),
              cn: comp.normalizedName,
              fn: mode.mode,
              im: mode.scores.im, li: mode.scores.li, de: mode.scores.de,
              os: mode.scores.outageType,
              rpv: 0, rl: '',
            });
          }
        }
      }
    }
    // Calculate RPV using simplified im * li * de * os formula
    fm.forEach(f => {
      const o = f.os || 0;
      if (o === 0) { f.rpv = 0; f.rl = 'Not a Risk'; return; }
      f.rpv = f.im * f.li * f.de * o;
      f.rl = f.rpv >= 100 ? 'Critical' : f.rpv >= 50 ? 'High' : f.rpv >= 30 ? 'Moderate' : 'Low';
    });
    return { fm };
  }

  function populateP3(system, failureModes) {
    // Group failure modes by workflow + source component so shared components get
    // independent mitigation entries per workflow (fixes cross-workflow dedup bug)
    const byWfComp = {};
    failureModes
      .filter(fm => fm.rl !== 'Not a Risk')
      .forEach(fm => {
        const key = (fm.wf || '') + '|' + fm.cn;
        if (!byWfComp[key]) byWfComp[key] = [];
        byWfComp[key].push(fm);
      });

    const mt = Object.keys(byWfComp).map(groupKey => {
      const fms = byWfComp[groupKey];
      const compName = fms[0].cn;
      // Sort by RPV descending, use highest-risk entry as primary
      fms.sort((a, b) => (b.rpv || 0) - (a.rpv || 0));
      const primary = fms[0];
      const comp = system.components.find(c => c.normalizedName === compName);
      const azureSvc = comp ? system.azureServices.find(a => a.componentId === comp.id) : null;

      // Consolidate all failure mode names
      const allModes = fms.map(f => f.fn).filter(Boolean);
      const fmDesc = allModes.length > 1 ? allModes.join('; ') : allModes[0] || '';

      // Consolidate mitigations from all failure modes — use service-aware lookup
      const allMitigations = fms.map(f => inferMitigations(f.fn));
      const consolidate = (field) => {
        const vals = allMitigations.map(m => m[field]).filter(Boolean);
        const unique = vals.filter((v, i) => vals.indexOf(v) === i);
        return unique.join('; ') || 'Review Needed';
      };

      // Find impacted workflows
      const wi = comp ? comp.workflowIds.map(wid => {
        const w = system.workflows.find(ww => ww.id === wid);
        return w ? w.name : null;
      }).filter(Boolean).join(', ') : '';

      // Dependent components — include Azure service type context
      const depComponents = comp ? system.dependencies
        .filter(d => d.from === comp.normalizedName || d.to === comp.normalizedName)
        .map(d => d.from === comp.normalizedName ? d.to : d.from)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 3) : [];
      const dc = depComponents.join(', ');

      // Cascading impact — unique per component based on service type and dependency count
      let ci;
      if (comp && comp.workflowIds.length > 1) {
        if (azureSvc) {
          ci = 'High — ' + azureSvc.name + ' failure cascades across ' + comp.workflowIds.length + ' workflows' +
               (depComponents.length > 0 ? ', impacting ' + depComponents.slice(0, 2).join(' and ') : '');
        } else {
          ci = 'High — shared across ' + comp.workflowIds.length + ' workflows' +
               (depComponents.length > 0 ? ', directly affects ' + depComponents.slice(0, 2).join(' and ') : '');
        }
      } else if (depComponents.length > 2) {
        ci = 'Medium — single workflow but ' + depComponents.length + ' downstream dependencies';
      } else if (azureSvc) {
        ci = 'Low — ' + azureSvc.name + ' isolated to single workflow with limited blast radius';
      } else {
        ci = 'Low — isolated to single workflow';
      }

      // Determine test type based on failure mode characteristics
      let tt = allMitigations[0] ? (allMitigations[0].testType || 'Chaos') : 'Chaos';
      // If the primary failure mode is load/capacity related, use Load test
      if (/throttl|exhaust|saturation|backlog|capacity|rate exceeded/i.test(fmDesc)) {
        tt = 'Load';
      }

      return {
        id: _uid(),
        _src: 'inferred',
        wf: fms[0].wf || '',
        sc: compName,
        fm: fmDesc,
        wi,
        dc,
        ci,
        cm: consolidate('client'),
        im: consolidate('infra'),
        dm: consolidate('detection'),
        rp: consolidate('recovery'),
        is: 'Not Started',
        ow: 'Unassigned',
      };
    });
    return { mt };
  }

  function populateP3Extra(failureModes, mitigations) {
    // Validate: check for duplicate failure modes that suggest generic fallback contamination
    const fmSet = new Set();
    const uniqueFailureModes = [];
    for (const m of mitigations) {
      if (m.fm && !fmSet.has(m.fm)) {
        fmSet.add(m.fm);
        uniqueFailureModes.push(m);
      }
    }

    return {
      ct: uniqueFailureModes.map(m => {
        return {
          id: _uid(),
          _src: 'inferred',
          wf: m.wf || '',
          fm: m.fm,
          ts: 'Inject ' + (m.fm.split(' — ')[0] || m.fm) + ' on ' + m.sc,
          it: m.fm,
          tc: m.sc,
          eb: 'System detects failure via ' + (m.dm ? m.dm.substring(0, 60) : 'monitoring') + ', ' + (m.rp ? m.rp.substring(0, 60) : 'recovers gracefully'),
          ab: 'Pending',
          rt: 'TBD',
          re: 'Pending',
          ob: '',
          to: 'Unassigned',
        };
      }),
      vr: failureModes.filter(fm => fm.rl !== 'Not a Risk').map(fm => ({
        id: _uid(),
        _src: 'inferred',
        wf: fm.wf || '',
        fm: fm.fn,
        co: fm.cn,
        rl: fm.rl,
        te: 'No',
        va: 'No',
        da: 'Unknown',
        me: 'Unknown',
        rs: 'Unknown',
        st: 'Not Started',
        ir: '',
      })),
    };
  }

  function inferBusinessFunction(workflow) {
    const name = workflow.name.toLowerCase();
    if (/ingestion|ingest/i.test(name)) return 'Data Ingestion';
    if (/analytic|report|sharing/i.test(name)) return 'Data Analytics & Reporting';
    if (/process|transform|engine|obie/i.test(name)) return 'Data Processing';
    if (/manage|project|setup/i.test(name)) return 'Project Management';
    if (/content/i.test(name)) return 'Content Management';
    if (/conclude|close/i.test(name)) return 'Engagement Closeout';
    if (/auth|login/i.test(name)) return 'Authentication';
    if (/payment|order/i.test(name)) return 'Transaction Processing';
    return 'Business Operations';
  }

  // ═══════════════════════════════════════════════════════════════
  // SIGNAL SUGGESTION ENGINE
  // Maps failure mode names → appropriate health signals + thresholds
  // ═══════════════════════════════════════════════════════════════

  function _suggestSignal(failureModeName, componentName, componentCategory) {
    var fm = failureModeName.toLowerCase();
    var cn = componentName.toLowerCase();

    // Azure service-specific patterns (check first — more specific)
    var azurePatterns = [
      { test: /cosmos/i,            signal: 'RU consumption %',         threshold: '< 80%' },
      { test: /sql.*database/i,     signal: 'DTU utilization %',        threshold: '< 85%' },
      { test: /databricks/i,        signal: 'Cluster state',            threshold: '= Running' },
      { test: /data.*lake|adls|storage/i, signal: 'Storage availability %', threshold: '> 99.9%' },
      { test: /service.*bus/i,      signal: 'Dead letter queue depth',  threshold: '< 100' },
      { test: /event.*hub/i,        signal: 'Incoming throughput lag',   threshold: '< 1000' },
      { test: /key.*vault/i,        signal: 'Access latency (ms)',      threshold: '< 200' },
    ];

    for (var i = 0; i < azurePatterns.length; i++) {
      if (azurePatterns[i].test.test(cn)) {
        return { signal: azurePatterns[i].signal, threshold: azurePatterns[i].threshold };
      }
    }

    // Failure mode pattern matching (17 patterns)
    var fmPatterns = [
      { test: /startup|boot|init|provision/,          signal: 'Service availability',       threshold: '= Running' },
      { test: /connection.*pool|connection.*saturat/,  signal: 'Active connections %',       threshold: '< 90%' },
      { test: /timeout|latency|slow/,                 signal: 'Latency (p95)',              threshold: '< 500ms' },
      { test: /corrupt|integrity|checksum/,           signal: 'Data integrity error rate',  threshold: '< 0.1%' },
      { test: /capacity|full|overflow|exhaust/,       signal: 'Resource utilization %',     threshold: '< 85%' },
      { test: /throttl|rate.*limit/,                  signal: 'Throttle rate',              threshold: '< 1%' },
      { test: /failover|replicat|sync/,               signal: 'Replication lag',            threshold: '< 5s' },
      { test: /auth|permission|access.*denied/,       signal: 'Auth failure rate',          threshold: '< 0.5%' },
      { test: /queue|backlog|dead.*letter/,           signal: 'Queue depth',                threshold: '< 1000' },
      { test: /memory|oom|heap/,                      signal: 'Memory utilization %',       threshold: '< 85%' },
      { test: /cpu|compute/,                          signal: 'CPU utilization %',          threshold: '< 80%' },
      { test: /disk|\bstorage\b|\bio\b/,                      signal: 'Disk IOPS utilization %',    threshold: '< 80%' },
      { test: /network|dns|routing/,                  signal: 'Network error rate',         threshold: '< 0.1%' },
      { test: /certif|ssl|tls|expir/,                signal: 'Certificate expiry days',    threshold: '> 30' },
      { test: /orchestrat|pipeline|workflow|process/,  signal: 'Pipeline success rate',      threshold: '> 95%' },
      { test: /ingestion|ingest|import/,              signal: 'Ingestion success rate',     threshold: '> 99%' },
      { test: /disrupt|outage|unavail|down/,          signal: 'Service availability %',     threshold: '> 99.9%' },
    ];

    for (var j = 0; j < fmPatterns.length; j++) {
      if (fmPatterns[j].test.test(fm)) {
        return { signal: fmPatterns[j].signal, threshold: fmPatterns[j].threshold };
      }
    }

    // Fallback
    return { signal: 'Service health check', threshold: '= Healthy' };
  }

  function deriveBizFuncName(workflowName) {
    return workflowName
      .replace(/_flow$/, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  function populateP4(system) {
    // Many-to-many health model: components appear under every workflow that uses them,
    // parented via the dependency graph (who calls this component in this workflow).
    const he = []; // Health Entities
    const pr = []; // Performance Report

    // --- Phase 1: Build relationship indexes ---

    // Reverse lookup: component normalizedName → [workflow objects that use it]
    const compToWorkflows = {};
    for (var ci = 0; ci < system.components.length; ci++) {
      var comp = system.components[ci];
      compToWorkflows[comp.normalizedName] = (comp.workflowIds || []).map(function(wfId) {
        return system.workflows.find(function(w) { return w.id === wfId; });
      }).filter(Boolean);
    }

    // Dependency index: target component → [source components that call it]
    const calledBy = {};
    for (var di = 0; di < system.dependencies.length; di++) {
      var dep = system.dependencies[di];
      if (!calledBy[dep.to]) calledBy[dep.to] = [];
      if (calledBy[dep.to].indexOf(dep.from) === -1) calledBy[dep.to].push(dep.from);
    }

    // --- Phase 2: Create Workflow + BizFunc entities ---

    for (var wi = 0; wi < system.workflows.length; wi++) {
      var w = system.workflows[wi];

      // Workflow entity
      he.push({
        id: _uid(), _src: 'auto', et: 'Workflow',
        en: w.name, pa: '', wf: w.name,
        mn: '', th: '', cv: '', hs: 'Unknown', tr: '', at: '',
        ui: inferImpact(w), bi: 0, ac: 0, pd: 0, ws: 0, vs: '',
        fmId: '', fmName: '', nt: ''
      });

      // User/System Workflow entity (1 per workflow, top-level in swimlane)
      var bfName = deriveBizFuncName(w.name);
      he.push({
        id: _uid(), _src: 'inferred', et: 'User/System Workflow',
        en: bfName, pa: '', wf: w.name,
        mn: '', th: '', cv: '', hs: 'Unknown', tr: '', at: '',
        ui: 3, bi: 0, ac: 0, pd: 0, ws: 0, vs: '',
        fmId: '', fmName: '', nt: ''
      });

      // Performance Report entry
      pr.push({
        id: _uid(), _src: 'inferred', wf: w.name,
        ts: 'End-to-end ' + w.name, ct: w.name,
        mm: 'Latency (p95)', pl: 'TBD', ov: 'Unknown', th: 'TBD',
        pf: 'Pending', dn: 'Unknown',
        rm: 'Auto-populated — thresholds require configuration'
      });
    }

    // --- Phase 3: Create component entities per (workflow, parent, component) relationship ---

    for (var cj = 0; cj < system.components.length; cj++) {
      var comp = system.components[cj];
      if (comp.category === 'User/External Actor') continue;

      var et = (comp.category === 'Platform Component' || comp.category === 'Azure Service')
        ? 'Platform' : 'Application';

      var workflows = compToWorkflows[comp.normalizedName] || [];

      for (var wj = 0; wj < workflows.length; wj++) {
        var wf = workflows[wj];

        // Derive parent from dependency graph: who calls this component in this workflow?
        var allCallers = calledBy[comp.normalizedName] || [];
        var callers = allCallers.filter(function(caller) {
          var callerComp = system.components.find(function(c) { return c.normalizedName === caller; });
          return callerComp && callerComp.workflowIds && callerComp.workflowIds.indexOf(wf.id) !== -1;
        });

        // Derive parent based on strict layer rules
        // Application → parent is User/System Workflow for this workflow
        // Platform → parent is first Application caller from dependency graph
        var bfNameForWf = deriveBizFuncName(wf.name);
        var parent;
        if (et === 'Application') {
          parent = bfNameForWf;
        } else {
          // Platform: find first Application caller from calledBy
          var appCallerCandidates = allCallers.filter(function(caller) {
            var callerComp = system.components.find(function(c) { return c.normalizedName === caller; });
            return callerComp && callerComp.category !== 'Platform Component' && callerComp.category !== 'Azure Service';
          });
          parent = appCallerCandidates.length > 0 ? appCallerCandidates[0] : '';
        }

        he.push({
          id: _uid(), _src: 'auto', et: et,
          en: comp.normalizedName, pa: parent, wf: wf.name,
          mn: '', th: '', cv: '', hs: 'Unknown', tr: '', at: '',
          ui: 3, bi: 0, ac: 0, pd: 0, ws: 0, vs: '',
          fmId: '', fmName: '', nt: ''
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Auto-link failure modes as Signal sub-rows
    // ═══════════════════════════════════════════════════════════════

    for (var wk = 0; wk < system.workflows.length; wk++) {
      var wfObj = system.workflows[wk];
      var wfComps = wfObj.components.filter(function(c) {
        return c.category !== 'User/External Actor';
      });

      for (var ck = 0; ck < wfComps.length; ck++) {
        var fmComp = wfComps[ck];
        if (!fmComp.failureModes || fmComp.failureModes.length === 0) continue;

        var fmEt = (fmComp.category === 'Platform Component' || fmComp.category === 'Azure Service')
          ? 'Platform' : 'Application';

        // Find the entity row for this component (already created above)
        var entityRow = null;
        for (var ek = 0; ek < he.length; ek++) {
          if (he[ek].en === fmComp.normalizedName &&
              he[ek].wf === wfObj.name &&
              he[ek].et === fmEt) {
            entityRow = he[ek];
            break;
          }
        }

        if (!entityRow) continue;

        // Clear mn/th/fmId/fmName on entity row — these belong on Signal sub-rows
        entityRow.mn = '';
        entityRow.th = '';
        entityRow.fmId = '';
        entityRow.fmName = '';

        // Set Impact on entity row using highest FM severity
        var maxImpact = 2;
        for (var fi2 = 0; fi2 < fmComp.failureModes.length; fi2++) {
          var fmRpv = fmComp.failureModes[fi2].rpv || 0;
          if (!fmRpv && fmComp.failureModes[fi2].scores) {
            fmRpv = (fmComp.failureModes[fi2].scores.impact || 1) *
                     (fmComp.failureModes[fi2].scores.likelihood || 1) *
                     (fmComp.failureModes[fi2].scores.detectability || 1);
          }
          var fmImpact = fmRpv >= 50 ? 4 : fmRpv >= 30 ? 3 : 2;
          if (fmImpact > maxImpact) maxImpact = fmImpact;
        }
        entityRow.ui = maxImpact;

        // Create Signal sub-rows — one per failure mode
        for (var fk = 0; fk < fmComp.failureModes.length; fk++) {
          var fm = fmComp.failureModes[fk];
          var fmId = fmComp.normalizedName + '|' + fm.mode;
          var suggestion = _suggestSignal(fm.mode, fmComp.normalizedName, fmComp.category);

          he.push({
            id: _uid(),
            _src: 'auto',
            et: 'Signal',
            en: fmComp.normalizedName,
            pa: fmComp.normalizedName,
            wf: wfObj.name,
            mn: suggestion.signal,
            th: suggestion.threshold,
            cv: '',
            hs: '',
            tr: '',
            at: '',
            ui: 0,
            bi: 0, ac: 0, pd: 0,
            ws: 0, vs: '',
            fmId: fmId,
            fmName: fm.mode,
            nt: ''
          });
        }
      }
    }

    // Auto-assign parents enforcing strict layer rules
    // User/System Workflow = top-level (no parent), App → User/System Workflow, Platform → App
    for (var ai = 0; ai < he.length; ai++) {
      var ae = he[ai];
      if (ae.et === 'Signal' || ae.et === 'Workflow') continue;
      var awf = ae.wf;
      if (!awf) continue;
      if (ae.et === 'User/System Workflow') {
        // Top-level — clear any parent
        if (ae.pa) ae.pa = '';
      } else if (ae.et === 'Application') {
        // Validate parent is a User/System Workflow; if not, reassign
        var currentParentIsWf = ae.pa && he.find(function(p) {
          return p.et === 'User/System Workflow' && p.en === ae.pa && p.wf === awf;
        });
        if (!currentParentIsWf) {
          var abf = he.find(function(p) { return p.et === 'User/System Workflow' && p.wf === awf; });
          ae.pa = abf ? abf.en : '';
        }
      } else if (ae.et === 'Platform') {
        // Validate parent is an Application; if not, reassign
        var currentParentIsApp = ae.pa && he.find(function(p) {
          return p.et === 'Application' && p.en === ae.pa && p.wf === awf;
        });
        if (!currentParentIsApp) {
          // Use dependency graph: find the App that calls this Platform
          var platformCallers = calledBy[ae.en] || [];
          var callerApp = null;
          for (var pci = 0; pci < platformCallers.length; pci++) {
            callerApp = he.find(function(p) {
              return p.et === 'Application' && p.en === platformCallers[pci] && p.wf === awf;
            });
            if (callerApp) break;
          }
          if (callerApp) {
            ae.pa = callerApp.en;
          } else {
            // Fallback: first App in same workflow
            var aapp = he.find(function(p) { return p.et === 'Application' && p.wf === awf; });
            ae.pa = aapp ? aapp.en : '';
          }
        }
      }
    }

    // Store dependency index on window for AP4() reuse
    if (typeof window !== 'undefined') {
      window._hmCalledBy = calledBy;
    }

    return { he, pr };
  }

  function populateP5(system) {
    const today = new Date().toISOString().split('T')[0];
    return {
      md: system.workflows.map(w => ({
        id: _uid(),
        _src: 'auto',
        wf: w.name,
        hs: 'Unknown',
        cs: 'Review Needed',
        fs: 'Pending',
        da: 'Review Needed',
        oa: '0',
        am: 'No',
        lu: today,
      })),
      gv: [
        { id: _uid(), _src: 'auto', ar: 'FMA Review', ow: 'Unassigned', fr: 'Quarterly', af: 'Phase 2 Failure Modes, Phase 3 Mitigations', op: 'Updated FMA scores and mitigation status' },
        { id: _uid(), _src: 'auto', ar: 'Health Model Review', ow: 'Unassigned', fr: 'Monthly', af: 'Phase 4 Health Model', op: 'Health model alignment report' },
        { id: _uid(), _src: 'auto', ar: 'Resilience Validation', ow: 'Unassigned', fr: 'Quarterly', af: 'Phase 3 Chaos Tests, Validation Report', op: 'Resilience test results and gap analysis' },
        { id: _uid(), _src: 'auto', ar: 'Monitoring Dashboard Review', ow: 'Unassigned', fr: 'Weekly', af: 'Phase 5 Dashboard, Open Alerts', op: 'Triage report, alert tuning recommendations' },
      ],
    };
  }

  // ============================================================
  // 7. AZURE MCP ENRICHMENT (OPTIONAL)
  // ============================================================

  function isAzureMCPAvailable() {
    return typeof window !== 'undefined' && typeof window._azureMCPSearch === 'function';
  }

  async function enrichWithAzureMCP(system, phase3Data, phase4Data) {
    if (!isAzureMCPAvailable()) {
      return { phase3Data, phase4Data, enriched: false };
    }
    // Hook for future MCP enrichment — returns unchanged data if not implemented
    try {
      for (const azSvc of system.azureServices) {
        // Phase 3 enrichment
        const p3Results = await window._azureMCPSearch(azSvc.name + ' failure modes reliability');
        if (p3Results && p3Results.results) {
          // Enrichment would add documented failure modes here
          // Mark as "Inferred from Azure Documentation via Azure MCP"
        }
        // Phase 4 enrichment
        const p4Results = await window._azureMCPSearch(azSvc.name + ' resilience best practices mitigation');
        if (p4Results && p4Results.results) {
          // Enrichment would enhance mitigations here
        }
      }
      return { phase3Data, phase4Data, enriched: true };
    } catch (e) {
      console.warn('Azure MCP enrichment failed, continuing without:', e.message);
      return { phase3Data, phase4Data, enriched: false };
    }
  }

  // ============================================================
  // 8. STATE COORDINATOR — Dual-mode merge with conflict detection
  // ============================================================

  // Conflict queue stored on the module; shown via conflict resolution UI
  var _pendingConflicts = [];

  function populate(classifiedSystem) {
    if (typeof S === 'undefined' || typeof sv !== 'function') {
      throw new Error('FMA Framework app not loaded — global S and sv() required');
    }

    const p1 = populateP1(classifiedSystem);
    const p2 = populateP2(classifiedSystem);
    const p3 = populateP3(classifiedSystem, p2.fm);
    const p3_extra = populateP3Extra(p2.fm, p3.mt);
    const p4 = populateP4(classifiedSystem);
    const p5 = populateP5(classifiedSystem);

    var added = { wf: 0, fm: 0, mt: 0, ct: 0, vr: 0, he: 0, pr: 0, md: 0, gv: 0 };
    var skipped = { wf: 0, fm: 0, mt: 0, ct: 0, vr: 0, he: 0, pr: 0, md: 0, gv: 0 };
    var conflicts = 0;
    _pendingConflicts = [];

    /**
     * Merge with conflict awareness:
     * - If no existing match → add (new entry)
     * - If existing match has _src='manual' → flag conflict, don't overwrite
     * - If existing match has _src='auto'/'inferred'/undefined → backfill empty fields, skip if nothing to fill
     */
    var merge = function (target, source, keyFn, label, phase, forceOverwrite) {
      for (var i = 0; i < source.length; i++) {
        var item = source[i];
        var k = keyFn(item);
        var existing = null;
        for (var j = 0; j < target.length; j++) {
          if (keyFn(target[j]) === k) { existing = target[j]; break; }
        }
        if (!existing) {
          target.push(item);
          added[label]++;
        } else if (existing._src === 'manual' && !forceOverwrite) {
          // Conflict: existing is manual, don't overwrite
          _pendingConflicts.push({
            phase: phase,
            key: k,
            existingId: existing.id,
            existing: Object.assign({}, existing),
            incoming: Object.assign({}, item),
            resolved: false,
          });
          conflicts++;
        } else {
          // Backfill + force-overwrite for richer incoming values
          for (var key in item) {
            if (key === 'id' || key === '_src') continue;
            var inVal = item[key];
            var exVal = existing[key];
            if (inVal !== '' && inVal !== null && inVal !== undefined) {
              if (exVal === '' || exVal === null || exVal === undefined) {
                existing[key] = inVal;
              } else if (forceOverwrite && typeof inVal === 'string' && typeof exVal === 'string' && inVal.length > exVal.length) {
                existing[key] = inVal;
              }
            }
          }
          if (!existing._src) existing._src = item._src || 'auto';
          skipped[label]++;
        }
      }
    };

    merge(S.p1.wf, p1.wf, function(i){return i.nm;}, 'wf', 'P1');
    merge(S.p2.fm, p2.fm, function(i){return i.wf + '|' + i.cn + '|' + i.fn;}, 'fm', 'P2');
    merge(S.p3.mt, p3.mt, function(i){return i.wf + '|' + i.sc;}, 'mt', 'P3');
    merge(S.p3.ct, p3_extra.ct, function(i){return i.wf + '|' + i.fm + '|' + i.tc;}, 'ct', 'P3');
    merge(S.p3.vr, p3_extra.vr, function(i){return i.wf + '|' + i.fm + '|' + i.co;}, 'vr', 'P3');
    
    // P4: Merge entity-based health model and performance report
    merge(S.p4.he, p4.he, function(i){
      if (i.et === 'Signal') {
        return i.wf + '|Signal|' + i.en + '|' + (i.fmId || i.mn);
      }
      return i.wf + '|' + i.et + '|' + i.en;
    }, 'he', 'P4');
    merge(S.p4.pr, p4.pr, function(i){return i.ts;}, 'pr', 'P4');
    
    // P5: Governance (was P6)
    merge(S.p5.md, p5.md, function(i){return i.wf;}, 'md', 'P5');
    merge(S.p5.gv, p5.gv, function(i){return i.ar;}, 'gv', 'P5');

    // Recalculate scores
    S.p1.wf.forEach(function(w) { if (typeof calcP1 === 'function') calcP1(w); });
    S.p2.fm.forEach(function(f) { if (typeof calcP2 === 'function') calcP2(f); });
    // calcP4 now operates on entity rows - will be called from UI on workflow entities
    if (typeof calcP4 === 'function') {
      S.p4.he.filter(function(e){ return e.et === 'Workflow'; }).forEach(calcP4);
    }

    sv();

    return {
      added: Object.values(added).reduce(function(a, b){return a + b;}, 0),
      skipped: Object.values(skipped).reduce(function(a, b){return a + b;}, 0),
      conflicts: conflicts,
      detail: added,
    };
  }

  // Clear all auto/inferred entries from all phases (preserves manual entries)
  function clearAutoPopulated() {
    if (typeof S === 'undefined') return;
    var arrays = [
      S.p1.wf, S.p2.fm, S.p3.mt, S.p3.ct, S.p3.vr,
      S.p4.he, S.p4.pr, S.p5.md, S.p5.gv,
    ];
    var cleared = 0;
    for (var a = 0; a < arrays.length; a++) {
      var arr = arrays[a];
      for (var i = arr.length - 1; i >= 0; i--) {
        if (arr[i]._src === 'auto' || arr[i]._src === 'inferred') {
          arr.splice(i, 1);
          cleared++;
        }
      }
    }
    if (typeof sv === 'function') sv();
    return cleared;
  }

  // Resolve a single conflict — apply incoming auto data over existing manual
  function resolveConflict(index, action) {
    if (index < 0 || index >= _pendingConflicts.length) return;
    var conflict = _pendingConflicts[index];
    if (conflict.resolved) return;

    if (action === 'keep') {
      // Keep existing manual — nothing to do
      conflict.resolved = true;
    } else if (action === 'replace') {
      // Replace with incoming auto data
      var allArrays = [
        S.p1.wf, S.p2.fm, S.p3.mt, S.p3.ct, S.p3.vr,
        S.p4.he, S.p4.pr, S.p5.md, S.p5.gv,
      ];
      for (var a = 0; a < allArrays.length; a++) {
        var arr = allArrays[a];
        for (var j = 0; j < arr.length; j++) {
          if (arr[j].id === conflict.existingId) {
            // Preserve id, replace all other fields from incoming
            var preserved = arr[j].id;
            Object.assign(arr[j], conflict.incoming);
            arr[j].id = preserved;
            break;
          }
        }
      }
      conflict.resolved = true;
      sv();
    }
  }

  function resolveAllConflicts(action) {
    for (var i = 0; i < _pendingConflicts.length; i++) {
      if (!_pendingConflicts[i].resolved) resolveConflict(i, action);
    }
    if (typeof RP === 'function') RP(S.cp);
  }

  function showConflictUI() {
    if (_pendingConflicts.length === 0) return;
    var unresolved = _pendingConflicts.filter(function(c){return !c.resolved;});
    if (unresolved.length === 0) return;

    var html = '<div style="max-height:60vh;overflow-y:auto">' +
      '<p style="color:var(--text2);margin-bottom:12px">' + unresolved.length +
      ' item(s) already exist with manual edits. Choose which values to keep:</p>';

    for (var i = 0; i < _pendingConflicts.length; i++) {
      var c = _pendingConflicts[i];
      if (c.resolved) continue;
      var existingLabel = c.existing.nm || c.existing.fn || c.existing.fm || c.existing.wf || c.existing.cn || c.existing.ar || c.key;
      html += '<div class="card" style="padding:12px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><strong>' + c.phase + ':</strong> ' + existingLabel +
        ' <span class="src-tag src-manual">✏️ manual</span> vs <span class="src-tag src-auto">🤖 auto</span></div>' +
        '<div style="display:flex;gap:4px">' +
        '<button class="btn btn-secondary btn-sm" onclick="SeqImport.resolveConflict(' + i + ',\'keep\');this.closest(\'.card\').style.opacity=0.4;this.closest(\'.card\').querySelector(\'.conflict-result\').textContent=\'✅ Kept manual\'">Keep Manual</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="SeqImport.resolveConflict(' + i + ',\'replace\');this.closest(\'.card\').style.opacity=0.4;this.closest(\'.card\').querySelector(\'.conflict-result\').textContent=\'🤖 Used auto\'">Use Auto</button>' +
        '</div></div><span class="conflict-result" style="font-size:.75rem;color:var(--text3)"></span></div>';
    }

    html += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
      '<button class="btn btn-secondary btn-sm" onclick="SeqImport.resolveAllConflicts(\'keep\');HM()">Keep All Manual</button>' +
      '<button class="btn btn-primary btn-sm" onclick="SeqImport.resolveAllConflicts(\'replace\');HM()">Use All Auto</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="HM();RP(S.cp)">Done</button></div></div>';

    if (typeof SM === 'function') SM('⚠️ Conflicts Found — ' + unresolved.length + ' item(s)', html);
  }

  // ============================================================
  // 9. MARKDOWN OUTPUT GENERATOR
  // ============================================================

  function toMarkdown(system) {
    const lines = [];
    const ln = (s) => lines.push(s || '');
    const tbl = (headers, rows) => {
      ln('| ' + headers.join(' | ') + ' |');
      ln('| ' + headers.map(() => '---').join(' | ') + ' |');
      rows.forEach(r => ln('| ' + r.join(' | ') + ' |'));
    };

    const ufCount = system.workflows.filter(w => w.flowType === 'User Flow').length;
    const sfCount = system.workflows.filter(w => w.flowType === 'System Flow').length;
    const appComps = system.components.filter(c => c.category === 'Application Component').length;
    const platComps = system.components.filter(c => c.category === 'Platform Component' || c.category === 'Azure Service').length;

    // Executive Summary
    ln('# FMA Auto-Population Report');
    ln('## Generated from Sequence Diagrams');
    ln('');
    ln('## Executive Summary');
    ln('- **Diagrams Analyzed:** ' + system.metadata.diagramCount);
    ln('- **Workflows Identified:** ' + system.workflows.length + ' (' + ufCount + ' User Flows, ' + sfCount + ' System Flows)');
    ln('- **Components Identified:** ' + system.components.length + ' (' + appComps + ' Application, ' + platComps + ' Platform/Azure)');
    ln('- **Azure Services:** ' + (system.azureServices.length > 0 ? system.azureServices.map(a => a.name).join(', ') : 'None detected'));
    ln('- **Generated:** ' + system.metadata.generatedAt);
    ln('');

    // Identified Workflows
    ln('## Identified Workflows');
    tbl(['#', 'Workflow Name', 'Flow Type', 'Source Diagram', 'Components'],
      system.workflows.map((w, i) => [
        String(i + 1), w.name, w.flowType, w.sourceDiagram,
        w.components.map(c => c.normalizedName).slice(0, 5).join(', ') + (w.components.length > 5 ? '...' : '')
      ]));
    ln('');

    // Identified Components
    ln('## Identified Components and Azure Services');
    tbl(['Component', 'Category', 'Workflows', 'Azure Service?'],
      system.components.map(c => [
        c.normalizedName, c.category,
        c.workflowIds.map(wid => { const w = system.workflows.find(ww => ww.id === wid); return w ? w.name : ''; }).filter(Boolean).join(', '),
        system.azureServices.find(a => a.componentId === c.id) ? system.azureServices.find(a => a.componentId === c.id).name : 'No'
      ]));
    ln('');

    // Phase 1
    ln('## Phase 1: Workflow Classification');
    tbl(['Flow Name', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'User Score', 'System Score', 'Flow Type', 'Notes'],
      system.workflows.map(w => [
        w.name,
        w.classification.q1, w.classification.q2, w.classification.q3, w.classification.q4,
        w.classification.q5, w.classification.q6, w.classification.q7, w.classification.q8,
        String(w.userScore), String(w.systemScore), w.flowType, 'Inferred from diagram'
      ]));
    ln('');

    // Phase 2
    ln('## Phase 2: Failure Mode Catalog');
    const p2fm = populateP2(system);
    tbl(['Comp. Type', 'Comp. Name', 'Failure Mode', 'Impact', 'Likelihood', 'Detectability', 'Outage', 'RPV', 'Risk Level', 'Notes'],
      p2fm.fm.map(f => [f.ct, f.cn, f.fn, String(f.im), String(f.li), String(f.de), String(f.os), String(f.rpv), f.rl, 'Inferred']));
    ln('');

    // Phase 3
    ln('## Phase 3: Mitigation Strategy');
    const p3mt = populateP3(system, p2fm.fm);
    tbl(['Source Comp.', 'Failure Mode', 'Workflows', 'Dependent Comp.', 'Cascading Impact', 'Client Mitigations', 'Infra Mitigations', 'Detection', 'Recovery Plan', 'Status', 'Owner'],
      p3mt.mt.map(m => [m.sc, m.fm, m.wi, m.dc, m.ci, m.cm, m.im || '', m.dm, m.rp, m.is, m.ow]));
    ln('');

    // Phase 4
    ln('## Phase 4: Health Model');
    const p4he = populateP4(system);
    tbl(['Entity Type', 'Entity Name', 'Workflow', 'Parent', 'Notes'],
      p4he.he.filter(e => e.et !== 'Signal' && e.et !== 'Workflow').map(e => [e.et, e.en, e.wf, e.pa || '', 'Inferred']));
    ln('');

    // Phase 5
    ln('## Phase 5: Continuous Monitoring & Governance');
    const p5mg = populateP5(system);
    ln('### Monitoring Dashboard');
    tbl(['Workflow', 'Health', 'Critical Signals', 'Last FMA Score', 'Dep. Alignment', 'Open Alerts', 'Auto-Mitigation?', 'Last Updated', 'Notes'],
      p5mg.md.map(m => [m.wf, m.hs, m.cs, m.fs, m.da, m.oa, m.am, m.lu, '']));
    ln('');
    ln('### Governance Model');
    tbl(['Governance Area', 'Owner', 'Frequency', 'Artifacts Reviewed', 'Output', 'Notes'],
      p5mg.gv.map(g => [g.ar, g.ow, g.fr, g.af, g.op, '']));
    ln('');

    // Assumptions
    ln('## Assumptions and Review Needed Items');
    ln('- All Q1-Q2 workflow classification answers are inferred from diagram structure');
    ln('- CQ2 (Revenue impact), CQ4 (Regulatory) default to "No" — **requires human review**');
    ln('- Failure modes are inferred from component type and Azure service category');
    ln('- Impact, Likelihood, Detectability scores are inferred — **requires review**');
    ln('- All health signal thresholds are defaults — **requires configuration**');
    ln('- Owners are "Unassigned" — **requires assignment**');
    ln('- Governance review frequencies are defaults — **requires confirmation**');
    ln('');

    return lines.join('\n');
  }

  function downloadMarkdown(mdText) {
    var blob = new Blob([mdText], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'FMA_AutoPopulation_' + new Date().toISOString().split('T')[0] + '.md';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // 10. UI INTEGRATION
  // ============================================================

  // Stored image data URL for traceability
  var _lastImageDataUrl = null;
  var _lastImageFileName = null;

  // LLM Vision API configuration helpers
  function _getLLMConfig() {
    return {
      apiKey: localStorage.getItem('fma_llm_api_key') || '',
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
    localStorage.setItem('fma_llm_api_key', apiKey);
    localStorage.setItem('fma_llm_provider', provider);
  }

  function showImportUI() {
    if (typeof SM !== 'function') {
      alert('FMA Framework app not loaded');
      return;
    }

    var llmCfg = _getLLMConfig();
    var hasKey = llmCfg.provider === 'foundry'
      ? (llmCfg.foundryAuthMethod === 'token'
          ? llmCfg.foundryBearerToken.length > 0
          : (llmCfg.foundryClientId.length > 0 && llmCfg.foundryTenantId.length > 0 && llmCfg.foundryClientSecret.length > 0))
      : llmCfg.apiKey.length > 0;
    
    // Get current workload name from state
    var currentWorkloadName = (typeof S !== 'undefined' && S.wn) ? S.wn : '';

    window._importUILocked = true;

    var html =
      '<div style="display:flex;flex-direction:column;gap:12px;">' +
      '<div style="display:flex;justify-content:flex-end;margin:-8px -8px 0 0">' +
      '<button onclick="window._importModalOpen=false;window._importUILocked=false;HM();" style="background:none;border:none;color:var(--text2);font-size:1.4rem;cursor:pointer;padding:4px 8px;line-height:1" title="Close">✕</button>' +
      '</div>' +
      // Workload Name input at the top
      '<div style="background:rgba(78,205,196,.08);padding:12px;border-radius:var(--radius);border-left:3px solid var(--accent)">' +
      '<label style="font-size:.82rem;font-weight:600;color:var(--text);display:block;margin-bottom:6px">🏗️ Workload Name</label>' +
      '<input type="text" id="seq-workload-name" value="' + (currentWorkloadName || '').replace(/"/g, '&quot;') + '" ' +
      'placeholder="e.g., Cortex Data Platform" ' +
      'oninput="SeqImport._onWnInput()" ' +
      'style="width:100%;padding:8px 12px;font-size:.9rem;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:var(--radius)">' +
      '<span id="seq-wn-error" style="display:none;color:#e55;font-size:12px;margin-left:8px;">⚠ Enter a workload name first</span>' +
      '<p style="font-size:.72rem;color:var(--text3);margin:6px 0 0 0">Required — This will be used as the application name on the Overview page.</p>' +
      '</div>' +
      // Tabs — Upload File first and default
      '<div class="seq-tabs">' +
      '<div class="seq-tab active" onclick="SeqImport._switchTab(\'mermaid\')">📁 Upload File</div>' +
      '<div class="seq-tab" onclick="SeqImport._switchTab(\'image\')">🖼️ Upload Image</div>' +
      '</div>' +

      // Tab 1: Upload Mermaid File (default active)
      '<div id="seq-tab-mermaid" class="seq-tab-panel active">' +
      '<p style="color:var(--text2);font-size:.82rem;margin-bottom:12px">Upload a Mermaid sequence diagram file (.mmd, .mermaid, .md, .txt).</p>' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 16px;border:2px dashed var(--border);border-radius:var(--radius);cursor:pointer;user-select:none" onclick="if(SeqImport._checkWorkloadName()) document.getElementById(\'seq-file-input\').click()">' +
      '<span style="font-size:2rem">📁</span>' +
      '<span style="font-size:.85rem;font-weight:600;color:var(--text)">Click to select a .mmd file</span>' +
      '<span style="font-size:.72rem;color:var(--text3)">Supports .mmd, .mermaid, .md, .txt</span>' +
      '</div>' +
      '<input type="file" id="seq-file-input" accept=".md,.mermaid,.mmd,.txt" style="display:none" onchange="SeqImport.handleFileUpload(this)">' +
      '<div id="seq-file-info" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(78,205,196,.08);border-radius:var(--radius);font-size:.8rem;color:var(--text2)"></div>' +
      '<textarea id="seq-input" style="display:none"></textarea>' +
      '</div>' +

      // Tab 2: Upload Image
      '<div id="seq-tab-image" class="seq-tab-panel">' +

      // Settings panel
      '<details id="seq-llm-settings" class="llm-settings" ' + (hasKey ? '' : 'open') + '>' +
      '<summary style="cursor:pointer;font-size:.82rem;font-weight:600;color:var(--text2);margin-bottom:6px">⚙️ AI Vision Settings</summary>' +
      '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:0 0 160px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Provider</label>' +
      '<select id="seq-llm-provider" onchange="SeqImport._saveLLMSettings()" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="foundry"' + (llmCfg.provider === 'foundry' ? ' selected' : '') + '>Azure Foundry (recommended)</option>' +
      '<option value="openai"' + (llmCfg.provider === 'openai' ? ' selected' : '') + '>OpenAI (GPT-4o)</option>' +
      '<option value="azure"' + (llmCfg.provider === 'azure' ? ' selected' : '') + '>Azure OpenAI</option>' +
      '</select>' +
      '</div>' +
      '<div id="seq-llm-apikey-wrap" style="flex:1;min-width:200px;display:' + (llmCfg.provider === 'foundry' ? 'none' : 'block') + '">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">API Key</label>' +
      '<input type="password" id="seq-llm-apikey" value="' + llmCfg.apiKey + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="sk-... or Azure key" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div id="seq-llm-azure-endpoint" style="flex:1;min-width:200px;display:' + (llmCfg.provider === 'azure' ? 'block' : 'none') + '">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Azure Endpoint</label>' +
      '<input type="text" id="seq-llm-azure-url" value="' + (localStorage.getItem('fma_llm_azure_endpoint') || '') + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="https://YOUR.openai.azure.com/openai/deployments/YOUR-DEPLOY/chat/completions?api-version=2024-02-01" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '</div>' +
      '<div id="seq-llm-foundry-fields" style="display:' + (llmCfg.provider === 'foundry' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:1;min-width:250px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Foundry Endpoint</label>' +
      '<input type="text" id="seq-llm-foundry-url" value="' + llmCfg.foundryEndpoint + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="https://your-resource.cognitiveservices.azure.com" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<p style="font-size:.62rem;color:var(--text3);margin:3px 0 0 0">Base URL only — do not include /openai/deployments/...</p>' +
      '</div>' +
      '<div style="flex:0 0 200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Model</label>' +
      '<select id="seq-llm-foundry-model" onchange="SeqImport._saveLLMSettings()" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="gpt-4o"' + (llmCfg.foundryModel === 'gpt-4o' ? ' selected' : '') + '>GPT-4o (recommended)</option>' +
      '<option value="gpt-4o-mini"' + (llmCfg.foundryModel === 'gpt-4o-mini' ? ' selected' : '') + '>GPT-4o Mini (faster)</option>' +
      '<option value="gpt-5-mini"' + (llmCfg.foundryModel === 'gpt-5-mini' ? ' selected' : '') + '>GPT-5 Mini</option>' +
      '<option value="gpt-5"' + (llmCfg.foundryModel === 'gpt-5' ? ' selected' : '') + '>GPT-5 (highest quality)</option>' +
      '<option value="Phi-4-multimodal-instruct"' + (llmCfg.foundryModel === 'Phi-4-multimodal-instruct' ? ' selected' : '') + '>Phi-4 Multimodal (Microsoft)</option>' +
      '</select>' +
      '</div>' +
      '<div style="flex:0 0 180px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Auth Method</label>' +
      '<select id="seq-llm-foundry-auth-method" onchange="SeqImport._saveLLMSettings();SeqImport._toggleFoundryAuth();" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '<option value="token"' + (llmCfg.foundryAuthMethod === 'token' ? ' selected' : '') + '>Bearer Token (recommended)</option>' +
      '<option value="entra"' + (llmCfg.foundryAuthMethod === 'entra' ? ' selected' : '') + '>Entra ID (Service Principal)</option>' +
      '</select>' +
      '</div>' +
      '</div>' +
      // Bearer Token auth fields
      '<div id="seq-llm-foundry-token-fields" style="display:' + (llmCfg.foundryAuthMethod === 'token' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<div style="display:flex;gap:8px;align-items:flex-end">' +
      '<div style="flex:1">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Bearer Token</label>' +
      '<input type="password" id="seq-llm-foundry-bearer-token" value="' + llmCfg.foundryBearerToken + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="Paste your Azure AD bearer token here" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<button onclick="SeqImport._testFoundryConnection()" style="padding:5px 12px;font-size:.78rem;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;white-space:nowrap">🔗 Test</button>' +
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
      '<p style="font-size:.62rem;color:var(--text3);margin:4px 0 0 0">⏱️ Tokens are valid for ~1 hour. You\'ll need to generate a new one when it expires.</p>' +
      '</details>' +
      '</div>' +
      // Entra ID (Service Principal) auth fields
      '<div id="seq-llm-foundry-entra-fields" style="display:' + (llmCfg.foundryAuthMethod === 'entra' ? 'flex' : 'none') + ';gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Client ID</label>' +
      '<input type="text" id="seq-llm-foundry-client-id" value="' + llmCfg.foundryClientId + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Tenant ID</label>' +
      '<input type="text" id="seq-llm-foundry-tenant-id" value="' + llmCfg.foundryTenantId + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<label style="font-size:.72rem;color:var(--text3);display:block;margin-bottom:2px">Client Secret</label>' +
      '<input type="password" id="seq-llm-foundry-client-secret" value="' + llmCfg.foundryClientSecret + '" onchange="SeqImport._saveLLMSettings()" ' +
      'placeholder="Service principal secret" style="width:100%;padding:5px 8px;font-size:.8rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)">' +
      '</div>' +
      '<p style="font-size:.62rem;color:var(--text3);width:100%;margin:0">⚠️ Entra ID client_credentials may be blocked by browser CORS. Use Bearer Token method if you get network errors.</p>' +
      '</div>' +
      '</div>' +
      '<div id="seq-llm-foundry-help" style="display:' + (llmCfg.provider === 'foundry' ? 'block' : 'none') + ';margin-bottom:6px">' +
      '<p style="font-size:.68rem;color:var(--text3);margin:0 0 2px 0"><strong>Setup:</strong> Create a Service Principal → Grant "Cognitive Services OpenAI User" role → Get a bearer token (recommended) or enter SP credentials directly</p>' +
      '</div>' +
      '<p style="font-size:.68rem;color:var(--text3);margin:0">🔒 Credentials are stored locally in your browser and never sent to our servers.</p>' +
      '</details>'+

      '<p style="color:var(--text2);font-size:.82rem;margin-bottom:8px">Upload a JPG/PNG sequence diagram image. ' +
      (hasKey ? 'AI vision will analyze the diagram.' : '⚠️ Using basic OCR. For better results, configure ' + (llmCfg.provider === 'foundry' ? 'Entra ID credentials' : 'an LLM API key') + ' in Settings.') +
      '</p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      // Left: image preview
      '<div>' +
      '<div id="seq-img-preview" class="img-preview-wrap" style="cursor:pointer;user-select:none" onclick="if(SeqImport._checkWorkloadName()) document.getElementById(\'seq-img-input\').click()">' +
      '<span class="drop-label">📷 Click to upload or drag & drop<br><small>.jpg, .jpeg, .png</small></span>' +
      '</div>' +
      '<input type="file" id="seq-img-input" accept=".jpg,.jpeg,.png" style="display:none" onchange="SeqImport.handleImageUpload(this)">' +
      '</div>' +
      // Right: converted mermaid (editable)
      '<div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
      '<span style="font-size:.78rem;font-weight:600;color:var(--text2)">Generated Mermaid (editable)</span>' +
      '<div id="seq-confidence" style="display:none"></div>' +
      '</div>' +
      '<textarea id="seq-img-mermaid" style="width:100%;min-height:220px;font-family:\'Space Mono\',monospace;font-size:11px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);padding:10px;resize:vertical;line-height:1.4" ' +
      'placeholder="Mermaid syntax will appear here after image processing.\n\nYou can edit it before analyzing."></textarea>' +
      '</div>' +
      '<div id="seq-ocr-progress" class="ocr-progress">' +
      '<span id="seq-ocr-status">Ready</span>' +
      '<div class="bar"><div id="seq-ocr-bar" class="bar-fill"></div></div>' +
      '</div>' +
      '</div>'+
      '</div>'+ // close seq-tab-image panel

      // Shared status + action buttons
      '<div id="seq-status" style="display:none;padding:10px;border-radius:var(--radius);font-size:.85rem"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap">' +
      '<button class="btn btn-secondary btn-sm" onclick="window._importModalOpen=false;HM()">Cancel</button>' +
      '<button class="btn btn-primary btn-sm" onclick="SeqImport.run()">🚀 Parse & Populate All Phases</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="SeqImport.runAndExportMD()">📄 Parse & Export Markdown</button>' +
      '</div></div>';

    // Use wider modal for image tab
    SM('📋 Import from Sequence Diagram <span style="font-size:.65rem;color:var(--text3);font-weight:400">v' + _SEQ_IMPORT_VERSION + '</span>', html);
    window._importModalOpen = true;
    // Widen the modal
    var modal = document.getElementById('modal-c');
    if (modal) modal.classList.add('modal-wide');

    // Set up drag-and-drop on the image preview area
    setTimeout(function() {
      var preview = document.getElementById('seq-img-preview');
      if (preview) {
        preview.addEventListener('dragover', function(e) { e.preventDefault(); preview.style.borderColor = 'var(--accent)'; });
        preview.addEventListener('dragleave', function() { preview.style.borderColor = ''; });
        preview.addEventListener('drop', function(e) {
          e.preventDefault();
          preview.style.borderColor = '';
          var file = e.dataTransfer.files[0];
          if (file && /\.(jpe?g|png)$/i.test(file.name)) {
            _processImageFile(file);
          }
        });
      }
      // Call _onWnInput once to set initial locked/unlocked state
      SeqImport._onWnInput();
    }, 100);
  }

  function _switchTab(tab) {
    var tabs = document.querySelectorAll('.seq-tab');
    var panels = document.querySelectorAll('.seq-tab-panel');
    tabs.forEach(function(t, i) {
      t.classList.toggle('active', (tab === 'mermaid' && i === 0) || (tab === 'image' && i === 1));
    });
    panels.forEach(function(p) {
      p.classList.toggle('active', p.id === 'seq-tab-' + tab);
    });
    // Modal width stays consistent across both tabs
    var modal = document.getElementById('modal-c');
    if (modal) modal.classList.add('modal-wide');
  }

  // ============================================================
  // 10b. IMAGE UPLOAD + LLM VISION / OCR-TO-MERMAID PIPELINE
  // ============================================================

  function _saveLLMSettings() {
    var keyEl = document.getElementById('seq-llm-apikey');
    var provEl = document.getElementById('seq-llm-provider');
    var epEl = document.getElementById('seq-llm-azure-url');
    if (keyEl && provEl) {
      _saveLLMConfig(keyEl.value.trim(), provEl.value);
    }
    if (epEl) {
      localStorage.setItem('fma_llm_azure_endpoint', epEl.value.trim());
    }
    // Save Foundry-specific config
    var foundryUrl = document.getElementById('seq-llm-foundry-url');
    var foundryModel = document.getElementById('seq-llm-foundry-model');
    var foundryAuthMethod = document.getElementById('seq-llm-foundry-auth-method');
    var foundryBearerToken = document.getElementById('seq-llm-foundry-bearer-token');
    if (foundryUrl) localStorage.setItem('fma_llm_foundry_endpoint', foundryUrl.value.trim());
    if (foundryModel) localStorage.setItem('fma_llm_foundry_model', foundryModel.value);
    if (foundryAuthMethod) localStorage.setItem('fma_llm_foundry_auth_method', foundryAuthMethod.value);
    if (foundryBearerToken) localStorage.setItem('fma_llm_foundry_bearer_token', foundryBearerToken.value.trim());
    // Save Foundry Entra ID credentials
    var foundryClientId = document.getElementById('seq-llm-foundry-client-id');
    var foundryTenantId = document.getElementById('seq-llm-foundry-tenant-id');
    var foundrySecret = document.getElementById('seq-llm-foundry-client-secret');
    if (foundryClientId) localStorage.setItem('fma_llm_foundry_client_id', foundryClientId.value.trim());
    if (foundryTenantId) localStorage.setItem('fma_llm_foundry_tenant_id', foundryTenantId.value.trim());
    if (foundrySecret) localStorage.setItem('fma_llm_foundry_client_secret', foundrySecret.value.trim());
    // Toggle field visibility based on provider
    var provider = provEl ? provEl.value : 'foundry';
    var foundryFields = document.getElementById('seq-llm-foundry-fields');
    var foundryHelp = document.getElementById('seq-llm-foundry-help');
    var azureDiv = document.getElementById('seq-llm-azure-endpoint');
    var apiKeyWrap = document.getElementById('seq-llm-apikey-wrap');
    if (foundryFields) foundryFields.style.display = provider === 'foundry' ? 'block' : 'none';
    if (foundryHelp) foundryHelp.style.display = provider === 'foundry' ? 'block' : 'none';
    if (azureDiv) azureDiv.style.display = provider === 'azure' ? 'block' : 'none';
    if (apiKeyWrap) apiKeyWrap.style.display = provider === 'foundry' ? 'none' : 'block';
  }

  function _toggleFoundryAuth() {
    var authMethod = document.getElementById('seq-llm-foundry-auth-method');
    var tokenFields = document.getElementById('seq-llm-foundry-token-fields');
    var entraFields = document.getElementById('seq-llm-foundry-entra-fields');
    if (!authMethod) return;
    var isToken = authMethod.value === 'token';
    if (tokenFields) tokenFields.style.display = isToken ? 'block' : 'none';
    if (entraFields) entraFields.style.display = isToken ? 'none' : 'flex';
  }

  var LLM_VISION_PROMPT =
    'Analyze this sequence diagram image and convert it to Mermaid sequenceDiagram syntax.\n\n' +
    'Rules:\n' +
    '- Use "sequenceDiagram" as the first line\n' +
    '- Extract ALL participants with their full labels including any text in parentheses like (ADLS), (Spark), (Cosmos/Azure SQL)\n' +
    '- Use "participant alias as Full Label" format\n' +
    '- Identify all arrows and message labels\n' +
    '- Preserve arrow types: ->> for solid, -->> for dashed\n' +
    '- Include any alt/opt/loop blocks\n' +
    '- Include any Note annotations\n' +
    '- Output ONLY valid Mermaid syntax, no explanation';

  function handleImageUpload(input) {
    var file = input.files[0];
    if (!file) return;
    _processImageFile(file);
  }

  function _processImageFile(file) {
    if (!/\.(jpe?g|png)$/i.test(file.name)) {
      showStatus('❌ Please upload a .jpg, .jpeg, or .png image file.', 'red');
      return;
    }
    _lastImageFileName = file.name;

    var reader = new FileReader();
    reader.onload = function(e) {
      _lastImageDataUrl = e.target.result;
      // Show preview
      var preview = document.getElementById('seq-img-preview');
      if (preview) {
        preview.innerHTML = '<img src="' + e.target.result + '" alt="Uploaded diagram" />';
      }

      // Decide: LLM vision or OCR fallback
      var cfg = _getLLMConfig();
      var hasLLMCreds = cfg.provider === 'foundry'
        ? (cfg.foundryAuthMethod === 'token'
            ? !!cfg.foundryBearerToken
            : (cfg.foundryClientId && cfg.foundryTenantId && cfg.foundryClientSecret))
        : !!cfg.apiKey;
      if (hasLLMCreds) {
        _runLLMVision(e.target.result, cfg);
      } else {
        showStatus('⚠️ Using basic OCR. For better results, configure ' + (cfg.provider === 'foundry' ? 'Entra ID credentials' : 'an LLM API key') + ' in Settings.', 'amber');
        _runOCR(e.target.result);
      }
    };
    reader.readAsDataURL(file);
  }

  function _setOCRProgress(msg, pct) {
    var el = document.getElementById('seq-ocr-progress');
    var status = document.getElementById('seq-ocr-status');
    var bar = document.getElementById('seq-ocr-bar');
    if (el) el.style.display = 'block';
    if (status) status.textContent = msg;
    if (bar) bar.style.width = pct + '%';
  }

  // ---- Entra ID (Azure AD) Token Acquisition ----

  var _entraTokenCache = { token: null, expiresAt: 0 };

  async function _getEntraToken(tenantId, clientId, clientSecret) {
    // Return cached token if still valid (with 60s buffer)
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
      throw new Error('Network error acquiring token. If running locally, browser CORS policy blocks Entra ID client_credentials flow. Try serving the app from a web server, or check browser console for details. (' + netErr.message + ')');
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

  // ---- Test Foundry Connection ----

  async function _testFoundryConnection() {
    var cfg = _getLLMConfig();
    var foundryEndpoint = cfg.foundryEndpoint.replace(/\/+$/, '');
    var baseMatch = foundryEndpoint.match(/^(https?:\/\/[^\/]+)/);
    if (baseMatch) foundryEndpoint = baseMatch[1];
    if (!foundryEndpoint) {
      showStatus('❌ Set a Foundry Endpoint first.', 'red');
      return;
    }
    var deployModel = cfg.foundryModel || 'gpt-4o';
    var testUrl = foundryEndpoint + '/openai/deployments/' + deployModel + '/chat/completions?api-version=2024-04-01-preview';

    // Get token based on auth method
    var token;
    if (cfg.foundryAuthMethod === 'token') {
      token = cfg.foundryBearerToken;
      if (!token) {
        showStatus('❌ Paste a Bearer Token first.', 'red');
        return;
      }
    } else {
      if (!cfg.foundryClientId || !cfg.foundryTenantId || !cfg.foundryClientSecret) {
        showStatus('❌ Fill in all Entra ID credential fields first.', 'red');
        return;
      }
      try {
        showStatus('🔄 Acquiring Entra ID token...', 'blue');
        token = await _getEntraToken(cfg.foundryTenantId, cfg.foundryClientId, cfg.foundryClientSecret);
      } catch (e) {
        showStatus('❌ Entra ID token failed: ' + e.message, 'red');
        return;
      }
    }

    showStatus('🔄 Testing connection to ' + deployModel + '...', 'blue');
    try {
      var resp = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          model: deployModel,
          messages: [{ role: 'user', content: 'Say "Hello" in one word.' }],
          max_tokens: 10
        })
      });
      if (!resp.ok) {
        var errText = await resp.text();
        showStatus('❌ API error (' + resp.status + '): ' + errText.substring(0, 200), 'red');
        return;
      }
      var data = await resp.json();
      var reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '(no content)';
      var model = data.model || deployModel;
      showStatus('✅ Connected! Model: ' + model + ' — Response: "' + reply.trim() + '"', 'green');
    } catch (netErr) {
      showStatus('❌ Network error: ' + netErr.message + (netErr.message.includes('fetch') ? ' — Token may be expired, generate a new one.' : ''), 'red');
    }
  }

  // ---- LLM Vision API ----

  function _extractMermaidFromResponse(text) {
    // Strip markdown code fences if present
    var fenced = text.match(/```(?:mermaid)?\s*\n?([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    // Already raw mermaid
    return text.trim();
  }

  async function _runLLMVision(imageDataUrl, cfg) {
    _setOCRProgress('🔄 Analyzing diagram with AI vision...', 10);

    // Extract base64 data from data URL
    var base64Data = imageDataUrl.split(',')[1];
    var mimeMatch = imageDataUrl.match(/^data:(image\/[a-z]+);/);
    var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    var url, headers, body;

    if (cfg.provider === 'foundry') {
      var foundryEndpoint = cfg.foundryEndpoint.replace(/\/+$/, '');
      // Strip full deployment URL to base endpoint (scheme + host only)
      var baseMatch = foundryEndpoint.match(/^(https?:\/\/[^\/]+)/);
      if (baseMatch) foundryEndpoint = baseMatch[1];
      if (!foundryEndpoint) {
        showStatus('❌ Missing Foundry endpoint. Set it in AI Vision Settings.', 'red');
        _setOCRProgress('❌ Missing Foundry endpoint', 0);
        return;
      }

      var deployModel = cfg.foundryModel || 'gpt-4o';
      url = foundryEndpoint + '/openai/deployments/' + deployModel + '/chat/completions?api-version=2024-04-01-preview';

      // Get bearer token based on auth method
      var token;
      if (cfg.foundryAuthMethod === 'token') {
        // Direct bearer token (CORS-safe, recommended for browsers)
        token = cfg.foundryBearerToken;
        if (!token) {
          showStatus('❌ Missing Bearer Token. Paste a token in AI Vision Settings or use the PowerShell command shown there.', 'red');
          _setOCRProgress('❌ Missing bearer token', 0);
          return;
        }
      } else {
        // Entra ID client credentials flow (may be CORS-blocked in browsers)
        if (!cfg.foundryClientId || !cfg.foundryTenantId || !cfg.foundryClientSecret) {
          showStatus('❌ Missing Entra ID credentials. Configure Client ID, Tenant ID, and Client Secret in AI Vision Settings.', 'red');
          _setOCRProgress('❌ Missing Entra ID credentials', 0);
          return;
        }
        try {
          token = await _getEntraToken(cfg.foundryTenantId, cfg.foundryClientId, cfg.foundryClientSecret);
        } catch (e) {
          showStatus('❌ Entra ID auth failed: ' + e.message + ' — Try switching to Bearer Token auth method.', 'red');
          _setOCRProgress('❌ Entra ID auth failed', 0);
          return;
        }
      }

      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      };
      body = JSON.stringify({
        model: deployModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: LLM_VISION_PROMPT },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } }
          ]
        }],
        max_tokens: 4096
      });
    } else if (cfg.provider === 'azure') {
      var endpoint = localStorage.getItem('fma_llm_azure_endpoint') || '';
      if (!endpoint) {
        showStatus('❌ Azure OpenAI endpoint not configured. Set it in AI Vision Settings.', 'red');
        _setOCRProgress('❌ Missing Azure endpoint', 0);
        return;
      }
      url = endpoint;
      headers = {
        'Content-Type': 'application/json',
        'api-key': cfg.apiKey
      };
      body = JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: LLM_VISION_PROMPT },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } }
          ]
        }],
        max_tokens: 4096
      });
    } else {
      // OpenAI
      url = 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      };
      body = JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: LLM_VISION_PROMPT },
            { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } }
          ]
        }],
        max_tokens: 4096
      });
    }

    _setOCRProgress('🔄 Sending image to AI vision API...', 30);

    fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    }).then(function(resp) {
      if (!resp.ok) {
        return resp.text().then(function(errText) {
          var errMsg = 'API error ' + resp.status;
          try { errMsg = JSON.parse(errText).error.message || errMsg; } catch(e) {}
          throw new Error(errMsg);
        });
      }
      return resp.json();
    }).then(function(data) {
      _setOCRProgress('🔄 Processing AI response...', 85);

      var content = '';
      if (data.choices && data.choices[0] && data.choices[0].message) {
        content = data.choices[0].message.content || '';
      }

      if (!content) {
        throw new Error('Empty response from AI vision API');
      }

      var mermaidCode = _extractMermaidFromResponse(content);

      // Add traceability comments
      var lines = [
        '%% Auto-converted from image: ' + (_lastImageFileName || 'uploaded image'),
        mermaidCode,
        '',
        '%% Conversion confidence: High',
        '%% Source: LLM Vision API (' + (cfg.provider === 'foundry' ? 'Azure Foundry ' + (cfg.foundryModel || 'gpt-4o') : cfg.provider === 'azure' ? 'Azure OpenAI' : 'OpenAI GPT-4o') + ')'
      ];

      var finalMermaid = _injectTitleFromFilename(lines.join('\n'), _lastImageFileName);

      var mermaidTextarea = document.getElementById('seq-img-mermaid');
      if (mermaidTextarea) {
        mermaidTextarea.value = finalMermaid;
      }

      // Count participants and messages for stats
      var pCount = (mermaidCode.match(/^\s*participant\s/gm) || []).length;
      var mCount = (mermaidCode.match(/->>/gm) || []).length;
      _showConfidence('High', { participants: pCount, messages: mCount });

      _setOCRProgress('✅ AI vision analysis complete — review and edit the generated Mermaid before analyzing.', 100);

      // Also populate the main textarea so run() picks it up
      var mainTextarea = document.getElementById('seq-input');
      if (mainTextarea) mainTextarea.value = finalMermaid;

    }).catch(function(err) {
      console.error('LLM Vision API error:', err);
      showStatus('⚠️ AI vision failed: ' + err.message + '. Falling back to OCR...', 'amber');
      _setOCRProgress('⚠️ AI vision failed — falling back to OCR...', 0);
      // Fallback to Tesseract OCR
      _runOCR(imageDataUrl);
    });
  }

  // ---- Tesseract OCR fallback ----

  function _runOCR(imageDataUrl) {
    if (typeof Tesseract === 'undefined') {
      showStatus('❌ Tesseract.js not loaded. Check your internet connection.', 'red');
      return;
    }

    _setOCRProgress('Initializing OCR engine...', 5);

    Tesseract.recognize(imageDataUrl, 'eng', {
      logger: function(m) {
        if (m.status === 'recognizing text') {
          var pct = Math.round((m.progress || 0) * 100);
          _setOCRProgress('Recognizing text... ' + pct + '%', 10 + pct * 0.8);
        }
      }
    }).then(function(result) {
      _setOCRProgress('Converting to Mermaid syntax...', 95);

      var conversion = _ocrToMermaid(result.data);
      conversion.mermaid = _injectTitleFromFilename(conversion.mermaid, _lastImageFileName);
      var mermaidTextarea = document.getElementById('seq-img-mermaid');
      if (mermaidTextarea) {
        mermaidTextarea.value = conversion.mermaid;
      }

      // Show confidence
      _showConfidence(conversion.confidence, conversion.stats);

      _setOCRProgress('✅ OCR complete — review and edit the generated Mermaid before analyzing.', 100);

      // Also populate the main textarea so run() picks it up
      var mainTextarea = document.getElementById('seq-input');
      if (mainTextarea) mainTextarea.value = conversion.mermaid;

    }).catch(function(err) {
      _setOCRProgress('❌ OCR failed: ' + err.message, 0);
      showStatus('❌ OCR error: ' + err.message, 'red');
    });
  }

  function _showConfidence(level, stats) {
    var el = document.getElementById('seq-confidence');
    if (!el) return;
    var cls = level === 'High' ? 'confidence-high' : level === 'Medium' ? 'confidence-medium' : 'confidence-low';
    var icon = level === 'High' ? '🟢' : level === 'Medium' ? '🟡' : '🔴';
    el.style.display = 'block';
    el.innerHTML = '<div class="confidence-bar ' + cls + '">' + icon + ' <strong>' + level + '</strong> confidence' +
      (stats ? ' — ' + stats.participants + ' participants, ' + stats.messages + ' messages' : '') + '</div>';
  }

  /**
   * Convert Tesseract OCR result to best-effort Mermaid sequenceDiagram.
   * Uses word bounding boxes to infer spatial layout:
   *   - Top-row text clusters → participants
   *   - Mid-section text → message labels
   *   - Keywords (alt, opt, loop, Note) → blocks
   */
  function _ocrToMermaid(ocrData) {
    var words = [];
    // Collect words with positions from Tesseract data
    if (ocrData.words) {
      for (var i = 0; i < ocrData.words.length; i++) {
        var w = ocrData.words[i];
        if (w.text && w.text.trim().length > 0 && w.confidence > 30) {
          words.push({
            text: w.text.trim(),
            x: w.bbox.x0,
            y: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
            confidence: w.confidence,
          });
        }
      }
    }

    // Fallback: if no word-level data, parse from lines
    if (words.length === 0 && ocrData.lines) {
      for (var li = 0; li < ocrData.lines.length; li++) {
        var line = ocrData.lines[li];
        if (line.text && line.text.trim().length > 0) {
          words.push({
            text: line.text.trim(),
            x: line.bbox.x0,
            y: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1,
            confidence: line.confidence,
          });
        }
      }
    }

    // Fallback: raw text parse
    if (words.length === 0 && ocrData.text) {
      return _ocrTextFallback(ocrData.text);
    }

    if (words.length === 0) {
      return { mermaid: '%% No text detected in image\nsequenceDiagram\n    Note over A: Review Needed - no text extracted', confidence: 'Low', stats: { participants: 0, messages: 0 } };
    }

    // Sort words by vertical position
    words.sort(function(a, b) { return a.y - b.y; });

    // Determine image height from word positions
    var maxY = 0;
    for (var k = 0; k < words.length; k++) {
      if (words[k].y1 > maxY) maxY = words[k].y1;
    }
    var topZone = maxY * 0.2; // Top 20% → participant zone

    // Phase 1: Extract participants from top zone
    var topWords = words.filter(function(w) { return w.y < topZone; });
    // Cluster top words by X proximity into participant labels
    var participants = _clusterWordsToLabels(topWords);

    // Phase 2: Extract messages from middle/bottom zone
    var midWords = words.filter(function(w) { return w.y >= topZone; });
    var messageLines = _clusterWordsToLines(midWords);

    // Phase 3: Identify special keywords
    var blockKeywords = [];
    var messageTexts = [];
    var noteTexts = [];

    for (var mi = 0; mi < messageLines.length; mi++) {
      var lineText = messageLines[mi].text;
      var lower = lineText.toLowerCase().trim();

      if (/^(alt|else)\b/i.test(lower)) {
        blockKeywords.push({ type: 'alt', text: lineText, y: messageLines[mi].y });
      } else if (/^opt\b/i.test(lower)) {
        blockKeywords.push({ type: 'opt', text: lineText, y: messageLines[mi].y });
      } else if (/^loop\b/i.test(lower)) {
        blockKeywords.push({ type: 'loop', text: lineText, y: messageLines[mi].y });
      } else if (/^end$/i.test(lower)) {
        blockKeywords.push({ type: 'end', text: lineText, y: messageLines[mi].y });
      } else if (/^note\b/i.test(lower)) {
        noteTexts.push(lineText);
      } else if (lineText.length > 1 && !/^\d+\.?$/.test(lineText)) {
        messageTexts.push({ text: lineText, y: messageLines[mi].y, x: messageLines[mi].x });
      }
    }

    // Phase 4: Build Mermaid output
    var lines = ['sequenceDiagram'];
    var aliases = [];
    var avgConfidence = 0;
    var totalConf = 0;

    // Add participants
    if (participants.length === 0) {
      // Fallback: create generic participants
      participants = [{ label: 'ServiceA', x: 0 }, { label: 'ServiceB', x: 100 }];
      lines.push('    %% Review Needed: no participants detected from image');
    }

    // Sort participants left to right
    participants.sort(function(a, b) { return a.x - b.x; });

    for (var pi = 0; pi < participants.length; pi++) {
      var alias = _makeAlias(participants[pi].label, aliases);
      aliases.push(alias);
      participants[pi].alias = alias;
      var cleanLabel = participants[pi].label.replace(/[|]/g, ' ').trim();
      lines.push('    participant ' + alias + ' as ' + cleanLabel);
      totalConf += (participants[pi].confidence || 50);
    }

    lines.push('');

    // Add messages — assign to participant pairs based on position
    for (var msi = 0; msi < messageTexts.length; msi++) {
      var msg = messageTexts[msi];
      // Find closest participant pair based on x position
      var fromP = _findClosestParticipant(msg.x, participants, 'left');
      var toP = _findClosestParticipant(msg.x, participants, 'right');
      if (fromP && toP && fromP !== toP) {
        lines.push('    ' + fromP + '->>' + toP + ': ' + msg.text);
      } else if (fromP) {
        var other = aliases.find(function(a) { return a !== fromP; }) || (aliases[1] || aliases[0]);
        lines.push('    ' + fromP + '->>' + other + ': ' + msg.text);
      } else {
        lines.push('    %% Review Needed: could not place message "' + msg.text + '"');
        if (aliases.length >= 2) {
          lines.push('    ' + aliases[0] + '->>' + aliases[1] + ': ' + msg.text);
        }
      }
      totalConf += (msg.confidence || 40);
    }

    // Add blocks
    for (var bi = 0; bi < blockKeywords.length; bi++) {
      var bk = blockKeywords[bi];
      if (bk.type === 'end') lines.push('    end');
      else lines.push('    ' + bk.type + ' ' + bk.text.substring(bk.type.length).trim());
    }

    // Add notes
    for (var ni = 0; ni < noteTexts.length; ni++) {
      if (aliases.length > 0) {
        lines.push('    Note over ' + aliases[0] + ': ' + noteTexts[ni]);
      }
    }

    // Calculate confidence
    var totalItems = participants.length + messageTexts.length;
    avgConfidence = totalItems > 0 ? totalConf / totalItems : 0;
    var confidenceLevel = avgConfidence > 70 ? 'High' : avgConfidence > 45 ? 'Medium' : 'Low';

    // Add traceability comment
    lines.unshift('%% Auto-converted from image: ' + (_lastImageFileName || 'uploaded image'));
    lines.push('');
    lines.push('%% Conversion confidence: ' + confidenceLevel);
    lines.push('%% Source: OCR extraction via Tesseract.js');
    if (confidenceLevel !== 'High') {
      lines.push('%% ⚠️ Review the participant names, arrow directions, and message labels');
    }

    return {
      mermaid: lines.join('\n'),
      confidence: confidenceLevel,
      stats: { participants: participants.length, messages: messageTexts.length },
    };
  }

  /**
   * Fallback parser when we only have raw text (no bounding boxes).
   */
  function _ocrTextFallback(rawText) {
    var textLines = rawText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    if (textLines.length === 0) {
      return { mermaid: '%% No text detected\nsequenceDiagram\n    Note over A: Review Needed', confidence: 'Low', stats: { participants: 0, messages: 0 } };
    }

    var lines = ['%% Auto-converted from image (text-only fallback): ' + (_lastImageFileName || 'image'), 'sequenceDiagram'];
    var participants = [];
    var messages = [];

    for (var i = 0; i < textLines.length; i++) {
      var t = textLines[i];
      // Already Mermaid? Pass through
      if (/^(sequenceDiagram|participant |actor |->|-->|Note |alt |opt |loop |else|end)/.test(t)) {
        if (!/^sequenceDiagram/.test(t)) lines.push('    ' + t);
        continue;
      }
      // Looks like an arrow?
      if (/[-=]>|→|->/.test(t)) {
        messages.push(t);
        lines.push('    %% ' + t + '  %% Review Needed: parse arrow');
        continue;
      }
      // Short text could be a participant
      if (t.length <= 30 && !/\s{3,}/.test(t)) {
        var alias = _makeAlias(t, participants);
        participants.push(alias);
        lines.push('    participant ' + alias + ' as ' + t);
        continue;
      }
      // Everything else is a potential message
      messages.push(t);
    }

    // If we got participants but no messages, add placeholder
    if (participants.length > 0 && messages.length === 0) {
      lines.push('    %% Review Needed: no messages detected');
    }

    // Add unmatched messages
    for (var j = 0; j < messages.length; j++) {
      if (participants.length >= 2) {
        lines.push('    ' + participants[0] + '->>' + participants[1] + ': ' + messages[j] + ' %% Review Needed');
      }
    }

    var confidence = participants.length >= 2 && messages.length >= 1 ? 'Medium' : 'Low';
    lines.push('');
    lines.push('%% Conversion confidence: ' + confidence);

    return { mermaid: lines.join('\n'), confidence: confidence, stats: { participants: participants.length, messages: messages.length } };
  }

  // Cluster words by X proximity into labels
  function _clusterWordsToLabels(words) {
    if (words.length === 0) return [];
    words.sort(function(a, b) { return a.x - b.x; });

    var clusters = [];
    var current = { words: [words[0]], x: words[0].x };

    for (var i = 1; i < words.length; i++) {
      var gap = words[i].x - (current.words[current.words.length - 1].x1 || current.words[current.words.length - 1].x + 50);
      if (gap < 40) {
        // Same cluster
        current.words.push(words[i]);
      } else {
        // New cluster
        clusters.push(current);
        current = { words: [words[i]], x: words[i].x };
      }
    }
    clusters.push(current);

    return clusters.map(function(c) {
      var label = c.words.map(function(w) { return w.text; }).join(' ');
      var avgConf = c.words.reduce(function(s, w) { return s + (w.confidence || 50); }, 0) / c.words.length;
      return { label: label, x: c.x, confidence: avgConf };
    }).filter(function(c) { return c.label.length > 1; });
  }

  // Cluster words into lines (by Y proximity)
  function _clusterWordsToLines(words) {
    if (words.length === 0) return [];
    words.sort(function(a, b) { return a.y - b.y || a.x - b.x; });

    var lines = [];
    var current = { words: [words[0]], y: words[0].y, x: words[0].x };

    for (var i = 1; i < words.length; i++) {
      var vGap = Math.abs(words[i].y - current.y);
      if (vGap < 15) {
        current.words.push(words[i]);
      } else {
        lines.push(current);
        current = { words: [words[i]], y: words[i].y, x: words[i].x };
      }
    }
    lines.push(current);

    return lines.map(function(l) {
      l.words.sort(function(a, b) { return a.x - b.x; });
      return {
        text: l.words.map(function(w) { return w.text; }).join(' '),
        y: l.y,
        x: l.x,
        confidence: l.words.reduce(function(s, w) { return s + (w.confidence || 50); }, 0) / l.words.length,
      };
    });
  }

  function _makeAlias(label, existing) {
    // Create short alias from label
    var clean = label.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    var parts = clean.split(/\s+/);
    var alias;
    if (parts.length === 1) {
      alias = parts[0].substring(0, 8);
    } else {
      alias = parts.map(function(p) { return p[0]; }).join('').toUpperCase();
    }
    if (!alias || alias.length === 0) alias = 'P' + existing.length;
    // Ensure uniqueness
    var base = alias;
    var counter = 2;
    while (existing.indexOf(alias) !== -1) {
      alias = base + counter;
      counter++;
    }
    return alias;
  }

  function _findClosestParticipant(x, participants, side) {
    if (participants.length === 0) return null;
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < participants.length; i++) {
      var px = participants[i].x;
      var dist = Math.abs(x - px);
      if (side === 'left' && px <= x && dist < bestDist) {
        best = participants[i].alias;
        bestDist = dist;
      } else if (side === 'right' && px > x && dist < bestDist) {
        best = participants[i].alias;
        bestDist = dist;
      }
    }
    // Fallback: just find closest regardless of side
    if (!best) {
      for (var j = 0; j < participants.length; j++) {
        var d2 = Math.abs(x - participants[j].x);
        if (d2 < bestDist) { best = participants[j].alias; bestDist = d2; }
      }
    }
    return best;
  }

  // Sync image tab mermaid to main textarea on edits
  function _syncImageMermaid() {
    var imgTA = document.getElementById('seq-img-mermaid');
    var mainTA = document.getElementById('seq-input');
    if (imgTA && mainTA) mainTA.value = imgTA.value;
  }

  function handleFileUpload(input) {
    var file = input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var textarea = document.getElementById('seq-input');
      if (textarea) {
        var content = _injectTitleFromFilename(e.target.result, file.name);
        textarea.value = content;
        // Show file info summary
        var info = document.getElementById('seq-file-info');
        if (info) {
          var lines = content.split('\n');
          var pCount = (content.match(/^\s*participant\s/gm) || []).length;
          var mCount = (content.match(/->>|-->>|->/gm) || []).length;
          info.style.display = 'block';
          info.innerHTML = '✅ <strong>' + file.name + '</strong> loaded — ' +
            pCount + ' participants, ' + mCount + ' interactions, ' +
            Math.round(content.length / 1024) + ' KB';
        }
        showStatus('✅ Ready to import — click 🚀 Parse & Populate All Phases', 'green');
      }
    };
    reader.readAsText(file);
  }

  function uploadFile() {
    var input = document.getElementById('seq-file-input');
    if (input) input.click();
  }

  function showStatus(msg, color) {
    var el = document.getElementById('seq-status');
    if (el) {
      el.style.display = 'block';
      el.style.background = color === 'green' ? 'rgba(81,207,102,.15)' : color === 'red' ? 'rgba(255,107,107,.15)' : 'rgba(78,205,196,.15)';
      el.style.color = color === 'green' ? 'var(--green)' : color === 'red' ? 'var(--red)' : 'var(--accent)';
      el.innerHTML = msg;
    }
  }

  function run() {
    // Check and save workload name first
    var workloadNameInput = document.getElementById('seq-workload-name');
    if (workloadNameInput) {
      var workloadName = workloadNameInput.value.trim();
      if (!workloadName) {
        showStatus('❌ Please enter a Workload Name before importing.', 'red');
        workloadNameInput.focus();
        return;
      }
      // Save to app state
      if (typeof S !== 'undefined' && typeof sv === 'function') {
        S.wn = workloadName;
        sv();
        // Update header if present
        var hdr = document.getElementById('wn-hdr');
        if (hdr) hdr.textContent = '— ' + workloadName;
        // If overview input is currently in the DOM, sync its value too
        var overviewInput = document.querySelector('#mc input[onchange*="S.wn"]');
        if (overviewInput) overviewInput.value = workloadName;
      }
    }
    
    // Sync image tab mermaid to main textarea if active
    var imgTA = document.getElementById('seq-img-mermaid');
    var textarea = document.getElementById('seq-input');
    if (imgTA && imgTA.value.trim() && document.getElementById('seq-tab-image') &&
        document.getElementById('seq-tab-image').classList.contains('active')) {
      // Also inject title from image filename
      var mermaidFromImg = _injectTitleFromFilename(imgTA.value, _lastImageFileName);
      if (textarea) textarea.value = mermaidFromImg;
    }
    if (!textarea || !textarea.value.trim()) {
      showStatus('❌ Please upload a Mermaid sequence diagram file.', 'red');
      return;
    }

    try {
      var text = textarea.value;
      var diagrams = parse(text);
      if (diagrams.length === 0) {
        showStatus('❌ No sequenceDiagram blocks found. Make sure the file starts with "sequenceDiagram".', 'red');
        return;
      }

      // Append mode — do NOT clear previous imports, merge new data alongside existing

      var system = classify(diagrams);
      var result = populate(system);

      // Show success
      var summary = '✅ <strong>Import Successful!</strong><br>' +
        '📊 ' + diagrams.length + ' diagram(s) parsed<br>' +
        '🔀 ' + system.workflows.length + ' workflow(s) classified<br>' +
        '🧩 ' + system.components.length + ' component(s) identified<br>' +
        '☁️ ' + system.azureServices.length + ' Azure service(s) detected<br>' +
        '📝 ' + result.added + ' entries added across all 8 phases' +
        (result.skipped > 0 ? '<br>⏭️ ' + result.skipped + ' duplicate entries skipped' : '') +
        (result.conflicts > 0 ? '<br>⚠️ ' + result.conflicts + ' conflict(s) with manually-edited data — click <strong>Review Conflicts</strong> to resolve' : '');

      showStatus(summary, result.conflicts > 0 ? 'amber' : 'green');

      // Re-render current phase after a brief delay to let user see the summary
      setTimeout(function () {
        window._importModalOpen = false;
        if (typeof HM === 'function') HM();
        if (typeof RP === 'function') RP(S.cp);
        if (typeof RS === 'function') RS();
        // Show conflict resolution UI if there are conflicts
        if (result.conflicts > 0) {
          setTimeout(function() { showConflictUI(); }, 300);
        }
      }, 1500);
    } catch (e) {
      showStatus('❌ Error: ' + e.message, 'red');
      console.error('SeqImport error:', e);
    }
  }

  function runAndExportMD() {
    // Sync image tab mermaid to main textarea if active
    var imgTA = document.getElementById('seq-img-mermaid');
    var textarea = document.getElementById('seq-input');
    if (imgTA && imgTA.value.trim() && document.getElementById('seq-tab-image') &&
        document.getElementById('seq-tab-image').classList.contains('active')) {
      if (textarea) textarea.value = imgTA.value;
    }
    if (!textarea || !textarea.value.trim()) {
      showStatus('❌ Please paste or upload a Mermaid sequence diagram.', 'red');
      return;
    }

    try {
      var text = textarea.value;
      var diagrams = parse(text);
      if (diagrams.length === 0) {
        showStatus('❌ No sequenceDiagram blocks found in input.', 'red');
        return;
      }

      var system = classify(diagrams);
      var md = toMarkdown(system);
      downloadMarkdown(md);
      showStatus('✅ Markdown exported! ' + diagrams.length + ' diagram(s), ' + system.workflows.length + ' workflow(s).', 'green');
    } catch (e) {
      showStatus('❌ Error: ' + e.message, 'red');
      console.error('SeqImport error:', e);
    }
  }

  // ============================================================
  // 11. EXPOSE PUBLIC API
  // ============================================================

  window.SeqImport = {
    // Core API
    parse: parse,
    classify: classify,
    populate: populate,
    toMarkdown: toMarkdown,
    inferMitigations: inferMitigations,

    // UI
    showImportUI: showImportUI,
    run: run,
    runAndExportMD: runAndExportMD,
    handleFileUpload: handleFileUpload,
    uploadFile: uploadFile,
    clearAutoPopulated: clearAutoPopulated,

    // Image OCR / LLM Vision
    handleImageUpload: handleImageUpload,
    _switchTab: _switchTab,
    _saveLLMSettings: _saveLLMSettings,
    _toggleFoundryAuth: _toggleFoundryAuth,
    _testFoundryConnection: _testFoundryConnection,
    _ocrToMermaid: _ocrToMermaid,
    _ocrTextFallback: _ocrTextFallback,
    _extractMermaidFromResponse: _extractMermaidFromResponse,
    _getLLMConfig: _getLLMConfig,
    _getEntraToken: _getEntraToken,
    getLastImageDataUrl: function() { return _lastImageDataUrl; },
    getLastImageFileName: function() { return _lastImageFileName; },

    // Conflict resolution
    resolveConflict: resolveConflict,
    resolveAllConflicts: resolveAllConflicts,
    showConflictUI: showConflictUI,
    getPendingConflicts: function() { return _pendingConflicts; },

    // Exposed for testing
    _parser: { splitDiagramBlocks: splitDiagramBlocks, parseSingleDiagram: parseSingleDiagram, cleanLabel: cleanLabel },
    _classifier: { classifyParticipant: classifyParticipant, classifyWorkflow: classifyWorkflow, detectAzureService: detectAzureService, normalizeEntityName: normalizeEntityName },
    _populator: { populateP1: populateP1, populateP2: populateP2, populateP3: populateP3, populateP4: populateP4, populateP5: populateP5 },
    _enricher: { enrichWithAzureMCP: enrichWithAzureMCP, isAzureMCPAvailable: isAzureMCPAvailable },
    _constants: { AZURE_SERVICE_MAP: AZURE_SERVICE_MAP, AZURE_PATTERNS: AZURE_PATTERNS, MITIGATION_MAP: MITIGATION_MAP },
    _signalEngine: { suggestSignal: _suggestSignal },
    suggestSignal: _suggestSignal,
    _imageOcr: { ocrToMermaid: _ocrToMermaid, ocrTextFallback: _ocrTextFallback, clusterWordsToLabels: _clusterWordsToLabels, clusterWordsToLines: _clusterWordsToLines, makeAlias: _makeAlias, extractMermaidFromResponse: _extractMermaidFromResponse, getLLMConfig: _getLLMConfig },
    
    // Workload name gating helpers
    _checkWorkloadName: function() {
      var wn = (document.getElementById('seq-workload-name') || {}).value || '';
      if (wn.trim().length < 3) {
        var msg = document.getElementById('seq-wn-error');
        if (msg) {
          msg.style.display = 'inline';
          setTimeout(function() { msg.style.display = 'none'; }, 2500);
        }
        return false;
      }
      return true;
    },
    _onWnInput: function() {
      var wn = (document.getElementById('seq-workload-name') || {}).value || '';
      var locked = wn.trim().length < 3;
      // Update file dropzone
      var fileZone = document.getElementById('seq-tab-mermaid');
      if (fileZone) {
        var fileDropzone = fileZone.querySelector('[onclick*="seq-file-input"]');
        if (fileDropzone) {
          fileDropzone.style.opacity = locked ? '0.45' : '1';
          fileDropzone.style.cursor = locked ? 'not-allowed' : 'pointer';
        }
      }
      // Update image preview
      var imgPreview = document.getElementById('seq-img-preview');
      if (imgPreview) {
        imgPreview.style.opacity = locked ? '0.45' : '1';
        imgPreview.style.cursor = locked ? 'not-allowed' : 'pointer';
      }
      // Update file inputs
      ['seq-file-input', 'seq-img-input'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.disabled = locked;
      });
    }
  };

})();

// Node.js support for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    importSequenceDiagram: function(content) {
      const parsed = window.SeqImport.parse(content);
      const classified = window.SeqImport.classify(parsed);
      window.SeqImport.populate(classified);
      return { parsed, classified };
    },
    parse: window.SeqImport.parse,
    classify: window.SeqImport.classify,
    populate: window.SeqImport.populate,
    toMarkdown: window.SeqImport.toMarkdown,
  };
}
