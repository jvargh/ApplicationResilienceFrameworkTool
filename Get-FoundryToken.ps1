<#
.SYNOPSIS
    Acquires a bearer token for Azure Foundry (Azure OpenAI) using Entra ID service principal credentials.

.DESCRIPTION
    Authenticates via OAuth2 client_credentials grant against Microsoft Entra ID
    and copies the resulting bearer token to your clipboard.
    Paste the token into the app's AI Vision Settings → Bearer Token field.

.PARAMETER ClientId
    The Azure AD Application (client) ID.

.PARAMETER ClientSecret
    The client secret for the application.

.PARAMETER TenantId
    The Azure AD tenant ID.

.EXAMPLE
    .\Get-FoundryToken.ps1 -ClientId "a2968893-..." -ClientSecret "esQ8Q~..." -TenantId "5bb5fa45-..."
#>

param(
    [Parameter(Mandatory=$false, HelpMessage="Azure AD Application (client) ID")]
    [string]$ClientId,

    [Parameter(Mandatory=$false, HelpMessage="Client secret for the application")]
    [string]$ClientSecret,

    [Parameter(Mandatory=$false, HelpMessage="Azure AD tenant ID")]
    [string]$TenantId
)

# Load from .env if any param is missing
$envFile = Join-Path $PSScriptRoot ".env"
if ((-not $ClientId -or -not $ClientSecret -or -not $TenantId) -and (Test-Path $envFile)) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*[^#]' } | ForEach-Object {
        $k, $v = $_ -split '=', 2
        switch ($k.Trim()) {
            'FOUNDRY_CLIENT_ID'     { if (-not $ClientId)     { $ClientId     = $v.Trim() } }
            'FOUNDRY_CLIENT_SECRET' { if (-not $ClientSecret) { $ClientSecret = $v.Trim() } }
            'FOUNDRY_TENANT_ID'     { if (-not $TenantId)     { $TenantId     = $v.Trim() } }
        }
    }
}

if (-not $ClientId -or -not $ClientSecret -or -not $TenantId) {
    Write-Host "ERROR: ClientId, ClientSecret, and TenantId are required (pass as params or set in .env)." -ForegroundColor Red
    exit 1
}

$ErrorActionPreference = "Stop"

$body = @{
    client_id     = $ClientId
    client_secret = $ClientSecret
    scope         = "https://cognitiveservices.azure.com/.default"
    grant_type    = "client_credentials"
}

$tokenUrl = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"

try {
    Write-Host "Requesting token from Entra ID..." -ForegroundColor Cyan
    $response = Invoke-RestMethod -Uri $tokenUrl -Method POST -Body $body
    $token = $response.access_token

    if (-not $token) {
        Write-Host "ERROR: No access_token in response." -ForegroundColor Red
        exit 1
    }

    $token | Set-Clipboard
    $expiresIn = $response.expires_in
    Write-Host "Token copied to clipboard (length: $($token.Length), valid ~$([math]::Floor($expiresIn / 60)) min)" -ForegroundColor Green
    Write-Host "Paste it into the app's AI Vision Settings → Bearer Token field." -ForegroundColor Yellow
}
catch {
    Write-Host "ERROR: Failed to acquire token." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
