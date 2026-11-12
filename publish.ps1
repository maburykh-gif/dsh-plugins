param(
  [string]$RepoUrl = "",
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

if (-not (Test-Path '.git')) {
  git init -b main | Out-Null
  Write-Host 'git: репозиторий создан' -ForegroundColor DarkGray
}

# Идентичность только для этого репозитория, глобальные настройки не трогаем.
git config user.name 'DSH Plugins'
git config user.email 'plugins@example.com'

git add -A
$pending = git status --porcelain
if ($pending) {
  git commit -m 'feat: AITunnel model routes and text.ru uniqueness plugins' | Out-Null
  Write-Host 'git: пакеты закоммичены' -ForegroundColor Green
}

$sha = (git rev-parse HEAD).Trim()

if ($RepoUrl) {
  & $node 'tools\make-index.mjs' --repo $RepoUrl --commit $sha
  if ($LASTEXITCODE -ne 0) { throw 'не удалось собрать market/index.json' }
  git add market/index.json
  if (git status --porcelain) {
    git commit -m "chore: market index pinned to $sha" | Out-Null
  }
} else {
  & $node 'tools\make-index.mjs' --commit $sha
}

& $node 'tools\validate-index.mjs'
if ($LASTEXITCODE -ne 0) { throw 'индекс не прошёл проверку формата' }

if ($RepoUrl -and -not $SkipPush) {
  git remote remove origin 2>$null
  git remote add origin $RepoUrl
  Write-Host "git: отправляю в $RepoUrl" -ForegroundColor Cyan
  git push -u origin main
  $base = $RepoUrl.TrimEnd('/')
  if ($base -match '^https?://github\.com/') {
    $raw = "https://raw.githubusercontent.com/$($base -replace '^https?://github\.com/', '')/main/market/index.json"
  } elseif ($base -match '^git@github\.com:') {
    $raw = "https://raw.githubusercontent.com/$($base -replace '^git@github\.com:', '')/main/market/index.json"
  } else {
    $raw = "$base/-/raw/main/market/index.json"
  }
  Write-Host ''
  Write-Host 'Индекс для DSH:' -ForegroundColor Cyan
  Write-Host "  $raw"
} elseif ($RepoUrl) {
  Write-Host 'Готово локально. Отправка пропущена (-SkipPush).' -ForegroundColor Yellow
} else {
  Write-Host 'Репозиторий готов, но URL не указан: индекс ссылается на плейсхолдер.' -ForegroundColor Yellow
  Write-Host 'Повторите с -RepoUrl https://github.com/<user>/<repo>' -ForegroundColor Yellow
}
