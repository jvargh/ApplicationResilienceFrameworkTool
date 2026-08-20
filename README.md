# Application Resilience Testing Tool - User Guide

## Featured Article

> 📖 [**Architecture to resilience: A decision guide**](https://techcommunity.microsoft.com/blog/azurearchitectureblog/architecture-to-resilience-a-decision-guide/4516552) — Learn the decision framework and architectural principles behind building resilient applications.

A browser-based tool for building operational resilience through workflow-driven health modeling. It walks you through four phases - from Failure Mode Analysis to Azure deployment and continuous governance.

📺 [Watch the video walkthrough](https://youtu.be/2UlnJGTGHY4)

## Contents

```
_AppResilienceTestingTool/
├── fma-framework.html      ← Main application (open in browser)
├── seq-import.js           ← Sequence-diagram import engine
├── block-import.js         ← Data-flow / architecture-image import engine
├── Get-FoundryToken.ps1    ← PowerShell helper for Azure AI bearer tokens
└── flows/
    ├── 01_ClientOnboarding_seqdiag.mmd   ← Sample Mermaid sequence diagram
    ├── 02_E2E_ClientInt_seqdiag.mmd      ← Sample Mermaid sequence diagram
    └── Overall-Data-Flow.png             ← Sample architecture / data-flow image
```

## Prerequisites

| Requirement | Details |
| --- | --- |
| **Browser** | Modern Chromium-based browser (Edge, Chrome) recommended |
| **Internet** | Required on first load for CDN libraries (SheetJS, Tesseract.js, Dagre, Google Fonts) |
| **Azure subscription** | Needed only for Phase 3 Deploy and AI Vision features |
| **PowerShell 5.1+** | Needed only if using `Get-FoundryToken.ps1` for AI vision tokens |

## Quick Start

1.  Open `**fma-framework.html**` in your browser.
2.  The app loads with an empty workspace - no server needed.

---

## Step-by-Step Walkthrough

### 1 - Import Sequence Diagrams (MMD Files)

Use this to import Mermaid sequence diagrams that define your application workflows.

1.  Click **📋 Import Sequence Diagram** in the toolbar.
2.  In the import dialog, choose **Upload .mmd file(s)**.
3.  Select the sample files from the `flows/` folder:
    *   `01_ClientOnboarding_seqdiag.mmd`
    *   `02_E2E_ClientInt_seqdiag.mmd`
4.  The engine parses the diagrams, detects Azure services, classifies workflows, and auto-populates Phase 1 data (components, failure modes, RPV scores).
5.  Review the imported workflows in the **Phase 1** panel.

### 2 - Import Data Flows (Architecture Image)

Use this to extract workflows from an architecture / data-flow diagram image via AI vision.

1.  Click **📊 Import Data Flows** in the toolbar.
2.  Choose **Upload Image** and select `flows/Overall-Data-Flow.png`.
3.  The tool sends the image to an AI vision model which extracts sequence diagrams from the architecture.
4.  Preview the extracted diagrams in the grid, then confirm to import.

> **AI Vision requires a bearer token.** If prompted, use the helper script:
>
> ```
> .\Get-FoundryToken.ps1 -ClientId "<app-id>" -ClientSecret "<secret>" -TenantId "<tenant>"
> ```
>
> The token is copied to your clipboard - paste it into the app's **AI Vision Settings → Bearer Token** field.
>
> Alternatively, create a `.env` file alongside the script:
>
> ```
> FOUNDRY_CLIENT_ID=<app-id>
> FOUNDRY_CLIENT_SECRET=<secret>
> FOUNDRY_TENANT_ID=<tenant>
> ```

### 3 - Phase 1: Failure Mode Analysis

After import, Phase 1 is pre-populated with:

*   **Workflows** - classified as User Flow or System Flow
*   **Components** - categorised as Application or Platform, with Azure service detection
*   **Failure Modes** - per-component, each scored with **RPV** (Risk Priority Value = Impact × Likelihood × Detectability)

**What to do:**

1.  Review each workflow and its components.
2.  Adjust failure modes, severity scores, and classifications as needed.
3.  Add any failure modes the auto-import missed.
4.  Verify criticality ratings (RPV ≥ 50 = High Risk).
5.  Mark Phase 1 complete when satisfied.

### 4 - Phase 2: Mitigation & Validation

1.  Navigate to **Phase 2**.
2.  Click **🔄 Import from Phase 1** to pull in failure modes.
3.  For each failure mode, review:
    *   **Mitigation strategy** - detection, client-side, infrastructure, and recovery actions
    *   **Validation / Chaos test** - the recommended test type (Chaos, Load, Failover, etc.)
4.  Refine mitigations - the tool auto-suggests strategies based on Azure service type.
5.  Download the XLSX export for offline review if needed.

### 5 - Phase 3: Health Model → Deploy to Azure

Phase 3 builds a hierarchical health model and deploys it.

1.  Navigate to **Phase 3**.
2.  Click **🔄 Import from Phase 1** to populate workflows, components, and FM-linked health signals.
3.  Review the entity hierarchy:
    *   **Workflow** → **Business Function** → **Application Component** → **Platform Resource**
4.  For each entity, review **health signals** - metric name, thresholds, operators.
5.  Add manual signals for any gaps; check the **FMA Coverage** score (aim for ≥ 80%).
6.  When ready, click **☁️ Deploy to Azure** on a workflow.
7.  Fill in the deployment form:
    *   **Subscription ID**
    *   **Resource Group**
    *   **Location** (Azure region)
    *   **Bearer Token** (use `Get-FoundryToken.ps1` or paste an existing token)
8.  Click **🚀 Deploy Now** - the tool creates entities and relationships in Azure Health Models.
9.  On success, use the **🔗 Open in Azure Portal** link to verify.

### 6 - Phase 4: Operations & Governance

After deployment, Phase 4 establishes ongoing operational practices.

1.  Navigate to **Phase 4**.
2.  Review the **Operations Summary** - open alerts, dependency alignment, auto-mitigation status.
3.  Define the **Governance Model**:
    *   **Governance Area** - what is being reviewed (e.g., "Health Signal Thresholds")
    *   **Owner** - team or individual responsible
    *   **Frequency** - review cadence (Weekly, Monthly, Quarterly)
    *   **Artifacts Reviewed** - dashboards, runbooks, incident reports
    *   **Output** - expected deliverable from each review cycle
4.  Track the **Governance Maturity Score** (0–100) in the Insights panel - it scores FM coverage, mitigation completeness, signal coverage, and validation rate.

### 7 - Insights Dashboard

Click **📊 Insights** at any time for a cross-phase summary:

*   Workflow and component counts
*   Failure mode coverage
*   Signal-to-FM alignment
*   Governance maturity score
*   Export the full workbook (**📥 Export All to XLSX**) for stakeholder reporting

---

## Data Persistence

All data is stored in the browser's **localStorage**. There is no server or database.

*   **Save** - data auto-saves on every change
*   **Export** - use per-phase or full XLSX exports to back up your work
*   **Import** - XLSX upload restores previously exported data
*   **Clear** - clearing browser data will erase all progress

## Offline Usage

After the first load (which fetches CDN libraries), most features work offline. The exceptions are:

*   **AI Vision** (Import Data Flows) - requires network access to the Azure OpenAI endpoint
*   **Deploy to Azure** - requires network access to Azure Resource Manager
*   **Google Fonts** - the app falls back to system fonts if unavailable