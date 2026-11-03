param(
    [string]$Source = (Join-Path $PSScriptRoot 'ComputerHelper.cs')
)

# Fallback transport for the dsh-computer-use-windows plugin, used only when
# csc.exe is unavailable. It compiles ComputerHelper.cs in memory and serves the
# exact same JSON-line protocol on stdin/stdout (see ../PROTOCOL.md).
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
    [Console]::Error.WriteLine("computer-helper: source not found: $Source")
    exit 2
}

try {
    $code = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
    $references = @(
        'System.dll',
        'System.Core.dll',
        'System.Drawing.dll',
        'System.Windows.Forms.dll',
        'System.Web.Extensions.dll'
    )
    Add-Type -TypeDefinition $code -ReferencedAssemblies $references -Language CSharp -ErrorAction Stop
}
catch {
    [Console]::Error.WriteLine("computer-helper: Add-Type failed: " + $_.Exception.Message)
    exit 3
}

[DshComputerUse.Program]::EnableDpiAwareness() | Out-Null
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $response = [DshComputerUse.Program]::HandleRequest($line)
    if ($null -ne $response -and $response.Length -gt 0) {
        [Console]::Out.WriteLine($response)
        [Console]::Out.Flush()
    }
    if ([DshComputerUse.Program]::QuitRequested) { break }
}

exit 0
