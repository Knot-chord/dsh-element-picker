<#
  compat.ps1 — 在隔离沙箱里验证本插件能被指定版本的 DSH 接受并挂载。

  用法：
    pwsh -File scripts/compat.ps1
        # 默认三个边界版本：0.2.0-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.4
    pwsh -File scripts/compat.ps1 -Versions 0.2.1-rc.5
    pwsh -File scripts/compat.ps1 -Fresh
        # 重建每个版本的 DSH_HOME（不动 npm 缓存）

  纯净性：
    - 每个版本一个独立 DSH_HOME，互不污染；
    - 插件用 link: 安装，不复制；
    - npm 缓存单独放在沙箱下，不复用桌面端/全局缓存；
    - 不读写 C:\Users\Z1234\.dsh 或 D:\dsh_data。
  说明：
    headless 下客户端（引用卡/输入框）无法运行；这里验证的是
    「宿主能装、能挂、配置能生成」。客户端能力由 client.js 的探测链保证。
#>
[CmdletBinding()]
param(
  [string[]]$Versions = @("0.2.0-rc.2", "0.2.1-rc.5", "0.2.2-rc.4", "0.2.2-rc.5"),
  [string]$PluginDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Profile = "compat",
  [switch]$Fresh
)

$ErrorActionPreference = "Stop"

# 沙箱根：DSH 安装目录下的统一沙盒区；可用 DSH_REF_COMPAT 覆盖。
$root = if ($env:DSH_REF_COMPAT) { $env:DSH_REF_COMPAT } else { "D:\dsh_data\sandbox\compat" }
$cache = Join-Path $root "npm-cache"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$env:npm_config_cache = $cache

# 沙箱 API key：如果你把 key 放在 D:\dsh_data\secrets\sandbox-deepseek.key，就注入给子进程；
# 不复制进仓库，也不写进 manifest。
$keyFile = "D:\dsh_data\secrets\sandbox-deepseek.key"
if (Test-Path $keyFile) {
  $env:DEEPSEEK_API_KEY = (Get-Content $keyFile -Raw).Trim()
}

$npxCmd = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npxCmd) { $npxCmd = "npx" }

$Versions = @($Versions | ForEach-Object { $_ -split "`",`"" } | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() })
$rows = [System.Collections.Generic.List[object]]::new()

function Resolve-DshBin([string]$Version) {
  # 同一份沙箱 npm 缓存里，找到指定版本已下载的 DSH 包，直接跑 lib/bin.js。
  foreach ($entry in (Get-ChildItem (Join-Path $cache "_npx") -Directory -ErrorAction SilentlyContinue)) {
    $pkg = Join-Path $entry.FullName "node_modules\@deepseek-ai\dsh\package.json"
    if (-not (Test-Path $pkg)) { continue }
    try { $json = Get-Content $pkg -Raw | ConvertFrom-Json } catch { continue }
    if ($json.version -ne $Version) { continue }
    $script = Join-Path $entry.FullName "node_modules\@deepseek-ai\dsh\lib\bin.js"
    if (Test-Path $script) { return $script }
  }
  return $null
}

function Dsh {
  param([string]$Version, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $local = Resolve-DshBin $Version
  if ($local) {
    & node $local @Arguments 2>&1
    return
  }
  & $npxCmd --yes "@deepseek-ai/dsh@$Version" @Arguments 2>&1
}

foreach ($version in $Versions) {
  $versionHome = Join-Path $root "versions\$version\dsh-home"
  if ($Fresh) { Remove-Item $versionHome -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $versionHome | Out-Null
  $env:DSH_HOME = $versionHome

  $result = [pscustomobject]@{
    Version = $version
    Home = $versionHome
    Cli = "?"
    Install = "?"
    Mounted = "?"
    Config = "?"
    Detail = ""
  }

  try {
    $printed = (Dsh $version --version) | Where-Object { "$_".Trim() -match '^\d+\.\d+\.\d+(-[0-9A-Za-z\.]+)?$' } | Select-Object -Last 1
    $trimmed = "$printed".Trim()
    $result.Cli = if ($trimmed -eq $version) { "PASS" } elseif ($trimmed -eq "") { "SKIP(no --version)" } else { "FAIL($trimmed)" }
  } catch {
    $result.Cli = "FAIL"
    $result.Detail = "$($_.Exception.Message)"
  }

  if ($result.Cli -notlike "FAIL*") {
    try {
      $patch = Join-Path $versionHome "profiles\$Profile\cordis.patch.yml"
      if (-not (Test-Path $patch)) {
        $null = Dsh $version $Profile --from-default-profile headless --dump-config
      }
      $spec = "link:" + ($PluginDir -replace "\\", "/")
      $out = Dsh $version plugin --profile $Profile add $spec
      if ($LASTEXITCODE -ne 0) { throw ($out | Select-Object -Last 1) }
      $result.Install = "PASS"
    } catch {
      $result.Install = "FAIL"
      $result.Detail = "$($_.Exception.Message)"
    }
  }

  if ($result.Install -eq "PASS") {
    try {
      $dump = Dsh $version --profile $Profile --dump-config
      $joined = ($dump -join "`n")
      $result.Mounted = if ($joined -match 'element-ref') { "PASS" } else { "FAIL(no row)" }
      $result.Config = if ($LASTEXITCODE -eq 0) { "PASS" } else { "FAIL" }
      if ($result.Mounted -eq "PASS" -and $LASTEXITCODE -ne 0) {
        $result.Detail = ($dump | Select-Object -Last 2) -join ' '
      }
    } catch {
      $result.Mounted = "FAIL"
      $result.Detail = "$($_.Exception.Message)"
    }
  }

  $rows.Add($result)
  Write-Host ("{0,-12} cli={1,-10} install={2,-10} mounted={3,-12} config={4,-6} {5}" -f `
    $result.Version, $result.Cli, $result.Install, $result.Mounted, $result.Config, $result.Detail)
}

$outFile = Join-Path $root "compat-result.json"
$rows | ConvertTo-Json -Depth 4 | Set-Content $outFile -Encoding utf8
Write-Host ""
Write-Host "写入 $outFile"



